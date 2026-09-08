-- Raise per-user maintenance-research onboarding capacity without changing
-- the global/provider spending ceiling, per-job reservation, or concurrency fence.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $$
declare c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid='private.my_stuff_research_runtime_config'::regclass
      and contype='c'
      and (
        pg_get_constraintdef(oid) ilike '%daily_user_job_cap%'
        or pg_get_constraintdef(oid) ilike '%monthly_user_job_cap%'
      )
  loop
    execute format('alter table private.my_stuff_research_runtime_config drop constraint %I',c.conname);
  end loop;
end $$;

alter table private.my_stuff_research_runtime_config
  add constraint my_stuff_research_runtime_daily_user_job_cap_check
    check(daily_user_job_cap between 1 and 15),
  add constraint my_stuff_research_runtime_monthly_user_job_cap_check
    check(monthly_user_job_cap between 1 and 50);

update private.my_stuff_research_runtime_config
set daily_user_job_cap=15,
    monthly_user_job_cap=50,
    updated_at=now()
where singleton;

commit;
