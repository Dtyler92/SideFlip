-- REVIEW ONLY: additive, service-only repair for verified duplicate Apple
-- entitlement states. Do not deploy without the production migration gate.
begin;

create table public.apple_entitlement_reconciliation_versions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.apple_entitlement_events(id),
  user_id uuid not null,
  original_transaction_id text not null,
  transaction_id text not null,
  provider_signed_at timestamptz not null,
  status text not null check (status in ('active', 'grace_period')),
  previous_expires_at timestamptz,
  reconciled_expires_at timestamptz not null,
  verified_at timestamptz not null,
  reconciled_at timestamptz not null default now()
);
create index apple_entitlement_reconciliation_versions_event_idx
  on public.apple_entitlement_reconciliation_versions(event_id, reconciled_at desc);

alter table public.apple_entitlement_reconciliation_versions enable row level security;
revoke all on table public.apple_entitlement_reconciliation_versions from public, anon, authenticated;
grant select on table public.apple_entitlement_reconciliation_versions to service_role;

create function public.reconcile_verified_apple_entitlement(
  p_user_id uuid,
  p_original_transaction_id text,
  p_transaction_id text,
  p_provider_signed_at timestamptz,
  p_status text,
  p_expires_at timestamptz,
  p_verified_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_entitlement public.user_entitlements%rowtype;
  v_event_id uuid;
  v_event_expires_at timestamptz;
  v_updated_count integer := 0;
begin
  if p_user_id is null
     or nullif(btrim(p_original_transaction_id), '') is null
     or nullif(btrim(p_transaction_id), '') is null
     or p_status not in ('active', 'grace_period')
     or p_provider_signed_at is null or not isfinite(p_provider_signed_at)
     or p_expires_at is null or not isfinite(p_expires_at)
     or p_verified_at is null or not isfinite(p_verified_at) then
    raise exception 'INVALID_APPLE_RECONCILIATION' using errcode = '22023';
  end if;

  -- Match the provider writer's subscription lock and the account-deletion
  -- state machine's user lock. The row lock below also fences direct Auth
  -- deletion/cascade while the repair transaction is in flight.
  perform pg_advisory_xact_lock(hashtextextended(p_original_transaction_id, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select e.* into v_entitlement
  from public.user_entitlements e
  where e.source = 'apple'
    and e.original_transaction_id = p_original_transaction_id
  for update;

  if not found then return false; end if;
  if v_entitlement.user_id <> p_user_id then
    raise exception 'APPLE_TRANSACTION_ALREADY_BOUND' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.account_deletion_tombstones t
    where t.user_id = p_user_id
       or p_original_transaction_id = any(t.apple_original_transaction_ids)
  ) then
    raise exception 'APPLE_EVENT_FOR_DELETED_ACCOUNT' using errcode = 'P0001';
  end if;

  -- Repair only the exact state still authoritative in the entitlement row.
  -- This prevents an equal-time terminal event or any newer event from being
  -- overwritten by an access-granting reconciliation.
  if v_entitlement.apple_latest_transaction_id is distinct from p_transaction_id
     or v_entitlement.apple_latest_signed_at is distinct from p_provider_signed_at
     or v_entitlement.status is distinct from p_status then
    return false;
  end if;

  select e.id, e.expires_at into v_event_id, v_event_expires_at
  from public.apple_entitlement_events e
  where e.original_transaction_id = p_original_transaction_id
    and e.transaction_id = p_transaction_id
    and e.provider_signed_at = p_provider_signed_at
    and e.status = p_status
  for update;
  if not found then return false; end if;

  if v_event_expires_at is not distinct from p_expires_at
     and v_entitlement.expires_at is not distinct from p_expires_at then
    return false;
  end if;

  update public.apple_entitlement_events
  set expires_at = p_expires_at
  where id = v_event_id;

  update public.user_entitlements
  set expires_at = p_expires_at,
      last_verified_at = greatest(last_verified_at, p_verified_at)
  where id = v_entitlement.id
    and source = 'apple'
    and user_id = p_user_id
    and original_transaction_id = p_original_transaction_id
    and apple_latest_transaction_id = p_transaction_id
    and apple_latest_signed_at = p_provider_signed_at
    and status = p_status;
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    raise exception 'APPLE_RECONCILIATION_STATE_CHANGED' using errcode = '40001';
  end if;

  insert into public.apple_entitlement_reconciliation_versions(
    event_id, user_id, original_transaction_id, transaction_id,
    provider_signed_at, status, previous_expires_at,
    reconciled_expires_at, verified_at
  ) values (
    v_event_id, p_user_id, p_original_transaction_id, p_transaction_id,
    p_provider_signed_at, p_status, v_event_expires_at,
    p_expires_at, p_verified_at
  );

  return true;
end;
$$;

revoke all on function public.reconcile_verified_apple_entitlement(uuid,text,text,timestamptz,text,timestamptz,timestamptz)
  from public, anon, authenticated;
grant execute on function public.reconcile_verified_apple_entitlement(uuid,text,text,timestamptz,text,timestamptz,timestamptz)
  to service_role;

commit;
