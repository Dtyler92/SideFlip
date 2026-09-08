-- Raise only SideFlip's aggregate monthly provider ceiling to $100.
-- Per-user and per-job limits remain $25 and all concurrency/tool caps remain unchanged.
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
      and pg_get_constraintdef(oid) ilike '%global_monthly_budget_cents%'
  loop
    execute format('alter table private.my_stuff_research_runtime_config drop constraint %I',c.conname);
  end loop;
end $$;

alter table private.my_stuff_research_runtime_config
  add constraint my_stuff_research_runtime_global_monthly_budget_check
  check(global_monthly_budget_cents between per_job_budget_cents and 10000);

update private.my_stuff_research_runtime_config
set global_monthly_budget_cents=10000,
    updated_at=now()
where singleton;

commit;
