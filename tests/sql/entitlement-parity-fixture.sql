create extension if not exists pgcrypto;
create schema auth;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end;
$$;

create table auth.users (id uuid primary key);
create table public.profiles (
  id uuid primary key references auth.users(id),
  subscription_status text,
  subscription_id text,
  stripe_customer_id text,
  current_period_end timestamptz,
  stripe_latest_event_at timestamptz,
  stripe_latest_event_id text,
  analytics_opt_out boolean not null default false,
  currency text default 'USD',
  language text default 'en',
  onboarded boolean not null default false
);
grant select, insert, update on public.profiles to authenticated;

create table public.user_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('stripe', 'apple', 'admin')),
  status text not null check (status in ('active', 'grace_period', 'expired', 'revoked', 'refunded', 'canceled')),
  product_id text,
  provider_customer_id text,
  provider_subscription_id text,
  original_transaction_id text,
  starts_at timestamptz,
  expires_at timestamptz,
  last_verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at is null or starts_at is null or expires_at >= starts_at),
  check (source <> 'apple' or (original_transaction_id is not null and product_id is not null))
);
create unique index user_entitlements_provider_subscription_unique
  on public.user_entitlements(source, provider_subscription_id)
  where provider_subscription_id is not null;
alter table public.user_entitlements enable row level security;

create table public.account_deletion_tombstones (
  user_id uuid primary key,
  stripe_subscription_ids text[] not null default '{}'::text[],
  stripe_customer_ids text[] not null default '{}'::text[],
  apple_original_transaction_ids text[] not null default '{}'::text[]
);
create table public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  provider_created_at timestamptz not null,
  subscription_id text,
  customer_id text,
  received_at timestamptz not null default now()
);

create table public.analytics_outbox (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  distinct_id uuid not null,
  event_name text not null,
  occurred_at timestamptz not null,
  properties jsonb not null default '{}'::jsonb
);
create function public.enqueue_analytics_outbox(
  p_dedupe_key text, p_distinct_id uuid, p_event_name text,
  p_occurred_at timestamptz, p_properties jsonb default '{}'::jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.analytics_outbox(dedupe_key,distinct_id,event_name,occurred_at,properties)
  values(p_dedupe_key,p_distinct_id,p_event_name,p_occurred_at,p_properties)
  on conflict(dedupe_key) do nothing returning id into v_id;
  return v_id;
end;
$$;

insert into auth.users(id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444'),
  ('55555555-5555-4555-8555-555555555555'),
  ('66666666-6666-4666-8666-666666666666'),
  ('77777777-7777-4777-8777-777777777777');
insert into public.profiles(id,subscription_id,subscription_status) values
  ('11111111-1111-4111-8111-111111111111','sub_browser_only','active'),
  ('22222222-2222-4222-8222-222222222222',null,null),
  ('33333333-3333-4333-8333-333333333333',null,null),
  ('44444444-4444-4444-8444-444444444444',null,null),
  ('55555555-5555-4555-8555-555555555555',null,null),
  ('66666666-6666-4666-8666-666666666666',null,null),
  ('77777777-7777-4777-8777-777777777777','sub_profile_only_valid','active');
insert into public.account_deletion_tombstones(user_id,stripe_subscription_ids,stripe_customer_ids)
values('44444444-4444-4444-8444-444444444444',array['sub_deleted'],array['cus_deleted']);
