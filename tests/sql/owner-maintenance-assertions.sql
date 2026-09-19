create function public._test_assert_v3(ok boolean,msg text) returns void language plpgsql as $$begin if ok is not true then raise exception 'assertion failed: %',msg; end if; end$$;
create function public._test_raises_v3(statement text,expected text) returns void language plpgsql as $$
begin
  begin
    execute statement;
  exception when others then
    if sqlerrm not like '%'||expected||'%' then raise exception 'assertion failed: expected %, got %',expected,sqlerrm; end if;
    return;
  end;
  raise exception 'assertion failed: statement did not raise expected error: %',expected;
end$$;
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.create_my_stuff_item_v2('{"name":"Undated initial fixture","item_type":"car","usage_dimensions":["mileage"],"current_mileage":79563,"purchase_price":1000}','owner-initial') as owner_item \gset
select public._test_assert_v3((select count(*)=0 from public.my_stuff_readings where item_id=:'owner_item'),'initial meter does not fabricate history');
select public._test_assert_v3(public.get_my_stuff_owner_preferences_v1(:'owner_item')='{"annual_mileage_estimate":null,"condition_answers":{}}','unknown defaults');
select public.save_my_stuff_owner_preferences_v1(:'owner_item','{"annual_mileage_estimate":12000,"condition_answers":{"frequent_short_trips":null,"towing":false,"temperature_f":20}}','Owner setup','owner-pref-1') as pref \gset
select public._test_assert_v3(public.save_my_stuff_owner_preferences_v1(:'owner_item','{"annual_mileage_estimate":12000,"condition_answers":{"frequent_short_trips":null,"towing":false,"temperature_f":20}}','Owner setup','owner-pref-1')=:'pref','preference replay');
select public._test_assert_v3((select current_mileage=79563 from public.my_stuff_items where id=:'owner_item'),'estimate never actual mileage');
select public._test_assert_v3((select count(*)=0 from public.my_stuff_readings where item_id=:'owner_item'),'preferences never dated readings');
select public.save_my_stuff_owner_preferences_v1(:'owner_item','{"annual_mileage_estimate":null,"condition_answers":{"towing":null}}','Not sure','owner-pref-2');
select public._test_assert_v3((select count(*)=2 from public.my_stuff_owner_preference_revisions where item_id=:'owner_item'),'append-only preference history');
select public._test_assert_v3(public.get_my_stuff_owner_preferences_v1(:'owner_item')->'condition_answers'='{"towing":null}','unknown is not normal');
select public._test_raises_v3(format('select public.save_my_stuff_owner_preferences_v1(%L,%L,%L,%L)',:'owner_item','{"condition_answers":{"towing":true}}','changed','owner-pref-1'),'Idempotency');
select public._test_raises_v3(format('select public.record_my_stuff_service_with_details_v1(%L,null,null,%L,null,%L,%L)',:'owner_item','{"service_name":"Oil"}','{}','unknown-date'),'Confirm completion date');
select public._test_raises_v3(format('select public.record_my_stuff_service_with_details_v1(%L,null,null,%L,null,%L,%L)',:'owner_item','{"service_name":"Oil","completed_at":"infinity"}','{}','infinite-date'),'Completion date');
select public.record_my_stuff_service_with_details_v1(:'owner_item',null,null,'{"service_name":"Oil change","completed_at":"2026-01-01Z"}','{"description":"Oil change","category":"maintenance","amount":75,"currency":"USD","incurred_on":"2026-01-01"}','{"oil_viscosity":"0W-20","oil_specification":null}','owner-service-1') as service \gset
select public._test_assert_v3(public.record_my_stuff_service_with_details_v1(:'owner_item',null,null,'{"service_name":"Oil change","completed_at":"2026-01-01Z"}','{"description":"Oil change","category":"maintenance","amount":75,"currency":"USD","incurred_on":"2026-01-01"}','{"oil_viscosity":"0W-20","oil_specification":null}','owner-service-1')=:'service'::jsonb,'service and expense replay');
select public._test_raises_v3(format('select public.record_my_stuff_service_with_details_v1(%L,null,null,%L,null,%L,%L)',:'owner_item','{"service_name":"Should roll back","completed_at":"2026-01-01Z"}','{"global_oil":true}','invalid-details'),'Unsupported service detail');
select public._test_assert_v3((select count(*)=1 from public.my_stuff_service_occurrences where item_id=:'owner_item'),'invalid details rolls back entire service');
select public._test_raises_v3(format('select public.record_my_stuff_service_with_details_v1(%L,null,null,%L,%L,%L,%L)',:'owner_item','{"service_name":"Oil change","completed_at":"2026-01-01Z"}','{"description":"Oil change","category":"maintenance","amount":75,"currency":"USD","incurred_on":"2026-01-01"}','{"oil_viscosity":"5W-20"}','owner-service-1'),'Idempotency');
select public._test_assert_v3((select count(*)=1 from public.my_stuff_expenses where item_id=:'owner_item'),'one linked expense');
select public._test_assert_v3((select count(*)=0 from public.my_stuff_readings where item_id=:'owner_item'),'unknown historical usage not invented');
select public.save_my_stuff_service_details_v1((:'service'::jsonb->>'service_occurrence_id')::uuid,'{"oil_viscosity":"5W-20"}','Correct receipt','owner-details-fix');
select public.revise_my_stuff_service_expense_v3((:'service'::jsonb->>'service_occurrence_id')::uuid,(:'service'::jsonb->>'expense_id')::uuid,'{"notes":"Corrected receipt"}','{"amount":80}','Receipt correction','owner-expense-fix');
select public.revise_my_stuff_service_expense_v3((:'service'::jsonb->>'service_occurrence_id')::uuid,(:'service'::jsonb->>'expense_id')::uuid,'{"notes":"Corrected receipt"}','{"amount":80}','Receipt correction','owner-expense-fix');
select public._test_assert_v3((select count(*)=1 from public.my_stuff_expenses where item_id=:'owner_item'),'correction never duplicates expense');
select public._test_assert_v3((select count(*)=2 from public.my_stuff_service_detail_revisions where item_id=:'owner_item'),'oil details append for exact service');
select public._test_assert_v3(not has_table_privilege('authenticated','public.my_stuff_owner_preference_revisions','insert,update,delete'),'no direct preference mutations');
select public._test_assert_v3(not has_table_privilege('authenticated','public.my_stuff_service_detail_revisions','insert,update,delete'),'no direct detail mutations');
select public._test_assert_v3(not has_function_privilege('anon','public.save_my_stuff_owner_preferences_v1(uuid,jsonb,text,text)','execute'),'anonymous denied');
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public._test_assert_v3((select count(*)=0 from public.my_stuff_owner_preference_revisions where item_id=:'owner_item'),'cross owner prefs hidden');
select public._test_assert_v3((select count(*)=0 from public.my_stuff_service_detail_revisions where item_id=:'owner_item'),'cross owner details hidden');
select public._test_raises_v3(format('select public.get_my_stuff_owner_preferences_v1(%L)',:'owner_item'),'not found');
select public._test_raises_v3(format('select public.save_my_stuff_service_details_v1(%L,%L,%L,%L)',(:'service'::jsonb->>'service_occurrence_id'),'{}','attempt','cross-owner'),'not found');
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.create_my_stuff_item_v2('{"name":"Hours fixture","item_type":"other","usage_dimensions":["hours"],"current_hours":100,"purchase_price":1000}','owner-hours') as hours_item \gset
select public.create_my_stuff_custom_task_v3(:'hours_item','{"name":"Hours service","normal_interval_hours":50,"first_interval_hours":20,"cadence_anchor":"asset_origin"}','owner-hours-task') as hours_def \gset
select public.record_my_stuff_service_with_details_v1(:'hours_item',null,:'hours_def','{"completed_at":"2026-01-01Z","hours":110}',null,'{}','owner-hours-service');
select public._test_assert_v3((select current_hours=110 and current_mileage is null from public.my_stuff_items where id=:'hours_item'),'hours service does not create mileage');
select public._test_assert_v3((select normal_interval_hours=50 and first_interval_hours=20 and provenance_type='manual' from public.my_stuff_maintenance_definitions where id=:'hours_def'),'manual first/subsequent hours preserved');
reset role;
