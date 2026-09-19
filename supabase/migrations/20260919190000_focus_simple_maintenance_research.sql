-- Keep V1 manufacturer research focused on confirmed VIN facts and one source-policy matcher.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

create or replace function private.my_stuff_research_source_matches_make_v1(p_domain text,p_make text)
returns boolean language sql stable security definer set search_path=private as $$
  select exists(
    select 1
    from private.my_stuff_research_source_domains d
    where d.domain=p_domain
      and d.enabled
      and d.terms_reviewed_on between current_date-365 and current_date
      and d.robots_reviewed_on between current_date-30 and current_date
      and exists(
        select 1 from unnest(d.manufacturer_aliases) alias(make_name)
        where lower(trim(alias.make_name))=lower(trim(p_make))
      )
  )
$$;
revoke execute on function private.my_stuff_research_source_matches_make_v1(text,text) from public,anon,authenticated,service_role;

create or replace function private.my_stuff_research_policy_is_current_v1(p_job_id uuid)
returns boolean language sql stable security definer set search_path=public,private as $$
  select coalesce((
    select c.enabled and j.policy_version=c.policy_version and not exists(
      select 1 from private.my_stuff_research_evidence e
      where e.job_id=j.id and not exists(
        select 1 from private.my_stuff_research_source_domains d
        where d.domain=e.source_domain
          and d.source_class=e.source_class
          and private.my_stuff_research_source_matches_make_v1(d.domain,j.request_snapshot->>'make')
          and e.accessed_on between current_date-30 and current_date
          and e.accessed_at between now()-interval '30 days' and now()
          and e.accessed_on=(e.accessed_at at time zone 'UTC')::date
          and substring(e.canonical_url from '^https://([^/?#:]+)(?:/|$)') is not null
          and substring(e.canonical_url from '^https://([^/?#:]+)(?:/|$)') = lower(substring(e.canonical_url from '^https://([^/?#:]+)(?:/|$)'))
          and (substring(e.canonical_url from '^https://([^/?#:]+)(?:/|$)')=d.domain
            or (d.include_subdomains and substring(e.canonical_url from '^https://([^/?#:]+)(?:/|$)') like '%.'||d.domain))
          and e.canonical_url ~ '^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:/[^?#]*)?(?:\?[^#]*)?$'
          and e.canonical_url !~* '%(2f|5c|2e)'
          and exists(select 1 from unnest(d.allowed_path_prefixes) prefix
            where prefix='/' or coalesce(substring(e.canonical_url from '^https://[^/?#:]+(/[^?#]*)'),'/')=prefix
              or (left(coalesce(substring(e.canonical_url from '^https://[^/?#:]+(/[^?#]*)'),'/'),length(prefix))=prefix
                and (right(prefix,1)='/' or substring(coalesce(substring(e.canonical_url from '^https://[^/?#:]+(/[^?#]*)'),'/') from length(prefix)+1 for 1)='/')))
      )
    )
    from private.my_stuff_research_jobs j cross join private.my_stuff_research_runtime_config c
    where j.id=p_job_id and c.singleton
  ),false)
$$;
revoke execute on function private.my_stuff_research_policy_is_current_v1(uuid) from public,anon,authenticated;
grant execute on function private.my_stuff_research_policy_is_current_v1(uuid) to service_role;

create or replace function public.enqueue_my_stuff_research_v3(p_item_id uuid,p_confirmed_fingerprint text,p_mutation_id text)
returns uuid language plpgsql security definer set search_path=public,private,pgmq,extensions as $$
declare
  v_user uuid:=auth.uid(); v_item public.my_stuff_items%rowtype; v_cfg private.my_stuff_research_runtime_config%rowtype;
  v_existing private.my_stuff_research_jobs%rowtype; v_job uuid; v_msg bigint; v_snapshot jsonb; v_hash text;
  v_day_count integer; v_month_count integer; v_month_spend bigint; v_global_month_spend bigint;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if exists(select 1 from public.account_deletion_tombstones where user_id=v_user) then raise exception 'ACCOUNT_DELETION_PENDING'; end if;
  if not public.user_has_verified_pro_entitlement(v_user) then raise exception 'PRO_REQUIRED'; end if;
  perform private.assert_my_stuff_research_user_v1(v_user);
  if nullif(trim(coalesce(p_mutation_id,'')),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required'; end if;
  select * into v_cfg from private.my_stuff_research_runtime_config where singleton for update;
  if not found or not v_cfg.enabled then raise exception 'RESEARCH_DISABLED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('research-user:'||v_user::text,0));
  perform pg_advisory_xact_lock(hashtextextended('research-global-budget:'||date_trunc('month',current_date)::date::text,0));
  select * into v_item from public.my_stuff_items where id=p_item_id and user_id=v_user for update;
  if not found then raise exception 'My Stuff item not found'; end if;
  if v_item.vin_confirmation_fingerprint is null or v_item.vin_confirmation_fingerprint is distinct from p_confirmed_fingerprint then raise exception 'IDENTITY_UNCONFIRMED'; end if;
  if v_item.model_year is null or nullif(trim(coalesce(v_item.make,v_item.manufacturer,'')),'') is null
    or nullif(trim(coalesce(v_item.model,'')),'') is null
    or coalesce(nullif(trim(coalesce(v_item.engine,'')),''),case when v_item.engine_displacement_liters is not null then v_item.engine_displacement_liters::text||'L' end,nullif(trim(coalesce(v_item.engine_model,'')),'')) is null
    then raise exception 'IDENTITY_INCOMPLETE'; end if;
  if not exists(
    select 1 from private.my_stuff_research_source_domains d
    where private.my_stuff_research_source_matches_make_v1(d.domain,coalesce(v_item.make,v_item.manufacturer))
  ) then raise exception 'RESEARCH_DISABLED'; end if;
  select * into v_existing from private.my_stuff_research_jobs where user_id=v_user and client_mutation_id=trim(p_mutation_id);
  if found then
    if v_existing.item_id<>p_item_id or v_existing.confirmed_fingerprint<>p_confirmed_fingerprint then raise exception 'Idempotency key reused with different request'; end if;
    return v_existing.id;
  end if;
  select count(*) into v_day_count from private.my_stuff_research_jobs where user_id=v_user and created_at>=date_trunc('day',now());
  select count(*) into v_month_count from private.my_stuff_research_jobs where user_id=v_user and created_at>=date_trunc('month',now());
  if v_day_count>=v_cfg.daily_user_job_cap or v_month_count>=v_cfg.monthly_user_job_cap then raise exception 'RESEARCH_RATE_LIMITED'; end if;
  select coalesce(sum(case when kind='reservation' then cents when kind='release' then -cents else 0 end),0) into v_month_spend
    from private.my_stuff_research_budget_ledger where user_id=v_user and month_start=date_trunc('month',current_date)::date;
  if v_month_spend+v_cfg.per_job_budget_cents>v_cfg.monthly_user_budget_cents then raise exception 'RESEARCH_BUDGET_EXHAUSTED'; end if;
  select coalesce(sum(case when kind='reservation' then cents when kind='release' then -cents else 0 end),0) into v_global_month_spend
    from private.my_stuff_research_budget_ledger where month_start=date_trunc('month',current_date)::date;
  if v_global_month_spend+v_cfg.per_job_budget_cents>v_cfg.global_monthly_budget_cents then raise exception 'RESEARCH_GLOBAL_BUDGET_EXHAUSTED'; end if;
  v_snapshot:=jsonb_strip_nulls(jsonb_build_object(
    'modelYear',v_item.model_year,
    'make',coalesce(v_item.make,v_item.manufacturer),
    'model',v_item.model,
    'engine',coalesce(nullif(trim(coalesce(v_item.engine,'')),''),case when v_item.engine_displacement_liters is not null then v_item.engine_displacement_liters::text||'L' end,nullif(trim(coalesce(v_item.engine_model,'')),'')),
    'transmission',nullif(trim(coalesce(v_item.transmission,'')),'')));
  v_hash:=encode(digest(jsonb_build_object('item',p_item_id,'fingerprint',p_confirmed_fingerprint,'policy',v_cfg.policy_version)::text,'sha256'),'hex');
  insert into private.my_stuff_research_jobs(user_id,item_id,confirmed_fingerprint,status,request_snapshot,reserved_cents,client_mutation_id,request_hash,policy_version)
    values(v_user,p_item_id,p_confirmed_fingerprint,'queued',v_snapshot,v_cfg.per_job_budget_cents,trim(p_mutation_id),v_hash,v_cfg.policy_version)
    returning id into v_job;
  insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents)
    values(v_job,v_user,date_trunc('month',current_date)::date,'reservation',v_cfg.per_job_budget_cents);
  select pgmq.send('my_stuff_research_v1',jsonb_build_object('job_id',v_job,'schema_version',1)) into v_msg;
  update private.my_stuff_research_jobs set queue_msg_id=v_msg where id=v_job;
  return v_job;
exception when unique_violation then
  select id into v_job from private.my_stuff_research_jobs where user_id=v_user and client_mutation_id=trim(p_mutation_id);
  if v_job is not null then return v_job; end if;
  raise exception 'RESEARCH_ALREADY_ACTIVE';
end $$;
revoke execute on function public.enqueue_my_stuff_research_v3(uuid,text,text) from public,anon;
grant execute on function public.enqueue_my_stuff_research_v3(uuid,text,text) to authenticated;

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
    if exists(select 1 from jsonb_object_keys(v_e) key where key not in ('id','title','canonicalUrl','exactExcerpt','accessedAt','applicability','sourceClass','page','section','locationVerified','verificationStatus','sourceDomain'))
      or nullif(v_e->>'id','') is null or length(v_e->>'id')>100
      or nullif(v_e->>'title','') is null or length(v_e->>'title')>500
      or nullif(v_e->>'canonicalUrl','') is null or length(v_e->>'canonicalUrl')>2048
      or nullif(v_e->>'exactExcerpt','') is null or length(v_e->>'exactExcerpt')>4000
      or nullif(v_e->>'applicability','') is null or length(v_e->>'applicability')>1000
      or v_e->>'sourceClass' not in ('manufacturer','authorized_dealer')
      or (v_e->>'sourceDomain')<>all(enabled_source_domains)
      or coalesce((v_e->>'locationVerified')::boolean,true) is not false
      or v_e->>'verificationStatus'<>'provider_citation_unconfirmed'
      or (nullif(v_e->>'page','') is null and nullif(v_e->>'section','') is null)
      then raise exception 'INVALID_EVIDENCE'; end if;
    insert into private.my_stuff_research_evidence(job_id,evidence_key,title,canonical_url,exact_excerpt,page,section,accessed_on,accessed_at,applicability,source_class,source_domain,location_verified,verification_status,content_hash)
      values(p_job_id,v_e->>'id',v_e->>'title',v_e->>'canonicalUrl',v_e->>'exactExcerpt',nullif(v_e->>'page',''),nullif(v_e->>'section',''),(v_e->>'accessedAt')::timestamptz::date,(v_e->>'accessedAt')::timestamptz,v_e->>'applicability',v_e->>'sourceClass',v_e->>'sourceDomain',false,'provider_citation_unconfirmed',encode(digest(v_e::text,'sha256'),'hex'));
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

commit;
