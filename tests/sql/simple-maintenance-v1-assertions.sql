begin;

update private.my_stuff_research_source_domains
set manufacturer='Honda', manufacturer_aliases=array['Honda','Honda Motor Company'], allowed_path_prefixes=array['/'], terms_reviewed_on=current_date, robots_reviewed_on=current_date
where domain='honda.com';
select public._research_assert(private.my_stuff_research_source_matches_make_v1('honda.com',' Honda Motor Company '),'source policy accepts normalized approved aliases');
select public._research_assert(not private.my_stuff_research_source_matches_make_v1('honda.com','Toyota'),'source policy rejects unrelated makes');

delete from public.user_entitlements where user_id='33333333-3333-4333-8333-333333333333';
insert into public.user_entitlements(user_id,source,status,expires_at,last_verified_at)
values('33333333-3333-4333-8333-333333333333','apple','active',now()+interval '30 days',now());
update private.my_stuff_research_jobs set status='cancelled' where status in('queued','retryable','running');
delete from pgmq.messages where queue_name='my_stuff_research_v1';
update private.my_stuff_research_runtime_config set enabled=true where singleton;

set role authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
select public.create_my_stuff_item_v2('{"name":"Focused research car","item_type":"car","usage_dimensions":["mileage"],"current_mileage":0,"origin_mileage":0,"purchase_price":0,"purchase_currency":"USD"}','focused-create') as focused_item \gset
select public.confirm_my_stuff_vehicle_identity_v3(:'focused_item','{"model_year":2020,"make":"Honda Motor Company","model":"Civic","engine_displacement_liters":1.5,"transmission":"CVT","trim":"EX","drivetrain":"FWD","vehicle_market":"US"}','focused-confirm');
select vin_confirmation_fingerprint as focused_fingerprint from public.my_stuff_items where id=:'focused_item' \gset
select public.enqueue_my_stuff_research_v3(:'focused_item',:'focused_fingerprint','focused-enqueue') as focused_job \gset
reset role;

select public._research_assert((select request_snapshot='{"modelYear":2020,"make":"Honda Motor Company","model":"Civic","engine":"1.5L","transmission":"CVT"}'::jsonb from private.my_stuff_research_jobs where id=:'focused_job'),'paid snapshot contains exactly the five confirmed vehicle facts');
select public._research_assert((select request_snapshot ?& array['modelYear','make','model','engine','transmission'] and not request_snapshot ?| array['vin','trim','drivetrain','vehicleMarket','itemType','userId'] from private.my_stuff_research_jobs where id=:'focused_job'),'paid snapshot excludes VIN and extra item/user facts');

set role authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
select public.create_my_stuff_item_v2('{"name":"Incomplete research car","item_type":"car","usage_dimensions":["mileage"],"current_mileage":0,"origin_mileage":0,"purchase_price":0,"purchase_currency":"USD"}','incomplete-create') as incomplete_item \gset
select public.confirm_my_stuff_vehicle_identity_v3(:'incomplete_item','{"model_year":2020,"make":"Honda","model":"Civic","transmission":"CVT"}','incomplete-confirm');
select vin_confirmation_fingerprint as incomplete_fingerprint from public.my_stuff_items where id=:'incomplete_item' \gset
select public._research_raises(format('select public.enqueue_my_stuff_research_v3(%L,%L,%L)',:'incomplete_item',:'incomplete_fingerprint','incomplete-enqueue'),'IDENTITY_INCOMPLETE');
reset role;
select public._research_assert(not exists(select 1 from private.my_stuff_research_jobs where item_id=:'incomplete_item'),'incomplete identity creates no paid job');

set role service_role;
select lease->'lease'->>'id' as leased_job,lease->'lease'->>'lease_token' as focused_token
from (select public.lease_my_stuff_research_worker_v2('focused-worker') lease) leased \gset
select public._research_assert(:'leased_job'::uuid=:'focused_job'::uuid,'alias-backed job reaches the real paid-worker lease boundary');
select public._research_raises(format(
  'select public.settle_my_stuff_research_worker_v2(%L,%L,1,%L::jsonb,%L::jsonb,%L::jsonb)',
  :'focused_job',:'focused_token',
  '[{"id":"e1","title":"Honda guide","canonicalUrl":"https://honda.com/guide","exactExcerpt":"Replace engine oil every 7,500 miles.","accessedAt":"2026-09-19T12:00:00Z","applicability":"2020 Honda Civic","sourceClass":"manufacturer","sourceDomain":"honda.com","page":"42","locationVerified":false,"verificationStatus":"provider_citation_unconfirmed","unexpected":"x"}]',
  '[]','[]'),'INVALID_EVIDENCE');
select public._research_raises(format(
  'select public.settle_my_stuff_research_worker_v2(%L,%L,1,%L::jsonb,%L::jsonb,%L::jsonb)',
  :'focused_job',:'focused_token',
  '[{"id":"e1","title":"Honda guide","canonicalUrl":"https://honda.com/guide","exactExcerpt":"Replace engine oil every 7,500 miles.","accessedAt":"2026-09-19T12:00:00Z","applicability":"2020 Honda Civic","sourceClass":"manufacturer","sourceDomain":"honda.com","page":"42","locationVerified":false,"verificationStatus":"provider_citation_unconfirmed"}]',
  '[{"name":"Engine oil","action":"replace","profile":"normal","dueSemantics":"whichever_first","intervalMiles":7500.5,"evidenceIds":["e1"],"uncertainty":"low","conflict":false}]','[]'),'INVALID_CANDIDATE');
select public._research_assert((select status='running' and not exists(select 1 from private.my_stuff_research_evidence e where e.job_id=:'focused_job') from private.my_stuff_research_jobs where id=:'focused_job'),'invalid settlement rolls back without partial writes');
select public.settle_my_stuff_research_worker_v2(:'focused_job',:'focused_token',1,
  '[{"id":"e1","title":"Honda guide","canonicalUrl":"https://honda.com/guide","exactExcerpt":"Replace engine oil every 7,500 miles.","accessedAt":"2026-09-19T12:00:00Z","applicability":"2020 Honda Civic","sourceClass":"manufacturer","sourceDomain":"honda.com","page":"42","locationVerified":false,"verificationStatus":"provider_citation_unconfirmed"}]',
  '[{"name":"Engine oil","action":"replace","profile":"normal","dueSemantics":"whichever_first","intervalMiles":7500,"evidenceIds":["e1"],"uncertainty":"low","conflict":false}]','[]');
reset role;
select public._research_assert((select status='awaiting_review' from private.my_stuff_research_jobs where id=:'focused_job'),'alias-backed focused research settles for review');

rollback;
