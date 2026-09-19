-- LOCAL ONLY / UNAPPLIED. Explicit document dispatch; no activation or transports.
begin;
alter table private.my_stuff_research_jobs add column execution_lane text not null default 'legacy' check(execution_lane in ('legacy','document_v2'));
alter table private.my_stuff_research_jobs drop constraint my_stuff_research_jobs_status_check;
alter table private.my_stuff_research_jobs add constraint my_stuff_research_jobs_status_check check(status in ('queued','running','awaiting_review','approved','applied','failed','cancelled','superseded','deleted','document_queued','document_pending','document_complete','document_failed'));
drop index private.my_stuff_research_one_active_user_uq;
create unique index my_stuff_research_one_active_user_uq on private.my_stuff_research_jobs(user_id) where status in ('queued','running','awaiting_review','approved','document_queued','document_pending');

create function public.enqueue_my_document_job_v1(p_item_id uuid,p_confirmed_fingerprint text,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare v_id uuid; j private.my_stuff_research_jobs;
begin
 -- Same config lock/order as legacy enqueue; all ownership/Pro/rate/budget checks
 -- and initial reservation remain in the existing enqueue transaction.
 perform 1 from private.my_stuff_research_runtime_config where singleton and enabled and document_lane_enabled for update;
 if not found then raise exception 'DOCUMENT_DISABLED'; end if;
 if exists(select 1 from private.my_stuff_research_jobs where user_id=auth.uid() and client_mutation_id=trim(p_mutation_id) and execution_lane<>'document_v2') then raise exception 'DOCUMENT_LANE_MISMATCH'; end if;
 v_id:=public.enqueue_my_stuff_research_v3(p_item_id,p_confirmed_fingerprint,p_mutation_id);
 select * into j from private.my_stuff_research_jobs where my_stuff_research_jobs.id=v_id;
 if j.execution_lane='document_v2' then return v_id; end if;
 if j.status<>'queued' or j.attempt_count<>0 then raise exception 'DOCUMENT_LANE_MISMATCH'; end if;
 -- Existing legacy mutation was rejected under the shared config lock above.
 if j.queue_msg_id is not null then perform pgmq.delete('my_stuff_research_v1',j.queue_msg_id); end if;
 update private.my_stuff_research_jobs set status='document_queued',execution_lane='document_v2',queue_msg_id=null where my_stuff_research_jobs.id=v_id;
 return v_id;
end $$;
revoke all on function public.enqueue_my_document_job_v1(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.enqueue_my_document_job_v1(uuid,text,text) to authenticated;

-- Serialize paid authority across BOTH lanes, including old v3 lease callers.
-- READY/pending acquisition is deliberately not a paid slot.
create function private.guard_research_paid_slot_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 if new.status='running' then
  perform pg_advisory_xact_lock(hashtextextended('research-provider-global',0));
  if exists(select 1 from private.my_stuff_document_executions where state='attempted') then raise exception 'DOCUMENT_PROVIDER_BUSY'; end if;
 end if;
 return new;
end $$;
revoke all on function private.guard_research_paid_slot_v1() from public,anon,authenticated,service_role;
create trigger research_paid_slot before insert or update of status on private.my_stuff_research_jobs for each row execute function private.guard_research_paid_slot_v1();
alter function private.lease_my_stuff_research_job_v4(text,integer) rename to lease_my_stuff_research_job_v4_legacy;
revoke all on function private.lease_my_stuff_research_job_v4_legacy(text,integer) from public,anon,authenticated,service_role;
create function private.lease_my_stuff_research_job_v4(p_worker text,p_lease_seconds integer default 300) returns private.my_stuff_research_jobs
language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('research-provider-global',0));
 if exists(select 1 from private.my_stuff_document_executions where state='attempted') then return null; end if;
 return private.lease_my_stuff_research_job_v4_legacy(p_worker,p_lease_seconds);
end $$;
revoke all on function private.lease_my_stuff_research_job_v4(text,integer) from public,anon,authenticated,service_role;
grant execute on function private.lease_my_stuff_research_job_v4(text,integer) to service_role;
alter function public.claim_document_job_v1(jsonb,jsonb) rename to claim_document_job_v1_atomic;
alter function public.claim_document_job_v1_atomic(jsonb,jsonb) set schema private;
revoke all on function private.claim_document_job_v1_atomic(jsonb,jsonb) from public,anon,authenticated,service_role;
create function public.claim_document_job_v1(p_binding jsonb,p_source jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('research-provider-global',0));
 if exists(select 1 from private.my_stuff_research_jobs where status='running') or
    exists(select 1 from private.my_stuff_document_executions where state='attempted') then return jsonb_build_object('claimed',false); end if;
 return private.claim_document_job_v1_atomic(p_binding,p_source);
end $$;
revoke all on function public.claim_document_job_v1(jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.claim_document_job_v1(jsonb,jsonb) to service_role;

create function public.lease_document_dispatch_v1(p_worker text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare j private.my_stuff_research_jobs; c private.my_stuff_research_runtime_config; b jsonb;
begin
 if nullif(trim(p_worker),'') is null or length(p_worker)>200 then raise exception 'DOCUMENT_WORKER_INVALID'; end if;
 perform pg_advisory_xact_lock(hashtextextended('research-provider-global',0));
 select * into c from private.my_stuff_research_runtime_config where singleton;
 if not c.enabled or not c.document_lane_enabled then raise exception 'DOCUMENT_DISABLED'; end if;
 if exists(select 1 from private.my_stuff_research_jobs where status='running') or exists(select 1 from private.my_stuff_document_executions where state='attempted') then return null; end if;
 select t.* into j from private.my_stuff_research_jobs t join private.my_stuff_document_executions d on d.job_id=t.id
 where t.execution_lane='document_v2' and t.status='document_pending' and d.state='ready' and t.cancellation_requested_at is null and t.lease_expires_at>clock_timestamp()
 order by t.created_at,t.id limit 1 for update of t skip locked;
 if found then
  begin
   select binding into b from private.my_stuff_document_executions where job_id=j.id;
   perform private.assert_document_job_v1(b);
  exception when others then
   if sqlerrm not in ('IDENTITY_UNCONFIRMED','PRO_REQUIRED','ACCOUNT_DELETION_PENDING','STALE_DOCUMENT_LEASE','DOCUMENT_CANCELLED') then raise; end if;
   perform public.fail_document_preflight_v1(b,(select attempt_id from private.my_stuff_document_executions where job_id=j.id));
   return null;
  end;
  return to_jsonb(j);
 end if;
 select * into j from private.my_stuff_research_jobs where execution_lane='document_v2' and status='document_queued' order by created_at,id limit 1 for update skip locked;
 if not found then return null; end if;
 begin
 -- Keep all pre-cost gates, original reservation cohort and policy ceilings.
 perform private.assert_my_stuff_research_user_v1(j.user_id);
 if not private.my_stuff_research_policy_is_current_v1(j.id) then raise exception 'POLICY_SUPERSEDED'; end if;
 if j.reservation_month<>date_trunc('month',current_date)::date or now()+make_interval(secs=>c.lease_seconds)>=date_trunc('month',now())+interval '1 month' then raise exception 'BUDGET_MONTH_ROLLOVER'; end if;
 if not exists(select 1 from private.my_stuff_research_source_domains where enabled and terms_reviewed_on between current_date-365 and current_date and robots_reviewed_on between current_date-30 and current_date and lower(manufacturer)=lower(j.request_snapshot->>'make')) then raise exception 'SOURCE_POLICY_UNAVAILABLE'; end if;
 if (select coalesce(sum(case when kind='reservation' then cents when kind='release' then -cents else 0 end),0) from private.my_stuff_research_budget_ledger where user_id=j.user_id and month_start=j.reservation_month)>c.monthly_user_budget_cents or
 (select coalesce(sum(case when kind='reservation' then cents when kind='release' then -cents else 0 end),0) from private.my_stuff_research_budget_ledger where month_start=j.reservation_month)>c.global_monthly_budget_cents then raise exception 'BUDGET_POLICY_CHANGED'; end if;
 update private.my_stuff_research_jobs set status='running',lease_owner=p_worker,lease_token=gen_random_uuid(),lease_expires_at=now()+make_interval(secs=>c.lease_seconds),attempt_count=1,state_version=state_version+1,updated_at=now() where id=j.id returning * into j;
 insert into private.my_stuff_research_attempts(job_id,attempt_number,provider,model,retention_policy,status) values(j.id,1,c.provider_name,c.provider_model,c.retention_policy,'running');
 b:=public.prepare_document_job_v1(j.id,j.lease_token);
 exception when others then
  if sqlerrm not in ('IDENTITY_UNCONFIRMED','PRO_REQUIRED','ACCOUNT_DELETION_PENDING','POLICY_SUPERSEDED','BUDGET_MONTH_ROLLOVER','SOURCE_POLICY_UNAVAILABLE','BUDGET_POLICY_CHANGED') then raise; end if;
  -- The nested transaction rolled back lease/adoption. No attempt or paid
  -- authority survived; retain one release and a sanitized terminal status.
  insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values(j.id,j.user_id,j.reservation_month,'release',j.reserved_cents,0);
  update private.my_stuff_research_jobs set status='document_failed',last_error_code='DOCUMENT_PREFLIGHT_REJECTED',state_version=state_version+1,updated_at=now() where id=j.id;
  return null;
 end;
 select * into j from private.my_stuff_research_jobs where id=j.id;
 return to_jsonb(j);
end $$;
revoke all on function public.lease_document_dispatch_v1(text) from public,anon,authenticated,service_role;
grant execute on function public.lease_document_dispatch_v1(text) to service_role;

-- Legacy cancellation remains byte-for-byte behind an ungranted helper.
alter function public.cancel_my_stuff_research_v1(uuid,text) rename to cancel_my_stuff_research_v1_legacy;
alter function public.cancel_my_stuff_research_v1_legacy(uuid,text) set schema private;
revoke all on function private.cancel_my_stuff_research_v1_legacy(uuid,text) from public,anon,authenticated,service_role;
create function public.cancel_my_stuff_research_v1(p_job_id uuid,p_mutation_id text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,private,extensions as $$
declare j private.my_stuff_research_jobs; d private.my_stuff_document_executions; h text;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if nullif(trim(p_mutation_id),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required'; end if;
 select * into j from private.my_stuff_research_jobs where id=p_job_id and user_id=auth.uid() for update;
 if not found then raise exception 'Research job not found'; end if;
 if j.execution_lane<>'document_v2' and not exists(select 1 from private.my_stuff_document_executions where job_id=j.id) then return private.cancel_my_stuff_research_v1_legacy(p_job_id,p_mutation_id); end if;
 h:=encode(digest(jsonb_build_object('job_id',p_job_id)::text,'sha256'),'hex');
 if j.cancellation_mutation_id is not null then
  if j.cancellation_mutation_id<>trim(p_mutation_id) or j.cancellation_request_hash<>h then raise exception 'MUTATION_ID_REUSED'; end if;
  return true;
 end if;
 -- Cancellation must not release a claimed owner's active slot or accounting.
 update private.my_stuff_research_jobs set cancellation_requested_at=now(),cancellation_mutation_id=trim(p_mutation_id),cancellation_request_hash=h,updated_at=now() where id=j.id;
 if j.status='document_queued' then
  insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values(j.id,j.user_id,j.reservation_month,'release',j.reserved_cents,0);
  update private.my_stuff_research_jobs set status='cancelled',state_version=state_version+1 where id=j.id;
 else
  select * into d from private.my_stuff_document_executions where job_id=j.id for update;
  if d.state='ready' then perform public.fail_document_preflight_v1(d.binding,d.attempt_id); end if;
 end if;
 return true;
end $$;
revoke all on function public.cancel_my_stuff_research_v1(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.cancel_my_stuff_research_v1(uuid,text) to authenticated;
-- Explicit bounded recovery, not a retry scheduler. A claimed timeout remains
-- conservatively charged; the five-minute grace exceeds the proposed bounded
-- transport deadline. Real transport/deadline activation remains a release gate.
create function public.recover_document_dispatch_v1(p_limit integer default 10) returns integer
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare j private.my_stuff_research_jobs; d private.my_stuff_document_executions; n integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 25 then raise exception 'DOCUMENT_RECOVERY_LIMIT'; end if;
 perform pg_advisory_xact_lock(hashtextextended('research-provider-global',0));
 for j in select t.* from private.my_stuff_research_jobs t join private.my_stuff_document_executions e on e.job_id=t.id
   where e.state in ('ready','attempted') and t.lease_expires_at<clock_timestamp()-interval '5 minutes'
   order by t.lease_expires_at,t.id limit p_limit for update of t skip locked loop
  select * into d from private.my_stuff_document_executions where job_id=j.id for update;
  if d.state='ready' then perform public.fail_document_preflight_v1(d.binding,d.attempt_id);
  elsif d.state='attempted' then perform public.fail_document_job_v1(d.binding,d.attempt_id,null,'DOCUMENT_ACCOUNTING_UNKNOWN');
  else continue;
  end if;
  n:=n+1;
 end loop;
 return n;
end $$;
revoke all on function public.recover_document_dispatch_v1(integer) from public,anon,authenticated,service_role;
grant execute on function public.recover_document_dispatch_v1(integer) to service_role;

-- Preserve the original unknown settlement and failure replay contract. Append
-- one trusted accounting correction, not a new attempt/reservation or template.
create table private.my_stuff_document_usage_reconciliations (
 job_id uuid primary key references private.my_stuff_document_executions(job_id) on delete cascade,
 attempt_id uuid not null references private.my_stuff_research_attempts(id) on delete cascade,
 cost_ticks bigint not null check(cost_ticks between 0 and 9007199254740991),
 prior_charge_cents integer not null check(prior_charge_cents>=0),
 reconciled_at timestamptz not null default now()
);
alter table private.my_stuff_document_usage_reconciliations enable row level security;
revoke all on private.my_stuff_document_usage_reconciliations from public,anon,authenticated,service_role;
create function public.reconcile_document_usage_v1(p_binding jsonb,p_attempt_id uuid,p_cost_ticks bigint) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare d private.my_stuff_document_executions; j private.my_stuff_research_jobs; r private.my_stuff_document_usage_reconciliations; charge integer;
begin
 d:=private.assert_document_job_v1(p_binding,false);
 if d.attempt_id is distinct from p_attempt_id then raise exception 'DOCUMENT_ATTEMPT_MISMATCH'; end if;
 select * into r from private.my_stuff_document_usage_reconciliations where job_id=d.job_id;
 if found then
  if r.cost_ticks is distinct from p_cost_ticks then raise exception 'DOCUMENT_RECONCILIATION_CONFLICT'; end if;
  return true;
 end if;
 if d.state<>'failed' or d.cost_ticks is not null or d.source is null then raise exception 'DOCUMENT_UNKNOWN_REQUIRED'; end if;
 select * into j from private.my_stuff_research_jobs where id=d.job_id;
 if p_cost_ticks is null or p_cost_ticks<0 or p_cost_ticks>9007199254740991 or ceil(p_cost_ticks::numeric/100000000)>j.reserved_cents then raise exception 'DOCUMENT_COST_INVALID'; end if;
 charge:=ceil(p_cost_ticks::numeric/100000000)::integer;
 insert into private.my_stuff_document_usage_reconciliations(job_id,attempt_id,cost_ticks,prior_charge_cents) values(j.id,d.attempt_id,p_cost_ticks,j.reserved_cents);
 insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values(j.id,j.user_id,j.reservation_month,'release',j.reserved_cents-charge,1);
 update private.my_stuff_research_attempts set usage_ticks=p_cost_ticks,usage_cents=charge where id=d.attempt_id;
 update private.my_stuff_research_jobs set actual_cents=actual_cents-j.reserved_cents+charge,actual_cost_ticks=actual_cost_ticks+p_cost_ticks,updated_at=now() where id=j.id;
 return true;
end $$;
revoke all on function public.reconcile_document_usage_v1(jsonb,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.reconcile_document_usage_v1(jsonb,uuid,bigint) to service_role;

-- Sanitized owner status also covers queued/cancelled-before-adoption jobs.
create or replace function public.get_my_document_job_result_v1(p_job_id uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,public,private as $$
 select jsonb_build_object('jobId',j.id,'state',coalesce(d.state,j.status),'jobStatus',j.status,
 'cancellationRequested',j.cancellation_requested_at is not null,'accountingPending',j.status in ('document_queued','document_pending'),
 'accountingState',case when r.job_id is not null then 'reconciled' when d.state='failed' and d.cost_ticks is null then 'unknown' when j.status in ('document_queued','document_pending') then 'reserved' else 'known' end,
 'templateId',d.template_id,'record',t.record,'costInUsdTicks',coalesce(r.cost_ticks,d.cost_ticks),
 'costUnknown',coalesce(d.state='failed' and d.cost_ticks is null and r.job_id is null,false))
 from private.my_stuff_research_jobs j left join private.my_stuff_document_executions d on d.job_id=j.id
 left join private.my_stuff_document_usage_reconciliations r on r.job_id=j.id
 left join public.manufacturer_template_versions t on t.id=d.template_id and t.owner_id=j.user_id
 where j.id=p_job_id and j.user_id=auth.uid() and (j.execution_lane='document_v2' or d.job_id is not null)
$$;
revoke all on function public.get_my_document_job_result_v1(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_my_document_job_result_v1(uuid) to authenticated;
commit;
