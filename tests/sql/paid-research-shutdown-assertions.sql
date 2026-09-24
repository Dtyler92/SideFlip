\set ON_ERROR_STOP on

create or replace function public._shutdown_assert(p_ok boolean,p_message text)
returns void language plpgsql as $$
begin
  if p_ok is distinct from true then
    raise exception 'shutdown assertion failed: %',p_message;
  end if;
end
$$;

select public._shutdown_assert(
  (select enabled=false from private.my_stuff_research_runtime_config where singleton),
  'runtime remains disabled'
);

select public._shutdown_assert(
  not exists(select 1 from cron.job where jobname='sideflip-maintenance-research-worker'),
  'research cron is absent'
);

select public._shutdown_assert(
  not exists(select 1 from private.my_stuff_research_jobs where status in ('queued','running','document_queued','document_pending')),
  'no executable jobs remain'
);

select public._shutdown_assert(
  (select status='cancelled'
          and last_error_code='RESEARCH_RETIRED'
          and queue_msg_id is null
          and lease_owner is null
          and lease_token is null
          and lease_expires_at is null
   from private.my_stuff_research_jobs
   where id='90000000-0000-4000-8000-000000000011'),
  'legacy queued job is cancelled and cleared'
);

select public._shutdown_assert(
  (select count(*)=1
          and min(month_start)=date '2026-08-01'
          and min(cents)=1250
   from private.my_stuff_research_budget_ledger
   where job_id='90000000-0000-4000-8000-000000000011'
     and kind='reservation'),
  'original reservation is unchanged'
);

select public._shutdown_assert(
  (select count(*)=1
          and min(month_start)=date '2026-08-01'
          and min(cents)=1050
   from private.my_stuff_research_budget_ledger
   where job_id='90000000-0000-4000-8000-000000000011'
     and kind='release'),
  'exact reserved-minus-actual amount is released once in original month'
);

select public._shutdown_assert(
  not exists(select 1 from pgmq.messages where queue_name='my_stuff_research_v1'),
  'exact queued PGMQ delivery is deleted'
);

select public._shutdown_assert(
  not has_table_privilege('service_role','private.my_stuff_research_budget_ledger','INSERT')
  and not has_table_privilege('service_role','private.my_stuff_research_budget_ledger','UPDATE')
  and not has_table_privilege('service_role','private.my_stuff_research_budget_ledger','DELETE'),
  'ledger is read-only to service role'
);

select public._shutdown_assert(
  has_table_privilege('service_role','private.my_stuff_research_budget_ledger','SELECT'),
  'ledger remains readable for audit'
);

select public._shutdown_assert(
  has_function_privilege('authenticated','public.get_my_stuff_research_status_v1(uuid)','EXECUTE'),
  'owner status remains readable'
);

select public._shutdown_assert(
  not has_function_privilege('anon','public.enqueue_my_stuff_research_v3(uuid,text,text)','EXECUTE')
  and not has_function_privilege('authenticated','public.enqueue_my_stuff_research_v3(uuid,text,text)','EXECUTE')
  and not has_function_privilege('service_role','public.enqueue_my_stuff_research_v3(uuid,text,text)','EXECUTE'),
  'old enqueue client is denied for every external role'
);

select public._shutdown_assert(
  not has_function_privilege('anon','private.fail_my_stuff_research_job_v2(uuid,uuid,bigint,text,text)','EXECUTE')
  and not has_function_privilege('authenticated','private.fail_my_stuff_research_job_v2(uuid,uuid,bigint,text,text)','EXECUTE')
  and not has_function_privilege('service_role','private.fail_my_stuff_research_job_v2(uuid,uuid,bigint,text,text)','EXECUTE'),
  'accidentally exposed private failure function is closed'
);

select public._shutdown_assert(
  not exists (
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
          'enqueue_my_document_job_v1','prepare_document_job_v1','read_document_job_v1',
          'claim_document_job_v1','claim_document_job_v1_atomic','lease_document_dispatch_v1',
          'recover_document_dispatch_v1','reconcile_document_usage_v1',
          'observe_document_transport_v1','get_document_transport_status_v1',
          'authorize_document_transport_release_v1','finalize_document_job_v1',
          'fail_document_preflight_v1','fail_document_job_v1','fail_document_job_v2',
          'assert_document_job_v1','document_binding_v1','settle_document_accounting_v1'
        )
      )
      and has_function_privilege(role_name,p.oid,'EXECUTE')
  ),
  'all paid research execution ACLs are zero'
);

do $$
begin
  begin
    perform private.activate_my_stuff_research_v1();
    raise exception 'activation unexpectedly returned';
  exception
    when raise_exception then
      if sqlerrm<>'RESEARCH_RETIRED' then
        raise;
      end if;
  end;
end
$$;

-- Optional full-document-stack assertions are catalog guarded so this same
-- acceptance file proves the historical base stack where those objects do not exist.
do $$
declare
  v_document_lane boolean;
  v_ok boolean;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='private'
      and table_name='my_stuff_research_runtime_config'
      and column_name='document_lane_enabled'
  ) then
    execute 'select document_lane_enabled=false from private.my_stuff_research_runtime_config where singleton'
      into v_document_lane;
    perform public._shutdown_assert(v_document_lane,'document lane remains disabled');
  end if;

  if to_regclass('private.my_stuff_document_executions') is not null then
    execute $query$
      select
        (select status='cancelled' and last_error_code='RESEARCH_RETIRED'
         from private.my_stuff_research_jobs
         where id='90000000-0000-4000-8000-000000000012')
        and
        (select count(*)=1 and min(month_start)=date '2026-07-01' and min(cents)=1250
         from private.my_stuff_research_budget_ledger
         where job_id='90000000-0000-4000-8000-000000000012' and kind='release')
        and
        (select status='document_failed' and lease_owner is null and lease_token is null and lease_expires_at is null
         from private.my_stuff_research_jobs
         where id='90000000-0000-4000-8000-000000000013')
        and
        (select state='failed' and cost_ticks=0 and error_code='DOCUMENT_SOURCE_UNAVAILABLE'
         from private.my_stuff_document_executions
         where job_id='90000000-0000-4000-8000-000000000013')
        and
        (select count(*)=1 and min(month_start)=date '2026-06-01' and min(cents)=1250
         from private.my_stuff_research_budget_ledger
         where job_id='90000000-0000-4000-8000-000000000013' and kind='release')
    $query$ into v_ok;
    perform public._shutdown_assert(v_ok,'document queued and READY work reconcile safely');
  end if;
end
$$;

drop function public._shutdown_assert(boolean,text);
