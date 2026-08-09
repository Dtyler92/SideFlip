-- Durable, privacy-conscious server analytics for verified Apple and Stripe lifecycle events.
-- REVIEW ONLY: do not apply without explicit production migration approval and the matching backend release.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.profiles
  add column analytics_opt_out boolean not null default false;

create table public.analytics_outbox (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique check (char_length(dedupe_key) between 1 and 240),
  distinct_id uuid not null,
  event_name text not null check (event_name in (
    'stripe_checkout_created',
    'checkout_completed',
    'subscription_trial_started',
    'subscription_started',
    'subscription_reactivated',
    'subscription_updated',
    'subscription_cancellation_scheduled',
    'subscription_ended',
    'subscription_payment_succeeded',
    'subscription_payment_failed',
    'subscription_trial_ending',
    'subscription_refunded',
    'subscription_revoked'
  )),
  occurred_at timestamptz not null,
  properties jsonb not null default '{}'::jsonb check (jsonb_typeof(properties) = 'object'),
  status text not null default 'pending' check (status in ('pending','processing','delivered','suppressed','dead_letter')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  claim_token uuid,
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 80),
  created_at timestamptz not null default now()
);
create index analytics_outbox_dispatch_idx on public.analytics_outbox (status, next_attempt_at, created_at);
create index analytics_outbox_distinct_idx on public.analytics_outbox (distinct_id, created_at desc);
alter table public.analytics_outbox enable row level security;
revoke all on table public.analytics_outbox from public, anon, authenticated;
grant select, insert, update on table public.analytics_outbox to service_role;

-- No auth.users foreign key: erasure work must survive Auth deletion. The
-- scoped PostHog personal key is held only by the worker, never in this table.
create table public.analytics_deletion_queue (
  user_id uuid primary key,
  -- PostHog bulk_delete is asynchronous. `submitted` means accepted by the
  -- provider, never completed; it is intentionally re-submitted daily because
  -- this API exposes no documented job-status endpoint.
  status text not null default 'pending' check (status in ('pending','processing','submitted')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  claim_token uuid,
  lease_expires_at timestamptz,
  deleted_at timestamptz,
  provider_submitted_at timestamptz,
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 80),
  requested_at timestamptz not null default now()
);
create index analytics_deletion_dispatch_idx on public.analytics_deletion_queue(status,next_attempt_at,requested_at);
alter table public.analytics_deletion_queue enable row level security;
revoke all on table public.analytics_deletion_queue from public, anon, authenticated;
grant select, insert, update, delete on table public.analytics_deletion_queue to service_role;

create function public.enqueue_analytics_outbox(
  p_dedupe_key text,
  p_distinct_id uuid,
  p_event_name text,
  p_occurred_at timestamptz,
  p_properties jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if exists (select 1 from public.account_deletion_tombstones where user_id = p_distinct_id) then
    return null;
  end if;
  if exists (select 1 from public.profiles where id = p_distinct_id and analytics_opt_out) then
    return null;
  end if;
  insert into public.analytics_outbox(dedupe_key, distinct_id, event_name, occurred_at, properties)
  values (p_dedupe_key, p_distinct_id, p_event_name, p_occurred_at, coalesce(p_properties, '{}'::jsonb))
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.analytics_outbox where dedupe_key = p_dedupe_key;
  end if;
  return v_id;
end;
$$;
revoke all on function public.enqueue_analytics_outbox(text,uuid,text,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_analytics_outbox(text,uuid,text,timestamptz,jsonb) to service_role;

-- Signed Stripe notifications that do not directly mutate entitlement state still
-- need durable replay protection (and email deduplication). The return value means
-- the provider event was newly accepted, even when analytics consent suppresses
-- the outbox row.
create function public.apply_stripe_analytics_event(
  p_event_id text, p_event_type text, p_provider_created_at timestamptz,
  p_user_id uuid, p_subscription_id text, p_customer_id text,
  p_event_name text, p_properties jsonb default '{}'::jsonb
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_inserted integer := 0; v_opted_out boolean := false;
begin
  perform pg_advisory_xact_lock(hashtextextended('stripe-event:' || p_event_id, 0));
  if not exists (select 1 from public.profiles where id = p_user_id) then return false; end if;
  if exists (
    select 1 from public.account_deletion_tombstones t
    where t.user_id = p_user_id
       or p_subscription_id = any(coalesce(t.stripe_subscription_ids, '{}'::text[]))
       or p_customer_id = any(coalesce(t.stripe_customer_ids, '{}'::text[]))
  ) then return false; end if;

  insert into public.stripe_webhook_events(event_id,event_type,provider_created_at,subscription_id,customer_id)
  values(p_event_id,p_event_type,p_provider_created_at,p_subscription_id,p_customer_id)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then return false; end if;

  select analytics_opt_out into v_opted_out from public.profiles where id = p_user_id;
  if not coalesce(v_opted_out, false) then
    perform public.enqueue_analytics_outbox(
      'stripe:' || p_event_id || ':' || p_event_name,
      p_user_id, p_event_name, p_provider_created_at,
      jsonb_build_object('provider','stripe') || coalesce(p_properties, '{}'::jsonb)
    );
  end if;
  return true;
end;
$$;
revoke all on function public.apply_stripe_analytics_event(text,text,timestamptz,uuid,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.apply_stripe_analytics_event(text,text,timestamptz,uuid,text,text,text,jsonb) to service_role;

create function public.claim_analytics_outbox(p_limit integer default 25)
returns table(id uuid, distinct_id uuid, event_name text, occurred_at timestamptz, properties jsonb, claim_token uuid)
language plpgsql security definer set search_path = public
as $$
begin
  update public.analytics_outbox o
  set status = 'suppressed', claim_token = null, lease_expires_at = null, last_error_code = 'account_deleted'
  where o.status in ('pending','processing')
    and exists (select 1 from public.account_deletion_tombstones t where t.user_id = o.distinct_id);

  update public.analytics_outbox o
  set status = 'suppressed', claim_token = null, lease_expires_at = null, last_error_code = 'analytics_opt_out'
  where o.status in ('pending','processing')
    and exists (select 1 from public.profiles p where p.id = o.distinct_id and p.analytics_opt_out);

  return query
  with candidates as (
    select o.id
    from public.analytics_outbox o
    where (
      (o.status = 'pending' and o.next_attempt_at <= now())
      or (o.status = 'processing' and o.lease_expires_at < now())
    )
    order by o.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  )
  update public.analytics_outbox o
  set status = 'processing', attempt_count = o.attempt_count + 1,
      claim_token = gen_random_uuid(), lease_expires_at = now() + interval '5 minutes', last_error_code = null
  from candidates c
  where o.id = c.id
  returning o.id, o.distinct_id, o.event_name, o.occurred_at, o.properties, o.claim_token;
end;
$$;
revoke all on function public.claim_analytics_outbox(integer) from public, anon, authenticated;
grant execute on function public.claim_analytics_outbox(integer) to service_role;

create function public.finish_analytics_outbox(
  p_id uuid,
  p_claim_token uuid,
  p_delivered boolean,
  p_error_code text default null
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_attempts integer;
begin
  select attempt_count into v_attempts from public.analytics_outbox where id = p_id and status = 'processing' and claim_token = p_claim_token for update;
  if v_attempts is null then return false; end if;
  if p_delivered then
    update public.analytics_outbox
    set status = 'delivered', delivered_at = now(), claim_token = null, lease_expires_at = null, last_error_code = null
    where id = p_id and status = 'processing' and claim_token = p_claim_token;
  else
    update public.analytics_outbox
    set status = case when v_attempts >= 12 then 'dead_letter' else 'pending' end,
        next_attempt_at = now() + make_interval(secs => least(3600, power(2, least(v_attempts, 11))::integer)),
        claim_token = null, lease_expires_at = null,
        last_error_code = left(coalesce(p_error_code, 'delivery_failed'), 80)
    where id = p_id and status = 'processing' and claim_token = p_claim_token;
  end if;
  return true;
end;
$$;
revoke all on function public.finish_analytics_outbox(uuid,uuid,boolean,text) from public, anon, authenticated;
grant execute on function public.finish_analytics_outbox(uuid,uuid,boolean,text) to service_role;

create function public.queue_analytics_deletion(p_user_id uuid) returns uuid
language plpgsql security definer set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('analytics-delete:' || p_user_id::text, 0));
  delete from public.analytics_outbox where distinct_id = p_user_id;
  insert into public.analytics_deletion_queue(user_id,status,next_attempt_at,claim_token,lease_expires_at,last_error_code)
  -- Wait out the maximum capture lease. A worker that claimed immediately
  -- before this transaction can still submit PostHog capture after the purge.
  values(p_user_id,'pending',now()+interval '5 minutes',null,null,null)
  on conflict(user_id) do update set
    status='pending',
    next_attempt_at=greatest(analytics_deletion_queue.next_attempt_at,now()+interval '5 minutes'),
    claim_token=null, lease_expires_at=null, last_error_code=null;
  return p_user_id;
end;
$$;
revoke all on function public.queue_analytics_deletion(uuid) from public, anon, authenticated;
grant execute on function public.queue_analytics_deletion(uuid) to service_role;

create function public.claim_analytics_deletions(p_limit integer default 25)
returns table(user_id uuid, claim_token uuid)
language plpgsql security definer set search_path = public
as $$
begin
  return query
  with candidates as (
    select q.user_id from public.analytics_deletion_queue q
    where (q.status in ('pending','submitted') and q.next_attempt_at <= now())
       or (q.status='processing' and q.lease_expires_at < now())
    order by q.requested_at for update skip locked
    limit greatest(1,least(coalesce(p_limit,25),100))
  )
  update public.analytics_deletion_queue q
  set status='processing', attempt_count=q.attempt_count+1, claim_token=gen_random_uuid(),
      lease_expires_at=now()+interval '10 minutes', last_error_code=null
  from candidates c where q.user_id=c.user_id
  returning q.user_id,q.claim_token;
end;
$$;
revoke all on function public.claim_analytics_deletions(integer) from public, anon, authenticated;
grant execute on function public.claim_analytics_deletions(integer) to service_role;

create function public.finish_analytics_deletion(p_user_id uuid,p_claim_token uuid,p_submitted boolean,p_error_code text default null)
returns boolean language plpgsql security definer set search_path = public
as $$
begin
  if not exists(select 1 from public.analytics_deletion_queue where user_id=p_user_id and status='processing' and claim_token=p_claim_token for update) then return false; end if;
  update public.analytics_deletion_queue
  set status=case when p_submitted then 'submitted' else 'pending' end,
      deleted_at=null,
      provider_submitted_at=case when p_submitted then now() else provider_submitted_at end,
      next_attempt_at=now()+interval '1 day',
      claim_token=null,lease_expires_at=null,last_error_code=case when p_submitted then null else left(coalesce(p_error_code,'deletion_failed'),80) end
  where user_id=p_user_id and status='processing' and claim_token=p_claim_token;
  return found;
end;
$$;
revoke all on function public.finish_analytics_deletion(uuid,uuid,boolean,text) from public, anon, authenticated;
grant execute on function public.finish_analytics_deletion(uuid,uuid,boolean,text) to service_role;

-- Analytics erasure is fail-open for product-account deletion, but never lost:
-- any surviving tombstone repairs a missing queue row on the next worker run.
create function public.repair_analytics_deletion_queue(p_limit integer default 25)
returns integer language plpgsql security definer set search_path = public
as $$
declare v_count integer;
begin
  with candidates as (
    select t.user_id
    from public.account_deletion_tombstones t
    left join public.analytics_deletion_queue q on q.user_id=t.user_id
    where q.user_id is null
    order by t.requested_at
    limit greatest(1,least(coalesce(p_limit,25),100))
  )
  insert into public.analytics_deletion_queue(user_id,status,next_attempt_at)
  select user_id,'pending',now()+interval '5 minutes' from candidates
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.repair_analytics_deletion_queue(integer) from public, anon, authenticated;
grant execute on function public.repair_analytics_deletion_queue(integer) to service_role;

-- `auth_deleting` is deliberately ambiguous after an Auth Admin timeout. Only
-- the privileged worker may reclaim an expired fence, query Auth, retry removal,
-- and mark completion after Auth is confirmed absent.
create function public.claim_account_deletion_reconciliations(p_limit integer default 5)
returns table(user_id uuid, claim_token uuid)
language plpgsql security definer set search_path = public
as $$
begin
  return query
  with candidates as (
    select t.user_id
    from public.account_deletion_tombstones t
    where t.status='auth_deleting'
      and (t.deletion_lease_expires_at is null or t.deletion_lease_expires_at < now())
    order by t.requested_at
    for update skip locked
    limit greatest(1,least(coalesce(p_limit,5),20))
  )
  update public.account_deletion_tombstones t
  set deletion_lease_id=gen_random_uuid(), deletion_lease_expires_at=now()+interval '2 minutes',
      last_error_code=null
  from candidates c where t.user_id=c.user_id
  returning t.user_id,t.deletion_lease_id;
end;
$$;
revoke all on function public.claim_account_deletion_reconciliations(integer) from public, anon, authenticated;
grant execute on function public.claim_account_deletion_reconciliations(integer) to service_role;

create function public.finish_account_deletion_reconciliation(
  p_user_id uuid,p_claim_token uuid,p_auth_absent boolean,p_error_code text default null
) returns boolean language plpgsql security definer set search_path = public
as $$
begin
  update public.account_deletion_tombstones
  set status=case when p_auth_absent then 'completed' else 'auth_deleting' end,
      completed_at=case when p_auth_absent then now() else completed_at end,
      deletion_lease_id=case when p_auth_absent then null else deletion_lease_id end,
      deletion_lease_expires_at=case when p_auth_absent then null else now()+interval '5 minutes' end,
      provider_cleanup_status=provider_cleanup_status || jsonb_build_object(
        'auth',case when p_auth_absent then 'complete' else 'retrying' end
      ),
      last_error_code=case when p_auth_absent then null else left(coalesce(p_error_code,'auth_reconciliation_failed'),80) end
  where user_id=p_user_id and status='auth_deleting' and deletion_lease_id=p_claim_token;
  return found;
end;
$$;
revoke all on function public.finish_account_deletion_reconciliation(uuid,uuid,boolean,text) from public, anon, authenticated;
grant execute on function public.finish_account_deletion_reconciliation(uuid,uuid,boolean,text) to service_role;

create function public.analytics_queue_backlog() returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'outbox',count(*) filter (where kind='outbox'),
    'deletions',count(*) filter (where kind='deletion'),
    'auth_reconciliations',count(*) filter (where kind='auth')
  )
  from (
    select 'outbox'::text kind from public.analytics_outbox where status in ('pending','processing')
    union all
    select 'deletion' from public.analytics_deletion_queue where status in ('pending','processing','submitted')
    union all
    select 'auth' from public.account_deletion_tombstones where status='auth_deleting'
  ) pending;
$$;
revoke all on function public.analytics_queue_backlog() from public, anon, authenticated;
grant execute on function public.analytics_queue_backlog() to service_role;

-- Provider lifecycle notifications are normally signed after the entitlement's
-- expiration timestamp. Remove the original temporal check that incorrectly
-- rejected legitimate expiration/refund/revocation updates.
do $$
declare r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.apple_entitlement_events'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%expires_at%provider_signed_at%'
  loop
    execute format('alter table public.apple_entitlement_events drop constraint %I', r.conname);
  end loop;
end;
$$;

-- Client verification has no Apple notification UUID. Deduplicate the same signed
-- semantic state while still allowing later signed lifecycle changes.
delete from public.apple_entitlement_events a
using public.apple_entitlement_events b
where a.id > b.id
  and a.original_transaction_id = b.original_transaction_id
  and a.transaction_id = b.transaction_id
  and a.provider_signed_at = b.provider_signed_at
  and a.status = b.status;
create unique index apple_entitlement_events_semantic_unique
  on public.apple_entitlement_events(original_transaction_id, transaction_id, provider_signed_at, status);

drop function public.apply_apple_entitlement_event(uuid,text,text,uuid,timestamptz,text,text,timestamptz,timestamptz);
create function public.apply_apple_entitlement_event(
  p_user_id uuid, p_original_transaction_id text, p_transaction_id text,
  p_notification_uuid uuid, p_provider_signed_at timestamptz, p_status text,
  p_product_id text, p_starts_at timestamptz, p_expires_at timestamptz,
  p_cancellation_just_scheduled boolean default false,
  p_billing_failure boolean default false
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  existing_user_id uuid;
  inserted_count integer := 0;
  state_applied integer := 0;
  previous_status text;
  analytics_event text;
  billing_interval text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_original_transaction_id, 0));
  if exists (
    select 1 from public.account_deletion_tombstones t
    where t.user_id = p_user_id or p_original_transaction_id = any(t.apple_original_transaction_ids)
  ) then
    raise exception 'APPLE_EVENT_FOR_DELETED_ACCOUNT' using errcode = 'P0001';
  end if;
  select user_id, status into existing_user_id, previous_status
  from public.user_entitlements
  where source = 'apple' and original_transaction_id = p_original_transaction_id
  for update;
  if existing_user_id is not null and existing_user_id <> p_user_id then
    raise exception 'APPLE_TRANSACTION_ALREADY_BOUND' using errcode = 'P0001';
  end if;

  insert into public.apple_entitlement_events
    (original_transaction_id, transaction_id, notification_uuid, provider_signed_at, status, product_id, expires_at)
  values
    (p_original_transaction_id, p_transaction_id, p_notification_uuid, p_provider_signed_at, p_status, p_product_id, p_expires_at)
  on conflict do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then return false; end if;

  if existing_user_id is null then
    insert into public.user_entitlements
      (user_id, source, status, product_id, original_transaction_id, starts_at, expires_at,
       apple_latest_transaction_id, apple_latest_signed_at, apple_latest_notification_uuid, last_verified_at)
    values
      (p_user_id, 'apple', p_status, p_product_id, p_original_transaction_id, p_starts_at, p_expires_at,
       p_transaction_id, p_provider_signed_at, p_notification_uuid, now());
    state_applied := 1;
  else
    update public.user_entitlements
    set status = p_status, product_id = p_product_id, expires_at = p_expires_at,
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
    get diagnostics state_applied = row_count;
  end if;

  if state_applied = 1 then
    analytics_event := case
      when existing_user_id is null and p_status in ('active','grace_period') then 'subscription_started'
      when previous_status in ('expired','revoked','refunded','canceled') and p_status in ('active','grace_period') then 'subscription_reactivated'
      when p_status = 'refunded' then 'subscription_refunded'
      when p_status = 'revoked' then 'subscription_revoked'
      when p_status in ('expired','canceled') then 'subscription_ended'
      else 'subscription_updated'
    end;
    billing_interval := case when p_product_id like '%.annual' then 'annual' when p_product_id like '%.monthly' then 'monthly' else null end;
    perform public.enqueue_analytics_outbox(
      'apple:' || p_original_transaction_id || ':' || p_transaction_id || ':' || extract(epoch from p_provider_signed_at)::bigint::text || ':' || p_status,
      p_user_id,
      analytics_event,
      p_provider_signed_at,
      jsonb_strip_nulls(jsonb_build_object(
        'provider','apple', 'status',p_status, 'previous_status',previous_status,
        'product_id',p_product_id, 'billing_interval',billing_interval
      ))
    );
    if p_cancellation_just_scheduled then
      perform public.enqueue_analytics_outbox(
        'apple:' || coalesce(p_notification_uuid::text,p_original_transaction_id || ':' || p_transaction_id || ':' || extract(epoch from p_provider_signed_at)::bigint::text) || ':subscription_cancellation_scheduled',
        p_user_id,'subscription_cancellation_scheduled',p_provider_signed_at,
        jsonb_strip_nulls(jsonb_build_object('provider','apple','status',p_status,'product_id',p_product_id,'billing_interval',billing_interval))
      );
    end if;
    if p_billing_failure then
      perform public.enqueue_analytics_outbox(
        'apple:' || coalesce(p_notification_uuid::text,p_original_transaction_id || ':' || p_transaction_id || ':' || extract(epoch from p_provider_signed_at)::bigint::text) || ':subscription_payment_failed',
        p_user_id,'subscription_payment_failed',p_provider_signed_at,
        jsonb_strip_nulls(jsonb_build_object('provider','apple','status','payment_failed','product_id',p_product_id,'billing_interval',billing_interval))
      );
    end if;
  end if;
  return state_applied = 1;
end;
$$;
revoke all on function public.apply_apple_entitlement_event(uuid,text,text,uuid,timestamptz,text,text,timestamptz,timestamptz,boolean,boolean) from public, anon, authenticated;
grant execute on function public.apply_apple_entitlement_event(uuid,text,text,uuid,timestamptz,text,text,timestamptz,timestamptz,boolean,boolean) to service_role;

create function public.apply_stripe_subscription_event_v2(
  p_event_id text, p_event_type text, p_provider_created_at timestamptz,
  p_user_id uuid, p_subscription_id text, p_customer_id text,
  p_status text, p_current_period_end timestamptz,
  p_cancel_at_period_end boolean, p_cancellation_just_scheduled boolean,
  p_was_trial boolean, p_churn_type text, p_plan text, p_billing_interval text
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  inserted_count integer := 0;
  state_applied integer := 0;
  v_profile public.profiles%rowtype;
  analytics_event text;
  safe_plan text;
  safe_interval text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select * into v_profile from public.profiles where id = p_user_id for update;
  if exists (
    select 1 from public.account_deletion_tombstones t
    where t.user_id = p_user_id or p_subscription_id = any(t.stripe_subscription_ids) or p_customer_id = any(t.stripe_customer_ids)
  ) then return false; end if;
  if v_profile.id is null then return false; end if;
  if v_profile.subscription_id is not null and v_profile.subscription_id <> p_subscription_id
     and not (v_profile.subscription_status in ('canceled','unpaid')
              and (v_profile.stripe_latest_event_at is null or p_provider_created_at > v_profile.stripe_latest_event_at)) then
    return false;
  end if;
  if exists(select 1 from public.stripe_webhook_events where event_id=p_event_id) then return false; end if;

  -- Stripe timestamps are second-granularity. Decide whether the snapshot wins
  -- before recording its event ID. In particular, trialing -> active is a valid
  -- same-second transition; a losing equal-time snapshot remains unconsumed so
  -- reconciliation can retry it rather than treating ambiguity as success.
  if not (
    v_profile.stripe_latest_event_at is null
    or p_provider_created_at > v_profile.stripe_latest_event_at
    or (p_provider_created_at = v_profile.stripe_latest_event_at and v_profile.subscription_status='trialing' and p_status='active')
  ) then return false; end if;

  insert into public.stripe_webhook_events(event_id,event_type,provider_created_at,subscription_id,customer_id)
  values(p_event_id,p_event_type,p_provider_created_at,p_subscription_id,p_customer_id)
  on conflict do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then return false; end if;

  update public.profiles
  set subscription_status=p_status, subscription_id=p_subscription_id,
      stripe_customer_id=p_customer_id, current_period_end=p_current_period_end,
      stripe_latest_event_at=p_provider_created_at, stripe_latest_event_id=p_event_id
  where id=p_user_id;
  get diagnostics state_applied = row_count;
  if state_applied = 0 then return false; end if;

  safe_plan := case when p_plan in ('monthly','annual') then p_plan else null end;
  safe_interval := case when p_billing_interval in ('month','monthly') then 'monthly' when p_billing_interval in ('year','annual') then 'annual' else null end;
  analytics_event := case
    when p_event_type = 'customer.subscription.created' and p_status = 'trialing' then 'subscription_trial_started'
    when p_event_type = 'customer.subscription.created' and p_status = 'active' then 'subscription_started'
    when v_profile.subscription_status in ('canceled','unpaid') and p_status in ('active','trialing') then 'subscription_reactivated'
    when p_event_type = 'customer.subscription.deleted' or p_status in ('canceled','unpaid') then 'subscription_ended'
    else 'subscription_updated'
  end;
  perform public.enqueue_analytics_outbox(
    'stripe:' || p_event_id || ':' || analytics_event,
    p_user_id,
    analytics_event,
    p_provider_created_at,
    jsonb_strip_nulls(jsonb_build_object(
      'provider','stripe', 'status',p_status, 'previous_status',v_profile.subscription_status,
      'plan',safe_plan, 'billing_interval',safe_interval,
      'is_trial',p_status = 'trialing', 'was_trial',p_was_trial,
      'churn_type',case when analytics_event='subscription_ended' and p_churn_type in ('trial_canceled','scheduled','immediate') then p_churn_type else null end
    ))
  );
  if p_cancel_at_period_end and p_cancellation_just_scheduled then
    perform public.enqueue_analytics_outbox(
      'stripe:' || p_event_id || ':subscription_cancellation_scheduled',
      p_user_id,
      'subscription_cancellation_scheduled',
      p_provider_created_at,
      jsonb_strip_nulls(jsonb_build_object(
        'provider','stripe', 'status',p_status, 'plan',safe_plan, 'billing_interval',safe_interval
      ))
    );
  end if;
  return true;
end;
$$;
revoke all on function public.apply_stripe_subscription_event_v2(text,text,timestamptz,uuid,text,text,text,timestamptz,boolean,boolean,boolean,text,text,text) from public, anon, authenticated;
grant execute on function public.apply_stripe_subscription_event_v2(text,text,timestamptz,uuid,text,text,text,timestamptz,boolean,boolean,boolean,text,text,text) to service_role;

-- Deployment gate: backend release automation calls the readiness endpoint,
-- which invokes this function, before routing provider traffic to new code.
create function public.analytics_backend_readiness() returns boolean
language sql stable security definer set search_path = public
as $$ select true $$;
revoke all on function public.analytics_backend_readiness() from public, anon, authenticated;
grant execute on function public.analytics_backend_readiness() to service_role;

commit;
