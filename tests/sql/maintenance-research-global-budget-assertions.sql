\set ON_ERROR_STOP on
begin;

do $$
declare cfg private.my_stuff_research_runtime_config%rowtype;
begin
  select * into cfg from private.my_stuff_research_runtime_config where singleton;
  if cfg.global_monthly_budget_cents<>10000 then
    raise exception 'global maintenance research budget was not raised to $100';
  end if;
  if cfg.per_job_budget_cents<>2500 or cfg.monthly_user_budget_cents<>2500 then
    raise exception 'individual maintenance research exposure changed';
  end if;
  if cfg.daily_user_job_cap<>15 or cfg.monthly_user_job_cap<>50 then
    raise exception 'job caps changed while raising the global budget';
  end if;
end $$;

savepoint invalid_global_budget;
\set ON_ERROR_STOP off
update private.my_stuff_research_runtime_config set global_monthly_budget_cents=10001 where singleton;
\if :ERROR
  rollback to savepoint invalid_global_budget;
\else
  \set ON_ERROR_STOP on
  \echo 'global budget constraint unexpectedly accepted $100.01'
  \quit 1
\endif
\set ON_ERROR_STOP on
commit;
