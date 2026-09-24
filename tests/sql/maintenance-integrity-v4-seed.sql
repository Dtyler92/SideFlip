\set ON_ERROR_STOP on
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.create_my_stuff_item_v2('{"name":"V4 manual archive","item_type":"car","usage_dimensions":["mileage","hours","cycles"],"current_mileage":10000,"current_hours":100,"current_cycles":10,"purchase_price":1000}','v4-fixture-item') as v4_item \gset
select public.create_my_stuff_maintenance_definition_v2(:'v4_item','{"name":" Duplicate Task ","service_action":"service","normal_interval_miles":5000,"enabled":true}','v4-enabled-winner') as enabled_winner \gset
select public.create_my_stuff_maintenance_definition_v2(:'v4_item','{"name":"duplicate   task","service_action":"service","normal_interval_miles":6000,"enabled":false}','v4-disabled-loser') as disabled_loser \gset
select public.create_my_stuff_maintenance_definition_v2(:'v4_item','{"name":"All disabled","service_action":"service","normal_interval_hours":50,"enabled":false}','v4-disabled-old') as disabled_old \gset
select public.create_my_stuff_maintenance_definition_v2(:'v4_item','{"name":" all   disabled ","service_action":"service","normal_interval_hours":60,"enabled":false}','v4-disabled-new') as disabled_new \gset
select public.record_my_stuff_service_occurrence_v2(:'v4_item',:'disabled_loser','{"completed_at":"2026-01-01Z","mileage":10000,"hours":100,"cycles":10,"notes":"historical original"}','v4-historical-service') as historical_occurrence \gset
reset role;
update public.my_stuff_maintenance_definitions set updated_at='2026-01-01Z' where id=:'disabled_old';
update public.my_stuff_maintenance_definitions set updated_at='2026-02-01Z' where id=:'disabled_new';
update public.my_stuff_items set archived_at='2026-01-01Z',archive_reason='manual owner archive' where id=:'v4_item';

set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.create_my_stuff_item_v2('{"name":"V4 transferred item","item_type":"car","usage_dimensions":["mileage"],"current_mileage":20000,"purchase_price":2000,"purchase_currency":"USD"}','v4-transfer-item') as transferred_item \gset
select public.transfer_my_stuff_to_project_v1(:'transferred_item','v4-transfer-out') as transferred_project \gset
reset role;

-- A legacy transfer reason is also authoritative even if its link was lost.
set role authenticated;
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',false);
select public.create_my_stuff_item_v2('{"name":"V4 transfer reason item","item_type":"tool"}','v4-transfer-reason-item') as transfer_reason_item \gset
reset role;
update public.my_stuff_items set archived_at='2026-01-02Z',archive_reason='Transferred to project' where id=:'transfer_reason_item';
