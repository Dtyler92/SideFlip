-- Seed one legacy queued $25 reservation so the policy migration must cancel
-- and release it before lowering the executable job authority.
update private.my_stuff_research_source_domains
set manufacturer='Honda',manufacturer_aliases=array['Honda'],allowed_path_prefixes=array['/'],
    terms_reviewed_on=current_date,robots_reviewed_on=current_date
where domain='honda.com';

delete from public.user_entitlements where user_id='33333333-3333-4333-8333-333333333333';
insert into public.user_entitlements(user_id,source,status,expires_at,last_verified_at)
values('33333333-3333-4333-8333-333333333333','apple','active',now()+interval '30 days',now());
update private.my_stuff_research_runtime_config set enabled=true where singleton;

set role authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
select public.create_my_stuff_item_v2('{"name":"Legacy reservation car","item_type":"car","usage_dimensions":["mileage"],"current_mileage":0,"origin_mileage":0,"purchase_price":0,"purchase_currency":"USD"}','legacy-budget-create') as legacy_item \gset
select public.confirm_my_stuff_vehicle_identity_v3(:'legacy_item','{"model_year":2020,"make":"Honda","model":"Civic","engine_displacement_liters":1.5,"transmission":"CVT"}','legacy-budget-confirm');
select vin_confirmation_fingerprint as legacy_fingerprint from public.my_stuff_items where id=:'legacy_item' \gset
select public.enqueue_my_stuff_research_v3(:'legacy_item',:'legacy_fingerprint','legacy-budget-enqueue');
reset role;
