set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.save_my_stuff_service_history_v1(:'owner_item',null,null,'{"service_name":"Past oil","completed_at":"2020-01-01Z","mileage":60000}','{"description":"Past oil","category":"maintenance","amount":50,"incurred_on":"2020-01-01"}','{"oil_viscosity":"0W-20"}','Imported receipt','history-known') as hist \gset
select public._test_assert_v3(public.save_my_stuff_service_history_v1(:'owner_item',null,null,'{"service_name":"Past oil","completed_at":"2020-01-01Z","mileage":60000}','{"description":"Past oil","category":"maintenance","amount":50,"incurred_on":"2020-01-01"}','{"oil_viscosity":"0W-20"}','Imported receipt','history-known')=:'hist'::jsonb,'history replay identical');
select public._test_assert_v3((select current_mileage=79563 from public.my_stuff_items where id=:'owner_item'),'past lower meter never rewinds live');
select public._test_assert_v3((select service->>'mileage'='60000' and service->>'completed_at'='2020-01-01Z' from public.my_stuff_service_history_revisions where id=(:'hist'::jsonb->>'revision_id')::uuid),'actual historical facts preserved');
select public.save_my_stuff_service_history_v1(:'owner_item',null,null,'{"service_name":"Undated oil"}','{"amount":25}', '{}','Unknown receipt date','history-unknown') as unknown_hist \gset
select public._test_assert_v3((select service->'completed_at'='null'::jsonb and service->'mileage'='null'::jsonb and created_at is not null and status='pending_history_clarification' from public.my_stuff_service_history_revisions where id=(:'unknown_hist'::jsonb->>'revision_id')::uuid),'explicit unknown separate audit time');
select public._test_assert_v3(:'unknown_hist'::jsonb->'expense_id'='null'::jsonb and :'unknown_hist'::jsonb->'schedule_updated'='false'::jsonb,'undated cost deferred no fake date');
select public._test_assert_v3((select count(*)=0 from public.my_stuff_readings where item_id=:'owner_item'),'history does not synthesize reading logs');
select public._test_assert_v3((select count(*)=1 from public.my_stuff_service_occurrences where item_id=:'owner_item'),'provisional never actual completion');
select public.save_my_stuff_service_history_v1(:'owner_item',(:'hist'::jsonb->>'history_id')::uuid,null,'{"service_name":"Past oil","completed_at":"2019-01-01Z","mileage":59000,"notes":"Corrected"}','{"description":"Past oil corrected","category":"maintenance","amount":55,"incurred_on":"2019-01-01"}','{"oil_viscosity":"5W-20"}','Correct receipt','history-correct') as corrected_hist \gset
select public._test_assert_v3(public.save_my_stuff_service_history_v1(:'owner_item',(:'hist'::jsonb->>'history_id')::uuid,null,'{"service_name":"Past oil","completed_at":"2019-01-01Z","mileage":59000,"notes":"Corrected"}','{"description":"Past oil corrected","category":"maintenance","amount":55,"incurred_on":"2019-01-01"}','{"oil_viscosity":"5W-20"}','Correct receipt','history-correct')=:'corrected_hist'::jsonb,'correction replay');
select public._test_assert_v3(:'hist'::jsonb->'expense_id'=:'corrected_hist'::jsonb->'expense_id','same linked expense after correction');
select public._test_assert_v3((select count(*)=2 from public.my_stuff_service_history_revisions where history_id=(:'hist'::jsonb->>'history_id')::uuid),'two audit revisions only');
select public._test_assert_v3((select count(*)=2 from public.my_stuff_expense_revisions where expense_id=(:'hist'::jsonb->>'expense_id')::uuid),'two expense revisions only');
select public._test_raises_v3(format('select public.save_my_stuff_service_history_v1(%L,null,null,%L,%L,%L,%L,%L)',:'owner_item','{"service_name":"Bad"}','{"description":"bad","category":"maintenance","amount":1,"incurred_on":"2020-01-01"}','{"invalid":true}','bad','history-bad-details'),'Unsupported service detail');
select public._test_raises_v3(format('select public.save_my_stuff_service_history_v1(%L,null,null,%L,%L,%L,%L,%L)',:'owner_item','{"service_name":"Bad expense"}','{"description":"bad","category":"invalid","amount":1,"incurred_on":"2020-01-01"}','{}','bad','history-bad-expense'),'Invalid expense category');
select public._test_assert_v3((select count(*)=2 from public.my_stuff_service_history where item_id=:'owner_item'),'expense validation rolls back inserted history');
select public._test_assert_v3((select count(*)=2 from public.my_stuff_expenses where item_id=:'owner_item'),'failed writes no extra expenses');
select public._test_raises_v3(format('select public.save_my_stuff_service_history_v1(%L,null,%L,%L,null,%L,%L,%L)',:'owner_item',:'hours_def','{"service_name":"Wrong definition"}','{}','bad','history-cross-definition'),'Definition not found');
select public._test_raises_v3(format('select public.save_my_stuff_service_history_v1(%L,%L,null,%L,%L,%L,%L,%L)',:'owner_item',(:'hist'::jsonb->>'history_id'),'{"service_name":"Failed correction"}','{"description":"bad","category":"invalid","amount":5,"currency":"EUR","incurred_on":"2020-01-01"}','{"oil_product":"bad correction"}','bad','history-rollback-correction'),'check constraint');
select public._test_assert_v3((select count(*)=2 from public.my_stuff_service_history_revisions where history_id=(:'hist'::jsonb->>'history_id')::uuid),'failed correction preserves detail audit count');
select public._test_assert_v3((select count(*)=2 from public.my_stuff_expense_revisions where expense_id=(:'hist'::jsonb->>'expense_id')::uuid),'failed correction preserves expense count');
reset role;
-- Legacy imported row fixture: modern creation requires a current reading.
insert into public.my_stuff_items(user_id,name,item_type,usage_dimensions,client_mutation_id) values('11111111-1111-4111-8111-111111111111','Unknown current meter','car',array['mileage'],'history-no-current') returning id as no_current_item \gset
set role authenticated;
select public.save_my_stuff_service_history_v1(:'no_current_item',null,null,'{"service_name":"Unknown date known meter","mileage":1000}',null,'{}','Owner recollection','history-no-current-service');
select public._test_assert_v3((select current_mileage is null from public.my_stuff_items where id=:'no_current_item'),'historical meter never manufactures current reading');
select public._test_raises_v3(format('select public.save_my_stuff_service_history_v1(%L,null,null,%L,null,%L,%L,%L)',:'owner_item','{"service_name":"Invalid date","completed_at":"infinity"}','{}','bad','history-infinity'),'Invalid completion date');
select public._test_assert_v3(not has_function_privilege('anon','public.save_my_stuff_service_history_v1(uuid,uuid,uuid,jsonb,jsonb,jsonb,text,text)','execute'),'anonymous RPC denied');
select public._test_assert_v3(not has_table_privilege('authenticated','public.my_stuff_service_history_revisions','insert,update,delete'),'direct history revisions denied');
select public._test_assert_v3(not has_table_privilege('authenticated','public.my_stuff_service_history','insert,update,delete'),'direct history identity denied');
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public._test_assert_v3((select count(*)=0 from public.my_stuff_service_history),'other owner history hidden');
select public._test_assert_v3((select count(*)=0 from public.my_stuff_service_history_revisions),'other owner revisions hidden');
select public._test_raises_v3(format('select public.save_my_stuff_service_history_v1(%L,null,null,%L,null,%L,%L,%L)',:'owner_item','{"service_name":"Cross owner"}','{}','bad','history-cross-owner'),'item not found');
reset role;
