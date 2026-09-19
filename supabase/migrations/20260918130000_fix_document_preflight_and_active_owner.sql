-- LOCAL ONLY / UNAPPLIED. Corrections to the reviewed atomic document lane.
-- No activation, dispatch, retry, provider, or historical migration changes.
begin;

-- Transactional replacement: concurrent inserts cannot observe a missing fence.
-- Existing duplicates fail the migration rather than silently cancelling work.
drop index private.my_stuff_research_one_active_user_uq;
create unique index my_stuff_research_one_active_user_uq
 on private.my_stuff_research_jobs(user_id)
 where status in ('queued','running','awaiting_review','approved','document_pending');

-- This capability represents nonbillable acquisition only. It has no caller cost
-- or error-stage selector. The existing assertion locks JOB then EXECUTION.
create function public.fail_document_preflight_v1(p_binding jsonb,p_attempt_id uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare d private.my_stuff_document_executions;
begin
 d:=private.assert_document_job_v1(p_binding,false);
 if d.attempt_id is distinct from p_attempt_id then raise exception 'DOCUMENT_ATTEMPT_MISMATCH'; end if;
 if d.state='failed' then
   return d.source is null and d.cost_ticks=0 and d.error_code='DOCUMENT_SOURCE_UNAVAILABLE';
 end if;
 -- A claimed attempt (including an unacknowledged claim) may have provider spend.
 -- Never settle it from a stale acquisition result, even after cancellation.
 if d.state<>'ready' or d.source is not null then return false; end if;
 update private.my_stuff_document_executions set state='failed',cost_ticks=0,error_code='DOCUMENT_SOURCE_UNAVAILABLE' where job_id=d.job_id;
 perform private.settle_document_accounting_v1(d,0,false,'DOCUMENT_SOURCE_UNAVAILABLE');
 return true;
end $$;
revoke all on function public.fail_document_preflight_v1(jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.fail_document_preflight_v1(jsonb,uuid) to service_role;

create or replace function public.fail_document_job_v1(p_binding jsonb,p_attempt_id uuid,p_cost_ticks bigint,p_code text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare d private.my_stuff_document_executions;
begin
 -- Compatibility for the already documented acquisition-error call. Do not let
 -- an old caller bypass the new ready-only transition using this original RPC.
 if p_code='DOCUMENT_SOURCE_UNAVAILABLE' then
   if p_cost_ticks is distinct from 0::bigint then raise exception 'DOCUMENT_PREFLIGHT_COST_INVALID'; end if;
   return public.fail_document_preflight_v1(p_binding,p_attempt_id);
 end if;
 d:=private.assert_document_job_v1(p_binding,false);
 if d.attempt_id is distinct from p_attempt_id then raise exception 'DOCUMENT_ATTEMPT_MISMATCH'; end if;
 if d.state='completed' then return false; end if;
 if d.state='failed' then
   if d.source is null or d.cost_ticks is distinct from p_cost_ticks or d.error_code is distinct from p_code then raise exception 'DOCUMENT_FAILURE_CONFLICT'; end if;
   return true;
 end if;
 if p_code is null or p_code !~ '^DOCUMENT_[A-Z_]{1,80}$' then raise exception 'DOCUMENT_ERROR_INVALID'; end if;
 -- Attempt-owned accounting is separate from acquisition, including known zero.
 if d.state<>'attempted' then raise exception 'DOCUMENT_ATTEMPT_REQUIRED'; end if;
 update private.my_stuff_document_executions set state='failed',cost_ticks=p_cost_ticks,error_code=p_code where job_id=d.job_id;
 perform private.settle_document_accounting_v1(d,p_cost_ticks,false,p_code);
 return true;
end $$;
revoke all on function public.fail_document_job_v1(jsonb,uuid,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.fail_document_job_v1(jsonb,uuid,bigint,text) to service_role;
commit;
