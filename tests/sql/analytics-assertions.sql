do $$ declare ok boolean; begin
select apply_apple_entitlement_event('11111111-1111-4111-8111-111111111111','orig1','tx1',null,'2026-08-08Z','active','com.sideflip.app.pro.monthly','2026-08-01Z','2026-09-01Z') into ok;
if not ok then raise exception 'apple first'; end if;
select apply_apple_entitlement_event('11111111-1111-4111-8111-111111111111','orig1','tx1',null,'2026-08-08Z','active','com.sideflip.app.pro.monthly','2026-08-01Z','2026-09-01Z') into ok;
if ok then raise exception 'apple duplicate'; end if;
select apply_apple_entitlement_event('11111111-1111-4111-8111-111111111111','orig1','old',null,'2026-08-05Z','expired','com.sideflip.app.pro.monthly','2026-08-01Z','2026-08-06Z') into ok;
if ok then raise exception 'apple stale'; end if;
select apply_apple_entitlement_event('11111111-1111-4111-8111-111111111111','orig1','expired','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-09-02Z','expired','com.sideflip.app.pro.monthly','2026-08-01Z','2026-09-01Z') into ok;
if not ok then raise exception 'apple expiry'; end if;
if (select status from user_entitlements where original_transaction_id='orig1') <> 'expired' then raise exception 'apple status'; end if;
if (select count(*) from analytics_outbox where distinct_id='11111111-1111-4111-8111-111111111111') <> 2 then raise exception 'apple outbox'; end if;
end $$;

begin;
select apply_apple_entitlement_event('33333333-3333-4333-8333-333333333333','rollback','tx',null,'2026-08-08Z','active','com.sideflip.app.pro.annual','2026-08-08Z','2027-08-08Z');
rollback;
do $$ begin if exists(select 1 from analytics_outbox where dedupe_key like 'apple:rollback:%') or exists(select 1 from user_entitlements where original_transaction_id='rollback') then raise exception 'atomic rollback'; end if; end $$;

do $$ declare ok boolean; a uuid; b uuid; begin
select apply_stripe_subscription_event_v2('evt1','customer.subscription.created','2026-08-08Z','22222222-2222-4222-8222-222222222222','sub1','cus1','trialing','2026-08-15Z',false,false,true,null,'annual','year') into ok;
if not ok then raise exception 'stripe first'; end if;
select apply_stripe_subscription_event_v2('evt1','customer.subscription.created','2026-08-08Z','22222222-2222-4222-8222-222222222222','sub1','cus1','trialing','2026-08-15Z',false,false,true,null,'annual','year') into ok;
if ok then raise exception 'stripe replay'; end if;
select apply_stripe_subscription_event_v2('evt0','customer.subscription.updated','2026-08-07Z','22222222-2222-4222-8222-222222222222','sub1','cus1','canceled','2026-08-07Z',false,false,true,'immediate','annual','year') into ok;
if ok then raise exception 'stripe stale'; end if;
select apply_stripe_subscription_event_v2('evt2','customer.subscription.updated','2026-08-09Z','22222222-2222-4222-8222-222222222222','sub1','cus1','active','2026-09-08Z',true,true,true,null,'annual','year') into ok;
if not ok or not exists(select 1 from analytics_outbox where dedupe_key='stripe:evt2:subscription_cancellation_scheduled') then raise exception 'stripe cancel'; end if;
if (select properties->>'billing_interval' from analytics_outbox where dedupe_key='stripe:evt1:subscription_trial_started') <> 'annual' then raise exception 'stripe interval normalization'; end if;
select enqueue_analytics_outbox('stripe:paid','22222222-2222-4222-8222-222222222222','subscription_payment_succeeded','2026-08-15Z','{"provider":"stripe","amount_minor":9999}'::jsonb) into a;
select enqueue_analytics_outbox('stripe:paid','22222222-2222-4222-8222-222222222222','subscription_payment_succeeded','2026-08-15Z','{}') into b;
if a is null or a <> b or (select count(*) from analytics_outbox where dedupe_key='stripe:paid') <> 1 then raise exception 'outbox dedupe'; end if;
end $$;

-- Stripe timestamps have only second precision. Apply the valid trial-to-active
-- transition, but do not consume a losing equal-time event that reconciliation
-- may later retry with authoritative subscription state.
do $$ declare ok boolean; begin
update profiles set subscription_status=null,subscription_id=null,stripe_latest_event_at=null,stripe_latest_event_id=null where id='33333333-3333-4333-8333-333333333333';
select apply_stripe_subscription_event_v2('same-trial','customer.subscription.created','2026-08-12T00:00:00Z','33333333-3333-4333-8333-333333333333','sub-same','cus-same','trialing','2026-08-20Z',false,false,true,null,'annual','year') into ok;
if not ok then raise exception 'same-second trial setup'; end if;
select apply_stripe_subscription_event_v2('same-active','customer.subscription.updated','2026-08-12T00:00:00Z','33333333-3333-4333-8333-333333333333','sub-same','cus-same','active','2026-09-12Z',false,false,true,null,'annual','year') into ok;
if not ok or (select subscription_status from profiles where id='33333333-3333-4333-8333-333333333333') <> 'active' then raise exception 'same-second trial conversion'; end if;
select apply_stripe_subscription_event_v2('same-stale','customer.subscription.updated','2026-08-12T00:00:00Z','33333333-3333-4333-8333-333333333333','sub-same','cus-same','trialing','2026-08-20Z',false,false,true,null,'annual','year') into ok;
if ok or exists(select 1 from stripe_webhook_events where event_id='same-stale') then raise exception 'same-second stale event consumed'; end if;
end $$;

do $$ declare ok boolean; begin
select apply_stripe_analytics_event('invoice1','invoice.payment_failed','2026-08-10Z','22222222-2222-4222-8222-222222222222','sub1','cus1','subscription_payment_failed','{}') into ok;
if not ok then raise exception 'signed Stripe event first apply'; end if;
select apply_stripe_analytics_event('invoice1','invoice.payment_failed','2026-08-10Z','22222222-2222-4222-8222-222222222222','sub1','cus1','subscription_payment_failed','{}') into ok;
if ok then raise exception 'signed Stripe event replay'; end if;
end $$;

do $$ declare x uuid; token uuid; begin
select id,claim_token into x,token from claim_analytics_outbox(1) limit 1;
if x is null or finish_analytics_outbox(x,gen_random_uuid(),true,null) then raise exception 'claim fence'; end if;
if not finish_analytics_outbox(x,token,true,null) then raise exception 'dispatch'; end if;
if (select status from analytics_outbox where id=x) <> 'delivered' then raise exception 'delivered'; end if;
end $$;
do $$ declare q uuid; token uuid; begin
select queue_analytics_deletion('11111111-1111-4111-8111-111111111111') into q;
if q is null or exists(select 1 from analytics_outbox where distinct_id='11111111-1111-4111-8111-111111111111') then raise exception 'deletion queue/purge'; end if;
if (select next_attempt_at < now() + interval '4 minutes 50 seconds' from analytics_deletion_queue where user_id='11111111-1111-4111-8111-111111111111') then raise exception 'deletion capture lease fence'; end if;
update analytics_deletion_queue set next_attempt_at=now() where user_id='11111111-1111-4111-8111-111111111111';
select claim_token into token from claim_analytics_deletions(1) where user_id='11111111-1111-4111-8111-111111111111';
if token is null or finish_analytics_deletion('11111111-1111-4111-8111-111111111111',gen_random_uuid(),true,null) then raise exception 'deletion fence'; end if;
if not finish_analytics_deletion('11111111-1111-4111-8111-111111111111',token,true,null) then raise exception 'deletion submitted'; end if;
if (select status from analytics_deletion_queue where user_id='11111111-1111-4111-8111-111111111111') <> 'submitted' then raise exception 'async deletion falsely completed'; end if;
if (select next_attempt_at < now() + interval '23 hours' from analytics_deletion_queue where user_id='11111111-1111-4111-8111-111111111111') then raise exception 'daily retry'; end if;
end $$;

do $$ declare claimed uuid; begin
insert into account_deletion_tombstones(user_id,status,deletion_lease_expires_at,provider_cleanup_status)
values('33333333-3333-4333-8333-333333333333','auth_deleting',now()-interval '1 minute','{"auth":"deleting","analytics":"pending"}');
select claim_token into claimed from claim_account_deletion_reconciliations(1) where user_id='33333333-3333-4333-8333-333333333333';
if claimed is null then raise exception 'auth reconciliation claim'; end if;
if finish_account_deletion_reconciliation('33333333-3333-4333-8333-333333333333',gen_random_uuid(),true,null) then raise exception 'auth reconciliation fence'; end if;
if not finish_account_deletion_reconciliation('33333333-3333-4333-8333-333333333333',claimed,true,null) then raise exception 'auth reconciliation completion'; end if;
if (select status from account_deletion_tombstones where user_id='33333333-3333-4333-8333-333333333333') <> 'completed' then raise exception 'auth reconciliation state'; end if;
end $$;
update profiles set analytics_opt_out=true where id='22222222-2222-4222-8222-222222222222';
do $$ declare ok boolean; begin
select apply_stripe_analytics_event('invoice2','invoice.payment_failed','2026-08-11Z','22222222-2222-4222-8222-222222222222','sub1','cus1','subscription_payment_failed','{}') into ok;
if not ok then raise exception 'opted-out signed event must remain processed for email dedupe'; end if;
if exists(select 1 from analytics_outbox where dedupe_key='stripe:invoice2:subscription_payment_failed') then raise exception 'opted-out signed event queued analytics'; end if;
end $$;
select * from claim_analytics_outbox(100);
do $$ begin
if exists(select 1 from analytics_outbox where distinct_id='22222222-2222-4222-8222-222222222222' and status in ('pending','processing')) then raise exception 'optout suppression'; end if;
if enqueue_analytics_outbox('opted-out','22222222-2222-4222-8222-222222222222','subscription_updated',now(),'{}') is not null then raise exception 'optout enqueue'; end if;
end $$;
insert into account_deletion_tombstones(user_id,status) values
 ('11111111-1111-4111-8111-111111111111','completed'),
 ('22222222-2222-4222-8222-222222222222','completed'),
 ('33333333-3333-4333-8333-333333333333','completed')
on conflict (user_id) do update set status=excluded.status;
select * from claim_analytics_outbox(100);
do $$ begin
if exists(select 1 from analytics_outbox where status in ('pending','processing')) then raise exception 'suppression'; end if;
if enqueue_analytics_outbox('deleted','33333333-3333-4333-8333-333333333333','subscription_updated',now(),'{}') is not null then raise exception 'deleted enqueue'; end if;
if has_table_privilege('anon','analytics_outbox','select') or has_table_privilege('authenticated','analytics_outbox','insert') or has_function_privilege('anon','claim_analytics_outbox(integer)','execute') then raise exception 'privileges'; end if;
end $$;
