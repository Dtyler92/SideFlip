-- Keep the operator-only paid-research activation gate coherent with the
-- previously approved cap and aggregate-budget migrations. Document dispatch
-- remains independently disabled.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create or replace function private.activate_my_stuff_research_v1()
returns void
language plpgsql
security definer
set search_path=pg_catalog,private,vault,cron
as $$
declare
  enabled_source_domains integer;
  v_secret_count integer;
  v_config private.my_stuff_research_runtime_config%rowtype;
begin
  if session_user not in ('postgres','supabase_admin') then
    raise exception 'Owner session required';
  end if;

  select count(*) into enabled_source_domains
  from private.my_stuff_research_source_domains
  where enabled
    and terms_reviewed_on between current_date-365 and current_date
    and robots_reviewed_on between current_date-30 and current_date;

  select count(*) into v_secret_count
  from vault.decrypted_secrets
  where name in ('maintenance_research_worker_url','maintenance_research_worker_secret')
    and nullif(decrypted_secret,'') is not null;

  if enabled_source_domains<1 or v_secret_count<>2 or exists(
    select 1
    from private.my_stuff_research_source_domains
    where enabled and (
      include_subdomains is not true
      or allowed_path_prefixes<>array['/']::text[]
      or cardinality(manufacturer_aliases)<1
      or cardinality(manufacturer_aliases)>50
      or exists(
        select 1
        from unnest(manufacturer_aliases) alias(make_name)
        where nullif(trim(alias.make_name),'') is null
           or length(alias.make_name)>80
      )
    )
  ) then
    raise exception 'Research source policy or Vault configuration is incomplete';
  end if;

  select * into v_config
  from private.my_stuff_research_runtime_config
  where singleton
  for update;

  if v_config.singleton is null
    or v_config.enabled is distinct from false
    or v_config.document_lane_enabled is distinct from false
    or v_config.provider_name is distinct from 'xai'
    or v_config.provider_model is distinct from 'grok-4.6'
    or v_config.retention_policy is distinct from 'standard-30-days-store-false'
    or v_config.policy_version is distinct from 'research-v2-xai-citations'
    or v_config.per_job_budget_cents is distinct from 2500
    or v_config.monthly_user_budget_cents is distinct from 2500
    or v_config.global_monthly_budget_cents is distinct from 10000
    or v_config.daily_user_job_cap is distinct from 15
    or v_config.monthly_user_job_cap is distinct from 50
    or v_config.max_attempts is distinct from 2
    or v_config.max_searches is distinct from 3
    or v_config.max_fetches is distinct from 2
    or v_config.provider_timeout_seconds is distinct from 120
    or v_config.lease_seconds is distinct from 300
  then
    raise exception 'Research provider configuration is incomplete';
  end if;

  update private.my_stuff_research_runtime_config
  set enabled=true,
      updated_at=now()
  where singleton;

  perform cron.schedule(
    'sideflip-maintenance-research-worker',
    '*/5 * * * *',
    'select private.invoke_my_stuff_research_worker_v1()'
  );
end
$$;

revoke all on function private.activate_my_stuff_research_v1()
from public,anon,authenticated;
grant execute on function private.activate_my_stuff_research_v1()
to service_role;

commit;
