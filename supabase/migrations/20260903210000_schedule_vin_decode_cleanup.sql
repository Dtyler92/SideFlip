begin;

-- Scheduling is part of the deployment contract. If pg_cron cannot be
-- installed, this migration errors and rolls back instead of silently leaving
-- VIN cache/rate-limit retention unscheduled.
create extension if not exists pg_cron with schema pg_catalog;

do $$
declare
  v_job record;
begin
  if to_regprocedure('public.cleanup_vin_decode_state(integer,integer,text)') is null then
    raise exception 'VIN cleanup function must exist before scheduling';
  end if;

  if to_regclass('cron.job') is null
     or to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regprocedure('cron.unschedule(bigint)') is null then
    raise exception 'pg_cron scheduling API is unavailable';
  end if;

  -- Remove every same-name job visible to the migration owner before creating
  -- the canonical definition. Failure to remove one aborts the transaction.
  for v_job in
    select jobid
    from cron.job
    where jobname = 'sideflip-vin-state-cleanup'
    order by jobid
  loop
    if not cron.unschedule(v_job.jobid) then
      raise exception 'failed to replace VIN cleanup cron job %', v_job.jobid;
    end if;
  end loop;

  perform cron.schedule(
    'sideflip-vin-state-cleanup',
    '17 * * * *',
    'select public.cleanup_vin_decode_state(500, null, null);'
  );
end
$$;

-- Treat an inactive, altered, missing, or duplicate job as a migration failure.
do $$
begin
  if (
    select count(*)
    from cron.job
    where jobname = 'sideflip-vin-state-cleanup'
      and schedule = '17 * * * *'
      and command = 'select public.cleanup_vin_decode_state(500, null, null);'
      and active
  ) <> 1
  or (
    select count(*)
    from cron.job
    where jobname = 'sideflip-vin-state-cleanup'
  ) <> 1 then
    raise exception 'VIN cleanup cron job verification failed';
  end if;
end
$$;

commit;
