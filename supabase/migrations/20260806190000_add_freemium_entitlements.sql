-- Freemium entitlement foundation and account-deletion tombstones.
-- Additive only: legacy profiles.subscription_* fields remain the compatibility
-- source for existing clients while server-verified providers write this table.
--
-- DO NOT APPLY without reviewing the live schema/RLS inventory and approving the
-- production migration. No deletion routine is created in this migration.

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
  check (
    (source <> 'apple')
    or (original_transaction_id is not null and product_id is not null)
  )
);

create unique index user_entitlements_apple_original_transaction_unique
  on public.user_entitlements(original_transaction_id)
  where source = 'apple' and original_transaction_id is not null;

create unique index user_entitlements_provider_subscription_unique
  on public.user_entitlements(source, provider_subscription_id)
  where provider_subscription_id is not null;

create index user_entitlements_user_active_idx
  on public.user_entitlements(user_id, status, expires_at desc);

alter table public.user_entitlements enable row level security;

-- No browser/client policies are deliberately granted. Entitlement state is
-- returned only by authenticated server endpoints after provider verification.

-- This table intentionally has no foreign key to auth.users. The deletion API
-- must copy provider correlation IDs here before it removes the Auth user, so
-- late Stripe/Apple webhooks can be suppressed after entitlement rows cascade.
create table public.account_deletion_tombstones (
  user_id uuid primary key,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  source text not null default 'in_app' check (source in ('in_app', 'support')),
  status text not null default 'requested' check (status in ('requested', 'processing', 'completed', 'failed')),
  apple_original_transaction_ids text[] not null default '{}'::text[],
  stripe_subscription_ids text[] not null default '{}'::text[],
  stripe_customer_ids text[] not null default '{}'::text[],
  provider_cleanup_status jsonb not null default '{}'::jsonb,
  last_error_code text,
  updated_at timestamptz not null default now()
);

create index account_deletion_tombstones_apple_transactions_idx
  on public.account_deletion_tombstones using gin (apple_original_transaction_ids);

create index account_deletion_tombstones_stripe_subscriptions_idx
  on public.account_deletion_tombstones using gin (stripe_subscription_ids);

create index account_deletion_tombstones_stripe_customers_idx
  on public.account_deletion_tombstones using gin (stripe_customer_ids);

alter table public.account_deletion_tombstones enable row level security;

create function public.set_freemium_entitlement_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger user_entitlements_set_updated_at
before update on public.user_entitlements
for each row execute function public.set_freemium_entitlement_updated_at();

create trigger account_deletion_tombstones_set_updated_at
before update on public.account_deletion_tombstones
for each row execute function public.set_freemium_entitlement_updated_at();

-- No browser/client policies are deliberately granted. The authenticated account
-- deletion API uses the service role after independently resolving the caller.
