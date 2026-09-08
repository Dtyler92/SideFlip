-- Convert grounded maintenance research to xAI Responses web search.
-- Provider citations remain unconfirmed until the owner explicitly verifies
-- the official source links. Installation is disabled and unscheduled.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '90s';

update private.my_stuff_research_runtime_config
set enabled=false, updated_at=now()
where singleton;

select cron.unschedule(jobid)
from cron.job
where jobname='sideflip-maintenance-research-worker';

-- Production had no jobs when this conversion was prepared. This remains
-- fail-safe if a job appears before deployment: stop work, preserve incurred
-- spend, and release only the unused reservation in its original month.
insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number)
select id,user_id,reservation_month,'release',greatest(reserved_cents-coalesce(actual_cents,0),0),0
from private.my_stuff_research_jobs
where status in ('queued','running','awaiting_review','approved')
on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;

select pgmq.delete('my_stuff_research_v1',queue_msg_id)
from private.my_stuff_research_jobs
where status in ('queued','running','awaiting_review','approved') and queue_msg_id is not null;

update private.my_stuff_research_attempts a
set status='cancelled',finished_at=coalesce(finished_at,now()),error_code=coalesce(error_code,'POLICY_SUPERSEDED')
from private.my_stuff_research_jobs j
where a.job_id=j.id and j.status in ('queued','running','awaiting_review','approved') and a.status='running';

update private.my_stuff_research_jobs
set status='superseded',last_error_code='POLICY_SUPERSEDED',queue_msg_id=null,
    lease_owner=null,lease_token=null,lease_expires_at=null,state_version=state_version+1,updated_at=now()
where status in ('queued','running','awaiting_review','approved');

alter table private.my_stuff_research_evidence
  add column if not exists verification_status text not null default 'independently_verified';
alter table private.my_stuff_research_jobs
  add column if not exists actual_cost_ticks bigint not null default 0 check(actual_cost_ticks>=0);
alter table private.my_stuff_research_attempts
  add column if not exists usage_ticks bigint check(usage_ticks is null or usage_ticks>=0);
alter table private.my_stuff_research_evidence
  drop constraint if exists my_stuff_research_evidence_verification_status_check;
alter table private.my_stuff_research_evidence
  add constraint my_stuff_research_evidence_verification_status_check
  check(verification_status in ('independently_verified','provider_citation_unconfirmed'));

alter table private.my_stuff_research_source_domains
  add column if not exists manufacturer_aliases text[] not null default '{}'::text[];
update private.my_stuff_research_source_domains
set manufacturer_aliases=array[manufacturer]
where cardinality(manufacturer_aliases)=0;

do $$ declare c record; begin
  for c in
    select conname from pg_constraint
    where conrelid='private.my_stuff_research_runtime_config'::regclass
      and contype='c' and pg_get_constraintdef(oid) ilike '%provider_name%'
  loop
    execute format('alter table private.my_stuff_research_runtime_config drop constraint %I',c.conname);
  end loop;
end $$;

alter table private.my_stuff_research_runtime_config
  add constraint my_stuff_research_runtime_provider_check
  check(not enabled or (
    provider_name='xai' and provider_model='grok-4.6' and
    retention_policy='standard-30-days-store-false'
  ));

update private.my_stuff_research_runtime_config
set enabled=false,provider_name='xai',provider_model='grok-4.6',
    retention_policy='standard-30-days-store-false',policy_version='research-v2-xai-citations',
    -- $12.50 per attempt bounds Grok 4.6's full context window,
    -- configured output ceilings, and five server-side web actions. Reserving
    -- both attempts consumes the entire hard $25 monthly provider ceiling.
    per_job_budget_cents=2500,monthly_user_budget_cents=2500,max_attempts=2,updated_at=now()
where singleton;

create unique index if not exists my_stuff_research_one_global_running_idx
  on private.my_stuff_research_jobs((true)) where status='running';

create or replace function private.lease_my_stuff_research_job_v4(p_worker text,p_lease_seconds integer default 300)
returns private.my_stuff_research_jobs language plpgsql security definer set search_path=public,private,pgmq,extensions as $$
declare v_job private.my_stuff_research_jobs%rowtype; v_charge integer; v_total integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('research-provider-global',0));
  if exists(select 1 from private.my_stuff_research_jobs where status='running' and lease_expires_at>now()) then return null; end if;
  select * into v_job from private.my_stuff_research_jobs where status='running' and lease_expires_at<=now() for update;
  if found then
    v_charge:=least(1250,greatest(v_job.reserved_cents-coalesce(v_job.actual_cents,0),0));
    v_total:=coalesce(v_job.actual_cents,0)+v_charge;
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number)
      values(v_job.id,v_job.user_id,v_job.reservation_month,'settlement',v_charge,v_job.attempt_count)
      on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    update private.my_stuff_research_attempts set status='failed',finished_at=now(),error_code='LEASE_EXPIRED',usage_cents=v_charge,usage_ticks=null
      where job_id=v_job.id and attempt_number=v_job.attempt_count and status='running';
    if v_job.cancellation_requested_at is not null then
      insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number)
        values(v_job.id,v_job.user_id,v_job.reservation_month,'release',v_job.reserved_cents-v_total,0)
        on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
      update private.my_stuff_research_jobs set status='cancelled',actual_cents=v_total,lease_owner=null,lease_token=null,lease_expires_at=null,state_version=state_version+1,updated_at=now() where id=v_job.id;
      if v_job.queue_msg_id is not null then perform pgmq.delete('my_stuff_research_v1',v_job.queue_msg_id); end if;
      return null;
    end if;
    update private.my_stuff_research_jobs set status='queued',actual_cents=v_total,lease_owner=null,lease_token=null,lease_expires_at=null,state_version=state_version+1,updated_at=now() where id=v_job.id;
  end if;
  return private.lease_my_stuff_research_job_v3(p_worker,p_lease_seconds);
end $$;

create or replace function private.settle_my_stuff_research_job_v4(
  p_job_id uuid,p_worker text,p_cost_ticks bigint,p_evidence jsonb,p_candidates jsonb,p_unresolved jsonb)
returns uuid language plpgsql security definer set search_path=public,private,pgmq,extensions as $$
declare v_job private.my_stuff_research_jobs%rowtype; v_cfg private.my_stuff_research_runtime_config%rowtype; v_e jsonb; v_c jsonb;
  enabled_source_domains text[]; v_token uuid; v_total integer; v_cost_cents integer;
begin
  v_token:=p_worker::uuid;
  select * into v_cfg from private.my_stuff_research_runtime_config where singleton;
  if not found or not v_cfg.enabled or v_cfg.provider_name<>'xai' or v_cfg.provider_model<>'grok-4.6' then raise exception 'RESEARCH_DISABLED'; end if;
  select * into v_job from private.my_stuff_research_jobs where id=p_job_id and status='running' and lease_token=v_token and lease_expires_at>now() for update;
  if not found then raise exception 'STALE_RESEARCH_LEASE'; end if;
  if not private.my_stuff_research_policy_is_current_v1(v_job.id) then raise exception 'POLICY_SUPERSEDED'; end if;
  select coalesce(array_agg(domain),array[]::text[]) into enabled_source_domains from private.my_stuff_research_source_domains where enabled and terms_reviewed_on between current_date-365 and current_date and robots_reviewed_on between current_date-30 and current_date and lower(manufacturer)=lower(v_job.request_snapshot->>'make');
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
  if jsonb_typeof(p_evidence)<>'array' or jsonb_array_length(p_evidence)>30 or jsonb_typeof(p_candidates)<>'array' or jsonb_array_length(p_candidates)>100 or jsonb_typeof(p_unresolved)<>'array' or jsonb_array_length(p_unresolved)>50 then raise exception 'INVALID_RESEARCH_RESULT'; end if;
  if exists(select 1 from jsonb_array_elements(p_unresolved) value where jsonb_typeof(value)<>'object' or nullif(trim(value->>'name'),'') is null or length(value->>'name')>200 or nullif(trim(value->>'reason'),'') is null or length(value->>'reason')>1000 or (value->>'name'||E'\n'||value->>'reason') ~* '(ignore|disregard).*(instruction|previous|system)|system\s*prompt|developer\s*message|jailbreak') then raise exception 'INVALID_RESEARCH_RESULT'; end if;
  delete from private.my_stuff_research_evidence where job_id=p_job_id;
  for v_e in select value from jsonb_array_elements(p_evidence) loop
    if nullif(v_e->>'id','') is null or nullif(v_e->>'canonicalUrl','') is null or nullif(v_e->>'exactExcerpt','') is null or (v_e->>'sourceDomain')<>all(enabled_source_domains) or coalesce((v_e->>'locationVerified')::boolean,true) is not false or v_e->>'verificationStatus'<>'provider_citation_unconfirmed' then raise exception 'INVALID_EVIDENCE'; end if;
    insert into private.my_stuff_research_evidence(job_id,evidence_key,title,canonical_url,exact_excerpt,page,section,accessed_on,accessed_at,applicability,source_class,source_domain,location_verified,verification_status,content_hash)
      values(p_job_id,v_e->>'id',v_e->>'title',v_e->>'canonicalUrl',v_e->>'exactExcerpt',nullif(v_e->>'page',''),nullif(v_e->>'section',''),(v_e->>'accessedAt')::timestamptz::date,(v_e->>'accessedAt')::timestamptz,v_e->>'applicability',v_e->>'sourceClass',v_e->>'sourceDomain',false,'provider_citation_unconfirmed',encode(digest(v_e::text,'sha256'),'hex'));
  end loop;
  delete from private.my_stuff_research_candidates where job_id=p_job_id;
  for v_c in select value from jsonb_array_elements(p_candidates) loop
    insert into private.my_stuff_research_candidates(job_id,candidate,content_hash) values(p_job_id,v_c,encode(digest(v_c::text,'sha256'),'hex'));
  end loop;
  insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values(p_job_id,v_job.user_id,v_job.reservation_month,'settlement',v_cost_cents,v_job.attempt_count) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
  insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values(p_job_id,v_job.user_id,v_job.reservation_month,'release',v_job.reserved_cents-v_total,0) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
  update private.my_stuff_research_attempts set status='succeeded',finished_at=now(),usage_cents=v_cost_cents,usage_ticks=p_cost_ticks where job_id=p_job_id and attempt_number=v_job.attempt_count;
  update private.my_stuff_research_jobs set status='awaiting_review',actual_cents=v_total,actual_cost_ticks=actual_cost_ticks+p_cost_ticks,unresolved=p_unresolved,lease_owner=null,lease_token=null,lease_expires_at=null,state_version=state_version+1,updated_at=now() where id=p_job_id;
  perform pgmq.delete('my_stuff_research_v1',v_job.queue_msg_id);
  return p_job_id;
end $$;

create or replace function private.fail_my_stuff_research_job_v2(p_job_id uuid,p_lease_token uuid,p_cost_ticks bigint,p_error_code text,p_error_detail text)
returns boolean language plpgsql security definer set search_path=public,private,pgmq,extensions as $$
declare v_job private.my_stuff_research_jobs%rowtype; v_cfg private.my_stuff_research_runtime_config%rowtype;
  v_attempt_charge integer; v_total integer; v_delay integer; v_new_msg bigint; v_old_msg bigint; v_error_code text;
begin
  select * into v_cfg from private.my_stuff_research_runtime_config where singleton;
  select * into v_job from private.my_stuff_research_jobs where id=p_job_id and status='running' and lease_token=p_lease_token for update;
  if not found then return false; end if;
  if p_cost_ticks is not null and p_cost_ticks<0 then raise exception 'INVALID_PROVIDER_RESPONSE'; end if;
  v_attempt_charge:=case when p_cost_ticks is null then least(1250,greatest(v_job.reserved_cents-coalesce(v_job.actual_cents,0),0)) else ceil(p_cost_ticks::numeric/100000000)::integer end;
  v_total:=coalesce(v_job.actual_cents,0)+v_attempt_charge;
  v_error_code:=case when v_total>v_job.reserved_cents then 'BUDGET_EXCEEDED' else left(coalesce(p_error_code,'WORKER_ERROR'),100) end;
  insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number)
    values(p_job_id,v_job.user_id,v_job.reservation_month,'settlement',v_attempt_charge,v_job.attempt_count)
    on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
  update private.my_stuff_research_attempts set status='failed',finished_at=now(),error_code=v_error_code,usage_cents=v_attempt_charge,usage_ticks=p_cost_ticks where job_id=p_job_id and attempt_number=v_job.attempt_count;
  update private.my_stuff_research_jobs set actual_cents=v_total,actual_cost_ticks=actual_cost_ticks+coalesce(p_cost_ticks,0) where id=p_job_id;
  if v_job.cancellation_requested_at is not null then
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number)
      values(p_job_id,v_job.user_id,v_job.reservation_month,'release',greatest(v_job.reserved_cents-v_total,0),0) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    update private.my_stuff_research_jobs set status='cancelled',lease_owner=null,lease_token=null,lease_expires_at=null,state_version=state_version+1,updated_at=now() where id=p_job_id;
    perform pgmq.delete('my_stuff_research_v1',v_job.queue_msg_id);
    return true;
  end if;
  if v_job.attempt_count>=v_cfg.max_attempts or v_error_code in ('INVALID_EVIDENCE','INVALID_CITATION','UNCITED_EVIDENCE','UNAPPROVED_SOURCE','INVALID_CANDIDATE','INVALID_PROVIDER_RESPONSE','PROVIDER_REJECTED','POLICY_SUPERSEDED','RESEARCH_DISABLED','BUDGET_EXCEEDED','PRO_REQUIRED','ACCOUNT_DELETION_PENDING') then
    insert into private.my_stuff_research_dead_letters(job_id,error_code,error_detail,payload_hash) values(p_job_id,v_error_code,left(p_error_detail,4000),encode(digest(jsonb_build_object('job_id',p_job_id,'attempt',v_job.attempt_count)::text,'sha256'),'hex')) on conflict(job_id) do nothing;
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number)
      values(p_job_id,v_job.user_id,v_job.reservation_month,'release',greatest(v_job.reserved_cents-v_total,0),0) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    update private.my_stuff_research_jobs set status='failed',last_error_code=v_error_code,lease_owner=null,lease_token=null,lease_expires_at=null,state_version=state_version+1,updated_at=now() where id=p_job_id;
    perform pgmq.delete('my_stuff_research_v1',v_job.queue_msg_id);
  else
    v_delay:=least(300,15*(2^v_job.attempt_count)::integer);
    v_old_msg:=v_job.queue_msg_id;
    select pgmq.send('my_stuff_research_v1',jsonb_build_object('job_id',p_job_id,'schema_version',1),v_delay) into v_new_msg;
    update private.my_stuff_research_jobs set status='queued',last_error_code=v_error_code,not_before=now()+make_interval(secs=>v_delay),queue_msg_id=v_new_msg,lease_owner=null,lease_token=null,lease_expires_at=null,state_version=state_version+1,updated_at=now() where id=p_job_id;
    if v_old_msg is not null then perform pgmq.delete('my_stuff_research_v1',v_old_msg); end if;
  end if;
  return true;
end $$;

create or replace function public.approve_my_stuff_research_v2(p_job_id uuid,p_candidate_ids uuid[],p_sources_verified boolean,p_mutation_id text)
returns uuid language plpgsql security definer set search_path=public,private,extensions as $$
declare v_user uuid:=auth.uid(); v_job private.my_stuff_research_jobs%rowtype; v_snapshot jsonb; v_hash text; v_request_hash text; v_id uuid; v_existing_job uuid; v_existing_request_hash text; v_selected_count integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if exists(select 1 from public.account_deletion_tombstones where user_id=v_user) then raise exception 'ACCOUNT_DELETION_PENDING'; end if;
  if not public.user_has_verified_pro_entitlement(v_user) then raise exception 'PRO_REQUIRED'; end if;
  perform private.assert_my_stuff_research_user_v1(v_user);
  if p_sources_verified is not true then raise exception 'SOURCES_NOT_VERIFIED'; end if;
  if nullif(trim(coalesce(p_mutation_id,'')),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required'; end if;
  if p_candidate_ids is null or cardinality(p_candidate_ids)<1 or cardinality(p_candidate_ids)>100 then raise exception 'Candidate selection required'; end if;
  if cardinality(p_candidate_ids)<>(select count(distinct value) from unnest(p_candidate_ids) as selected(value)) then raise exception 'Duplicate candidate selection'; end if;
  v_request_hash:=encode(digest(jsonb_build_object('job_id',p_job_id,'candidate_ids',(select jsonb_agg(value order by value) from unnest(p_candidate_ids) selected(value)),'sources_verified',true)::text,'sha256'),'hex');
  select id,job_id,request_hash into v_id,v_existing_job,v_existing_request_hash from private.my_stuff_research_approvals where user_id=v_user and client_mutation_id=trim(p_mutation_id);
  if v_id is not null then
    if v_existing_job<>p_job_id or v_existing_request_hash is distinct from v_request_hash then raise exception 'MUTATION_ID_REUSED'; end if;
    return v_id;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('research-job:'||p_job_id::text,0));
  -- A concurrent identical first request may have committed while this caller
  -- waited for the job lock. Recheck before reading mutable job identity.
  select id,job_id,request_hash into v_id,v_existing_job,v_existing_request_hash from private.my_stuff_research_approvals where user_id=v_user and client_mutation_id=trim(p_mutation_id);
  if v_id is not null then
    if v_existing_job<>p_job_id or v_existing_request_hash is distinct from v_request_hash then raise exception 'MUTATION_ID_REUSED'; end if;
    return v_id;
  end if;
  select * into v_job from private.my_stuff_research_jobs where id=p_job_id and user_id=v_user for update;
  if not found then raise exception 'Research job not found'; end if;
  if not exists(select 1 from public.my_stuff_items where id=v_job.item_id and user_id=v_user and vin_confirmation_fingerprint=v_job.confirmed_fingerprint) then raise exception 'IDENTITY_CHANGED'; end if;
  if not private.my_stuff_research_policy_is_current_v1(p_job_id) then raise exception 'POLICY_SUPERSEDED'; end if;
  if exists(select 1 from private.my_stuff_research_approvals where job_id=p_job_id) then raise exception 'RESEARCH_ALREADY_APPROVED'; end if;
  if v_job.status<>'awaiting_review' then raise exception 'Research job is not awaiting review'; end if;
  select count(*) into v_selected_count from private.my_stuff_research_candidates c where c.job_id=p_job_id and c.id=any(p_candidate_ids);
  if v_selected_count<>cardinality(p_candidate_ids) then raise exception 'Invalid candidate selection'; end if;
  if exists(
    select 1 from private.my_stuff_research_candidates c
    cross join lateral jsonb_array_elements_text(c.candidate->'evidenceIds') selected_evidence(evidence_key)
    left join private.my_stuff_research_evidence e on e.job_id=p_job_id and e.evidence_key=selected_evidence.evidence_key
    where c.job_id=p_job_id and c.id=any(p_candidate_ids)
      and (e.id is null or e.verification_status<>'provider_citation_unconfirmed')
  ) then raise exception 'INVALID_EVIDENCE'; end if;
  v_snapshot:=jsonb_build_object('schema_version',2,'job_id',p_job_id,'item_id',v_job.item_id,'confirmed_fingerprint',v_job.confirmed_fingerprint,'policy_version',v_job.policy_version,'sources_verified',true,
    'evidence',coalesce((select jsonb_agg(to_jsonb(e) order by e.evidence_key) from private.my_stuff_research_evidence e where e.job_id=p_job_id and e.evidence_key in (select jsonb_array_elements_text(c.candidate->'evidenceIds') from private.my_stuff_research_candidates c where c.job_id=p_job_id and c.id=any(p_candidate_ids))),'[]'::jsonb),
    'candidates',coalesce((select jsonb_agg(jsonb_build_object('candidate_id',c.id)||c.candidate order by c.id) from private.my_stuff_research_candidates c where c.job_id=p_job_id and c.id=any(p_candidate_ids)),'[]'::jsonb));
  v_hash:=encode(digest(v_snapshot::text,'sha256'),'hex');
  insert into private.my_stuff_research_approvals(job_id,user_id,item_id,snapshot,snapshot_hash,client_mutation_id,request_hash)
    values(p_job_id,v_user,v_job.item_id,v_snapshot,v_hash,trim(p_mutation_id),v_request_hash) returning id into v_id;
  update private.my_stuff_research_jobs set status='approved',state_version=state_version+1,updated_at=now() where id=p_job_id;
  return v_id;
end $$;

create or replace function public.approve_my_stuff_research_v1(p_job_id uuid,p_candidate_ids uuid[],p_mutation_id text)
returns uuid language plpgsql security definer set search_path=public,private as $$
declare v_user uuid:=auth.uid();
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if exists(select 1 from public.account_deletion_tombstones where user_id=v_user) then raise exception 'ACCOUNT_DELETION_PENDING'; end if;
  if not public.user_has_verified_pro_entitlement(v_user) then raise exception 'PRO_REQUIRED'; end if;
  perform private.assert_my_stuff_research_user_v1(v_user);
  if not exists(select 1 from private.my_stuff_research_jobs where id=p_job_id and user_id=v_user) then raise exception 'Research job not found'; end if;
  raise exception 'UNCONFIRMED_EVIDENCE_REQUIRES_V2_APPROVAL';
end $$;

create or replace function public.lease_my_stuff_research_worker_v2(p_worker text)
returns jsonb language plpgsql security definer set search_path=private as $$
declare v_job private.my_stuff_research_jobs%rowtype; v_cfg private.my_stuff_research_runtime_config%rowtype; v_domains jsonb;
begin
  select * into v_cfg from private.my_stuff_research_runtime_config where singleton;
  v_job:=private.lease_my_stuff_research_job_v4(p_worker,v_cfg.lease_seconds);
  if v_job.id is null then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('domain',d.domain,'source_class',d.source_class,'include_subdomains',d.include_subdomains,'allowed_path_prefixes',d.allowed_path_prefixes,'manufacturer',d.manufacturer,'terms_reviewed_on',d.terms_reviewed_on,'robots_reviewed_on',d.robots_reviewed_on) order by d.domain),'[]'::jsonb)
    into v_domains from private.my_stuff_research_source_domains d
    where d.enabled and d.terms_reviewed_on between current_date-365 and current_date and d.robots_reviewed_on between current_date-30 and current_date
      and exists(select 1 from unnest(d.manufacturer_aliases) alias(make_name) where lower(trim(alias.make_name))=lower(v_job.request_snapshot->>'make'));
  return jsonb_build_object('lease',to_jsonb(v_job),'config',jsonb_build_object('provider_name',v_cfg.provider_name,'provider_model',v_cfg.provider_model,'retention_policy',v_cfg.retention_policy,'policy_version',v_cfg.policy_version,'max_searches',v_cfg.max_searches,'max_fetches',v_cfg.max_fetches,'provider_timeout_seconds',v_cfg.provider_timeout_seconds),'domains',v_domains);
end $$;
create or replace function public.settle_my_stuff_research_worker_v2(p_job_id uuid,p_lease_token text,p_cost_ticks bigint,p_evidence jsonb,p_candidates jsonb,p_unresolved jsonb)
returns uuid language sql security definer set search_path=private as $$
  select private.settle_my_stuff_research_job_v4(p_job_id,p_lease_token,p_cost_ticks,p_evidence,p_candidates,p_unresolved)
$$;
create or replace function public.fail_my_stuff_research_worker_v2(p_job_id uuid,p_lease_token uuid,p_cost_ticks bigint,p_error_code text,p_error_detail text)
returns boolean language sql security definer set search_path=private as $$
  select private.fail_my_stuff_research_job_v2(p_job_id,p_lease_token,p_cost_ticks,p_error_code,p_error_detail)
$$;

create or replace function private.activate_my_stuff_research_v1()
returns void language plpgsql security definer set search_path=private,vault,cron as $$
declare enabled_source_domains integer; v_secret_count integer;
begin
  if session_user not in ('postgres','supabase_admin') then raise exception 'Owner session required'; end if;
  select count(*) into enabled_source_domains from private.my_stuff_research_source_domains where enabled and terms_reviewed_on between current_date-365 and current_date and robots_reviewed_on between current_date-30 and current_date;
  select count(*) into v_secret_count from vault.decrypted_secrets where name in ('maintenance_research_worker_url','maintenance_research_worker_secret') and nullif(decrypted_secret,'') is not null;
  if enabled_source_domains<1 or v_secret_count<>2 or exists(
    select 1 from private.my_stuff_research_source_domains
    where enabled and (
      include_subdomains is not true or allowed_path_prefixes<>array['/']::text[]
      or cardinality(manufacturer_aliases)<1 or cardinality(manufacturer_aliases)>50
      or exists(select 1 from unnest(manufacturer_aliases) alias(make_name) where nullif(trim(alias.make_name),'') is null or length(alias.make_name)>80)
    )
  ) then raise exception 'Research source policy or Vault configuration is incomplete'; end if;
  if not exists(select 1 from private.my_stuff_research_runtime_config where singleton and enabled=false and provider_name='xai' and provider_model='grok-4.6' and retention_policy='standard-30-days-store-false' and per_job_budget_cents=2500 and monthly_user_budget_cents=2500 and global_monthly_budget_cents=2500 and max_attempts * 1250=per_job_budget_cents) then raise exception 'Research provider configuration is incomplete'; end if;
  update private.my_stuff_research_runtime_config set enabled=true,updated_at=now() where singleton;
  perform cron.schedule('sideflip-maintenance-research-worker','*/5 * * * *','select private.invoke_my_stuff_research_worker_v1()');
end $$;

revoke execute on function public.approve_my_stuff_research_v2(uuid,uuid[],boolean,text) from public,anon;
grant execute on function public.approve_my_stuff_research_v2(uuid,uuid[],boolean,text) to authenticated;
revoke execute on function public.approve_my_stuff_research_v1(uuid,uuid[],text) from public,anon;
grant execute on function public.approve_my_stuff_research_v1(uuid,uuid[],text) to authenticated;
revoke execute on function public.lease_my_stuff_research_worker_v1(text) from service_role;
revoke execute on function public.settle_my_stuff_research_worker_v1(uuid,text,integer,jsonb,jsonb,jsonb) from service_role;
revoke execute on function public.fail_my_stuff_research_worker_v1(uuid,uuid,text,text) from service_role;
revoke execute on function public.lease_my_stuff_research_worker_v2(text) from public,anon,authenticated;
grant execute on function public.lease_my_stuff_research_worker_v2(text) to service_role;
revoke execute on function public.settle_my_stuff_research_worker_v2(uuid,text,bigint,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.settle_my_stuff_research_worker_v2(uuid,text,bigint,jsonb,jsonb,jsonb) to service_role;
revoke execute on function public.fail_my_stuff_research_worker_v2(uuid,uuid,bigint,text,text) from public,anon,authenticated;
grant execute on function public.fail_my_stuff_research_worker_v2(uuid,uuid,bigint,text,text) to service_role;
revoke execute on function private.activate_my_stuff_research_v1() from public,anon,authenticated;
grant execute on function private.activate_my_stuff_research_v1() to service_role;

commit;
