create function public._test_assert_v3(ok boolean,msg text) returns void language plpgsql as $$begin if ok is not true then raise exception 'assertion failed: %',msg; end if; end$$;
create function public._test_raises_v3(statement text,expected text) returns void language plpgsql as $$
begin execute statement; raise exception 'assertion failed: expected %',expected;
exception when others then if sqlerrm not like '%'||expected||'%' then raise exception 'assertion failed: expected %, got %',expected,sqlerrm; end if; end$$;
select public._test_assert_v3(not has_table_privilege('authenticated','public.my_stuff_expenses','insert,update,delete'),'direct expense writes denied');
select public._test_assert_v3(not has_table_privilege('authenticated','public.my_stuff_to_project_transfers','insert,update,delete'),'direct item transfer provenance writes denied');
select public._test_assert_v3(not has_table_privilege('authenticated','public.my_stuff_to_project_expense_copies','select,insert,update,delete'),'expense-copy provenance is server-only');
select public._test_assert_v3(has_function_privilege('authenticated','public.transfer_my_stuff_to_project_v1(uuid,text)','execute'),'item to Project transfer RPC granted');
select public._test_assert_v3(has_function_privilege('authenticated','public.create_my_stuff_expense_v3(uuid,jsonb,text)','execute'),'expense RPC granted');
select public._test_assert_v3(not has_function_privilege('authenticated','public.enqueue_my_stuff_research_v3(uuid,text,text)','execute'),'research enqueue disabled');
select public._test_assert_v3(not has_function_privilege('service_role','private.lease_my_stuff_research_job_v3(text,integer)','execute'),'provider lease disabled');
select public._test_assert_v3(not has_function_privilege('service_role','private.settle_my_stuff_research_job_v3(uuid,text,integer,jsonb,jsonb)','execute'),'provider settle disabled');
select public._test_assert_v3(not has_function_privilege('authenticated','public.reserve_my_stuff_attachment_v3(uuid,uuid,uuid,text,bigint,text,text)','execute'),'attachment reserve disabled');
select public._test_assert_v3(not has_function_privilege('authenticated','public.finalize_my_stuff_attachment_v3(uuid,text,text,text)','execute'),'attachment finalize disabled');
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.create_my_stuff_item_v2('{"name":"V3 car","item_type":"car","purchase_price":1000,"purchase_currency":"USD"}','v3-item') as item \gset
select public.confirm_my_stuff_vehicle_identity_v3(:'item','{"model_year":2020,"make":"Honda","model":"Civic","engine_model":"L15B7","engine_displacement_liters":1.5,"engine_cylinders":4,"vehicle_market":"US"}','confirm-1');
select public.create_my_stuff_expense_v3(:'item','{"description":"Custom","category":"other","custom_category":"Detailing","amount":25,"currency":"USD","incurred_on":"2026-09-05","mileage":12345,"hours":678}','expense-1') as expense \gset
select public.record_my_stuff_service_with_expense_v3(:'item',null,null,'{"service_name":"Oil change","completed_at":"2026-09-05T12:00:00Z","parts":[],"labor":[],"vendor":{},"warranty":{}}','{"description":"Oil change","category":"maintenance","amount":75,"currency":"USD","incurred_on":"2026-09-05"}','service-cost-1') as linked \gset
select public._test_assert_v3((select count(*)=2 from public.my_stuff_expenses),'two stable expenses');
select public._test_assert_v3((select custom_category='Detailing' and mileage=12345 and hours=678 from public.get_my_stuff_expenses_v3(:'item') where expense_id=:'expense'),'expense read RPC preserves editable custom category and usage');
select public._test_assert_v3((select (public.get_my_stuff_financial_summary_v3(:'item')->>'total_invested')::numeric=1100),'purchase is distinct and costs count once');
select public.revise_my_stuff_expense_v3(:'expense','{"amount":30}','correction','expense-revise');
select public._test_assert_v3((select count(*)=2 from public.my_stuff_expense_revisions where expense_id=:'expense'),'expense revisions append');
select public._test_raises_v3(format('select public.revise_my_stuff_expense_v3(%L,%L,%L,%L)', :'expense', '{"currency":"EUR"}', 'wrong currency', 'expense-revise-currency'), 'purchase currency');
select public._test_raises_v3(format('select public.void_my_stuff_expense_v3(%L,%L,%L)', :'expense', repeat('x',1001), 'expense-void-too-long'), 'must not exceed 1000');
select public._test_assert_v3(not has_table_privilege('authenticated','public.my_stuff_expense_revisions','update'),'immutable expense revisions deny direct updates');
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public._test_assert_v3((select count(*)=0 from public.my_stuff_expenses),'cross-owner RLS hides expenses');
reset role;
insert into public.projects(id,user_id,title,category) values('10000000-0000-4000-8000-000000000001','33333333-3333-4333-8333-333333333333','Adopt project','car');
insert into public.expenses(id,project_id,user_id,description,amount,category) values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','33333333-3333-4333-8333-333333333333','Imported paint',50,'cosmetic');
set role authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
select public.transfer_project_to_my_stuff_v2('10000000-0000-4000-8000-000000000001','{}','prior-v2') as adopted \gset
select public._test_assert_v3(public.transfer_project_to_my_stuff_v3('10000000-0000-4000-8000-000000000001','{}','adopt-v3')=:'adopted','V3 adopts V2 item');
select public._test_assert_v3((select count(*)=1 from public.my_stuff_expenses where source_project_expense_id='20000000-0000-4000-8000-000000000001'),'source expense imported once');
select public.transfer_project_to_my_stuff_v3('10000000-0000-4000-8000-000000000001','{}','adopt-v3');
select public._test_assert_v3((select count(*)=1 from public.my_stuff_expenses where source_project_expense_id='20000000-0000-4000-8000-000000000001'),'retry dedupes source expense');
reset role;
-- A V2 service transfer is adopted without duplicating its immutable occurrence.
insert into public.projects(id,user_id,title,category) values('10000000-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222','Service adoption','car');
insert into public.expenses(id,project_id,user_id,description,amount,category) values('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222','Transferred oil',80,'maintenance');
set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.transfer_project_to_my_stuff_v2('10000000-0000-4000-8000-000000000002','{"selected_expense_ids":["20000000-0000-4000-8000-000000000002"],"service_expense_ids":["20000000-0000-4000-8000-000000000002"]}','prior-v2-service') as adopted_service \gset
select public.transfer_project_to_my_stuff_v3('10000000-0000-4000-8000-000000000002','{"service_expense_ids":["20000000-0000-4000-8000-000000000002"]}','adopt-v3-service');
select public._test_assert_v3((select count(*)=1 from public.my_stuff_service_occurrences where user_id='22222222-2222-4222-8222-222222222222' and provenance_type='project_expense_snapshot' and provenance->>'id'='20000000-0000-4000-8000-000000000002'),'V2 service occurrence reused');
select public._test_assert_v3((select linked_occurrence_id is not null from public.my_stuff_expenses where source_project_expense_id='20000000-0000-4000-8000-000000000002'),'adopted cost links reused service occurrence');
reset role;
-- A new V3 transfer snapshots only an explicit project/expense allowlist, even
-- when legacy tables later gain sensitive columns that V2 would serialize.
alter table public.projects add column review_secret text;
alter table public.expenses add column review_secret text;
select public._test_raises_v3(format('insert into public.projects(user_id,title,category,transmission) values(%L,%L,%L,%L)','44444444-4444-4444-8444-444444444444','Invalid transmission','car',repeat('x',201)),'projects_transmission_length');
insert into public.projects(id,user_id,title,category,vehicle_year,transmission,review_secret) values('10000000-0000-4000-8000-000000000003','44444444-4444-4444-8444-444444444444','V3 direct transfer','car','2012','Automatic','project-secret');
insert into public.expenses(id,project_id,user_id,description,amount,category,review_secret) values('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003','44444444-4444-4444-8444-444444444444','V3 direct expense',45,'parts','expense-secret');
set role authenticated;
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',false);
select public.transfer_project_to_my_stuff_v3('10000000-0000-4000-8000-000000000003','{}','direct-v3') as direct_v3_item \gset
select public._test_assert_v3((select item_id=:'direct_v3_item' and project_snapshot->>'transmission'='Automatic' and 'transmission'=any(copied_fields) and not project_snapshot ? 'review_secret' and not selected_expense_snapshot::text like '%review_secret%' and not selected_expense_snapshot::text like '%expense-secret%' from public.my_stuff_project_transfers where project_id='10000000-0000-4000-8000-000000000003'),'V3 direct transfer snapshots are allowlisted and include transmission');
select public._test_assert_v3(public.transfer_project_to_my_stuff_v3('10000000-0000-4000-8000-000000000003','{}','direct-v3')=:'direct_v3_item','V3 direct transfer retry is idempotent');
reset role;
select public._test_assert_v3((select client_mutation_id='transfer-v3:10000000-0000-4000-8000-000000000003' and acquired_on is null and model_year=2012 and transmission='Automatic' from public.my_stuff_items where id=:'direct_v3_item') and (select count(*)=0 from public.my_stuff_v2_mutations where user_id='44444444-4444-4444-8444-444444444444'),'V3 converts the text Project year to an integer, includes transmission, does not delegate to V2, and does not invent an acquisition date');
-- Missing, blank, nonnumeric, and out-of-range Project years remain unknown.
insert into public.projects(id,user_id,title,category,vehicle_year) values
 ('10000000-0000-4000-8000-000000000004','55555555-5555-4555-8555-555555555555','Blank year','car','  '),
 ('10000000-0000-4000-8000-000000000005','66666666-6666-4666-8666-666666666666','Nonnumeric year','car','unknown'),
 ('10000000-0000-4000-8000-000000000006','77777777-7777-4777-8777-777777777777','Out of range year','car','9999'),
 ('10000000-0000-4000-8000-000000000007','99999999-9999-4999-8999-999999999999','Missing year','car',null);
set role authenticated;
select set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555555',false);
select public.transfer_project_to_my_stuff_v3('10000000-0000-4000-8000-000000000004','{}','blank-year') as blank_year_item \gset
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','66666666-6666-4666-8666-666666666666',false);
select public.transfer_project_to_my_stuff_v3('10000000-0000-4000-8000-000000000005','{}','nonnumeric-year') as nonnumeric_year_item \gset
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','77777777-7777-4777-8777-777777777777',false);
select public.transfer_project_to_my_stuff_v3('10000000-0000-4000-8000-000000000006','{}','out-of-range-year') as out_of_range_year_item \gset
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',false);
select public.transfer_project_to_my_stuff_v3('10000000-0000-4000-8000-000000000007','{}','missing-year') as missing_year_item \gset
reset role;
select public._test_assert_v3(
 (select model_year is null from public.my_stuff_items where id=:'blank_year_item') and
 (select model_year is null from public.my_stuff_items where id=:'nonnumeric_year_item') and
 (select model_year is null from public.my_stuff_items where id=:'out_of_range_year_item') and
 (select model_year is null from public.my_stuff_items where id=:'missing_year_item'),
 'invalid or missing Project years remain unknown instead of failing or being invented');
select public._test_raises_v3(format('insert into public.my_stuff_expense_audit(user_id,item_id,expense_id,action,actor_id,reason) values(%L,%L,%L,%L,%L,%L)', '11111111-1111-4111-8111-111111111111', :'item', :'expense', 'voided', '11111111-1111-4111-8111-111111111111', repeat('x',1001)), 'my_stuff_expense_audit_reason_check');
-- Exactly one owned immutable revision must be targeted by attachment metadata.
select public._test_raises_v3(format('insert into public.my_stuff_attachments(user_id,item_id,storage_path,media_type,byte_size,sha256,state) values(%L,%L,%L,%L,1,%L,%L)', '11111111-1111-4111-8111-111111111111', :'item', 'disabled', 'image/jpeg', repeat('a',64), 'reserved'), 'my_stuff_attachment_exactly_one_target_v3');
-- Completion is one-way and a second mutation cannot duplicate service or financial history.
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.create_my_stuff_custom_task_v3(:'item','{"name":"Brake fluid","service_category":"maintenance","service_action":"replace","normal_calendar_months":24}','task-create') as definition \gset
select id as planned from public.my_stuff_planned_occurrences where definition_id=:'definition' \gset
reset role;
create function public._test_block_next_v3() returns trigger language plpgsql as $$begin raise exception 'blocked successor'; end$$;
create trigger _test_block_next_v3 before insert on public.my_stuff_planned_occurrences for each row execute function public._test_block_next_v3();
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public._test_raises_v3(format('select public.complete_my_stuff_planned_occurrence_v3(%L,%L,%L,%L)', :'planned', '{"service_name":"Brake fluid","completed_at":"2026-09-05T12:00:00Z","parts":[],"labor":[],"vendor":{},"warranty":{}}', '{"description":"Brake fluid","category":"maintenance","amount":90,"currency":"USD","incurred_on":"2026-09-05"}', 'planned-complete-blocked'), 'blocked successor');
select public._test_assert_v3((select status='not_completed' and completed_service_occurrence_id is null from public.my_stuff_planned_occurrences where id=:'planned') and not exists(select 1 from public.my_stuff_service_occurrences where user_id='11111111-1111-4111-8111-111111111111' and client_mutation_id='v3-service:planned-complete-blocked') and not exists(select 1 from public.my_stuff_expenses where user_id='11111111-1111-4111-8111-111111111111' and client_mutation_id='v3-expense:planned-complete-blocked'),'successor failure rolls back the entire completion mutation');
reset role;
drop trigger _test_block_next_v3 on public.my_stuff_planned_occurrences;
drop function public._test_block_next_v3();
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.complete_my_stuff_planned_occurrence_v3(:'planned','{"service_name":"Brake fluid","completed_at":"2026-09-05T12:00:00Z","parts":[],"labor":[],"vendor":{},"warranty":{}}','{"description":"Brake fluid","category":"maintenance","amount":90,"currency":"USD","incurred_on":"2026-09-05"}','planned-complete-1');
select public._test_assert_v3((select count(*)=2 and count(*) filter(where status='not_completed')=1 and count(*) filter(where status='completed')=1 from public.my_stuff_planned_occurrences where definition_id=:'definition'),'completion atomically materializes next recurrence');
select public._test_raises_v3(format('select public.complete_my_stuff_planned_occurrence_v3(%L,%L,%L,%L)', :'planned', '{"service_name":"Brake fluid again","completed_at":"2026-09-05T13:00:00Z","parts":[],"labor":[],"vendor":{},"warranty":{}}', '{"description":"duplicate","category":"maintenance","amount":90,"currency":"USD","incurred_on":"2026-09-05"}', 'planned-complete-2'), 'already completed');
select public._test_raises_v3(format('select public.transition_my_stuff_occurrence_status_v3(%L,%L,null,%L)', :'planned', 'skipped', 'planned-reopen'), 'already completed');
select public._test_assert_v3((select count(*)=1 from public.my_stuff_service_occurrences where id=(select completed_service_occurrence_id from public.my_stuff_planned_occurrences where id=:'planned')),'one completion occurrence');
reset role;
-- Moving an owned item to Projects preserves original purchase cost, imports each
-- latest non-voided expense once, archives the item, and retains maintenance history.
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.transfer_my_stuff_to_project_v1(:'item','item-to-project-1') as selling_project \gset
select public._test_assert_v3((select purchase_price=1000 and title='V3 car' from public.projects where id=:'selling_project'),'original purchase price remains the Project purchase cost');
select public._test_assert_v3((select count(*)=3 and sum(amount)=195 from public.expenses where project_id=:'selling_project'),'latest non-voided item expenses transfer without folding into purchase cost');
reset role;
select public._test_assert_v3((select count(*)=3 and count(distinct source_expense_id)=3 from public.my_stuff_to_project_expense_copies where project_id=:'selling_project'),'each source expense has one server-only provenance row');
select public._test_assert_v3((select count(*) from public.my_stuff_to_project_expense_copies c join public.my_stuff_expenses e on e.id=c.source_expense_id where c.project_id=:'selling_project' and e.linked_occurrence_id is not null)=(select count(*) from public.my_stuff_expenses where item_id=:'item' and linked_occurrence_id is not null and voided_at is null),'linked maintenance expenses are copied once, not duplicated');
select public._test_assert_v3((select archived_at is not null from public.my_stuff_items where id=:'item'),'source item is archived');
select public._test_assert_v3((select count(*)>=2 from public.my_stuff_service_occurrences where item_id=:'item'),'source maintenance history is retained');
select public._test_raises_v3(format('delete from public.projects where id=%L', :'selling_project'), 'my_stuff_to_project_transfers_project_id_fkey');
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public._test_assert_v3(public.transfer_my_stuff_to_project_v1(:'item','item-to-project-1')=:'selling_project','identical retry returns the same Project');
select public._test_raises_v3(format('select public.transfer_my_stuff_to_project_v1(%L,%L)', :'item', 'item-alias-rejected'), 'Item was already moved to Projects');
select public._test_assert_v3((select count(*)=3 from public.expenses where project_id=:'selling_project'),'retry does not duplicate Project expenses');
select public._test_raises_v3(format('select public.create_my_stuff_expense_v3(%L,%L,%L)', :'item', '{"description":"Late cost","category":"repair","amount":1,"currency":"USD","incurred_on":"2026-09-05"}', 'late-expense'), 'Restore this My Stuff item');
reset role;
select project_expense_id as deletable_project_expense,source_expense_id as deletable_source_expense from public.my_stuff_to_project_expense_copies where project_id=:'selling_project' order by created_at,id limit 1 \gset
delete from public.expenses where id=:'deletable_project_expense';
select public._test_assert_v3((select project_expense_id is null from public.my_stuff_to_project_expense_copies where source_expense_id=:'deletable_source_expense'),'deleting an imported Project expense retains source provenance without blocking normal expense management');
set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public._test_raises_v3(format('select public.transfer_my_stuff_to_project_v1(%L,%L)', :'item', 'cross-owner-item-transfer'), 'Item not found');
reset role;

-- Projects have a USD, two-decimal accounting model. Reject unsupported source
-- currency or precision instead of silently rounding or losing denomination.
insert into public.user_entitlements(user_id,source,status,expires_at,last_verified_at)
values('11111111-1111-4111-8111-111111111111','stripe','active',now()+interval '30 days',now());
insert into public.my_stuff_items(id,user_id,name,item_type,category,purchase_price,purchase_currency,usage_profile,usage_dimensions,client_mutation_id) values
('50000000-0000-0000-0000-000000000091','11111111-1111-4111-8111-111111111111','EUR item','mower','equipment',25,'EUR','normal','{}','currency-item'),
('50000000-0000-0000-0000-000000000092','11111111-1111-4111-8111-111111111111','Fractional purchase','mower','equipment',10.005,'USD','normal','{}','fraction-purchase-item'),
('50000000-0000-0000-0000-000000000093','11111111-1111-4111-8111-111111111111','Fractional expense','mower','equipment',10,'USD','normal','{}','fraction-expense-item'),
('50000000-0000-0000-0000-000000000094','11111111-1111-4111-8111-111111111111','Non-VIN identity','mower','equipment',10,'USD','normal','{}','non-vin-identity-item');
update public.my_stuff_items set vin='1HGCM82633A004352',model_number='M1',serial_number='S1' where id='50000000-0000-0000-0000-000000000094';
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.create_my_stuff_expense_v3('50000000-0000-0000-0000-000000000093','{"description":"Fractional","category":"repair","amount":1.005,"currency":"USD","incurred_on":"2026-09-05"}','fraction-expense');
select public._test_raises_v3($q$select public.transfer_my_stuff_to_project_v1('50000000-0000-0000-0000-000000000091','currency-transfer')$q$,'Only USD items');
select public._test_raises_v3($q$select public.transfer_my_stuff_to_project_v1('50000000-0000-0000-0000-000000000092','fraction-purchase-transfer')$q$,'Purchase price must use no more than two decimal places');
select public._test_raises_v3($q$select public.transfer_my_stuff_to_project_v1('50000000-0000-0000-0000-000000000093','fraction-expense-transfer')$q$,'Every transferred expense must use USD and no more than two decimal places');
select public.transfer_my_stuff_to_project_v1('50000000-0000-0000-0000-000000000094','item-alias-rejected') as non_vin_project \gset
reset role;
select public._test_assert_v3(not exists(select 1 from public.projects where trade_up_mutation_id in ('my-stuff-transfer:50000000-0000-0000-0000-000000000091','my-stuff-transfer:50000000-0000-0000-0000-000000000092','my-stuff-transfer:50000000-0000-0000-0000-000000000093')),'rejected accounting transfers create no Projects');
select public._test_assert_v3((select vin is null and model_number='M1' and serial_number='S1' from public.projects where id=:'non_vin_project'),'non-VIN transfer keeps model and serial but drops stale hidden VIN');

insert into public.my_stuff_items(id,user_id,name,item_type,category,purchase_price,purchase_currency,usage_profile,usage_dimensions,client_mutation_id)
values('50000000-0000-0000-0000-000000000099','88888888-8888-4888-8888-888888888888','Limit test item','mower','equipment',25,'USD','normal','{}','limit-item');
insert into public.projects(id,user_id,title,category,status,purchase_price)
select gen_random_uuid(),'88888888-8888-4888-8888-888888888888','Active '||g,'other','active',1 from generate_series(1,6) g;
set role authenticated;
select set_config('request.jwt.claim.sub','88888888-8888-4888-8888-888888888888',false);
do $$begin
 begin perform public.transfer_my_stuff_to_project_v1('50000000-0000-0000-0000-000000000099','limit-check'); raise exception 'expected active project limit';
 exception when others then if sqlerrm not like 'Free accounts can have up to 6 active projects%' then raise; end if; end;
end$$;
reset role;
select public._test_assert_v3(not exists(select 1 from public.my_stuff_to_project_transfers where item_id='50000000-0000-0000-0000-000000000099'),'failed transfer writes no provenance');
select public._test_assert_v3((select archived_at is null from public.my_stuff_items where id='50000000-0000-0000-0000-000000000099'),'failed transfer leaves source item active');

-- Deferred provenance foreign keys block ordinary Project deletion without breaking
-- whole-account deletion cascades.
insert into auth.users(id) values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
insert into public.my_stuff_items(id,user_id,name,item_type,category,purchase_price,purchase_currency,usage_profile,usage_dimensions,client_mutation_id)
values('50000000-0000-0000-0000-000000000098','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Deletion item','mower','equipment',25,'USD','normal','{}','deletion-item');
set role authenticated;
select set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',false);
select public.create_my_stuff_expense_v3('50000000-0000-0000-0000-000000000098','{"description":"Blade","category":"maintenance","amount":2,"currency":"USD","incurred_on":"2026-09-05"}','deletion-expense');
select public.transfer_my_stuff_to_project_v1('50000000-0000-0000-0000-000000000098','deletion-transfer') as deletion_project \gset
reset role;
delete from auth.users where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select public._test_assert_v3(not exists(select 1 from public.projects where id=:'deletion_project'),'account deletion removes transferred Project');
select public._test_assert_v3(not exists(select 1 from public.my_stuff_to_project_transfers where user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),'account deletion removes transfer provenance');
select public._test_assert_v3(not exists(select 1 from public.my_stuff_to_project_expense_copies where user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),'account deletion removes expense provenance');

-- Revision rows reject both UPDATE and direct DELETE, even as table owner.
select public._test_raises_v3(format('update public.my_stuff_expense_revisions set notes=%L where expense_id=%L','tamper',:'expense'),'immutable');
select public._test_raises_v3(format('delete from public.my_stuff_expense_revisions where expense_id=%L',:'expense'),'immutable');
drop function public._test_assert_v3(boolean,text);
drop function public._test_raises_v3(text,text);
