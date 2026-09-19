\set ON_ERROR_STOP on

insert into vault.decrypted_secrets(name,decrypted_secret)
values
  ('maintenance_research_worker_url','https://example.invalid/worker'),
  ('maintenance_research_worker_secret','local-test-secret')
on conflict(name) do update set decrypted_secret=excluded.decrypted_secret;

update private.my_stuff_research_source_domains
set include_subdomains=true,
    allowed_path_prefixes=array['/']::text[],
    manufacturer_aliases=case
      when cardinality(manufacturer_aliases)=0 then array[manufacturer]
      else manufacturer_aliases
    end,
    terms_reviewed_on=current_date,
    robots_reviewed_on=current_date
where enabled;

update private.my_stuff_research_runtime_config
set enabled=false,
    document_lane_enabled=true
where singleton;

select public._research_raises(
  'select private.activate_my_stuff_research_v1()',
  'Research provider configuration is incomplete'
);

select public._research_assert(
  (select enabled is false and document_lane_enabled is true
   from private.my_stuff_research_runtime_config where singleton)
  and not exists(select 1 from cron.job where jobname='sideflip-maintenance-research-worker'),
  'operator activation fails closed while document dispatch is enabled'
);

update private.my_stuff_research_runtime_config
set document_lane_enabled=false
where singleton;

select private.activate_my_stuff_research_v1();

select public._research_assert(
  (select enabled is true
      and document_lane_enabled is false
      and provider_name='xai'
      and provider_model='grok-4.6'
      and retention_policy='standard-30-days-store-false'
      and policy_version='research-v2-xai-citations'
      and per_job_budget_cents=2500
      and monthly_user_budget_cents=2500
      and global_monthly_budget_cents=10000
      and daily_user_job_cap=15
      and monthly_user_job_cap=50
      and max_attempts=2
      and lease_seconds=300
   from private.my_stuff_research_runtime_config where singleton),
  'operator activation accepts final budget/cap config and leaves document dispatch off'
);

select public._research_assert(
  (select count(*)=1 and bool_and(active) and min(schedule)='*/5 * * * *'
   from cron.job where jobname='sideflip-maintenance-research-worker'),
  'operator activation schedules exactly one active worker cron'
);
