-- LOCAL DISPOSABLE ONLY. Full optional-document-stack coherence checks.
do $$
begin
  if not exists(
    select 1 from private.my_stuff_research_runtime_config
    where singleton and not enabled and not document_lane_enabled
      and per_job_budget_cents=1250 and max_attempts=1
  ) then raise exception 'retry budget/document defaults incoherent'; end if;
  if exists(
    select 1 from private.my_stuff_research_jobs
    where status in ('queued','document_queued','document_pending') and reserved_cents<>1250
  ) then raise exception 'legacy reservation authority remains'; end if;
end $$;

update private.my_stuff_research_runtime_config
set enabled=false,document_lane_enabled=false,
    provider_name='xai',provider_model='grok-4.6',
    retention_policy='standard-30-days-store-false',policy_version='research-v2-xai-citations',
    per_job_budget_cents=1250,monthly_user_budget_cents=2500,global_monthly_budget_cents=10000,
    daily_user_job_cap=15,monthly_user_job_cap=50,max_attempts=1,max_searches=3,max_fetches=2,
    provider_timeout_seconds=120,lease_seconds=300
where singleton;

select private.activate_my_stuff_research_v1();

do $$
begin
  if not exists(
    select 1 from private.my_stuff_research_runtime_config
    where singleton and enabled and not document_lane_enabled
  ) then raise exception 'document-stack activation did not remain default-off'; end if;
  if (select count(*) from cron.job where jobname='sideflip-maintenance-research-worker')<>1
  then raise exception 'document-stack activation cron mismatch'; end if;
end $$;