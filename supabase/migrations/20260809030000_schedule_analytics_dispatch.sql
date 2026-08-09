begin;

-- Supabase Cron uses pg_cron and pg_net. The dispatcher credential itself is
-- provisioned separately in Vault after the compatible backend is live; no
-- credential value is stored in migration history or cron.job.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

-- Keep one deterministic job across migration replays.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'sideflip-analytics-dispatch') then
    perform cron.unschedule('sideflip-analytics-dispatch');
  end if;
end
$$;

select cron.schedule(
  'sideflip-analytics-dispatch',
  '*/5 * * * *',
  $cron$
    select net.http_post(
      url := 'https://sideflip.org/api/analytics-dispatch',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || dispatcher_secret.decrypted_secret
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    )
    from (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'sideflip_analytics_cron_secret'
      limit 1
    ) as dispatcher_secret;
  $cron$
);

commit;
