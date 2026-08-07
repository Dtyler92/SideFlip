-- Stripe event replay/order safety. REVIEW ONLY; apply only with the reviewed
-- entitlement/deletion migration set.
begin;

create table public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  provider_created_at timestamptz not null,
  subscription_id text,
  customer_id text,
  received_at timestamptz not null default now()
);
alter table public.stripe_webhook_events enable row level security;
revoke all on table public.stripe_webhook_events from public, anon, authenticated;
grant select, insert on table public.stripe_webhook_events to service_role;

alter table public.profiles add column stripe_latest_event_at timestamptz;
alter table public.profiles add column stripe_latest_event_id text;

create function public.apply_stripe_subscription_event(
  p_event_id text, p_event_type text, p_provider_created_at timestamptz,
  p_user_id uuid, p_subscription_id text, p_customer_id text,
  p_status text, p_current_period_end timestamptz
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare inserted_count integer := 0; v_profile public.profiles%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select * into v_profile from public.profiles where id = p_user_id for update;
  if exists (select 1 from public.account_deletion_tombstones t where t.user_id = p_user_id or p_subscription_id = any(t.stripe_subscription_ids) or p_customer_id = any(t.stripe_customer_ids)) then
    return false;
  end if;
  if v_profile.id is null then return false; end if;
  -- A subscription replacement is permitted only from a terminal current
  -- subscription and only with strictly newer provider time. Otherwise an old
  -- subscription event is rejected before it is recorded as consumed.
  if v_profile.subscription_id is not null and v_profile.subscription_id <> p_subscription_id
     and not (v_profile.subscription_status in ('canceled','unpaid')
              and (v_profile.stripe_latest_event_at is null or p_provider_created_at > v_profile.stripe_latest_event_at)) then
    return false;
  end if;
  insert into public.stripe_webhook_events(event_id,event_type,provider_created_at,subscription_id,customer_id)
  values(p_event_id,p_event_type,p_provider_created_at,p_subscription_id,p_customer_id)
  on conflict do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then return false; end if;
  update public.profiles set subscription_status=p_status, subscription_id=p_subscription_id, stripe_customer_id=p_customer_id, current_period_end=p_current_period_end, stripe_latest_event_at=p_provider_created_at, stripe_latest_event_id=p_event_id
  where id=p_user_id
    and (
      stripe_latest_event_at is null or p_provider_created_at > stripe_latest_event_at
      or (p_provider_created_at = stripe_latest_event_at and
        case p_status when 'canceled' then 5 when 'unpaid' then 4 when 'past_due' then 3 when 'trialing' then 2 else 1 end
        > case subscription_status when 'canceled' then 5 when 'unpaid' then 4 when 'past_due' then 3 when 'trialing' then 2 else 1 end
      )
      or (p_provider_created_at = stripe_latest_event_at and p_status = subscription_status and p_event_id > coalesce(stripe_latest_event_id, ''))
    );
  return true;
end;
$$;
revoke all on function public.apply_stripe_subscription_event(text,text,timestamptz,uuid,text,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.apply_stripe_subscription_event(text,text,timestamptz,uuid,text,text,text,timestamptz) to service_role;
commit;
