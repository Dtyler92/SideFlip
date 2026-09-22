-- Stop new work in a committed fail-closed step before changing reservation
-- policy. If the guarded migration below finds an uncertain paid execution,
-- this disablement remains in force for operator reconciliation.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
update private.my_stuff_research_runtime_config
set enabled=false,updated_at=now()
where singleton;
do $$ begin
  if exists(select 1 from information_schema.columns where table_schema='private' and table_name='my_stuff_research_runtime_config' and column_name='document_lane_enabled') then
    execute 'update private.my_stuff_research_runtime_config set document_lane_enabled=false,updated_at=now() where singleton';
  end if;
end $$;
select cron.unschedule(jobid)
from cron.job
where jobname='sideflip-maintenance-research-worker';
commit;

begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Close the activation race across the intentionally committed fail-closed
-- boundary and hold the singleton lock until this policy transaction commits.
select 1 from private.my_stuff_research_runtime_config where singleton for update;
update private.my_stuff_research_runtime_config
set enabled=false,updated_at=now()
where singleton;
do $$ begin
  if exists(select 1 from information_schema.columns where table_schema='private' and table_name='my_stuff_research_runtime_config' and column_name='document_lane_enabled') then
    execute 'update private.my_stuff_research_runtime_config set document_lane_enabled=false,updated_at=now() where singleton';
  end if;
end $$;
select cron.unschedule(jobid)
from cron.job
where jobname='sideflip-maintenance-research-worker';

-- Never change paid authority while a provider invocation may still be live or
-- its terminal transport state is unknown.
do $$
declare v_document_uncertain boolean:=false; v_has_transport_state boolean:=false;
begin
  perform pg_advisory_xact_lock(hashtextextended('research-provider-global',0));
  if to_regclass('private.my_stuff_document_executions') is not null then
    select exists(
      select 1 from information_schema.columns
      where table_schema='private' and table_name='my_stuff_document_executions' and column_name='transport_state'
    ) into v_has_transport_state;
    if v_has_transport_state then
      execute $query$
        select exists(
          select 1 from private.my_stuff_document_executions
          where state='attempted'
             or transport_state in ('in_flight','abort_requested_remote_unknown','local_stopped_remote_unknown')
        )
      $query$ into v_document_uncertain;
    else
      execute 'select exists(select 1 from private.my_stuff_document_executions where state=''attempted'')'
        into v_document_uncertain;
    end if;
  end if;
  if exists(select 1 from private.my_stuff_research_jobs where status='running')
    or v_document_uncertain
  then
    raise exception 'RESEARCH_EXECUTION_RECONCILIATION_REQUIRED';
  end if;
end
$$;

-- The optional, default-off document lane has its own nonbillable READY state.
-- Settle it through its guarded transition before cancelling untouched document
-- queue rows. Attempted or incoherent rows fail this conversion closed.
do $$
declare v_execution record; v_pending boolean:=false;
begin
  if to_regclass('private.my_stuff_document_executions') is not null then
    if to_regprocedure('public.fail_document_preflight_v1(jsonb,uuid)') is null then
      raise exception 'DOCUMENT_RECONCILIATION_CAPABILITY_MISSING';
    end if;
    for v_execution in execute $query$
      select e.binding,e.attempt_id
      from private.my_stuff_research_jobs j
      join private.my_stuff_document_executions e on e.job_id=j.id
      where j.status='document_pending' and j.reserved_cents<>1250 and e.state='ready'
      order by j.created_at,j.id
      for update of j,e
    $query$ loop
      execute 'select public.fail_document_preflight_v1($1,$2)'
        using v_execution.binding,v_execution.attempt_id;
    end loop;
    execute $query$
      select exists(
        select 1 from private.my_stuff_research_jobs
        where status='document_pending' and reserved_cents<>1250
      )
    $query$ into v_pending;
    if v_pending then raise exception 'DOCUMENT_RECONCILIATION_REQUIRED'; end if;
  end if;
end
$$;

-- Cancel queued jobs that carry the old $25 authority and release their unused
-- reservation in its original accounting month. Users may explicitly enqueue
-- a new $12.50 job after reactivation.
insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number)
select id,user_id,reservation_month,'release',greatest(reserved_cents-coalesce(actual_cents,0),0),0
from private.my_stuff_research_jobs
where status in ('queued','document_queued') and reserved_cents<>1250
on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;

update private.my_stuff_research_jobs
set status='cancelled',last_error_code='BUDGET_POLICY_CHANGED',
    lease_owner=null,lease_token=null,lease_expires_at=null,
    state_version=state_version+1,updated_at=now()
where status in ('queued','document_queued') and reserved_cents<>1250;

-- Reserve one worst-case paid attempt per user action. A terminal low-cost
-- validation failure must leave room for another explicit user-triggered job
-- while the existing $25/user and $100/service monthly ceilings remain hard.
update private.my_stuff_research_runtime_config
set per_job_budget_cents=1250,
    max_attempts=1,
    updated_at=now()
where singleton;

-- Web citations do not always expose a real page or section label. Preserve
-- those locations as unknown rather than inventing one; URL, source policy,
-- provider citation proof, exact excerpt and human review remain required.
alter table private.my_stuff_research_evidence
  drop constraint my_stuff_research_evidence_check;
alter table private.my_stuff_research_evidence
  add constraint my_stuff_research_evidence_check
  check(
    content_hash ~ '^[0-9a-f]{64}$'
    and (
      verification_status='provider_citation_unconfirmed'
      or nullif(trim(page),'') is not null
      or nullif(trim(section),'') is not null
    )
  );

create or replace function private.settle_my_stuff_research_job_v4(
  p_job_id uuid,p_worker text,p_cost_ticks bigint,p_evidence jsonb,p_candidates jsonb,p_unresolved jsonb)
returns uuid language plpgsql security definer set search_path=public,private,pgmq,extensions as $$
declare v_job private.my_stuff_research_jobs%rowtype; v_cfg private.my_stuff_research_runtime_config%rowtype; v_e jsonb; v_c jsonb;
  enabled_source_domains text[]; v_token uuid; v_total integer; v_cost_cents integer; v_accessed_at timestamptz;
begin
  v_token:=p_worker::uuid;
  select * into v_cfg from private.my_stuff_research_runtime_config where singleton;
  if not found or not v_cfg.enabled or v_cfg.provider_name<>'xai' or v_cfg.provider_model<>'grok-4.6' then raise exception 'RESEARCH_DISABLED'; end if;
  select * into v_job from private.my_stuff_research_jobs where id=p_job_id and status='running' and lease_token=v_token and lease_expires_at>now() for update;
  if not found then raise exception 'STALE_RESEARCH_LEASE'; end if;
  if not private.my_stuff_research_policy_is_current_v1(v_job.id) then raise exception 'POLICY_SUPERSEDED'; end if;
  select coalesce(array_agg(domain),array[]::text[]) into enabled_source_domains
    from private.my_stuff_research_source_domains
    where private.my_stuff_research_source_matches_make_v1(domain,v_job.request_snapshot->>'make');
  if cardinality(enabled_source_domains)=0 then raise exception 'RESEARCH_DISABLED'; end if;
  perform private.assert_my_stuff_research_user_v1(v_job.user_id);
  if p_cost_ticks is null or p_cost_ticks<0 then raise exception 'INVALID_PROVIDER_RESPONSE'; end if;
  v_cost_cents:=ceil(p_cost_ticks::numeric/100000000)::integer;
  v_total:=coalesce(v_job.actual_cents,0)+v_cost_cents;
  if v_cost_cents<0 or v_total>v_job.reserved_cents then raise exception 'RESEARCH_BUDGET_EXCEEDED'; end if;
  if v_job.cancellation_requested_at is not null then
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values(p_job_id,v_job.user_id,v_job.reservation_month,'settlement',v_cost_cents,v_job.attempt_count) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values(p_job_id,v_job.user_id,v_job.reservation_month,'release',v_job.reserved_cents-v_total,0) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    update private.my_stuff_research_attempts set status='cancelled',finished_at=now(),usage_cents=v_cost_cents,usage_ticks=p_cost_ticks where job_id=p_job_id and attempt_number=v_job.attempt_count;
    update private.my_stuff_research_jobs set status='cancelled',actual_cents=v_total,actual_cost_ticks=actual_cost_ticks+p_cost_ticks,lease_owner=null,lease_token=null,lease_expires_at=null,state_version=state_version+1,updated_at=now() where id=p_job_id;
    perform pgmq.delete('my_stuff_research_v1',v_job.queue_msg_id);
    return p_job_id;
  end if;
  if jsonb_typeof(p_evidence)<>'array' or jsonb_array_length(p_evidence)>30 or pg_column_size(p_evidence)>262144
    or jsonb_typeof(p_candidates)<>'array' or jsonb_array_length(p_candidates)>100 or pg_column_size(p_candidates)>262144
    or jsonb_typeof(p_unresolved)<>'array' or jsonb_array_length(p_unresolved)>50 or pg_column_size(p_unresolved)>131072
    then raise exception 'INVALID_RESEARCH_RESULT'; end if;
  if exists(
    select 1 from jsonb_array_elements(p_unresolved) value
    where jsonb_typeof(value)<>'object'
      or exists(select 1 from jsonb_object_keys(value) key where key not in ('name','reason'))
      or nullif(trim(value->>'name'),'') is null or length(value->>'name')>200
      or nullif(trim(value->>'reason'),'') is null or length(value->>'reason')>1000
      or ((value->>'name')||E'\n'||(value->>'reason')) ~* '(ignore|disregard).*(instruction|previous|system)|system\s*prompt|developer\s*message|jailbreak'
  ) then raise exception 'INVALID_RESEARCH_RESULT'; end if;
  delete from private.my_stuff_research_evidence where job_id=p_job_id;
  for v_e in select value from jsonb_array_elements(p_evidence) loop
    begin
      if jsonb_typeof(v_e->'accessedAt')<>'string'
        or (v_e->>'accessedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      then raise exception 'INVALID_EVIDENCE'; end if;
      v_accessed_at:=(v_e->>'accessedAt')::timestamptz;
    exception when others then raise exception 'INVALID_EVIDENCE';
    end;
    if jsonb_typeof(v_e)<>'object'
      or exists(select 1 from jsonb_object_keys(v_e) key where key not in ('id','title','canonicalUrl','exactExcerpt','accessedAt','applicability','sourceClass','page','section','locationVerified','verificationStatus','sourceDomain'))
      or jsonb_typeof(v_e->'id')<>'string' or nullif(trim(v_e->>'id'),'') is null or (v_e->>'id')<>trim(v_e->>'id') or length(v_e->>'id')>100 or (v_e->>'id') ~ '[[:cntrl:]]'
      or jsonb_typeof(v_e->'title')<>'string' or nullif(trim(v_e->>'title'),'') is null or (v_e->>'title')<>trim(v_e->>'title') or length(v_e->>'title')>500 or (v_e->>'title') ~ '[[:cntrl:]]'
      or jsonb_typeof(v_e->'canonicalUrl')<>'string' or nullif(trim(v_e->>'canonicalUrl'),'') is null or (v_e->>'canonicalUrl')<>trim(v_e->>'canonicalUrl') or length(v_e->>'canonicalUrl')>2048 or (v_e->>'canonicalUrl') ~ '[[:cntrl:]]'
      or jsonb_typeof(v_e->'exactExcerpt')<>'string' or nullif(trim(v_e->>'exactExcerpt'),'') is null or (v_e->>'exactExcerpt')<>trim(v_e->>'exactExcerpt') or length(v_e->>'exactExcerpt')>4000 or (v_e->>'exactExcerpt') ~ '[[:cntrl:]]'
      or jsonb_typeof(v_e->'applicability')<>'string' or nullif(trim(v_e->>'applicability'),'') is null or (v_e->>'applicability')<>trim(v_e->>'applicability') or length(v_e->>'applicability')>1000 or (v_e->>'applicability') ~ '[[:cntrl:]]'
      or jsonb_typeof(v_e->'sourceDomain')<>'string' or nullif(trim(v_e->>'sourceDomain'),'') is null or (v_e->>'sourceDomain')<>trim(v_e->>'sourceDomain') or (v_e->>'sourceDomain')<>lower(v_e->>'sourceDomain')
      or v_e->>'sourceClass' not in ('manufacturer','authorized_dealer')
      or (v_e->>'sourceDomain')<>all(enabled_source_domains)
      or v_e->'locationVerified' is distinct from 'false'::jsonb
      or v_e->>'verificationStatus'<>'provider_citation_unconfirmed'
      or v_accessed_at>now() or v_accessed_at<now()-interval '30 days'
      or ((v_e->>'title')||E'\n'||(v_e->>'exactExcerpt')) ~* '(ignore|disregard|override)\s+(all\s+)?(previous|prior|system)\s+instructions?|reveal\s+(secrets?|credentials?|system prompt)|act as\s+(a|an)\s+'
      or (v_e->>'canonicalUrl') !~ '^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:/[^?#]*)?(?:\?[^#]*)?$'
      or (v_e->>'canonicalUrl') ~* '%(?:2f|5c|2e)'
      or (v_e->>'canonicalUrl') ~ '/(?:\.{1,2})(?:/|\?|$)'
      or not exists(
        select 1 from private.my_stuff_research_source_domains d
        where d.enabled
          and d.domain=v_e->>'sourceDomain'
          and d.source_class=v_e->>'sourceClass'
          and d.terms_reviewed_on between current_date-365 and current_date
          and d.robots_reviewed_on between current_date-30 and current_date
          and exists(select 1 from unnest(d.manufacturer_aliases) alias(make_name) where lower(trim(alias.make_name))=lower(v_job.request_snapshot->>'make'))
          and (
            substring(v_e->>'canonicalUrl' from '^https://([^/?#:]+)(?:/|$)')=d.domain
            or (d.include_subdomains and substring(v_e->>'canonicalUrl' from '^https://([^/?#:]+)(?:/|$)') like '%.'||d.domain)
          )
          and exists(
            select 1 from unnest(d.allowed_path_prefixes) prefix
            where prefix='/'
               or coalesce(substring(v_e->>'canonicalUrl' from '^https://[^/?#:]+(/[^?#]*)'),'/')=prefix
               or (left(coalesce(substring(v_e->>'canonicalUrl' from '^https://[^/?#:]+(/[^?#]*)'),'/'),length(prefix))=prefix
                 and (right(prefix,1)='/' or substring(coalesce(substring(v_e->>'canonicalUrl' from '^https://[^/?#:]+(/[^?#]*)'),'/') from length(prefix)+1 for 1)='/'))
          )
      )
      or (
        v_e ? 'page' and v_e->'page'<>'null'::jsonb and (
          jsonb_typeof(v_e->'page')<>'string'
          or nullif(trim(v_e->>'page'),'') is null
          or (v_e->>'page')<>trim(v_e->>'page')
          or length(v_e->>'page')>100
          or (v_e->>'page') ~ '[[:cntrl:]]'
        )
      )
      or (
        v_e ? 'section' and v_e->'section'<>'null'::jsonb and (
          jsonb_typeof(v_e->'section')<>'string'
          or nullif(trim(v_e->>'section'),'') is null
          or (v_e->>'section')<>trim(v_e->>'section')
          or length(v_e->>'section')>500
          or (v_e->>'section') ~ '[[:cntrl:]]'
        )
      )
      then raise exception 'INVALID_EVIDENCE'; end if;
    insert into private.my_stuff_research_evidence(job_id,evidence_key,title,canonical_url,exact_excerpt,page,section,accessed_on,accessed_at,applicability,source_class,source_domain,location_verified,verification_status,content_hash)
      values(p_job_id,v_e->>'id',v_e->>'title',v_e->>'canonicalUrl',v_e->>'exactExcerpt',nullif(v_e->>'page',''),nullif(v_e->>'section',''),(v_accessed_at at time zone 'UTC')::date,v_accessed_at,v_e->>'applicability',v_e->>'sourceClass',v_e->>'sourceDomain',false,'provider_citation_unconfirmed',encode(digest(v_e::text,'sha256'),'hex'));
  end loop;
  delete from private.my_stuff_research_candidates where job_id=p_job_id;
  for v_c in select value from jsonb_array_elements(p_candidates) loop
    if jsonb_typeof(v_c)<>'object'
      or exists(select 1 from jsonb_object_keys(v_c) key where key not in ('name','action','profile','dueSemantics','intervalMiles','intervalHours','intervalCycles','intervalMonths','evidenceIds','uncertainty','conflict'))
      or nullif(trim(v_c->>'name'),'') is null or length(v_c->>'name')>200
      or v_c->>'action' not in ('inspect','adjust','replace')
      or v_c->>'profile' not in ('normal','severe')
      or v_c->>'dueSemantics' not in ('whichever_first','all')
      or nullif(trim(v_c->>'uncertainty'),'') is null or length(v_c->>'uncertainty')>500
      or v_c->'conflict' is distinct from 'false'::jsonb
      or jsonb_typeof(v_c->'evidenceIds')<>'array' or jsonb_array_length(v_c->'evidenceIds') not between 1 and 10
      or exists(select 1 from jsonb_array_elements(v_c->'evidenceIds') ref where jsonb_typeof(ref)<>'string' or not exists(select 1 from private.my_stuff_research_evidence e where e.job_id=p_job_id and e.evidence_key=ref#>>'{}'))
      or not (v_c ?| array['intervalMiles','intervalHours','intervalCycles','intervalMonths'])
      or exists(
        select 1 from unnest(array['intervalMiles','intervalHours','intervalCycles','intervalMonths']) field
        where v_c ? field and (
          jsonb_typeof(v_c->field)<>'number'
          or (v_c->>field)!~'^[1-9][0-9]*$'
          or (v_c->>field)::numeric > case field when 'intervalMonths' then 1200 when 'intervalCycles' then 1000000000 else 10000000 end
        )
      )
      then raise exception 'INVALID_CANDIDATE'; end if;
    insert into private.my_stuff_research_candidates(job_id,candidate,content_hash) values(p_job_id,v_c,encode(digest(v_c::text,'sha256'),'hex'));
  end loop;
  insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values(p_job_id,v_job.user_id,v_job.reservation_month,'settlement',v_cost_cents,v_job.attempt_count) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
  insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values(p_job_id,v_job.user_id,v_job.reservation_month,'release',v_job.reserved_cents-v_total,0) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
  update private.my_stuff_research_attempts set status='succeeded',finished_at=now(),usage_cents=v_cost_cents,usage_ticks=p_cost_ticks where job_id=p_job_id and attempt_number=v_job.attempt_count;
  update private.my_stuff_research_jobs set status='awaiting_review',actual_cents=v_total,actual_cost_ticks=actual_cost_ticks+p_cost_ticks,unresolved=p_unresolved,lease_owner=null,lease_token=null,lease_expires_at=null,state_version=state_version+1,updated_at=now() where id=p_job_id;
  perform pgmq.delete('my_stuff_research_v1',v_job.queue_msg_id);
  return p_job_id;
end $$;

revoke execute on function private.settle_my_stuff_research_job_v4(uuid,text,bigint,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function private.settle_my_stuff_research_job_v4(uuid,text,bigint,jsonb,jsonb,jsonb) to service_role;


-- Keep the operator-only reactivation gate coherent with the new bounded
-- one-attempt reservation policy.
create or replace function private.activate_my_stuff_research_v1()
returns void
language plpgsql
security definer
set search_path=pg_catalog,private,vault,cron
as $$
declare
  enabled_source_domains integer;
  v_secret_count integer;
  v_config private.my_stuff_research_runtime_config%rowtype;
  v_document_uncertain boolean:=false;
  v_document_lane_enabled boolean:=false;
  v_has_transport_state boolean:=false;
begin
  if session_user not in ('postgres','supabase_admin') then
    raise exception 'Owner session required';
  end if;

  select count(*) into enabled_source_domains
  from private.my_stuff_research_source_domains
  where enabled
    and terms_reviewed_on between current_date-365 and current_date
    and robots_reviewed_on between current_date-30 and current_date;

  select count(*) into v_secret_count
  from vault.decrypted_secrets
  where name in ('maintenance_research_worker_url','maintenance_research_worker_secret')
    and nullif(decrypted_secret,'') is not null;

  if enabled_source_domains<1 or v_secret_count<>2 or exists(
    select 1
    from private.my_stuff_research_source_domains
    where enabled and (
      include_subdomains is not true
      or allowed_path_prefixes<>array['/']::text[]
      or cardinality(manufacturer_aliases)<1
      or cardinality(manufacturer_aliases)>50
      or exists(
        select 1
        from unnest(manufacturer_aliases) alias(make_name)
        where nullif(trim(alias.make_name),'') is null
           or length(alias.make_name)>80
      )
    )
  ) then
    raise exception 'Research source policy or Vault configuration is incomplete';
  end if;

  select * into v_config
  from private.my_stuff_research_runtime_config
  where singleton
  for update;

  if exists(
    select 1 from information_schema.columns
    where table_schema='private' and table_name='my_stuff_research_runtime_config' and column_name='document_lane_enabled'
  ) then
    execute 'select document_lane_enabled from private.my_stuff_research_runtime_config where singleton'
      into v_document_lane_enabled;
  end if;

  if to_regclass('private.my_stuff_document_executions') is not null then
    select exists(
      select 1 from information_schema.columns
      where table_schema='private' and table_name='my_stuff_document_executions' and column_name='transport_state'
    ) into v_has_transport_state;
    if v_has_transport_state then
      execute $query$
        select exists(
          select 1 from private.my_stuff_document_executions
          where state='attempted'
             or transport_state in ('in_flight','abort_requested_remote_unknown','local_stopped_remote_unknown')
        )
      $query$ into v_document_uncertain;
    else
      execute 'select exists(select 1 from private.my_stuff_document_executions where state=''attempted'')'
        into v_document_uncertain;
    end if;
  end if;

  if v_config.singleton is null
    or v_config.enabled is distinct from false
    or v_document_lane_enabled is distinct from false
    or v_config.provider_name is distinct from 'xai'
    or v_config.provider_model is distinct from 'grok-4.6'
    or v_config.retention_policy is distinct from 'standard-30-days-store-false'
    or v_config.policy_version is distinct from 'research-v2-xai-citations'
    or v_config.per_job_budget_cents is distinct from 1250
    or v_config.monthly_user_budget_cents is distinct from 2500
    or v_config.global_monthly_budget_cents is distinct from 10000
    or v_config.daily_user_job_cap is distinct from 15
    or v_config.monthly_user_job_cap is distinct from 50
    or v_config.max_attempts is distinct from 1
    or v_config.max_searches is distinct from 3
    or v_config.max_fetches is distinct from 2
    or v_config.provider_timeout_seconds is distinct from 120
    or v_config.lease_seconds is distinct from 300
    or exists(
      select 1 from private.my_stuff_research_jobs
      where status in ('queued','running','document_queued','document_pending') and reserved_cents<>1250
    )
    or v_document_uncertain
  then
    raise exception 'Research provider configuration is incomplete';
  end if;

  update private.my_stuff_research_runtime_config
  set enabled=true,
      updated_at=now()
  where singleton;

  perform cron.schedule(
    'sideflip-maintenance-research-worker',
    '*/5 * * * *',
    'select private.invoke_my_stuff_research_worker_v1()'
  );
end
$$;


revoke all on function private.activate_my_stuff_research_v1() from public,anon,authenticated;
grant execute on function private.activate_my_stuff_research_v1() to service_role;


commit;
