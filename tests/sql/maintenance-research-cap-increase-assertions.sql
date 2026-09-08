\set ON_ERROR_STOP on
begin;

do $$
declare cfg private.my_stuff_research_runtime_config%rowtype;
begin
  select * into cfg from private.my_stuff_research_runtime_config where singleton;
  if cfg.daily_user_job_cap<>15 or cfg.monthly_user_job_cap<>50 then
    raise exception 'maintenance research job caps were not raised';
  end if;
  if cfg.per_job_budget_cents<>2500 or cfg.monthly_user_budget_cents<>2500 or cfg.global_monthly_budget_cents<>2500 then
    raise exception 'spending safeguards changed while raising job caps';
  end if;
  if cfg.max_attempts<>2 or cfg.max_searches<>3 or cfg.max_fetches<>2 then
    raise exception 'provider work bounds changed while raising job caps';
  end if;
end $$;

savepoint invalid_daily_cap;
\set ON_ERROR_STOP off
update private.my_stuff_research_runtime_config set daily_user_job_cap=16 where singleton;
\if :ERROR
  rollback to savepoint invalid_daily_cap;
\else
  \set ON_ERROR_STOP on
  \echo 'daily cap constraint unexpectedly accepted 16'
  \quit 1
\endif
\set ON_ERROR_STOP on

savepoint invalid_monthly_cap;
\set ON_ERROR_STOP off
update private.my_stuff_research_runtime_config set monthly_user_job_cap=51 where singleton;
\if :ERROR
  rollback to savepoint invalid_monthly_cap;
\else
  \set ON_ERROR_STOP on
  \echo 'monthly cap constraint unexpectedly accepted 51'
  \quit 1
\endif
\set ON_ERROR_STOP on
commit;
