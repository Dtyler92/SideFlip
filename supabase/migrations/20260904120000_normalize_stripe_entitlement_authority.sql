-- REVIEW ONLY. Do not apply without the separately approved production inventory,
-- provider-verified reconciliation, and explicit read-cutover gate. No state in this
-- migration is derived from browser-writable profiles subscription columns.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.user_entitlements
  drop constraint user_entitlements_status_check;
alter table public.user_entitlements
  add constraint user_entitlements_status_check
  check (status in ('active', 'trialing', 'grace_period', 'expired', 'revoked', 'refunded', 'canceled'));

alter table public.user_entitlements enable row level security;
revoke all on table public.user_entitlements from public, anon, authenticated;
grant select, insert, update on table public.user_entitlements to service_role;

-- Immutable subscription ownership is separate from the current per-user snapshot.
-- It prevents a replaced or deleted subscription from later binding to another user.
create table public.stripe_subscription_ownership (
  provider_subscription_id text primary key check (
    char_length(provider_subscription_id) between 1 and 255
    and provider_subscription_id = btrim(provider_subscription_id)
  ),
  user_id uuid not null,
  provider_customer_id text not null check (
    char_length(provider_customer_id) between 1 and 255
    and provider_customer_id = btrim(provider_customer_id)
  ),
  first_verified_at timestamptz not null check (isfinite(first_verified_at)),
  created_at timestamptz not null default now()
);
alter table public.stripe_subscription_ownership enable row level security;
revoke all on table public.stripe_subscription_ownership from public, anon, authenticated;
grant select, insert on table public.stripe_subscription_ownership to service_role;

create table public.stripe_subscription_state (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  provider_subscription_id text not null unique
    references public.stripe_subscription_ownership(provider_subscription_id),
  provider_customer_id text not null check (
    char_length(provider_customer_id) between 1 and 255
    and provider_customer_id = btrim(provider_customer_id)
  ),
  status text not null check (status in (
    'active','trialing','past_due','unpaid','canceled','incomplete','incomplete_expired','paused'
  )),
  current_period_end timestamptz not null check (isfinite(current_period_end)),
  latest_provider_created_at timestamptz not null check (isfinite(latest_provider_created_at)),
  latest_event_id text not null check (
    char_length(latest_event_id) between 1 and 255
    and latest_event_id = btrim(latest_event_id)
  ),
  latest_event_type text not null check (latest_event_type in (
    'customer.subscription.created','customer.subscription.updated',
    'customer.subscription.deleted','reconciliation.snapshot'
  )),
  last_verified_at timestamptz not null check (isfinite(last_verified_at)),
  updated_at timestamptz not null default now()
);
alter table public.stripe_subscription_state enable row level security;
revoke all on table public.stripe_subscription_state from public, anon, authenticated;
grant select, insert, update on table public.stripe_subscription_state to service_role;

-- Compatibility is the safe default. It may be changed only after a provider-backed
-- inventory and reconciliation, never merely because this migration was installed.
create table public.stripe_entitlement_rollout_state (
  singleton boolean primary key default true check (singleton),
  read_mode text not null default 'compatibility' check (read_mode in ('compatibility','canonical')),
  inventory_verified_at timestamptz,
  reconciliation_completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (inventory_verified_at is null or isfinite(inventory_verified_at)),
  check (reconciliation_completed_at is null or isfinite(reconciliation_completed_at)),
  check (read_mode <> 'canonical' or (inventory_verified_at is not null and reconciliation_completed_at is not null))
);
insert into public.stripe_entitlement_rollout_state(singleton) values(true);
alter table public.stripe_entitlement_rollout_state enable row level security;
revoke all on table public.stripe_entitlement_rollout_state from public, anon, authenticated;
grant select, update on table public.stripe_entitlement_rollout_state to service_role;

create or replace function public.stripe_entitlement_read_mode()
returns text
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select read_mode from public.stripe_entitlement_rollout_state where singleton
$$;
revoke all on function public.stripe_entitlement_read_mode() from public, anon, authenticated;
grant execute on function public.stripe_entitlement_read_mode() to service_role;

create or replace function public.complete_stripe_entitlement_reconciliation(
  p_inventory_provider_verified boolean,
  p_all_current_subscriptions_reconciled boolean
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if p_inventory_provider_verified is not true
     or p_all_current_subscriptions_reconciled is not true then
    return false;
  end if;
  update public.stripe_entitlement_rollout_state
  set read_mode='canonical', inventory_verified_at=now(),
      reconciliation_completed_at=now(), updated_at=now()
  where singleton and read_mode='compatibility';
  return found;
end;
$$;
revoke all on function public.complete_stripe_entitlement_reconciliation(boolean,boolean) from public, anon, authenticated;
grant execute on function public.complete_stripe_entitlement_reconciliation(boolean,boolean) to service_role;

-- Existing profile preference writes remain available. Only Stripe-owned columns
-- are fenced, including inserts, regardless of broad legacy table grants/policies.
create or replace function public.protect_stripe_profile_columns()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if pg_has_role(current_user, 'service_role', 'usage') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.subscription_status is not null or new.subscription_id is not null
       or new.stripe_customer_id is not null or new.current_period_end is not null
       or new.stripe_latest_event_at is not null or new.stripe_latest_event_id is not null then
      raise insufficient_privilege using message = 'Stripe profile columns are provider-managed';
    end if;
  elsif new.subscription_status is distinct from old.subscription_status
     or new.subscription_id is distinct from old.subscription_id
     or new.stripe_customer_id is distinct from old.stripe_customer_id
     or new.current_period_end is distinct from old.current_period_end
     or new.stripe_latest_event_at is distinct from old.stripe_latest_event_at
     or new.stripe_latest_event_id is distinct from old.stripe_latest_event_id then
    raise insufficient_privilege using message = 'Stripe profile columns are provider-managed';
  end if;
  return new;
end;
$$;
revoke all on function public.protect_stripe_profile_columns() from public, anon, authenticated;
create trigger profiles_protect_stripe_provider_columns
before insert or update on public.profiles
for each row execute function public.protect_stripe_profile_columns();

create or replace function public.stripe_event_precedence(p_event_type text, p_status text)
returns integer
language sql immutable
set search_path = pg_catalog, public
as $$
  select case
    when p_event_type = 'customer.subscription.deleted' then 100
    when p_status = 'canceled' then 90
    when p_status = 'unpaid' then 80
    when p_status = 'past_due' then 70
    when p_status = 'incomplete_expired' then 65
    when p_status = 'paused' then 60
    when p_status = 'incomplete' then 50
    when p_status = 'active' then 20
    when p_status = 'trialing' then 10
    else 0
  end
$$;
revoke all on function public.stripe_event_precedence(text,text) from public, anon, authenticated;
grant execute on function public.stripe_event_precedence(text,text) to service_role;

create or replace function public.user_has_verified_pro_entitlement(p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.user_entitlements e
    where e.user_id = p_user_id
      and (
        (e.source = 'stripe' and e.status in ('active', 'trialing'))
        or (e.source = 'apple' and e.status in ('active', 'grace_period'))
      )
      and e.expires_at is not null and isfinite(e.expires_at) and e.expires_at > now()
      and e.last_verified_at is not null and isfinite(e.last_verified_at) and e.last_verified_at <= now()
  )
$$;
revoke all on function public.user_has_verified_pro_entitlement(uuid) from public, anon, authenticated;

-- Internal canonical state transition. The profile row is used only as an account
-- existence/locking target and compatibility write sink; none of its provider
-- values participate in binding, ownership, ordering, acceptance, or rejection.
create or replace function public.apply_verified_stripe_state_internal(
  p_event_id text, p_event_type text, p_provider_created_at timestamptz,
  p_user_id uuid, p_subscription_id text, p_customer_id text,
  p_status text, p_current_period_end timestamptz, p_record_webhook boolean,
  p_product_id text default null
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_state public.stripe_subscription_state%rowtype;
  v_owner public.stripe_subscription_ownership%rowtype;
  v_existing_entitlement_user uuid;
  v_inserted integer := 0;
  v_entitlement_status text;
  v_previous_status text;
  v_incoming_precedence integer;
  v_current_precedence integer;
begin
  if p_user_id is null
     or nullif(btrim(p_event_id), '') is null or p_event_id <> btrim(p_event_id)
     or nullif(btrim(p_subscription_id), '') is null or p_subscription_id <> btrim(p_subscription_id)
     or nullif(btrim(p_customer_id), '') is null or p_customer_id <> btrim(p_customer_id)
     or p_provider_created_at is null or not isfinite(p_provider_created_at)
     or p_current_period_end is null or not isfinite(p_current_period_end)
     or p_status not in ('active','trialing','past_due','unpaid','canceled','incomplete','incomplete_expired','paused')
     or (p_record_webhook and p_event_type not in ('customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'))
     or (not p_record_webhook and p_event_type <> 'reconciliation.snapshot')
     or (p_event_type = 'customer.subscription.deleted' and p_status <> 'canceled') then
    return jsonb_build_object('applied',false);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('stripe-user:' || p_user_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('stripe-subscription:' || p_subscription_id, 0));

  perform 1 from public.profiles where id=p_user_id for update;
  if not found then return jsonb_build_object('applied',false); end if;
  if exists (
    select 1 from public.account_deletion_tombstones t
    where t.user_id=p_user_id
       or p_subscription_id=any(coalesce(t.stripe_subscription_ids,'{}'::text[]))
       or p_customer_id=any(coalesce(t.stripe_customer_ids,'{}'::text[]))
  ) then return jsonb_build_object('applied',false); end if;

  select e.user_id into v_existing_entitlement_user
  from public.user_entitlements e
  where e.source='stripe' and e.provider_subscription_id=p_subscription_id
  for update;
  if v_existing_entitlement_user is not null and v_existing_entitlement_user <> p_user_id then
    return jsonb_build_object('applied',false);
  end if;

  select * into v_owner from public.stripe_subscription_ownership
  where provider_subscription_id=p_subscription_id for update;
  if v_owner.provider_subscription_id is not null
     and (v_owner.user_id <> p_user_id or v_owner.provider_customer_id <> p_customer_id) then
    return jsonb_build_object('applied',false);
  end if;

  if p_record_webhook and exists(
    select 1 from public.stripe_webhook_events where event_id=p_event_id
  ) then return jsonb_build_object('applied',false); end if;

  select * into v_state from public.stripe_subscription_state
  where user_id=p_user_id for update;
  v_previous_status := v_state.status;
  v_incoming_precedence := public.stripe_event_precedence(p_event_type,p_status);

  if v_state.user_id is not null then
    if v_state.provider_subscription_id <> p_subscription_id then
      if v_state.status in ('active','trialing')
         or p_provider_created_at <= v_state.latest_provider_created_at then
        return jsonb_build_object('applied',false);
      end if;
    else
      v_current_precedence := public.stripe_event_precedence(v_state.latest_event_type,v_state.status);
      if not (
        p_provider_created_at > v_state.latest_provider_created_at
        or (p_provider_created_at = v_state.latest_provider_created_at
            and v_incoming_precedence > v_current_precedence)
        or (p_provider_created_at = v_state.latest_provider_created_at
            and v_incoming_precedence = v_current_precedence
            and p_event_id > v_state.latest_event_id)
      ) then return jsonb_build_object('applied',false); end if;
    end if;
  end if;

  if p_record_webhook then
    insert into public.stripe_webhook_events(
      event_id,event_type,provider_created_at,subscription_id,customer_id
    ) values(p_event_id,p_event_type,p_provider_created_at,p_subscription_id,p_customer_id)
    on conflict do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted=0 then return jsonb_build_object('applied',false); end if;
  end if;

  -- Defer first ownership binding until every rejection/order check has passed, so
  -- a losing or duplicate event cannot reserve a provider identifier.
  if v_owner.provider_subscription_id is null then
    insert into public.stripe_subscription_ownership(
      provider_subscription_id,user_id,provider_customer_id,first_verified_at
    ) values(p_subscription_id,p_user_id,p_customer_id,p_provider_created_at);
  end if;

  insert into public.stripe_subscription_state(
    user_id,provider_subscription_id,provider_customer_id,status,current_period_end,
    latest_provider_created_at,latest_event_id,latest_event_type,last_verified_at
  ) values(
    p_user_id,p_subscription_id,p_customer_id,p_status,p_current_period_end,
    p_provider_created_at,p_event_id,p_event_type,now()
  ) on conflict(user_id) do update set
    provider_subscription_id=excluded.provider_subscription_id,
    provider_customer_id=excluded.provider_customer_id,
    status=excluded.status,
    current_period_end=excluded.current_period_end,
    latest_provider_created_at=excluded.latest_provider_created_at,
    latest_event_id=excluded.latest_event_id,
    latest_event_type=excluded.latest_event_type,
    last_verified_at=excluded.last_verified_at,
    updated_at=now();

  -- Compatibility mirror only. Trusted decisions above do not read these columns.
  update public.profiles set
    subscription_status=p_status, subscription_id=p_subscription_id,
    stripe_customer_id=p_customer_id, current_period_end=p_current_period_end,
    stripe_latest_event_at=p_provider_created_at, stripe_latest_event_id=p_event_id
  where id=p_user_id;

  v_entitlement_status := case
    when p_status='active' then 'active'
    when p_status='trialing' then 'trialing'
    when p_status='canceled' then 'canceled'
    else 'expired'
  end;
  update public.user_entitlements
  set status='revoked', last_verified_at=now()
  where user_id=p_user_id and source='stripe'
    and provider_subscription_id is distinct from p_subscription_id
    and status in ('active','trialing');
  insert into public.user_entitlements(
    user_id,source,status,product_id,provider_customer_id,
    provider_subscription_id,expires_at,last_verified_at
  ) values(
    p_user_id,'stripe',v_entitlement_status,
    case when p_product_id in ('monthly','annual') then p_product_id else null end,
    p_customer_id,p_subscription_id,p_current_period_end,now()
  ) on conflict(source,provider_subscription_id) where provider_subscription_id is not null
  do update set
    status=excluded.status,
    product_id=coalesce(excluded.product_id,user_entitlements.product_id),
    provider_customer_id=excluded.provider_customer_id,
    expires_at=excluded.expires_at,
    last_verified_at=excluded.last_verified_at
  where user_entitlements.user_id=excluded.user_id;

  return jsonb_build_object('applied',true,'previous_status',v_previous_status);
end;
$$;
revoke all on function public.apply_verified_stripe_state_internal(text,text,timestamptz,uuid,text,text,text,timestamptz,boolean,text) from public, anon, authenticated, service_role;

-- Preserve the installed eight-argument signature and boolean return contract.
create or replace function public.apply_stripe_subscription_event(
  p_event_id text, p_event_type text, p_provider_created_at timestamptz,
  p_user_id uuid, p_subscription_id text, p_customer_id text,
  p_status text, p_current_period_end timestamptz
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_result jsonb;
begin
  v_result := public.apply_verified_stripe_state_internal(
    p_event_id,p_event_type,p_provider_created_at,p_user_id,p_subscription_id,
    p_customer_id,p_status,p_current_period_end,true,null
  );
  return coalesce((v_result->>'applied')::boolean,false);
end;
$$;
revoke all on function public.apply_stripe_subscription_event(text,text,timestamptz,uuid,text,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.apply_stripe_subscription_event(text,text,timestamptz,uuid,text,text,text,timestamptz) to service_role;

-- Preserve the installed analytics-aware fourteen-argument signature.
create or replace function public.apply_stripe_subscription_event_v2(
  p_event_id text, p_event_type text, p_provider_created_at timestamptz,
  p_user_id uuid, p_subscription_id text, p_customer_id text,
  p_status text, p_current_period_end timestamptz,
  p_cancel_at_period_end boolean, p_cancellation_just_scheduled boolean,
  p_was_trial boolean, p_churn_type text, p_plan text, p_billing_interval text
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
  v_previous_status text;
  v_analytics_event text;
  v_safe_plan text;
  v_safe_interval text;
begin
  v_result := public.apply_verified_stripe_state_internal(
    p_event_id,p_event_type,p_provider_created_at,p_user_id,p_subscription_id,
    p_customer_id,p_status,p_current_period_end,true,p_plan
  );
  if not coalesce((v_result->>'applied')::boolean,false) then return false; end if;
  v_previous_status := v_result->>'previous_status';
  v_safe_plan := case when p_plan in ('monthly','annual') then p_plan else null end;
  v_safe_interval := case
    when p_billing_interval in ('month','monthly') then 'monthly'
    when p_billing_interval in ('year','annual') then 'annual'
    else null
  end;
  v_analytics_event := case
    when p_event_type='customer.subscription.created' and p_status='trialing' then 'subscription_trial_started'
    when p_event_type='customer.subscription.created' and p_status='active' then 'subscription_started'
    when v_previous_status not in ('active','trialing') and p_status in ('active','trialing') then 'subscription_reactivated'
    when p_event_type='customer.subscription.deleted' or p_status in ('canceled','unpaid') then 'subscription_ended'
    else 'subscription_updated'
  end;
  perform public.enqueue_analytics_outbox(
    'stripe:' || p_event_id || ':' || v_analytics_event,
    p_user_id,v_analytics_event,p_provider_created_at,
    jsonb_strip_nulls(jsonb_build_object(
      'provider','stripe','status',p_status,'previous_status',v_previous_status,
      'plan',v_safe_plan,'billing_interval',v_safe_interval,
      'is_trial',p_status='trialing','was_trial',p_was_trial,
      'churn_type',case when v_analytics_event='subscription_ended'
        and p_churn_type in ('trial_canceled','scheduled','immediate') then p_churn_type else null end
    ))
  );
  if p_cancel_at_period_end and p_cancellation_just_scheduled then
    perform public.enqueue_analytics_outbox(
      'stripe:' || p_event_id || ':subscription_cancellation_scheduled',
      p_user_id,'subscription_cancellation_scheduled',p_provider_created_at,
      jsonb_strip_nulls(jsonb_build_object(
        'provider','stripe','status',p_status,'plan',v_safe_plan,'billing_interval',v_safe_interval
      ))
    );
  end if;
  return true;
end;
$$;
revoke all on function public.apply_stripe_subscription_event_v2(text,text,timestamptz,uuid,text,text,text,timestamptz,boolean,boolean,boolean,text,text,text) from public, anon, authenticated;
grant execute on function public.apply_stripe_subscription_event_v2(text,text,timestamptz,uuid,text,text,text,timestamptz,boolean,boolean,boolean,text,text,text) to service_role;

-- This is intentionally separate from webhook ingestion. The trusted service must
-- fetch the current Stripe subscription and attest that the supplied snapshot was
-- provider-verified; profile data is never an input to this contract.
create or replace function public.reconcile_verified_stripe_subscription(
  p_reconciliation_id text, p_provider_verified boolean, p_verified_at timestamptz,
  p_user_id uuid, p_subscription_id text, p_customer_id text,
  p_status text, p_current_period_end timestamptz
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_result jsonb;
begin
  if p_provider_verified is not true
     or p_verified_at is null or not isfinite(p_verified_at)
     or nullif(btrim(p_reconciliation_id),'') is null
     or p_reconciliation_id <> btrim(p_reconciliation_id) then
    return false;
  end if;
  v_result := public.apply_verified_stripe_state_internal(
    'reconcile:' || p_reconciliation_id,'reconciliation.snapshot',p_verified_at,
    p_user_id,p_subscription_id,p_customer_id,p_status,p_current_period_end,false,null
  );
  return coalesce((v_result->>'applied')::boolean,false);
end;
$$;
revoke all on function public.reconcile_verified_stripe_subscription(text,boolean,timestamptz,uuid,text,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.reconcile_verified_stripe_subscription(text,boolean,timestamptz,uuid,text,text,text,timestamptz) to service_role;

commit;
