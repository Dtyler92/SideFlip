-- LOCAL ONLY / UNAPPLIED. No paid activation. Never expires remote uncertainty.
begin;
alter table private.my_stuff_document_executions
 add column transport_state text not null default 'not_started' check(transport_state in ('not_started','in_flight','abort_requested_remote_unknown','local_stopped_remote_unknown','response_complete','authorized_release')),
 add column transport_cost_ticks bigint check(transport_cost_ticks between 0 and 9007199254740991),
 add column transport_recovery_authorization uuid,
 add column transport_updated_at timestamptz not null default now();
-- Existing consumed attempts have no transport acknowledgement. Fail closed.
update private.my_stuff_document_executions set transport_state='abort_requested_remote_unknown'
 where state='attempted' or (state='failed' and source is not null and cost_ticks is null);
create or replace function private.guard_research_paid_slot_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 if new.status='running' then
  perform pg_advisory_xact_lock(hashtextextended('research-provider-global',0));
  if exists(select 1 from private.my_stuff_document_executions where state='attempted' or transport_state in ('in_flight','abort_requested_remote_unknown','local_stopped_remote_unknown')) then raise exception 'DOCUMENT_PROVIDER_BUSY'; end if;
 end if;
 return new;
end $$;

create or replace function private.lease_my_stuff_research_job_v4(p_worker text,p_lease_seconds integer default 300) returns private.my_stuff_research_jobs
language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('research-provider-global',0));
 if exists(select 1 from private.my_stuff_document_executions where state='attempted' or transport_state in ('in_flight','abort_requested_remote_unknown','local_stopped_remote_unknown')) then return null; end if;
 return private.lease_my_stuff_research_job_v4_legacy(p_worker,p_lease_seconds);
end $$;

create or replace function public.claim_document_job_v1(p_binding jsonb,p_source jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('research-provider-global',0));
 if exists(select 1 from private.my_stuff_research_jobs where status='running') or
    exists(select 1 from private.my_stuff_document_executions where state='attempted' or transport_state in ('in_flight','abort_requested_remote_unknown','local_stopped_remote_unknown')) then return jsonb_build_object('claimed',false); end if;
 return private.claim_document_job_v1_atomic(p_binding,p_source);
end $$;

create or replace function public.lease_document_dispatch_v1(p_worker text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare j private.my_stuff_research_jobs; c private.my_stuff_research_runtime_config; b jsonb;
begin
 if nullif(trim(p_worker),'') is null or length(p_worker)>200 then raise exception 'DOCUMENT_WORKER_INVALID'; end if;
 perform pg_advisory_xact_lock(hashtextextended('research-provider-global',0));
 select * into c from private.my_stuff_research_runtime_config where singleton;
 if not c.enabled or not c.document_lane_enabled then raise exception 'DOCUMENT_DISABLED'; end if;
 if exists(select 1 from private.my_stuff_research_jobs where status='running') or exists(select 1 from private.my_stuff_document_executions where state='attempted' or transport_state in ('in_flight','abort_requested_remote_unknown','local_stopped_remote_unknown')) then return null; end if;
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
create or replace function public.recover_document_dispatch_v1(p_limit integer default 10) returns integer
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
  elsif d.state='attempted' then
   -- Expiry proves neither invocation absence nor remote termination.
   update private.my_stuff_document_executions set transport_state='abort_requested_remote_unknown' where job_id=d.job_id and transport_state='not_started';
   perform public.fail_document_job_v1(d.binding,d.attempt_id,d.transport_cost_ticks,'DOCUMENT_ACCOUNTING_UNKNOWN');
  else continue;
  end if;
  n:=n+1;
 end loop;
 return n;
end $$;

create function public.observe_document_transport_v1(p_binding jsonb,p_attempt_id uuid,p_event text,p_cost_ticks bigint default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare d private.my_stuff_document_executions; next_state text;
begin
 perform pg_advisory_xact_lock(hashtextextended('research-provider-global',0));
 d:=private.assert_document_job_v1(p_binding,false);
 if d.attempt_id is distinct from p_attempt_id then raise exception 'DOCUMENT_ATTEMPT_MISMATCH'; end if;
 if p_event is null or p_event not in ('start','abort_requested','local_stopped','response_complete') then raise exception 'DOCUMENT_TRANSPORT_EVENT'; end if;
 if p_cost_ticks<0 or p_cost_ticks>9007199254740991 then raise exception 'DOCUMENT_COST_INVALID'; end if;
 if p_event='start' then
  perform private.assert_document_job_v1(p_binding,true);
  if d.state<>'attempted' or d.transport_state<>'not_started' then raise exception 'DOCUMENT_TRANSPORT_ALREADY_STARTED'; end if;
  next_state:='in_flight';
 else
  if d.transport_state='not_started' then raise exception 'DOCUMENT_TRANSPORT_NOT_STARTED'; end if;
  next_state:=case p_event when 'abort_requested' then 'abort_requested_remote_unknown' when 'local_stopped' then 'local_stopped_remote_unknown' else 'response_complete' end;
  -- Delayed abort notifications must not undo a complete response or explicit release.
  if d.transport_state in ('response_complete','authorized_release') then next_state:=d.transport_state; end if;
 end if;
 if d.transport_cost_ticks is not null and p_cost_ticks is not null and d.transport_cost_ticks<>p_cost_ticks then raise exception 'DOCUMENT_RECONCILIATION_CONFLICT'; end if;
 if p_cost_ticks is not null and d.state='failed' and d.cost_ticks is null then
  perform public.reconcile_document_usage_v1(p_binding,p_attempt_id,p_cost_ticks);
 end if;
 update private.my_stuff_document_executions set transport_state=next_state,transport_cost_ticks=coalesce(transport_cost_ticks,p_cost_ticks),transport_updated_at=clock_timestamp() where job_id=d.job_id;
 return true;
end $$;

create function public.get_document_transport_status_v1(p_binding jsonb,p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare d private.my_stuff_document_executions; j private.my_stuff_research_jobs;
begin
 d:=private.assert_document_job_v1(p_binding,false);
 if d.attempt_id is distinct from p_attempt_id then raise exception 'DOCUMENT_ATTEMPT_MISMATCH'; end if;
 select * into j from private.my_stuff_research_jobs where id=d.job_id;
 return jsonb_build_object('transportState',d.transport_state,'stopRequested',d.state<>'attempted' or j.cancellation_requested_at is not null or j.lease_expires_at<=clock_timestamp());
end $$;

-- Deliberate service/operator authorization only; NEVER called by dispatcher or
-- usage reconciliation. This accepts remote-overlap risk, not a stopped-provider claim.
create function public.authorize_document_transport_release_v1(p_binding jsonb,p_attempt_id uuid,p_authorization_id uuid,p_accept_remote_unknown boolean) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare d private.my_stuff_document_executions;
begin
 if p_authorization_id is null or p_accept_remote_unknown is distinct from true then raise exception 'DOCUMENT_RECOVERY_AUTHORIZATION_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended('research-provider-global',0));
 d:=private.assert_document_job_v1(p_binding,false);
 if d.attempt_id is distinct from p_attempt_id then raise exception 'DOCUMENT_ATTEMPT_MISMATCH'; end if;
 if d.state<>'failed' then raise exception 'DOCUMENT_TERMINAL_REQUIRED'; end if;
 if d.transport_recovery_authorization is not null and d.transport_recovery_authorization<>p_authorization_id then raise exception 'DOCUMENT_RECOVERY_AUTHORIZATION_CONFLICT'; end if;
 update private.my_stuff_document_executions set transport_state='authorized_release',transport_recovery_authorization=p_authorization_id,transport_updated_at=clock_timestamp() where job_id=d.job_id;
 return true;
end $$;

-- Only the new lifecycle worker uses this late-result accounting contract.
-- Keep v1's strict replay semantics unchanged for older callers.
create function public.fail_document_job_v2(p_binding jsonb,p_attempt_id uuid,p_cost_ticks bigint,p_code text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare d private.my_stuff_document_executions; effective_ticks bigint;
begin
 d:=private.assert_document_job_v1(p_binding,false);
 if d.attempt_id is distinct from p_attempt_id then raise exception 'DOCUMENT_ATTEMPT_MISMATCH'; end if;
 if p_cost_ticks is not null and d.transport_cost_ticks is not null and p_cost_ticks<>d.transport_cost_ticks then raise exception 'DOCUMENT_RECONCILIATION_CONFLICT'; end if;
 effective_ticks:=coalesce(p_cost_ticks,d.transport_cost_ticks);
 if d.state='failed' then
  if d.cost_ticks is null and effective_ticks is not null then return public.reconcile_document_usage_v1(p_binding,p_attempt_id,effective_ticks); end if;
  if effective_ticks is null or d.cost_ticks=effective_ticks then return true; end if;
  raise exception 'DOCUMENT_FAILURE_CONFLICT';
 end if;
 return public.fail_document_job_v1(p_binding,p_attempt_id,effective_ticks,p_code);
end $$;

create or replace function public.get_my_document_job_result_v1(p_job_id uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,public,private as $$
 select jsonb_build_object('jobId',j.id,'state',coalesce(d.state,j.status),'jobStatus',j.status,
 'transportState',coalesce(d.transport_state,'not_started'),'admissionQuarantined',coalesce(d.transport_state in ('in_flight','abort_requested_remote_unknown','local_stopped_remote_unknown'),false),'reconciliationRequired',coalesce(d.transport_state in ('abort_requested_remote_unknown','local_stopped_remote_unknown') or (d.state='failed' and d.transport_state='in_flight'),false),'cancellationRequested',j.cancellation_requested_at is not null,'accountingPending',j.status in ('document_queued','document_pending'),
 'accountingState',case when r.job_id is not null then 'reconciled' when d.state='failed' and d.cost_ticks is null then 'unknown' when j.status in ('document_queued','document_pending') then 'reserved' else 'known' end,
 'templateId',d.template_id,'record',t.record,'costInUsdTicks',coalesce(r.cost_ticks,d.cost_ticks),
 'costUnknown',coalesce(d.state='failed' and d.cost_ticks is null and r.job_id is null,false))
 from private.my_stuff_research_jobs j left join private.my_stuff_document_executions d on d.job_id=j.id
 left join private.my_stuff_document_usage_reconciliations r on r.job_id=j.id
 left join public.manufacturer_template_versions t on t.id=d.template_id and t.owner_id=j.user_id
 where j.id=p_job_id and j.user_id=auth.uid() and (j.execution_lane='document_v2' or d.job_id is not null)
$$;
revoke all on function public.observe_document_transport_v1(jsonb,uuid,text,bigint) from public,anon,authenticated,service_role;
grant execute on function public.observe_document_transport_v1(jsonb,uuid,text,bigint) to service_role;

revoke all on function public.get_document_transport_status_v1(jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_document_transport_status_v1(jsonb,uuid) to service_role;

revoke all on function public.authorize_document_transport_release_v1(jsonb,uuid,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.authorize_document_transport_release_v1(jsonb,uuid,uuid,boolean) to service_role;

revoke all on function public.fail_document_job_v2(jsonb,uuid,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.fail_document_job_v2(jsonb,uuid,bigint,text) to service_role;

-- Deletion/cascade must not silently erase an ambiguous provider fence.
create function private.guard_transport_quarantine_delete() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 if old.state='attempted' or old.transport_state in ('in_flight','abort_requested_remote_unknown','local_stopped_remote_unknown') then raise exception 'DOCUMENT_TRANSPORT_RECONCILIATION_REQUIRED'; end if;
 return old;
end $$;
revoke all on function private.guard_transport_quarantine_delete() from public,anon,authenticated,service_role;
create trigger document_transport_quarantine_delete before delete on private.my_stuff_document_executions for each row execute function private.guard_transport_quarantine_delete();
commit;
