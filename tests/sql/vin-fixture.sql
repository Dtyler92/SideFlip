begin;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema auth;
create table auth.users (
  id uuid primary key
);

insert into auth.users(id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444');

-- Minimal pg_cron-compatible catalog for hosts where the extension package is
-- unavailable. The harness removes only CREATE EXTENSION from the production
-- schedule migration; all scheduling and fail-closed assertions execute here.
create schema cron;
create table cron.job (
  jobid bigint generated always as identity primary key,
  schedule text not null,
  command text not null,
  database text not null default current_database(),
  username text not null default current_user,
  active boolean not null default true,
  jobname text not null
);

create function cron.schedule(p_jobname text, p_schedule text, p_command text)
returns bigint
language plpgsql
as $$
declare v_jobid bigint;
begin
  insert into cron.job(jobname, schedule, command)
  values (p_jobname, p_schedule, p_command)
  returning jobid into v_jobid;
  return v_jobid;
end;
$$;

create function cron.unschedule(p_jobid bigint)
returns boolean
language plpgsql
as $$
begin
  delete from cron.job where jobid = p_jobid;
  return found;
end;
$$;

commit;
