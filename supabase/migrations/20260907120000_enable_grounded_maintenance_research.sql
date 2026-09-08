-- Grounded manufacturer-maintenance research foundation.
-- Additive and fail-closed: activation requires an owner session, Vault secrets,
-- reviewed source domains, and explicit runtime configuration.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '90s';

create extension if not exists pgcrypto;
create extension if not exists pgmq;
create extension if not exists pg_cron;
create extension if not exists pg_net;
create schema if not exists private;

select pgmq.create('my_stuff_research_v1');

create table private.my_stuff_research_runtime_config (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  provider_name text,
  provider_model text,
  retention_policy text,
  policy_version text not null default 'research-v1',
  max_searches integer not null default 3 check (max_searches between 1 and 3),
  max_fetches integer not null default 2 check (max_fetches between 1 and 2),
  max_attempts integer not null default 2 check (max_attempts between 1 and 2),
  daily_user_job_cap integer not null default 2 check (daily_user_job_cap between 1 and 2),
  monthly_user_job_cap integer not null default 10 check (monthly_user_job_cap between 1 and 10),
  -- Sonnet 4.5 worst case per attempt: two 200k-token inputs ($1.20),
  -- 20k output tokens ($0.30), and three web searches ($0.03) = $1.53.
  -- Reserve every configured attempt before enqueueing.
  per_job_budget_cents integer not null default 306 check (per_job_budget_cents between 1 and 100000),
  monthly_user_budget_cents integer not null default 500 check (monthly_user_budget_cents >= per_job_budget_cents),
  global_monthly_budget_cents integer not null default 2500 check (global_monthly_budget_cents between 1 and 2500 and global_monthly_budget_cents >= per_job_budget_cents),
  provider_timeout_seconds integer not null default 120 check (provider_timeout_seconds between 10 and 140),
  lease_seconds integer not null default 300 check (lease_seconds >= (2 * provider_timeout_seconds) + 30 and lease_seconds <= 600),
  updated_at timestamptz not null default now(),
  check (per_job_budget_cents >= max_attempts * 153),
  check (not enabled or (provider_name='anthropic' and provider_model='claude-sonnet-4-5-20250929' and retention_policy is not null))
);
insert into private.my_stuff_research_runtime_config(singleton) values(true) on conflict(singleton) do nothing;

create table private.my_stuff_research_source_domains (
  id bigint generated always as identity primary key,
  domain text not null unique,
  source_class text not null check (source_class in ('manufacturer','authorized_dealer')),
  include_subdomains boolean not null default false,
  enabled boolean not null default false,
  manufacturer text not null,
  allowed_path_prefixes text[] not null default array['/']::text[],
  terms_reviewed_on date not null,
  robots_reviewed_on date not null,
  licensing_disposition text not null,
  reviewed_by text not null,
  created_at timestamptz not null default now(),
  check (domain = lower(domain) and domain ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'),
  check (cardinality(allowed_path_prefixes) between 1 and 20),
  check (length(array_to_string(allowed_path_prefixes,E'\n'))<=10000 and array_to_string(allowed_path_prefixes,E'\n') ~ '^(?:/[^\n]*)(?:\n/[^\n]*)*$' and array_to_string(allowed_path_prefixes,E'\n') !~ '[\\?#]' and array_to_string(allowed_path_prefixes,E'\n') !~* '%(2f|5c|2e)'),
  check (length(trim(manufacturer)) between 1 and 200 and length(trim(licensing_disposition)) between 1 and 1000 and length(trim(reviewed_by)) between 1 and 200)
);

alter table private.my_stuff_research_jobs
  add column if not exists schema_version integer not null default 1,
  add column if not exists state_version bigint not null default 0,
  add column if not exists lease_token uuid,
  add column if not exists queue_msg_id bigint,
  add column if not exists not_before timestamptz not null default now(),
  add column if not exists reservation_month date not null default date_trunc('month',current_date)::date,
  add column if not exists actual_cents integer,
  add column if not exists policy_version text,
  add column if not exists cancellation_requested_at timestamptz,
  add column if not exists cancellation_mutation_id text,
  add column if not exists cancellation_request_hash text,
  add column if not exists last_error_code text,
  add column if not exists unresolved jsonb not null default '[]'::jsonb;
alter table private.my_stuff_research_jobs
  add constraint my_stuff_research_jobs_unresolved_check
  check(jsonb_typeof(unresolved)='array' and jsonb_array_length(unresolved)<=50);

-- Provider spend must survive account/item deletion so the global kill switch
-- cannot be reset by deleting an account. Remove identifying links at deletion.
do $$ declare c record; begin
  for c in select conname from pg_constraint
    where conrelid='private.my_stuff_research_budget_ledger'::regclass
      and contype='f'
      and confrelid in ('private.my_stuff_research_jobs'::regclass,'auth.users'::regclass)
  loop execute format('alter table private.my_stuff_research_budget_ledger drop constraint %I',c.conname); end loop;
end $$;
alter table private.my_stuff_research_budget_ledger
  alter column job_id drop not null,
  alter column user_id drop not null;
alter table private.my_stuff_research_budget_ledger
  drop constraint if exists my_stuff_research_budget_ledger_job_id_kind_key;
alter table private.my_stuff_research_budget_ledger
  add column if not exists attempt_number integer not null default 0;
create unique index my_stuff_research_budget_job_kind_attempt_uq
  on private.my_stuff_research_budget_ledger(job_id,kind,attempt_number) where job_id is not null;
create or replace function private.preserve_my_stuff_research_budget_on_job_delete()
returns trigger language plpgsql security definer set search_path=private as $$
begin
  update private.my_stuff_research_budget_ledger set user_id=null,job_id=null where job_id=old.id;
  return old;
end $$;
create trigger preserve_my_stuff_research_budget_on_job_delete
before delete on private.my_stuff_research_jobs for each row execute function private.preserve_my_stuff_research_budget_on_job_delete();

create unique index my_stuff_research_one_active_user_uq
on private.my_stuff_research_jobs(user_id)
where status in ('queued','running','awaiting_review','approved');
create index my_stuff_research_lease_idx on private.my_stuff_research_jobs(status,not_before,lease_expires_at);

alter table private.my_stuff_research_evidence
  add column if not exists accessed_at timestamptz,
  add column if not exists source_domain text,
  add column if not exists location_verified boolean not null default false;
alter table private.my_stuff_research_evidence
  drop constraint if exists my_stuff_research_evidence_source_class_check;
alter table private.my_stuff_research_evidence
  add constraint my_stuff_research_evidence_source_class_check
  check(source_class in ('manufacturer','authorized_dealer'));
alter table private.my_stuff_research_evidence
  add constraint my_stuff_research_evidence_access_time_check
  check(accessed_at is not null and accessed_on=(accessed_at at time zone 'UTC')::date and accessed_at<=now() and accessed_at>=now()-interval '30 days');

-- item_type is part of identity without changing the public confirmation RPC.
create or replace function private.my_stuff_vehicle_identity_fingerprint_v3(p_item public.my_stuff_items) returns text
language sql immutable set search_path=public,private,extensions as $$
 select encode(digest(jsonb_strip_nulls(jsonb_build_object(
   'item_type',p_item.item_type,
   'vin_sha256',case when nullif(upper(regexp_replace(coalesce(p_item.vin,''),'[^A-Z0-9]','','g')),'') is null then null
     else encode(digest(upper(regexp_replace(p_item.vin,'[^A-Z0-9]','','g')),'sha256'),'hex') end,
   'model_year',p_item.model_year,'manufacturer',p_item.manufacturer,'make',p_item.make,'model',p_item.model,'trim',p_item.trim,
   'engine',p_item.engine,'engine_model',p_item.engine_model,'engine_displacement_liters',p_item.engine_displacement_liters,
   'engine_cylinders',p_item.engine_cylinders,'transmission',p_item.transmission,'drivetrain',p_item.drivetrain,
   'fuel_power_type',p_item.fuel_power_type,'vehicle_type',p_item.vehicle_type,'body_style',p_item.body_style,
   'plant_name',p_item.plant_name,'plant_country',p_item.plant_country,'vehicle_market',p_item.vehicle_market
 ))::text,'sha256'),'hex')
$$;

create or replace function public.invalidate_my_stuff_vehicle_confirmation_v3() returns trigger language plpgsql set search_path=public,extensions as $$
begin
 if row(new.item_type,new.vin,new.model_year,new.manufacturer,new.make,new.model,new.trim,new.engine,new.engine_model,new.engine_displacement_liters,new.engine_cylinders,
   new.transmission,new.drivetrain,new.fuel_power_type,new.vehicle_type,new.body_style,new.plant_name,new.plant_country,new.vehicle_market) is distinct from
    row(old.item_type,old.vin,old.model_year,old.manufacturer,old.make,old.model,old.trim,old.engine,old.engine_model,old.engine_displacement_liters,old.engine_cylinders,
   old.transmission,old.drivetrain,old.fuel_power_type,old.vehicle_type,old.body_style,old.plant_name,old.plant_country,old.vehicle_market) then
   new.vin_confirmed_at:=null; new.vin_confirmation_fingerprint:=null;
 end if;
 return new;
end $$;

alter table private.my_stuff_research_approvals
  add column if not exists item_id uuid,
  add column if not exists approved_at timestamptz not null default now(),
  add column if not exists request_hash text;
create unique index my_stuff_research_one_approval_per_job_uq on private.my_stuff_research_approvals(job_id);

create table private.my_stuff_research_definition_evidence (
  definition_id uuid not null references public.my_stuff_maintenance_definitions(id) on delete cascade,
  evidence_id uuid not null references private.my_stuff_research_evidence(id) on delete restrict,
  approval_id uuid not null references private.my_stuff_research_approvals(id) on delete restrict,
  due_semantics text not null check(due_semantics in ('whichever_first','all')),
  profile text not null check(profile in ('normal','severe')),
  created_at timestamptz not null default now(),
  primary key(definition_id,evidence_id)
);

-- All research internals remain inaccessible to browser roles.
do $$ declare r text; begin
  foreach r in array array[
    'my_stuff_research_runtime_config','my_stuff_research_source_domains','my_stuff_research_jobs',
    'my_stuff_research_attempts','my_stuff_research_evidence','my_stuff_research_candidates',
    'my_stuff_research_approvals','my_stuff_research_apply_records','my_stuff_research_budget_ledger',
    'my_stuff_research_dead_letters','my_stuff_research_definition_evidence'
  ] loop
    execute format('alter table private.%I enable row level security',r);
    execute format('revoke all on table private.%I from public,anon,authenticated',r);
    execute format('grant select,insert,update,delete on table private.%I to service_role',r);
  end loop;
end $$;
revoke all on all sequences in schema private from public,anon,authenticated;
grant usage,select on all sequences in schema private to service_role;

create or replace function private.assert_my_stuff_research_user_v1(p_user_id uuid)
returns void language plpgsql stable security definer set search_path=public,private as $$
begin
  if p_user_id is null then raise exception 'Authentication required'; end if;
  if exists(select 1 from public.account_deletion_tombstones where user_id=p_user_id) then raise exception 'ACCOUNT_DELETION_PENDING'; end if;
  if not public.user_has_verified_pro_entitlement(p_user_id) then raise exception 'PRO_REQUIRED'; end if;
end $$;

create or replace function private.my_stuff_research_policy_is_current_v1(p_job_id uuid)
returns boolean language sql stable security definer set search_path=public,private as $$
  select coalesce((
    select c.enabled and j.policy_version=c.policy_version and not exists(
      select 1 from private.my_stuff_research_evidence e
      where e.job_id=j.id and not exists(
        select 1 from private.my_stuff_research_source_domains d
        where d.enabled
          and d.domain=e.source_domain
          and d.source_class=e.source_class
          and lower(d.manufacturer)=lower(j.request_snapshot->>'make')
          and d.terms_reviewed_on between current_date-365 and current_date
          and d.robots_reviewed_on between current_date-30 and current_date
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
  -- Serialize all reservations for the configured global Anthropic ceiling.
  perform pg_advisory_xact_lock(hashtextextended('research-global-budget:'||date_trunc('month',current_date)::date::text,0));
  select * into v_item from public.my_stuff_items where id=p_item_id and user_id=v_user for update;
  if not found then raise exception 'My Stuff item not found'; end if;
  if v_item.vin_confirmation_fingerprint is null or v_item.vin_confirmation_fingerprint is distinct from p_confirmed_fingerprint then raise exception 'IDENTITY_UNCONFIRMED'; end if;
  if not exists(select 1 from private.my_stuff_research_source_domains where enabled and terms_reviewed_on between current_date-365 and current_date and robots_reviewed_on between current_date-30 and current_date and lower(manufacturer)=lower(coalesce(v_item.make,v_item.manufacturer))) then raise exception 'RESEARCH_DISABLED'; end if;
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
    'modelYear',v_item.model_year,'make',coalesce(v_item.make,v_item.manufacturer),'model',v_item.model,
    'trim',v_item.trim,'engine',coalesce(v_item.engine_model,v_item.engine),'transmission',v_item.transmission,
    'drivetrain',v_item.drivetrain,'fuel',v_item.fuel_power_type,'market',v_item.vehicle_market,'vehicleType',v_item.vehicle_type));
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

create or replace function public.get_my_stuff_research_status_v1(p_item_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,private as $$
declare v_user uuid:=auth.uid(); v_result jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if exists(select 1 from public.account_deletion_tombstones where user_id=v_user) then raise exception 'ACCOUNT_DELETION_PENDING'; end if;
  if not public.user_has_verified_pro_entitlement(v_user) then raise exception 'PRO_REQUIRED'; end if;
  perform private.assert_my_stuff_research_user_v1(v_user);
  select jsonb_build_object(
      'id',j.id,'item_id',j.item_id,'status',case when j.status in ('queued','running','awaiting_review','approved') and not private.my_stuff_research_policy_is_current_v1(j.id) then 'superseded' else j.status end,'attempt_count',j.attempt_count,
      'created_at',j.created_at,'updated_at',j.updated_at,'last_error_code',j.last_error_code,
      'approval_id',(select a.id from private.my_stuff_research_approvals a where a.job_id=j.id order by a.created_at desc,a.id desc limit 1)
    )
    into v_result
    from private.my_stuff_research_jobs j
    where j.item_id=p_item_id and j.user_id=v_user
    order by j.created_at desc,j.id desc limit 1;
  return v_result;
end $$;

create or replace function public.get_my_stuff_research_review_v1(p_job_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,private as $$
declare v_user uuid:=auth.uid(); v_result jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if exists(select 1 from public.account_deletion_tombstones where user_id=v_user) then raise exception 'ACCOUNT_DELETION_PENDING'; end if;
  if not public.user_has_verified_pro_entitlement(v_user) then raise exception 'PRO_REQUIRED'; end if;
  perform private.assert_my_stuff_research_user_v1(v_user);
  if not exists(select 1 from private.my_stuff_research_jobs where id=p_job_id and user_id=v_user and status in ('awaiting_review','approved','applied') and (status='applied' or private.my_stuff_research_policy_is_current_v1(id))) then raise exception 'Research review not found'; end if;
  select jsonb_build_object(
    'job_id',p_job_id,
    'approval_id',(select a.id from private.my_stuff_research_approvals a where a.job_id=p_job_id order by a.created_at desc,a.id desc limit 1),
    'unresolved',(select j.unresolved from private.my_stuff_research_jobs j where j.id=p_job_id),
    'evidence',coalesce((select jsonb_agg(to_jsonb(e) order by e.evidence_key) from private.my_stuff_research_evidence e where e.job_id=p_job_id),'[]'::jsonb),
    'candidates',coalesce((select jsonb_agg(jsonb_build_object('id',c.id)||c.candidate order by c.id) from private.my_stuff_research_candidates c where c.job_id=p_job_id),'[]'::jsonb)
  ) into v_result;
  return v_result;
end $$;

create or replace function public.approve_my_stuff_research_v1(p_job_id uuid,p_candidate_ids uuid[],p_mutation_id text)
returns uuid language plpgsql security definer set search_path=public,private,extensions as $$
declare v_user uuid:=auth.uid(); v_job private.my_stuff_research_jobs%rowtype; v_snapshot jsonb; v_hash text; v_request_hash text; v_id uuid; v_existing_job uuid; v_existing_request_hash text; v_selected_count integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if exists(select 1 from public.account_deletion_tombstones where user_id=v_user) then raise exception 'ACCOUNT_DELETION_PENDING'; end if;
  if not public.user_has_verified_pro_entitlement(v_user) then raise exception 'PRO_REQUIRED'; end if;
  perform private.assert_my_stuff_research_user_v1(v_user);
  if nullif(trim(coalesce(p_mutation_id,'')),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required'; end if;
  if p_candidate_ids is null or cardinality(p_candidate_ids)<1 or cardinality(p_candidate_ids)>100 then raise exception 'Candidate selection required'; end if;
  if cardinality(p_candidate_ids)<>(select count(distinct value) from unnest(p_candidate_ids) as selected(value)) then raise exception 'Duplicate candidate selection'; end if;
  perform pg_advisory_xact_lock(hashtextextended('research-job:'||p_job_id::text,0));
  select * into v_job from private.my_stuff_research_jobs where id=p_job_id and user_id=v_user for update;
  if not found then raise exception 'Research job not found'; end if;
  if not exists(select 1 from public.my_stuff_items where id=v_job.item_id and user_id=v_user and vin_confirmation_fingerprint=v_job.confirmed_fingerprint) then raise exception 'IDENTITY_CHANGED'; end if;
  v_request_hash:=encode(digest(jsonb_build_object('job_id',p_job_id,'candidate_ids',(select jsonb_agg(value order by value) from unnest(p_candidate_ids) selected(value)))::text,'sha256'),'hex');
  select id,job_id,request_hash into v_id,v_existing_job,v_existing_request_hash from private.my_stuff_research_approvals where user_id=v_user and client_mutation_id=trim(p_mutation_id);
  if v_id is not null then
    if v_existing_job<>p_job_id or v_existing_request_hash is distinct from v_request_hash then raise exception 'MUTATION_ID_REUSED'; end if;
    return v_id;
  end if;
  if not private.my_stuff_research_policy_is_current_v1(p_job_id) then raise exception 'POLICY_SUPERSEDED'; end if;
  if exists(select 1 from private.my_stuff_research_approvals where job_id=p_job_id) then raise exception 'RESEARCH_ALREADY_APPROVED'; end if;
  if v_job.status<>'awaiting_review' then raise exception 'Research job is not awaiting review'; end if;
  select count(*) into v_selected_count from private.my_stuff_research_candidates c where c.job_id=p_job_id and c.id=any(p_candidate_ids);
  if v_selected_count<>cardinality(p_candidate_ids) then raise exception 'Invalid candidate selection'; end if;
  v_snapshot:=jsonb_build_object('schema_version',1,'job_id',p_job_id,'item_id',v_job.item_id,'confirmed_fingerprint',v_job.confirmed_fingerprint,'policy_version',v_job.policy_version,
    'evidence',coalesce((select jsonb_agg(to_jsonb(e) order by e.evidence_key) from private.my_stuff_research_evidence e where e.job_id=p_job_id and e.evidence_key in (select jsonb_array_elements_text(c.candidate->'evidenceIds') from private.my_stuff_research_candidates c where c.job_id=p_job_id and c.id=any(p_candidate_ids))),'[]'::jsonb),
    'candidates',coalesce((select jsonb_agg(jsonb_build_object('candidate_id',c.id)||c.candidate order by c.id) from private.my_stuff_research_candidates c where c.job_id=p_job_id and c.id=any(p_candidate_ids)),'[]'::jsonb));
  v_hash:=encode(digest(v_snapshot::text,'sha256'),'hex');
  insert into private.my_stuff_research_approvals(job_id,user_id,item_id,snapshot,snapshot_hash,client_mutation_id,request_hash)
    values(p_job_id,v_user,v_job.item_id,v_snapshot,v_hash,trim(p_mutation_id),v_request_hash) returning id into v_id;
  update private.my_stuff_research_jobs set status='approved',state_version=state_version+1,updated_at=now() where id=p_job_id;
  return v_id;
end $$;

create or replace function public.apply_my_stuff_research_v1(p_approval_id uuid,p_mutation_id text)
returns uuid[] language plpgsql security definer set search_path=public,private,extensions as $$
declare v_user uuid:=auth.uid(); v_a private.my_stuff_research_approvals%rowtype; v_job private.my_stuff_research_jobs%rowtype;
  v_candidate jsonb; v_evidence jsonb; v_evidence_key text; v_definition jsonb; v_def uuid; v_version_hash text; v_ids uuid[]:=array[]::uuid[]; v_existing uuid[]; v_existing_mutation text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if exists(select 1 from public.account_deletion_tombstones where user_id=v_user) then raise exception 'ACCOUNT_DELETION_PENDING'; end if;
  if not public.user_has_verified_pro_entitlement(v_user) then raise exception 'PRO_REQUIRED'; end if;
  perform private.assert_my_stuff_research_user_v1(v_user);
  if nullif(trim(coalesce(p_mutation_id,'')),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('research-approval:'||p_approval_id::text,0));
  select * into v_a from private.my_stuff_research_approvals where id=p_approval_id and user_id=v_user;
  if not found then raise exception 'Research approval not found'; end if;
  select * into v_job from private.my_stuff_research_jobs where id=v_a.job_id and user_id=v_user for update;
  select definition_ids,client_mutation_id into v_existing,v_existing_mutation from private.my_stuff_research_apply_records where approval_id=p_approval_id;
  if v_existing is not null then
    if v_existing_mutation<>trim(p_mutation_id) then raise exception 'MUTATION_ID_REUSED'; end if;
    return v_existing;
  end if;
  if not exists(select 1 from public.my_stuff_items where id=v_a.item_id and user_id=v_user and vin_confirmation_fingerprint=v_job.confirmed_fingerprint) then raise exception 'IDENTITY_CHANGED'; end if;
  if v_job.status<>'approved' then raise exception 'Research job is not approved'; end if;
  if not private.my_stuff_research_policy_is_current_v1(v_a.job_id) then raise exception 'POLICY_SUPERSEDED'; end if;
  for v_candidate in select value from jsonb_array_elements(v_a.snapshot->'candidates') loop
    select value into v_evidence from jsonb_array_elements(v_a.snapshot->'evidence') where value->>'evidence_key'=v_candidate->'evidenceIds'->>0 limit 1;
    if v_evidence is null then raise exception 'Approved candidate has no sealed evidence'; end if;
    v_definition:=jsonb_strip_nulls(jsonb_build_object(
      'name',v_candidate->>'name','service_category','other','service_action',v_candidate->>'action','due_semantics',v_candidate->>'dueSemantics','active_profile',v_candidate->>'profile','cadence_anchor','last_completion',
      'normal_interval_miles',case when v_candidate->>'profile'='normal' then v_candidate->>'intervalMiles' end,'normal_interval_hours',case when v_candidate->>'profile'='normal' then v_candidate->>'intervalHours' end,'normal_interval_cycles',case when v_candidate->>'profile'='normal' then v_candidate->>'intervalCycles' end,'normal_calendar_months',case when v_candidate->>'profile'='normal' then v_candidate->>'intervalMonths' end,
      'severe_interval_miles',case when v_candidate->>'profile'='severe' then v_candidate->>'intervalMiles' end,'severe_interval_hours',case when v_candidate->>'profile'='severe' then v_candidate->>'intervalHours' end,'severe_interval_cycles',case when v_candidate->>'profile'='severe' then v_candidate->>'intervalCycles' end,'severe_calendar_months',case when v_candidate->>'profile'='severe' then v_candidate->>'intervalMonths' end,
      'provenance_type','ai_research','source_class',case when v_evidence->>'source_class'='authorized_dealer' then 'dealer' else 'manufacturer_guide' end,'citation_url',v_evidence->>'canonical_url','citation_title',v_evidence->>'title','citation_page',v_evidence->>'page','citation_section',v_evidence->>'section','citation_accessed_on',v_evidence->>'accessed_on','uncertain',(v_candidate->>'uncertainty')<>'low','uncertainty_reason',v_candidate->>'uncertainty','enabled',true));
    -- The trusted helper validates and inserts into public.my_stuff_maintenance_definitions.
    if nullif(v_candidate->>'candidate_id','') is null then raise exception 'Approved candidate identity missing'; end if;
    v_def:=private.create_my_stuff_maintenance_definition_v2_trusted(v_user,v_a.item_id,v_definition,'research:'||p_approval_id::text||':'||(v_candidate->>'candidate_id'));
    v_version_hash:=encode(digest(jsonb_build_object('approval_id',p_approval_id,'candidate_id',v_candidate->>'candidate_id','definition',v_definition)::text,'sha256'),'hex');
    insert into public.my_stuff_definition_versions(user_id,item_id,definition_id,version_number,definition,provenance_type,client_mutation_id,request_hash)
      values(v_user,v_a.item_id,v_def,1,v_definition,'ai_research','research-version:'||p_approval_id::text||':'||(v_candidate->>'candidate_id'),v_version_hash);
    perform public.materialize_my_stuff_next_occurrence_v3(v_def);
    for v_evidence_key in select value from jsonb_array_elements_text(v_candidate->'evidenceIds') loop
      insert into private.my_stuff_research_definition_evidence(definition_id,evidence_id,approval_id,due_semantics,profile)
        select v_def,e.id,p_approval_id,v_candidate->>'dueSemantics',v_candidate->>'profile'
        from private.my_stuff_research_evidence e where e.job_id=v_a.job_id and e.evidence_key=v_evidence_key;
      if not found then raise exception 'Approved candidate has missing sealed evidence'; end if;
    end loop;
    v_ids:=array_append(v_ids,v_def);
  end loop;
  insert into private.my_stuff_research_apply_records(approval_id,user_id,definition_ids,client_mutation_id)
    values(p_approval_id,v_user,v_ids,trim(p_mutation_id))
    on conflict(approval_id) do update set approval_id=excluded.approval_id returning definition_ids into v_ids;
  update private.my_stuff_research_jobs set status='applied',state_version=state_version+1,updated_at=now() where id=v_a.job_id and status='approved';
  return v_ids;
end $$;

create or replace function public.cancel_my_stuff_research_v1(p_job_id uuid,p_mutation_id text)
returns boolean language plpgsql security definer set search_path=public,private,pgmq,extensions as $$
declare v_user uuid:=auth.uid(); v_job private.my_stuff_research_jobs%rowtype; v_hash text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if exists(select 1 from public.account_deletion_tombstones where user_id=v_user) then raise exception 'ACCOUNT_DELETION_PENDING'; end if;
  if not public.user_has_verified_pro_entitlement(v_user) then raise exception 'PRO_REQUIRED'; end if;
  perform private.assert_my_stuff_research_user_v1(v_user);
  if nullif(trim(coalesce(p_mutation_id,'')),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required'; end if;
  v_hash:=encode(digest(jsonb_build_object('job_id',p_job_id)::text,'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended('research-job:'||p_job_id::text,0));
  select * into v_job from private.my_stuff_research_jobs where id=p_job_id and user_id=v_user for update;
  if not found then raise exception 'Research job not found'; end if;
  if v_job.cancellation_mutation_id is not null then
    if v_job.cancellation_mutation_id<>trim(p_mutation_id) or v_job.cancellation_request_hash<>v_hash then raise exception 'MUTATION_ID_REUSED'; end if;
    return true;
  end if;
  if v_job.status='applied' then raise exception 'Applied research cannot be cancelled'; end if;
  if v_job.status='queued' then
    if v_job.queue_msg_id is not null then perform pgmq.delete('my_stuff_research_v1',v_job.queue_msg_id); end if;
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents)
      values(v_job.id,v_user,v_job.reservation_month,'release',greatest(v_job.reserved_cents-coalesce(v_job.actual_cents,0),0))
      on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    update private.my_stuff_research_jobs set status='cancelled',cancellation_requested_at=now(),cancellation_mutation_id=trim(p_mutation_id),cancellation_request_hash=v_hash,state_version=state_version+1,updated_at=now() where id=p_job_id;
  elsif v_job.status='running' then
    update private.my_stuff_research_jobs set cancellation_requested_at=now(),cancellation_mutation_id=trim(p_mutation_id),cancellation_request_hash=v_hash,state_version=state_version+1,updated_at=now() where id=p_job_id;
  else
    update private.my_stuff_research_jobs set status='cancelled',cancellation_requested_at=now(),cancellation_mutation_id=trim(p_mutation_id),cancellation_request_hash=v_hash,state_version=state_version+1,updated_at=now() where id=p_job_id;
  end if;
  return true;
end $$;

create or replace function private.lease_my_stuff_research_job_v3(p_worker text,p_lease_seconds integer default 300)
returns private.my_stuff_research_jobs language plpgsql security definer set search_path=public,private,pgmq,extensions as $$
declare v_cfg private.my_stuff_research_runtime_config%rowtype; v_msg record; v_job_id uuid; v_job private.my_stuff_research_jobs%rowtype;
  v_attempt_charge integer; v_total integer;
begin
  select * into v_cfg from private.my_stuff_research_runtime_config where singleton;
  if not found or not v_cfg.enabled or p_lease_seconds<(2*v_cfg.provider_timeout_seconds)+30 or p_lease_seconds>v_cfg.lease_seconds then raise exception 'RESEARCH_DISABLED'; end if;
  if not exists(select 1 from private.my_stuff_research_source_domains where enabled and terms_reviewed_on between current_date-365 and current_date and robots_reviewed_on between current_date-30 and current_date) then raise exception 'RESEARCH_DISABLED'; end if;
  select * into v_msg from pgmq.read('my_stuff_research_v1',p_lease_seconds,1) limit 1;
  if not found then return null; end if;
  if jsonb_typeof(v_msg.message) is distinct from 'object'
     or jsonb_typeof(v_msg.message->'schema_version') is distinct from 'number'
     or v_msg.message->>'schema_version'<>'1'
     or coalesce(v_msg.message->>'job_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    perform pgmq.delete('my_stuff_research_v1',v_msg.msg_id);
    return null;
  end if;
  v_job_id:=(v_msg.message->>'job_id')::uuid;
  select * into v_job from private.my_stuff_research_jobs where id=v_job_id and ((status='queued' and not_before<=now()) or (status='running' and lease_expires_at<=now())) for update skip locked;
  if not found then
    -- A currently locked, delayed, or unexpired job still owns this message. Leave it
    -- invisible for this visibility window rather than destroying its only queue entry.
    select * into v_job from private.my_stuff_research_jobs where id=v_job_id;
    if not found or v_job.queue_msg_id is distinct from v_msg.msg_id or v_job.status not in ('queued','running') then
      perform pgmq.delete('my_stuff_research_v1',v_msg.msg_id);
    end if;
    return null;
  end if;
  if v_job.status='running' then
    v_attempt_charge:=least(153,greatest(v_job.reserved_cents-coalesce(v_job.actual_cents,0),0));
    v_total:=coalesce(v_job.actual_cents,0)+v_attempt_charge;
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number)
      values(v_job.id,v_job.user_id,v_job.reservation_month,'settlement',v_attempt_charge,v_job.attempt_count)
      on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    update private.my_stuff_research_attempts set status='failed',finished_at=now(),error_code='LEASE_EXPIRED',usage_cents=v_attempt_charge where job_id=v_job.id and attempt_number=v_job.attempt_count and status='running';
    update private.my_stuff_research_jobs set actual_cents=v_total where id=v_job.id;
    v_job.actual_cents:=v_total;
  end if;
  -- A calendar-month ceiling cannot safely lease old-cohort work or work whose
  -- maximum lease crosses midnight into a new billing month. End it before any
  -- new provider request; the user may explicitly enqueue again next month.
  if v_job.reservation_month<>date_trunc('month',current_date)::date
     or now()+make_interval(secs=>p_lease_seconds)>=date_trunc('month',now())+interval '1 month' then
    update private.my_stuff_research_jobs set status='cancelled',last_error_code='BUDGET_MONTH_ROLLOVER',lease_owner=null,lease_token=null,lease_expires_at=null,updated_at=now() where id=v_job.id;
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents)
      values(v_job.id,v_job.user_id,v_job.reservation_month,'release',greatest(v_job.reserved_cents-coalesce(v_job.actual_cents,0),0)) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    perform pgmq.delete('my_stuff_research_v1',v_msg.msg_id); return null;
  end if;
  if v_job.attempt_count>=v_cfg.max_attempts then
    insert into private.my_stuff_research_dead_letters(job_id,error_code,error_detail,payload_hash)
      values(v_job.id,'MAX_ATTEMPTS','MAX_ATTEMPTS',encode(digest(jsonb_build_object('job_id',v_job.id,'attempt',v_job.attempt_count)::text,'sha256'),'hex')) on conflict(job_id) do nothing;
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number)
      values(v_job.id,v_job.user_id,v_job.reservation_month,'release',v_job.reserved_cents-coalesce(v_job.actual_cents,0),0)
      on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    update private.my_stuff_research_jobs set status='failed',last_error_code='MAX_ATTEMPTS',lease_owner=null,lease_token=null,lease_expires_at=null,updated_at=now() where id=v_job.id;
    perform pgmq.delete('my_stuff_research_v1',v_msg.msg_id); return null;
  end if;
  if exists(select 1 from public.account_deletion_tombstones where user_id=v_job.user_id)
     or not public.user_has_verified_pro_entitlement(v_job.user_id) then
    update private.my_stuff_research_jobs set status='cancelled',last_error_code=case when exists(select 1 from public.account_deletion_tombstones where user_id=v_job.user_id) then 'ACCOUNT_DELETION_PENDING' else 'PRO_REQUIRED' end,updated_at=now() where id=v_job.id;
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents)
      values(v_job.id,v_job.user_id,v_job.reservation_month,'release',greatest(v_job.reserved_cents-coalesce(v_job.actual_cents,0),0)) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    perform pgmq.delete('my_stuff_research_v1',v_msg.msg_id); return null;
  end if;
  if not exists(select 1 from public.my_stuff_items where id=v_job.item_id and user_id=v_job.user_id and vin_confirmation_fingerprint=v_job.confirmed_fingerprint) then
    update private.my_stuff_research_jobs set status='cancelled',last_error_code='IDENTITY_CHANGED',updated_at=now() where id=v_job.id;
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents)
      values(v_job.id,v_job.user_id,v_job.reservation_month,'release',greatest(v_job.reserved_cents-coalesce(v_job.actual_cents,0),0)) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    perform pgmq.delete('my_stuff_research_v1',v_msg.msg_id); return null;
  end if;
  if not private.my_stuff_research_policy_is_current_v1(v_job.id) then
    update private.my_stuff_research_jobs set status='superseded',last_error_code='POLICY_SUPERSEDED',updated_at=now() where id=v_job.id;
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents)
      values(v_job.id,v_job.user_id,v_job.reservation_month,'release',greatest(v_job.reserved_cents-coalesce(v_job.actual_cents,0),0)) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    perform pgmq.delete('my_stuff_research_v1',v_msg.msg_id); return null;
  end if;
  if not exists(select 1 from private.my_stuff_research_source_domains where enabled and terms_reviewed_on between current_date-365 and current_date and robots_reviewed_on between current_date-30 and current_date and lower(manufacturer)=lower(v_job.request_snapshot->>'make')) then
    update private.my_stuff_research_jobs set status='cancelled',last_error_code='SOURCE_POLICY_UNAVAILABLE',updated_at=now() where id=v_job.id;
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents)
      values(v_job.id,v_job.user_id,v_job.reservation_month,'release',greatest(v_job.reserved_cents-coalesce(v_job.actual_cents,0),0)) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    perform pgmq.delete('my_stuff_research_v1',v_msg.msg_id); return null;
  end if;
  if not exists(select 1 from private.my_stuff_research_budget_ledger where job_id=v_job.id and user_id=v_job.user_id and month_start=v_job.reservation_month and kind='reservation' and cents=v_job.reserved_cents) then
    update private.my_stuff_research_jobs set status='failed',last_error_code='BUDGET_RESERVATION_MISSING',updated_at=now() where id=v_job.id;
    perform pgmq.delete('my_stuff_research_v1',v_msg.msg_id); return null;
  end if;
  if (select coalesce(sum(case when kind='reservation' then cents when kind='release' then -cents else 0 end),0) from private.my_stuff_research_budget_ledger where user_id=v_job.user_id and month_start=v_job.reservation_month)>v_cfg.monthly_user_budget_cents
     or (select coalesce(sum(case when kind='reservation' then cents when kind='release' then -cents else 0 end),0) from private.my_stuff_research_budget_ledger where month_start=v_job.reservation_month)>v_cfg.global_monthly_budget_cents then
    update private.my_stuff_research_jobs set status='cancelled',last_error_code='BUDGET_POLICY_CHANGED',updated_at=now() where id=v_job.id;
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents)
      values(v_job.id,v_job.user_id,v_job.reservation_month,'release',greatest(v_job.reserved_cents-coalesce(v_job.actual_cents,0),0)) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    perform pgmq.delete('my_stuff_research_v1',v_msg.msg_id); return null;
  end if;
  update private.my_stuff_research_jobs set status='running',lease_owner=left(p_worker,200),lease_token=gen_random_uuid(),lease_expires_at=now()+make_interval(secs=>p_lease_seconds),attempt_count=attempt_count+1,state_version=state_version+1,queue_msg_id=v_msg.msg_id,updated_at=now()
    where id=v_job.id returning * into v_job;
  insert into private.my_stuff_research_attempts(job_id,attempt_number,provider,model,retention_policy,status)
    values(v_job.id,v_job.attempt_count,v_cfg.provider_name,v_cfg.provider_model,v_cfg.retention_policy,'running') on conflict(job_id,attempt_number) do nothing;
  return v_job;
end $$;

create or replace function private.settle_my_stuff_research_job_v3(p_job_id uuid,p_worker text,p_cost_cents integer,p_evidence jsonb,p_candidates jsonb,p_unresolved jsonb)
returns uuid language plpgsql security definer set search_path=public,private,pgmq,extensions as $$
declare v_job private.my_stuff_research_jobs%rowtype; v_cfg private.my_stuff_research_runtime_config%rowtype; v_e jsonb; v_c jsonb;
  enabled_source_domains text[]; v_token uuid; v_total integer;
begin
  v_token:=p_worker::uuid;
  select * into v_cfg from private.my_stuff_research_runtime_config where singleton;
  if not v_cfg.enabled then raise exception 'RESEARCH_DISABLED'; end if;
  select * into v_job from private.my_stuff_research_jobs where id=p_job_id and status='running' and lease_token=v_token and lease_expires_at>now() for update;
  if not found then raise exception 'STALE_RESEARCH_LEASE'; end if;
  if not private.my_stuff_research_policy_is_current_v1(v_job.id) then raise exception 'POLICY_SUPERSEDED'; end if;
  select coalesce(array_agg(domain),array[]::text[]) into enabled_source_domains from private.my_stuff_research_source_domains where enabled and terms_reviewed_on between current_date-365 and current_date and robots_reviewed_on between current_date-30 and current_date and lower(manufacturer)=lower(v_job.request_snapshot->>'make');
  if cardinality(enabled_source_domains)=0 then raise exception 'RESEARCH_DISABLED'; end if;
  perform private.assert_my_stuff_research_user_v1(v_job.user_id);
  v_total:=coalesce(v_job.actual_cents,0)+p_cost_cents;
  if p_cost_cents<0 or v_total>v_job.reserved_cents then raise exception 'RESEARCH_BUDGET_EXCEEDED'; end if;
  if v_job.cancellation_requested_at is not null then
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values(p_job_id,v_job.user_id,v_job.reservation_month,'settlement',p_cost_cents,v_job.attempt_count) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values(p_job_id,v_job.user_id,v_job.reservation_month,'release',v_job.reserved_cents-v_total,0) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    update private.my_stuff_research_attempts set status='cancelled',finished_at=now(),usage_cents=p_cost_cents where job_id=p_job_id and attempt_number=v_job.attempt_count;
    update private.my_stuff_research_jobs set status='cancelled',actual_cents=v_total,lease_owner=null,lease_token=null,lease_expires_at=null,state_version=state_version+1,updated_at=now() where id=p_job_id;
    perform pgmq.delete('my_stuff_research_v1',v_job.queue_msg_id);
    return p_job_id;
  end if;
  if jsonb_typeof(p_evidence)<>'array' or jsonb_array_length(p_evidence)>30 or jsonb_typeof(p_candidates)<>'array' or jsonb_array_length(p_candidates)>100 or jsonb_typeof(p_unresolved)<>'array' or jsonb_array_length(p_unresolved)>50 then raise exception 'INVALID_RESEARCH_RESULT'; end if;
  if exists(select 1 from jsonb_array_elements(p_unresolved) value where jsonb_typeof(value)<>'object' or nullif(trim(value->>'name'),'') is null or length(value->>'name')>200 or nullif(trim(value->>'reason'),'') is null or length(value->>'reason')>1000 or (value->>'name'||E'\n'||value->>'reason') ~* '(ignore|disregard).*(instruction|previous|system)|system\s*prompt|developer\s*message|jailbreak') then raise exception 'INVALID_RESEARCH_RESULT'; end if;
  delete from private.my_stuff_research_evidence where job_id=p_job_id;
  for v_e in select value from jsonb_array_elements(p_evidence) loop
    if nullif(v_e->>'id','') is null or nullif(v_e->>'canonicalUrl','') is null or nullif(v_e->>'exactExcerpt','') is null or (v_e->>'sourceDomain')<>all(enabled_source_domains) or coalesce((v_e->>'locationVerified')::boolean,false) is not true then raise exception 'INVALID_EVIDENCE'; end if;
    insert into private.my_stuff_research_evidence(job_id,evidence_key,title,canonical_url,exact_excerpt,page,section,accessed_on,accessed_at,applicability,source_class,source_domain,location_verified,content_hash)
      values(p_job_id,v_e->>'id',v_e->>'title',v_e->>'canonicalUrl',v_e->>'exactExcerpt',nullif(v_e->>'page',''),nullif(v_e->>'section',''),(v_e->>'accessedAt')::timestamptz::date,(v_e->>'accessedAt')::timestamptz,v_e->>'applicability',v_e->>'sourceClass',v_e->>'sourceDomain',true,encode(digest(v_e::text,'sha256'),'hex'));
  end loop;
  delete from private.my_stuff_research_candidates where job_id=p_job_id;
  for v_c in select value from jsonb_array_elements(p_candidates) loop
    insert into private.my_stuff_research_candidates(job_id,candidate,content_hash) values(p_job_id,v_c,encode(digest(v_c::text,'sha256'),'hex'));
  end loop;
  insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values(p_job_id,v_job.user_id,v_job.reservation_month,'settlement',p_cost_cents,v_job.attempt_count) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
  insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values(p_job_id,v_job.user_id,v_job.reservation_month,'release',v_job.reserved_cents-v_total,0) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
  update private.my_stuff_research_attempts set status='succeeded',finished_at=now(),usage_cents=p_cost_cents where job_id=p_job_id and attempt_number=v_job.attempt_count;
  update private.my_stuff_research_jobs set status='awaiting_review',actual_cents=v_total,unresolved=p_unresolved,lease_owner=null,lease_token=null,lease_expires_at=null,state_version=state_version+1,updated_at=now() where id=p_job_id;
  perform pgmq.delete('my_stuff_research_v1',v_job.queue_msg_id);
  return p_job_id;
end $$;

create or replace function private.fail_my_stuff_research_job_v1(p_job_id uuid,p_lease_token uuid,p_error_code text,p_error_detail text)
returns boolean language plpgsql security definer set search_path=public,private,pgmq,extensions as $$
declare v_job private.my_stuff_research_jobs%rowtype; v_cfg private.my_stuff_research_runtime_config%rowtype;
  v_attempt_charge integer; v_total integer; v_delay integer; v_new_msg bigint; v_old_msg bigint;
begin
  select * into v_cfg from private.my_stuff_research_runtime_config where singleton;
  select * into v_job from private.my_stuff_research_jobs where id=p_job_id and status='running' and lease_token=p_lease_token for update;
  if not found then return false; end if;
  v_attempt_charge:=least(153,greatest(v_job.reserved_cents-coalesce(v_job.actual_cents,0),0));
  v_total:=coalesce(v_job.actual_cents,0)+v_attempt_charge;
  insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number)
    values(p_job_id,v_job.user_id,v_job.reservation_month,'settlement',v_attempt_charge,v_job.attempt_count)
    on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
  update private.my_stuff_research_attempts set status='failed',finished_at=now(),error_code=left(coalesce(p_error_code,'WORKER_ERROR'),100),usage_cents=v_attempt_charge where job_id=p_job_id and attempt_number=v_job.attempt_count;
  if v_job.cancellation_requested_at is not null then
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number)
      values(p_job_id,v_job.user_id,v_job.reservation_month,'release',v_job.reserved_cents-v_total,0) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    update private.my_stuff_research_jobs set status='cancelled',actual_cents=v_total,lease_owner=null,lease_token=null,lease_expires_at=null,state_version=state_version+1,updated_at=now() where id=p_job_id;
    perform pgmq.delete('my_stuff_research_v1',v_job.queue_msg_id);
    return true;
  end if;
  if v_job.attempt_count>=v_cfg.max_attempts or p_error_code in ('INVALID_EVIDENCE','INVALID_CITATION','UNCITED_EVIDENCE','UNAPPROVED_SOURCE','INVALID_CANDIDATE','INVALID_PROVIDER_RESPONSE','PROVIDER_REJECTED','POLICY_SUPERSEDED','RESEARCH_DISABLED','BUDGET_EXCEEDED','PRO_REQUIRED','ACCOUNT_DELETION_PENDING') then
    insert into private.my_stuff_research_dead_letters(job_id,error_code,error_detail,payload_hash) values(p_job_id,left(coalesce(p_error_code,'WORKER_ERROR'),100),left(p_error_detail,4000),encode(digest(jsonb_build_object('job_id',p_job_id,'attempt',v_job.attempt_count)::text,'sha256'),'hex')) on conflict(job_id) do nothing;
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number)
      values(p_job_id,v_job.user_id,v_job.reservation_month,'release',v_job.reserved_cents-v_total,0) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    update private.my_stuff_research_jobs set status='failed',actual_cents=v_total,last_error_code=left(coalesce(p_error_code,'WORKER_ERROR'),100),lease_owner=null,lease_token=null,lease_expires_at=null,state_version=state_version+1,updated_at=now() where id=p_job_id;
    perform pgmq.delete('my_stuff_research_v1',v_job.queue_msg_id);
  else
    v_delay:=least(300,15*(2^v_job.attempt_count)::integer);
    v_old_msg:=v_job.queue_msg_id;
    select pgmq.send('my_stuff_research_v1',jsonb_build_object('job_id',p_job_id,'schema_version',1),v_delay) into v_new_msg;
    update private.my_stuff_research_jobs set status='queued',actual_cents=v_total,last_error_code=left(coalesce(p_error_code,'WORKER_ERROR'),100),not_before=now()+make_interval(secs=>v_delay),queue_msg_id=v_new_msg,lease_owner=null,lease_token=null,lease_expires_at=null,state_version=state_version+1,updated_at=now() where id=p_job_id;
    if v_old_msg is not null then perform pgmq.delete('my_stuff_research_v1',v_old_msg); end if;
  end if;
  return true;
end $$;

create or replace function private.prevent_my_stuff_research_immutable_update()
returns trigger language plpgsql set search_path=private as $$
begin
  if tg_op='DELETE' and pg_trigger_depth()>1 then return old; end if;
  raise exception 'Approved research snapshots and apply records are immutable';
end $$;
create trigger my_stuff_research_approvals_immutable before update or delete on private.my_stuff_research_approvals for each row execute function private.prevent_my_stuff_research_immutable_update();
create trigger my_stuff_research_apply_records_immutable before update or delete on private.my_stuff_research_apply_records for each row execute function private.prevent_my_stuff_research_immutable_update();
create trigger my_stuff_research_definition_evidence_immutable before update or delete on private.my_stuff_research_definition_evidence for each row execute function private.prevent_my_stuff_research_immutable_update();

-- Service-only public-schema wrappers avoid exposing the private schema through PostgREST.
create or replace function public.lease_my_stuff_research_worker_v1(p_worker text)
returns jsonb language plpgsql security definer set search_path=private as $$
declare v_job private.my_stuff_research_jobs%rowtype; v_cfg private.my_stuff_research_runtime_config%rowtype; v_domains jsonb;
begin
  select * into v_cfg from private.my_stuff_research_runtime_config where singleton;
  v_job:=private.lease_my_stuff_research_job_v3(p_worker,v_cfg.lease_seconds);
  if v_job.id is null then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('domain',d.domain,'source_class',d.source_class,'include_subdomains',d.include_subdomains,'allowed_path_prefixes',d.allowed_path_prefixes,'manufacturer',d.manufacturer,'terms_reviewed_on',d.terms_reviewed_on,'robots_reviewed_on',d.robots_reviewed_on) order by d.domain),'[]'::jsonb)
    into v_domains from private.my_stuff_research_source_domains d
    where d.enabled and d.terms_reviewed_on between current_date-365 and current_date and d.robots_reviewed_on between current_date-30 and current_date and lower(d.manufacturer)=lower(v_job.request_snapshot->>'make');
  return jsonb_build_object(
    'lease',to_jsonb(v_job),
    'config',jsonb_build_object('provider_name',v_cfg.provider_name,'provider_model',v_cfg.provider_model,'retention_policy',v_cfg.retention_policy,'policy_version',v_cfg.policy_version,'max_searches',v_cfg.max_searches,'max_fetches',v_cfg.max_fetches,'provider_timeout_seconds',v_cfg.provider_timeout_seconds),
    'domains',v_domains);
end $$;
create or replace function public.settle_my_stuff_research_worker_v1(p_job_id uuid,p_lease_token text,p_cost_cents integer,p_evidence jsonb,p_candidates jsonb,p_unresolved jsonb)
returns uuid language sql security definer set search_path=private as $$
  select private.settle_my_stuff_research_job_v3(p_job_id,p_lease_token,p_cost_cents,p_evidence,p_candidates,p_unresolved)
$$;
create or replace function public.fail_my_stuff_research_worker_v1(p_job_id uuid,p_lease_token uuid,p_error_code text,p_error_detail text)
returns boolean language sql security definer set search_path=private as $$
  select private.fail_my_stuff_research_job_v1(p_job_id,p_lease_token,p_error_code,p_error_detail)
$$;

create or replace function private.invoke_my_stuff_research_worker_v1()
returns bigint language plpgsql security definer set search_path=private,net,vault as $$
declare v_url text; v_secret text; v_request bigint; v_timeout_ms integer;
begin
  if not (select enabled from private.my_stuff_research_runtime_config where singleton) then return null; end if;
  select lease_seconds*1000 into v_timeout_ms from private.my_stuff_research_runtime_config where singleton;
  select decrypted_secret into v_url from vault.decrypted_secrets where name='maintenance_research_worker_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name='maintenance_research_worker_secret';
  if nullif(v_url,'') is null or nullif(v_secret,'') is null then raise exception 'RESEARCH_DISABLED'; end if;
  select net.http_post(url=>v_url,headers=>jsonb_build_object('Authorization','Bearer '||v_secret,'Content-Type','application/json'),body=>'{}'::jsonb,timeout_milliseconds=>v_timeout_ms) into v_request;
  return v_request;
end $$;

create or replace function private.activate_my_stuff_research_v1()
returns void language plpgsql security definer set search_path=private,vault,cron as $$
declare enabled_source_domains integer; v_secret_count integer;
begin
  if session_user not in ('postgres','supabase_admin') then raise exception 'Owner session required'; end if;
  select count(*) into enabled_source_domains from private.my_stuff_research_source_domains where enabled and terms_reviewed_on between current_date-365 and current_date and robots_reviewed_on between current_date-30 and current_date;
  select count(*) into v_secret_count from vault.decrypted_secrets where name in ('maintenance_research_worker_url','maintenance_research_worker_secret') and nullif(decrypted_secret,'') is not null;
  if enabled_source_domains<1 or v_secret_count<>2 then raise exception 'Research source policy or Vault configuration is incomplete'; end if;
  if exists(select 1 from private.my_stuff_research_runtime_config where singleton and (provider_name is null or provider_model is null or retention_policy is null)) then raise exception 'Research provider configuration is incomplete'; end if;
  update private.my_stuff_research_runtime_config set enabled=true,updated_at=now() where singleton;
  perform cron.schedule('sideflip-maintenance-research-worker','*/5 * * * *','select private.invoke_my_stuff_research_worker_v1()');
end $$;

-- No Cron job is installed until the owner-only activation gate passes.

-- Default function ACLs are broad. Revoke first, then expose only human RPCs.
do $$ declare f record; begin
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname like '%my_stuff_research%' loop
    execute format('revoke execute on function %s from public,anon,authenticated',f.sig);
    execute format('grant execute on function %s to service_role',f.sig);
  end loop;
end $$;
grant execute on function public.enqueue_my_stuff_research_v3(uuid,text,text) to authenticated;
grant execute on function public.get_my_stuff_research_status_v1(uuid) to authenticated;
grant execute on function public.get_my_stuff_research_review_v1(uuid) to authenticated;
grant execute on function public.approve_my_stuff_research_v1(uuid,uuid[],text) to authenticated;
grant execute on function public.apply_my_stuff_research_v1(uuid,text) to authenticated;
grant execute on function public.cancel_my_stuff_research_v1(uuid,text) to authenticated;

-- Queue internals are never browser APIs; only SECURITY DEFINER worker RPCs touch them.
revoke usage on schema pgmq from public,anon,authenticated;
revoke all privileges on all tables in schema pgmq from public,anon,authenticated;
revoke all privileges on all sequences in schema pgmq from public,anon,authenticated;
revoke execute on all functions in schema pgmq from public,anon,authenticated;

commit;
