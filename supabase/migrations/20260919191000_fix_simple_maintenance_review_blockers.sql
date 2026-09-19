-- Resolve final focused-lane review blockers without enabling research.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

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
    or v_item.engine_displacement_liters is null
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
    'engine',v_item.engine_displacement_liters::text||'L',
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
  select * into v_existing from private.my_stuff_research_jobs where user_id=v_user and client_mutation_id=trim(p_mutation_id);
  if found then
    if v_existing.item_id<>p_item_id or v_existing.confirmed_fingerprint<>p_confirmed_fingerprint then raise exception 'Idempotency key reused with different request'; end if;
    return v_existing.id;
  end if;
  raise exception 'RESEARCH_ALREADY_ACTIVE';
end $$;
revoke execute on function public.enqueue_my_stuff_research_v3(uuid,text,text) from public,anon;
grant execute on function public.enqueue_my_stuff_research_v3(uuid,text,text) to authenticated;

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
    select * into v_job from private.my_stuff_research_jobs where id=v_job_id;
    if not found or v_job.queue_msg_id is distinct from v_msg.msg_id or v_job.status not in ('queued','running') then perform pgmq.delete('my_stuff_research_v1',v_msg.msg_id); end if;
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
  if not exists(select 1 from private.my_stuff_research_source_domains d where private.my_stuff_research_source_matches_make_v1(d.domain,v_job.request_snapshot->>'make')) then
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
revoke execute on function private.lease_my_stuff_research_job_v3(text,integer) from public,anon,authenticated,service_role;

commit;
