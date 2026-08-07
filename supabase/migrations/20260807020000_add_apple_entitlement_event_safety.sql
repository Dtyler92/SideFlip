-- Replay-safe Apple entitlement state. REVIEW ONLY: do not apply without an
-- approved production migration gate and handler changes that use this RPC.
begin;

alter table public.user_entitlements
  add column apple_latest_transaction_id text,
  add column apple_latest_signed_at timestamptz,
  add column apple_latest_notification_uuid uuid;

create table public.apple_entitlement_events (
  id uuid primary key default gen_random_uuid(),
  original_transaction_id text not null,
  transaction_id text not null,
  notification_uuid uuid,
  provider_signed_at timestamptz not null,
  status text not null check (status in ('active', 'grace_period', 'expired', 'revoked', 'refunded', 'canceled')),
  product_id text not null,
  expires_at timestamptz,
  received_at timestamptz not null default now(),
  check (expires_at is null or expires_at >= provider_signed_at)
);
-- A transaction can receive later signed lifecycle states (expiration,
-- revocation, refund). Deduplicate webhooks by Apple's notification UUID, while
-- signed-time/status ordering below makes client-originated repeats harmless.
create index apple_entitlement_events_transaction_signed_idx on public.apple_entitlement_events (original_transaction_id, transaction_id, provider_signed_at desc);
create unique index apple_entitlement_events_notification_unique on public.apple_entitlement_events (notification_uuid) where notification_uuid is not null;
create index apple_entitlement_events_original_signed_idx on public.apple_entitlement_events (original_transaction_id, provider_signed_at desc);

alter table public.apple_entitlement_events enable row level security;
revoke all on table public.user_entitlements from public, anon, authenticated;
revoke all on table public.account_deletion_tombstones from public, anon, authenticated;
revoke all on table public.apple_entitlement_events from public, anon, authenticated;
grant select, insert, update on table public.user_entitlements to service_role;
grant select, insert, update on table public.account_deletion_tombstones to service_role;
grant select, insert on table public.apple_entitlement_events to service_role;

create function public.apply_apple_entitlement_event(
  p_user_id uuid, p_original_transaction_id text, p_transaction_id text,
  p_notification_uuid uuid, p_provider_signed_at timestamptz, p_status text,
  p_product_id text, p_starts_at timestamptz, p_expires_at timestamptz
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare existing_user_id uuid; inserted_count integer := 0;
begin
  -- Serialize all first-bind, replay, and webhook updates for this Apple subscription.
  perform pg_advisory_xact_lock(hashtextextended(p_original_transaction_id, 0));
  if exists (
    select 1 from public.account_deletion_tombstones t
    where t.user_id = p_user_id or p_original_transaction_id = any(t.apple_original_transaction_ids)
  ) then
    raise exception 'APPLE_EVENT_FOR_DELETED_ACCOUNT' using errcode = 'P0001';
  end if;
  select user_id into existing_user_id from public.user_entitlements
    where source = 'apple' and original_transaction_id = p_original_transaction_id for update;
  if existing_user_id is not null and existing_user_id <> p_user_id then
    raise exception 'APPLE_TRANSACTION_ALREADY_BOUND' using errcode = 'P0001';
  end if;

  insert into public.apple_entitlement_events (original_transaction_id, transaction_id, notification_uuid, provider_signed_at, status, product_id, expires_at)
  values (p_original_transaction_id, p_transaction_id, p_notification_uuid, p_provider_signed_at, p_status, p_product_id, p_expires_at)
  on conflict do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then return false; end if;

  if existing_user_id is null then
    insert into public.user_entitlements (user_id, source, status, product_id, original_transaction_id, starts_at, expires_at, apple_latest_transaction_id, apple_latest_signed_at, apple_latest_notification_uuid, last_verified_at)
    values (p_user_id, 'apple', p_status, p_product_id, p_original_transaction_id, p_starts_at, p_expires_at, p_transaction_id, p_provider_signed_at, p_notification_uuid, now());
  else
    update public.user_entitlements set status = p_status, product_id = p_product_id, expires_at = p_expires_at,
      apple_latest_transaction_id = p_transaction_id, apple_latest_signed_at = p_provider_signed_at,
      apple_latest_notification_uuid = p_notification_uuid, last_verified_at = now()
    where source = 'apple' and user_id = p_user_id and original_transaction_id = p_original_transaction_id
      and (
        apple_latest_signed_at is null or p_provider_signed_at > apple_latest_signed_at
        or (p_provider_signed_at = apple_latest_signed_at and
          case p_status when 'revoked' then 6 when 'refunded' then 5 when 'expired' then 4 when 'canceled' then 3 when 'grace_period' then 2 else 1 end
          > case status when 'revoked' then 6 when 'refunded' then 5 when 'expired' then 4 when 'canceled' then 3 when 'grace_period' then 2 else 1 end
        )
      );
  end if;
  return true;
end;
$$;

revoke all on function public.apply_apple_entitlement_event(uuid, text, text, uuid, timestamptz, text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_apple_entitlement_event(uuid, text, text, uuid, timestamptz, text, text, timestamptz, timestamptz) to service_role;
commit;
