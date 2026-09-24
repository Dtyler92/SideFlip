-- Permanently retire paid maintenance research without deleting audit/history.
-- Phase one commits fail-closed disablement before guarded reconciliation so an
-- active/uncertain provider execution leaves the scheduler disabled on abort.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

select pg_advisory_xact_lock(hashtextextended('research-provider-global', 0));

do $$
begin
  perform 1
  from private.my_stuff_research_runtime_config
  where singleton
  for update;
  if not found then
    raise exception 'RESEARCH_RUNTIME_SINGLETON_MISSING';
  end if;
  if (select count(*) from private.my_stuff_research_runtime_config) <> 1 then
    raise exception 'RESEARCH_RUNTIME_SINGLETON_INCONSISTENT';
  end if;

  update private.my_stuff_research_runtime_config
  set enabled = false,
      updated_at = now()
  where singleton;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'private'
      and table_name = 'my_stuff_research_runtime_config'
      and column_name = 'document_lane_enabled'
  ) then
    execute 'update private.my_stuff_research_runtime_config set document_lane_enabled=false,updated_at=now() where singleton';
  end if;
end
$$;

do $$
declare
  v_job record;
begin
  if to_regclass('cron.job') is null
     or to_regprocedure('cron.unschedule(bigint)') is null then
    raise exception 'RESEARCH_CRON_CONTROL_MISSING';
  end if;

  for v_job in
    select jobid
    from cron.job
    where jobname in ('sideflip-maintenance-research-worker')
    order by jobid
  loop
    if not cron.unschedule(v_job.jobid) then
      raise exception 'RESEARCH_CRON_UNSCHEDULE_FAILED';
    end if;
  end loop;
end
$$;
commit;

-- Phase two repeats the locks and disablement across the committed boundary,
-- rejects any paid/uncertain execution, reconciles only known-nonbillable READY
-- document work, cancels untouched queues, and removes every execution grant.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

select pg_advisory_xact_lock(hashtextextended('research-provider-global', 0));

do $$
begin
  perform 1
  from private.my_stuff_research_runtime_config
  where singleton
  for update;
  if not found then
    raise exception 'RESEARCH_RUNTIME_SINGLETON_MISSING';
  end if;
  if (select count(*) from private.my_stuff_research_runtime_config) <> 1 then
    raise exception 'RESEARCH_RUNTIME_SINGLETON_INCONSISTENT';
  end if;

  update private.my_stuff_research_runtime_config
  set enabled = false,
      updated_at = now()
  where singleton;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'private'
      and table_name = 'my_stuff_research_runtime_config'
      and column_name = 'document_lane_enabled'
  ) then
    execute 'update private.my_stuff_research_runtime_config set document_lane_enabled=false,updated_at=now() where singleton';
  end if;
end
$$;

select cron.unschedule(jobid)
from cron.job
where jobname in ('sideflip-maintenance-research-worker');

-- A running legacy job can have paid remote work in flight. Never infer remote
-- termination from a SQL lease or local timeout.
do $$
begin
  if exists (
    select 1
    from private.my_stuff_research_jobs
    where status = 'running'
       or (
         status <> 'document_pending'
         and (
           lease_token is not null
           or lease_owner is not null
           or lease_expires_at is not null
         )
       )
  ) then
    raise exception 'RESEARCH_EXECUTION_RECONCILIATION_REQUIRED';
  end if;
end
$$;

-- The document lane is optional in the historical base stack. If present, its
-- catalog shape and row relationships must be exact. Only READY/not-started
-- acquisition can be settled at known zero cost by its authoritative function.
do $$
declare
  v_has_transport boolean := false;
  v_row record;
  v_ok boolean;
begin
  if to_regclass('private.my_stuff_document_executions') is null then
    if exists (
      select 1 from private.my_stuff_research_jobs
      where status in ('document_queued','document_pending')
    ) then
      raise exception 'DOCUMENT_RECONCILIATION_CAPABILITY_MISSING';
    end if;
    return;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='private'
      and table_name='my_stuff_document_executions'
      and column_name='state'
  ) then
    raise exception 'DOCUMENT_RECONCILIATION_SCHEMA_INCONSISTENT';
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema='private'
      and table_name='my_stuff_document_executions'
      and column_name='transport_state'
  ) into v_has_transport;

  if exists (
    select 1
    from private.my_stuff_document_executions e
    left join private.my_stuff_research_jobs j on j.id=e.job_id
    where j.id is null
       or (e.state='ready' and j.status<>'document_pending')
       or (e.state='completed' and j.status<>'document_complete')
       or (e.state='failed' and j.status<>'document_failed')
       or e.state not in ('ready','attempted','completed','failed')
  ) or exists (
    select 1
    from private.my_stuff_research_jobs j
    left join private.my_stuff_document_executions e on e.job_id=j.id
    where j.status='document_pending' and e.job_id is null
  ) then
    raise exception 'DOCUMENT_RECONCILIATION_SCHEMA_INCONSISTENT';
  end if;

  if exists (
    select 1
    from private.my_stuff_document_executions
    where state='attempted'
  ) then
    raise exception 'RESEARCH_EXECUTION_RECONCILIATION_REQUIRED';
  end if;

  if v_has_transport then
    execute $query$
      select exists (
        select 1
        from private.my_stuff_document_executions
        where transport_state in (
          'in_flight',
          'abort_requested_remote_unknown',
          'local_stopped_remote_unknown'
        )
           or (state='ready' and transport_state<>'not_started')
      )
    $query$ into v_ok;
    if v_ok then
      raise exception 'RESEARCH_EXECUTION_RECONCILIATION_REQUIRED';
    end if;
  end if;

  if exists (
    select 1
    from private.my_stuff_research_jobs j
    join private.my_stuff_document_executions e on e.job_id=j.id
    where j.status='document_pending' and e.state='ready'
  ) and to_regprocedure('public.fail_document_preflight_v1(jsonb,uuid)') is null then
    raise exception 'DOCUMENT_RECONCILIATION_CAPABILITY_MISSING';
  end if;

  for v_row in
    select e.binding,e.attempt_id
    from private.my_stuff_research_jobs j
    join private.my_stuff_document_executions e on e.job_id=j.id
    where j.status='document_pending' and e.state='ready'
    order by j.created_at,j.id
    for update of j,e
  loop
    execute 'select public.fail_document_preflight_v1($1,$2)'
      into v_ok
      using v_row.binding,v_row.attempt_id;
    if v_ok is distinct from true then
      raise exception 'DOCUMENT_RECONCILIATION_FAILED';
    end if;
  end loop;

  if exists (
    select 1 from private.my_stuff_research_jobs
    where status='document_pending'
  ) then
    raise exception 'DOCUMENT_RECONCILIATION_REQUIRED';
  end if;
end
$$;

-- Untouched queued work has no provider attempt. Before changing a job, prove
-- the original reservation and exact unused release identity, then prove that
-- queue_msg_id names this job's canonical PGMQ payload. Cancellation and queue
-- deletion are in the same transaction, so either every effect commits or none.
do $$
declare
  v_job record;
  v_expected_release integer;
  v_release_count integer;
  v_release_exact boolean;
  v_queue_count integer;
  v_queue_exact boolean;
  v_deleted boolean;
  v_updated integer;
begin
  if exists (
    select 1 from private.my_stuff_research_jobs
    where status in ('queued','document_queued')
  ) and to_regclass('pgmq.q_my_stuff_research_v1') is null then
    raise exception 'RESEARCH_QUEUE_MESSAGE_INCONSISTENT';
  end if;

  for v_job in
    select id,user_id,reservation_month,reserved_cents,coalesce(actual_cents,0) as actual_cents,queue_msg_id
    from private.my_stuff_research_jobs
    where status in ('queued','document_queued')
    order by created_at,id
    for update
  loop
    if v_job.actual_cents < 0 or v_job.actual_cents > v_job.reserved_cents then
      raise exception 'RESEARCH_RELEASE_INCONSISTENT';
    end if;
    v_expected_release := v_job.reserved_cents-v_job.actual_cents;

    if (select count(*)
        from private.my_stuff_research_budget_ledger l
        where l.job_id=v_job.id
          and l.user_id=v_job.user_id
          and l.month_start=v_job.reservation_month
          and l.kind='reservation'
          and l.cents=v_job.reserved_cents
          and l.attempt_number=0) <> 1
       or (select count(*)
           from private.my_stuff_research_budget_ledger l
           where l.job_id=v_job.id and l.kind='reservation') <> 1 then
      raise exception 'RESEARCH_RESERVATION_INCONSISTENT';
    end if;

    select count(*),
           coalesce(bool_and(
             l.user_id=v_job.user_id
             and l.month_start=v_job.reservation_month
             and l.kind='release'
             and l.cents=v_expected_release
             and l.attempt_number=0
           ),true)
      into v_release_count,v_release_exact
    from private.my_stuff_research_budget_ledger l
    where l.job_id=v_job.id and l.kind='release';

    if v_release_count > 1 or not v_release_exact then
      raise exception 'RESEARCH_RELEASE_INCONSISTENT';
    end if;
    if v_release_count = 0 then
      insert into private.my_stuff_research_budget_ledger(
        job_id,user_id,month_start,kind,cents,attempt_number
      ) values (
        v_job.id,v_job.user_id,v_job.reservation_month,'release',v_expected_release,0
      );
    end if;

    if v_job.queue_msg_id is null then
      raise exception 'RESEARCH_QUEUE_MESSAGE_INCONSISTENT';
    end if;
    execute $query$
      select count(*),
             coalesce(bool_and(message=$2),false)
      from pgmq.q_my_stuff_research_v1
      where msg_id=$1
    $query$
      into v_queue_count,v_queue_exact
      using v_job.queue_msg_id,
            jsonb_build_object('job_id',v_job.id,'schema_version',1);
    if v_queue_count <> 1 or not v_queue_exact then
      raise exception 'RESEARCH_QUEUE_MESSAGE_INCONSISTENT';
    end if;

    select pgmq.delete('my_stuff_research_v1',v_job.queue_msg_id)
      into v_deleted;
    if v_deleted is distinct from true then
      raise exception 'RESEARCH_QUEUE_DELETE_FAILED';
    end if;
    execute 'select count(*) from pgmq.q_my_stuff_research_v1 where msg_id=$1'
      into v_queue_count using v_job.queue_msg_id;
    if v_queue_count <> 0 then
      raise exception 'RESEARCH_QUEUE_DELETE_FAILED';
    end if;

    update private.my_stuff_research_jobs
    set status='cancelled',
        last_error_code='RESEARCH_RETIRED',
        queue_msg_id=null,
        lease_owner=null,
        lease_token=null,
        lease_expires_at=null,
        state_version=state_version+1,
        updated_at=now()
    where id=v_job.id
      and status in ('queued','document_queued')
      and queue_msg_id=v_job.queue_msg_id;
    get diagnostics v_updated=row_count;
    if v_updated <> 1 then
      raise exception 'RESEARCH_QUEUE_MESSAGE_INCONSISTENT';
    end if;
  end loop;

  -- A replay may see no queue row only after this migration's terminal marker
  -- and exact original-cohort reconciliation are both authoritative.
  if exists (
    select 1
    from private.my_stuff_research_jobs j
    where j.status='cancelled'
      and j.last_error_code='RESEARCH_RETIRED'
      and (
        j.queue_msg_id is not null
        or j.lease_owner is not null
        or j.lease_token is not null
        or j.lease_expires_at is not null
        or coalesce(j.actual_cents,0)<0
        or coalesce(j.actual_cents,0)>j.reserved_cents
        or (select count(*)
            from private.my_stuff_research_budget_ledger l
            where l.job_id=j.id and l.kind='release')<>1
        or not exists (
          select 1
          from private.my_stuff_research_budget_ledger l
          where l.job_id=j.id
            and l.user_id=j.user_id
            and l.month_start=j.reservation_month
            and l.kind='release'
            and l.cents=j.reserved_cents-coalesce(j.actual_cents,0)
            and l.attempt_number=0
        )
      )
  ) then
    raise exception 'RESEARCH_TERMINAL_RECONCILIATION_INCONSISTENT';
  end if;
end
$$;

-- This name remains as a permanent owner-safe tombstone. Even a future grant
-- cannot reactivate the retired provider path.
create or replace function private.activate_my_stuff_research_v1()
returns void
language plpgsql
security definer
set search_path=pg_catalog
as $$
begin
  raise exception 'RESEARCH_RETIRED';
end
$$;

-- Remove direct mutation of retired internals while preserving service-role
-- read-only audit/history access. SECURITY DEFINER calls continue to work only
-- for the database owner, and all externally reachable mutators are revoked below.
do $$
declare
  v_table record;
begin
  for v_table in
    select c.oid::regclass as relation_name
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='private'
      and c.relkind in ('r','p')
      and (
        c.relname like 'my_stuff_research_%'
        or c.relname like 'my_stuff_document_%'
      )
    order by c.relname
  loop
    execute format(
      'revoke insert,update,delete,truncate,references,trigger on table %s from public,anon,authenticated,service_role',
      v_table.relation_name
    );
    execute format('grant select on table %s to service_role',v_table.relation_name);
  end loop;
end
$$;

-- Revoke every research mutator/worker overload and every document execution,
-- dispatch, settlement, failure, recovery, or transport-control entrypoint.
-- The three owner-facing status/review functions and document result function
-- remain read-only and keep their prior authenticated ACLs.
do $$
declare
  v_function record;
begin
  for v_function in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private')
      and (
        (
          p.proname like '%my_stuff_research%'
          and not (
            n.nspname='public'
            and p.proname in (
              'get_my_stuff_research_status_v1',
              'get_my_stuff_research_review_v1',
              'get_my_stuff_research_review_v2'
            )
          )
        )
        or p.proname in (
          'enqueue_my_document_job_v1',
          'prepare_document_job_v1',
          'read_document_job_v1',
          'claim_document_job_v1',
          'claim_document_job_v1_atomic',
          'lease_document_dispatch_v1',
          'recover_document_dispatch_v1',
          'reconcile_document_usage_v1',
          'observe_document_transport_v1',
          'get_document_transport_status_v1',
          'authorize_document_transport_release_v1',
          'finalize_document_job_v1',
          'fail_document_preflight_v1',
          'fail_document_job_v1',
          'fail_document_job_v2',
          'assert_document_job_v1',
          'document_binding_v1',
          'settle_document_accounting_v1'
        )
      )
    order by n.nspname,p.proname,p.oid
  loop
    execute format(
      'revoke all on function %s from public,anon,authenticated,service_role',
      v_function.signature
    );
  end loop;
end
$$;

-- Fail the migration if any executable capability survived a direct or PUBLIC
-- grant. This includes private.fail_my_stuff_research_job_v2 and all overloads.
do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    cross join unnest(array['anon','authenticated','service_role']) role_name
    where n.nspname in ('public','private')
      and (
        (
          p.proname like '%my_stuff_research%'
          and not (
            n.nspname='public'
            and p.proname in (
              'get_my_stuff_research_status_v1',
              'get_my_stuff_research_review_v1',
              'get_my_stuff_research_review_v2'
            )
          )
        )
        or p.proname in (
          'enqueue_my_document_job_v1',
          'prepare_document_job_v1',
          'read_document_job_v1',
          'claim_document_job_v1',
          'claim_document_job_v1_atomic',
          'lease_document_dispatch_v1',
          'recover_document_dispatch_v1',
          'reconcile_document_usage_v1',
          'observe_document_transport_v1',
          'get_document_transport_status_v1',
          'authorize_document_transport_release_v1',
          'finalize_document_job_v1',
          'fail_document_preflight_v1',
          'fail_document_job_v1',
          'fail_document_job_v2',
          'assert_document_job_v1',
          'document_binding_v1',
          'settle_document_accounting_v1'
        )
      )
      and has_function_privilege(role_name,p.oid,'EXECUTE')
  ) then
    raise exception 'RESEARCH_EXECUTE_PRIVILEGE_SURVIVED';
  end if;
end
$$;

commit;
