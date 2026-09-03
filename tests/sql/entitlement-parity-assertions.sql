create function public._entitlement_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'assertion failed: %', p_message; end if;
end;
$$;

select public._entitlement_assert(
  public.stripe_entitlement_read_mode() = 'compatibility',
  'canonical reads remain behind an explicit reconciliation cutover gate'
);
select public._entitlement_assert(
  not exists(select 1 from public.user_entitlements where user_id='11111111-1111-4111-8111-111111111111'),
  'migration performs no profile backfill'
);

select public._entitlement_assert(public.apply_stripe_subscription_event_v2(
  'evt_poison_ignored','customer.subscription.created','2026-09-04T11:00:00Z',
  '11111111-1111-4111-8111-111111111111','sub_verified_not_poison','cus_verified_not_poison',
  'active','2030-01-01T00:00:00Z',false,false,false,null,'monthly','month'
), 'browser-poisoned profile binding does not reject verified canonical state');
select public._entitlement_assert(
  (select provider_subscription_id='sub_verified_not_poison' and provider_customer_id='cus_verified_not_poison'
   from public.stripe_subscription_state where user_id='11111111-1111-4111-8111-111111111111'),
  'trusted binding is stored only in canonical provider state'
);

set role authenticated;
update public.profiles set currency='CAD', language='fr', onboarded=true
where id='11111111-1111-4111-8111-111111111111';
do $$
begin
  begin
    update public.profiles set subscription_status='trialing', subscription_id='sub_attacker',
      stripe_customer_id='cus_attacker', current_period_end='2099-01-01T00:00:00Z',
      stripe_latest_event_at='2099-01-01T00:00:00Z', stripe_latest_event_id='evt_attacker'
    where id='11111111-1111-4111-8111-111111111111';
    raise exception 'provider-column poison unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
select public._entitlement_assert(
  (select currency='CAD' and language='fr' and onboarded
     and subscription_id='sub_verified_not_poison' and stripe_customer_id='cus_verified_not_poison'
   from public.profiles where id='11111111-1111-4111-8111-111111111111'),
  'profile preferences remain writable while provider columns reject browser poison'
);

select public._entitlement_assert(public.apply_stripe_subscription_event_v2(
  'evt_trial','customer.subscription.created','2026-09-04T12:00:00Z',
  '22222222-2222-4222-8222-222222222222','sub_authoritative','cus_authoritative',
  'trialing','2030-01-01T00:00:00Z',false,false,true,null,'monthly','month'
), 'trusted trial event accepted');
select public._entitlement_assert(
  (select status='trialing' and provider_customer_id='cus_authoritative' and expires_at='2030-01-01T00:00:00Z'
   from public.user_entitlements where source='stripe' and provider_subscription_id='sub_authoritative'),
  'trial event creates canonical Stripe entitlement'
);
select public._entitlement_assert(
  public.user_has_verified_pro_entitlement('22222222-2222-4222-8222-222222222222'),
  'future verified Stripe trial grants Pro'
);

select public._entitlement_assert(public.apply_stripe_subscription_event_v2(
  'evt_active','customer.subscription.updated','2026-09-04T12:00:00Z',
  '22222222-2222-4222-8222-222222222222','sub_authoritative','cus_authoritative',
  'active','2031-01-01T00:00:00Z',false,false,true,null,'monthly','month'
), 'same-second trial to active accepted');
select public._entitlement_assert(
  (select status='active' and expires_at='2031-01-01T00:00:00Z'
   from public.user_entitlements where provider_subscription_id='sub_authoritative'),
  'same-second active transition updates canonical entitlement'
);

select public._entitlement_assert(public.apply_stripe_subscription_event_v2(
  'evt_equal_terminal','customer.subscription.deleted','2026-09-04T12:00:00Z',
  '22222222-2222-4222-8222-222222222222','sub_authoritative','cus_authoritative',
  'canceled','2031-01-01T00:00:00Z',false,false,true,'immediate','monthly','month'
), 'same-second terminal event beats active');
select public._entitlement_assert(not public.apply_stripe_subscription_event_v2(
  'evt_equal_reactivate','customer.subscription.updated','2026-09-04T12:00:00Z',
  '22222222-2222-4222-8222-222222222222','sub_authoritative','cus_authoritative',
  'active','2032-01-01T00:00:00Z',false,false,true,null,'monthly','month'
), 'same-second active cannot reactivate terminal state');
select public._entitlement_assert(
  (select status='canceled' from public.user_entitlements where provider_subscription_id='sub_authoritative')
  and not exists(select 1 from public.stripe_webhook_events where event_id='evt_equal_reactivate'),
  'losing same-second reactivation is unconsumed and terminal state remains authoritative'
);

select public._entitlement_assert(public.apply_stripe_subscription_event_v2(
  'evt_scheduled','customer.subscription.updated','2026-09-04T12:00:01Z',
  '22222222-2222-4222-8222-222222222222','sub_authoritative','cus_authoritative',
  'active','2031-01-01T00:00:00Z',true,true,true,'scheduled','monthly','month'
), 'strictly newer verified active state can reactivate');
select public._entitlement_assert(
  public.user_has_verified_pro_entitlement('22222222-2222-4222-8222-222222222222'),
  'strictly newer active state restores Pro through the verified period'
);

select public._entitlement_assert(
  not public.apply_stripe_subscription_event_v2('', 'customer.subscription.updated','2026-09-04T12:00:02Z',
    '22222222-2222-4222-8222-222222222222','sub_authoritative','cus_authoritative','active','2031-01-01T00:00:00Z',false,false,false,null,'monthly','month')
  and not public.apply_stripe_subscription_event_v2('evt_bad_type','invoice.paid','2026-09-04T12:00:02Z',
    '22222222-2222-4222-8222-222222222222','sub_authoritative','cus_authoritative','active','2031-01-01T00:00:00Z',false,false,false,null,'monthly','month')
  and not public.apply_stripe_subscription_event_v2('evt_bad_status','customer.subscription.updated','2026-09-04T12:00:02Z',
    '22222222-2222-4222-8222-222222222222','sub_authoritative','cus_authoritative','bogus','2031-01-01T00:00:00Z',false,false,false,null,'monthly','month')
  and not public.apply_stripe_subscription_event_v2('evt_empty_customer','customer.subscription.updated','2026-09-04T12:00:02Z',
    '22222222-2222-4222-8222-222222222222','sub_authoritative','   ','active','2031-01-01T00:00:00Z',false,false,false,null,'monthly','month')
  and not public.apply_stripe_subscription_event_v2('evt_infinite_period','customer.subscription.updated','2026-09-04T12:00:02Z',
    '22222222-2222-4222-8222-222222222222','sub_authoritative','cus_authoritative','active','infinity',false,false,false,null,'monthly','month'),
  'malformed trusted inputs fail before consumption'
);
select public._entitlement_assert(
  not exists(select 1 from public.stripe_webhook_events where event_id in ('evt_bad_type','evt_bad_status','evt_empty_customer','evt_infinite_period')),
  'invalid events are never marked consumed'
);

select public._entitlement_assert(not public.reconcile_verified_stripe_subscription(
  'recon_unverified',false,'2026-09-04T12:30:00Z','77777777-7777-4777-8777-777777777777',
  'sub_reconciled','cus_reconciled','active','2031-01-01T00:00:00Z'
), 'unverified reconciliation input is rejected');
select public._entitlement_assert(public.reconcile_verified_stripe_subscription(
  'recon_verified',true,'2026-09-04T12:30:00Z','77777777-7777-4777-8777-777777777777',
  'sub_reconciled','cus_reconciled','active','2031-01-01T00:00:00Z'
), 'provider-verified reconciliation writes canonical state');
select public._entitlement_assert(
  public.user_has_verified_pro_entitlement('77777777-7777-4777-8777-777777777777'),
  'verified reconciliation preserves a valid profile-only Stripe user'
);

select public._entitlement_assert(not public.apply_stripe_subscription_event_v2(
  'evt_stale','customer.subscription.deleted','2026-09-04T11:59:59Z',
  '22222222-2222-4222-8222-222222222222','sub_authoritative','cus_authoritative',
  'canceled','2026-09-04T11:59:59Z',false,false,true,'immediate','monthly','month'
), 'stale cancellation rejected');
select public._entitlement_assert(
  not exists(select 1 from public.stripe_webhook_events where event_id='evt_stale')
  and (select status='active' from public.user_entitlements where provider_subscription_id='sub_authoritative'),
  'stale cancellation is unconsumed and cannot revoke access'
);
select public._entitlement_assert(not public.apply_stripe_subscription_event_v2(
  'evt_rejected_replacement','customer.subscription.created','2026-09-04T12:00:01Z',
  '22222222-2222-4222-8222-222222222222','sub_rejected_replacement','cus_rejected_replacement',
  'active','2031-01-01T00:00:00Z',false,false,false,null,'annual','year'
), 'active canonical subscription rejects replacement binding');
select public._entitlement_assert(
  not exists(select 1 from public.stripe_subscription_ownership where provider_subscription_id='sub_rejected_replacement')
  and not exists(select 1 from public.stripe_webhook_events where event_id='evt_rejected_replacement'),
  'rejected replacement cannot poison immutable ownership or event delivery state'
);

select public._entitlement_assert(public.apply_stripe_subscription_event_v2(
  'evt_cancel','customer.subscription.deleted','2026-09-04T12:00:02Z',
  '22222222-2222-4222-8222-222222222222','sub_authoritative','cus_authoritative',
  'canceled','2031-01-01T00:00:00Z',false,false,true,'immediate','monthly','month'
), 'new cancellation accepted');
select public._entitlement_assert(
  (select status='canceled' from public.user_entitlements where provider_subscription_id='sub_authoritative')
  and not public.user_has_verified_pro_entitlement('22222222-2222-4222-8222-222222222222'),
  'Stripe cancellation revokes Pro even with future period end'
);

select public._entitlement_assert(public.apply_stripe_subscription_event(
  'evt_legacy','customer.subscription.created','2026-09-04T13:00:00Z',
  '33333333-3333-4333-8333-333333333333','sub_legacy_rpc','cus_legacy',
  'active','2030-01-01T00:00:00Z'
), 'legacy RPC signature remains operational');
select public._entitlement_assert(
  public.user_has_verified_pro_entitlement('33333333-3333-4333-8333-333333333333'),
  'legacy trusted RPC writes canonical entitlement'
);

select public._entitlement_assert(not public.apply_stripe_subscription_event_v2(
  'evt_deleted','customer.subscription.created','2026-09-04T14:00:00Z',
  '44444444-4444-4444-8444-444444444444','sub_deleted','cus_deleted',
  'active','2030-01-01T00:00:00Z',false,false,false,null,'annual','year'
), 'deletion tombstone suppresses Stripe lifecycle');
select public._entitlement_assert(
  not exists(select 1 from public.stripe_webhook_events where event_id='evt_deleted')
  and not exists(select 1 from public.user_entitlements where user_id='44444444-4444-4444-8444-444444444444'),
  'suppressed deletion event mutates no authority state'
);

select public._entitlement_assert(not public.apply_stripe_subscription_event_v2(
  'evt_cross_user','customer.subscription.created','2026-09-04T15:00:00Z',
  '55555555-5555-4555-8555-555555555555','sub_legacy_rpc','cus_attacker',
  'active','2032-01-01T00:00:00Z',false,false,false,null,'annual','year'
), 'provider subscription cannot be rebound cross-account');
select public._entitlement_assert(
  (select user_id='33333333-3333-4333-8333-333333333333'::uuid
   from public.user_entitlements where provider_subscription_id='sub_legacy_rpc'),
  'cross-account rejection preserves original owner'
);

select public._entitlement_assert(public.apply_stripe_subscription_event_v2(
  'evt_expired','customer.subscription.updated','2026-09-04T16:00:00Z',
  '33333333-3333-4333-8333-333333333333','sub_legacy_rpc','cus_legacy',
  'past_due','2026-09-04T16:00:00Z',false,false,false,null,'monthly','month'
), 'Stripe non-access lifecycle accepted');
select public._entitlement_assert(
  (select status='expired' from public.user_entitlements where provider_subscription_id='sub_legacy_rpc')
  and not public.user_has_verified_pro_entitlement('33333333-3333-4333-8333-333333333333'),
  'Stripe past-due lifecycle normalizes to expired and Free'
);
select public._entitlement_assert(not public.apply_stripe_subscription_event_v2(
  'evt_revoked','customer.subscription.updated','2026-09-04T16:00:01Z',
  '33333333-3333-4333-8333-333333333333','sub_legacy_rpc','cus_legacy',
  'provider_terminal_unknown','2032-01-01T00:00:00Z',false,false,false,null,'monthly','month'
), 'unknown Stripe lifecycle is rejected');
select public._entitlement_assert(
  (select status='expired' from public.user_entitlements where provider_subscription_id='sub_legacy_rpc')
  and not exists(select 1 from public.stripe_webhook_events where event_id='evt_revoked')
  and not public.user_has_verified_pro_entitlement('33333333-3333-4333-8333-333333333333'),
  'unknown Stripe lifecycle cannot mutate or consume canonical state'
);

insert into public.user_entitlements(user_id,source,status,product_id,original_transaction_id,expires_at,last_verified_at)
values
  ('55555555-5555-4555-8555-555555555555','apple','active','sideflip.monthly','apple-active','2030-01-01T00:00:00Z',now()),
  ('66666666-6666-4666-8666-666666666666','apple','grace_period','sideflip.monthly','apple-grace','2030-01-01T00:00:00Z',now());
select public._entitlement_assert(
  public.user_has_verified_pro_entitlement('55555555-5555-4555-8555-555555555555')
  and public.user_has_verified_pro_entitlement('66666666-6666-4666-8666-666666666666'),
  'Apple active and grace grant Pro'
);
update public.user_entitlements set status='revoked' where original_transaction_id='apple-active';
update public.user_entitlements set expires_at='infinity' where original_transaction_id='apple-grace';
select public._entitlement_assert(
  not public.user_has_verified_pro_entitlement('55555555-5555-4555-8555-555555555555')
  and not public.user_has_verified_pro_entitlement('66666666-6666-4666-8666-666666666666'),
  'Apple revoked and non-finite expiration fail closed'
);

select public._entitlement_assert(
  public.stripe_event_precedence('customer.subscription.updated','canceled')
    > public.stripe_event_precedence('customer.subscription.updated','active')
  and public.stripe_event_precedence('customer.subscription.deleted','canceled')
    > public.stripe_event_precedence('customer.subscription.updated','active')
  and public.stripe_event_precedence('customer.subscription.updated','past_due')
    > public.stripe_event_precedence('customer.subscription.updated','trialing')
  and public.stripe_event_precedence('customer.subscription.updated','unpaid')
    > public.stripe_event_precedence('customer.subscription.updated','active'),
  'all terminal Stripe states outrank granting states at equal provider time'
);

select public._entitlement_assert(
  (select relrowsecurity from pg_class where oid='public.user_entitlements'::regclass),
  'entitlement RLS remains enabled'
);
select public._entitlement_assert(
  not has_table_privilege('anon','public.user_entitlements','select')
  and not has_table_privilege('authenticated','public.user_entitlements','select')
  and not has_function_privilege('anon','public.apply_stripe_subscription_event(text,text,timestamptz,uuid,text,text,text,timestamptz)','execute')
  and not has_function_privilege('authenticated','public.apply_stripe_subscription_event_v2(text,text,timestamptz,uuid,text,text,text,timestamptz,boolean,boolean,boolean,text,text,text)','execute')
  and has_function_privilege('service_role','public.apply_stripe_subscription_event(text,text,timestamptz,uuid,text,text,text,timestamptz)','execute')
  and has_function_privilege('service_role','public.apply_stripe_subscription_event_v2(text,text,timestamptz,uuid,text,text,text,timestamptz,boolean,boolean,boolean,text,text,text)','execute')
  and not has_table_privilege('authenticated','public.stripe_subscription_state','select')
  and not has_table_privilege('authenticated','public.stripe_subscription_ownership','select')
  and not has_function_privilege('authenticated','public.reconcile_verified_stripe_subscription(text,boolean,timestamptz,uuid,text,text,text,timestamptz)','execute')
  and has_function_privilege('service_role','public.reconcile_verified_stripe_subscription(text,boolean,timestamptz,uuid,text,text,text,timestamptz)','execute'),
  'authority tables and RPCs are service-only'
);
select public._entitlement_assert(
  (select proconfig @> array['search_path=pg_catalog, public'] from pg_proc where oid='public.user_has_verified_pro_entitlement(uuid)'::regprocedure)
  and (select proconfig @> array['search_path=pg_catalog, public'] from pg_proc where oid='public.apply_stripe_subscription_event(text,text,timestamptz,uuid,text,text,text,timestamptz)'::regprocedure)
  and (select proconfig @> array['search_path=pg_catalog, public'] from pg_proc where oid='public.apply_stripe_subscription_event_v2(text,text,timestamptz,uuid,text,text,text,timestamptz,boolean,boolean,boolean,text,text,text)'::regprocedure),
  'authority functions use fixed search_path'
);

select public._entitlement_assert(
  not public.complete_stripe_entitlement_reconciliation(false,true)
  and public.stripe_entitlement_read_mode()='compatibility',
  'cutover refuses incomplete provider inventory attestation'
);
select public._entitlement_assert(
  public.complete_stripe_entitlement_reconciliation(true,true),
  'explicit verified inventory and reconciliation permit canonical cutover'
);
select public._entitlement_assert(
  public.stripe_entitlement_read_mode()='canonical',
  'canonical read mode becomes visible after explicit cutover'
);

drop function public._entitlement_assert(boolean,text);
