create function public._test_assert_v3(ok boolean,msg text) returns void language plpgsql as $$begin if ok is not true then raise exception 'assertion failed: %',msg; end if; end$$;
create function public._test_raises_v3(statement text,expected text) returns void language plpgsql as $$
begin execute statement; raise exception 'assertion failed: expected %',expected;
exception when others then if sqlerrm not like '%'||expected||'%' then raise exception 'assertion failed: expected %, got %',expected,sqlerrm; end if; end$$;
select public._test_assert_v3(not has_table_privilege('authenticated','public.my_stuff_expenses','insert,update,delete'),'direct expense writes denied');
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
insert into public.projects(id,user_id,title,category,review_secret) values('10000000-0000-4000-8000-000000000003','44444444-4444-4444-8444-444444444444','V3 direct transfer','car','project-secret');
insert into public.expenses(id,project_id,user_id,description,amount,category,review_secret) values('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003','44444444-4444-4444-8444-444444444444','V3 direct expense',45,'parts','expense-secret');
set role authenticated;
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',false);
select public.transfer_project_to_my_stuff_v3('10000000-0000-4000-8000-000000000003','{}','direct-v3') as direct_v3_item \gset
select public._test_assert_v3((select item_id=:'direct_v3_item' and not project_snapshot ? 'review_secret' and not selected_expense_snapshot::text like '%review_secret%' and not selected_expense_snapshot::text like '%expense-secret%' from public.my_stuff_project_transfers where project_id='10000000-0000-4000-8000-000000000003'),'V3 direct transfer snapshots are allowlisted');
select public._test_assert_v3(public.transfer_project_to_my_stuff_v3('10000000-0000-4000-8000-000000000003','{}','direct-v3')=:'direct_v3_item','V3 direct transfer retry is idempotent');
reset role;
select public._test_assert_v3((select client_mutation_id='transfer-v3:10000000-0000-4000-8000-000000000003' and acquired_on is null from public.my_stuff_items where id=:'direct_v3_item') and (select count(*)=0 from public.my_stuff_v2_mutations where user_id='44444444-4444-4444-8444-444444444444'),'V3 creates its item without delegating to V2 or inventing an acquisition date');
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
-- Revision rows reject both UPDATE and direct DELETE, even as table owner.
select public._test_raises_v3(format('update public.my_stuff_expense_revisions set notes=%L where expense_id=%L','tamper',:'expense'),'immutable');
select public._test_raises_v3(format('delete from public.my_stuff_expense_revisions where expense_id=%L',:'expense'),'immutable');
drop function public._test_assert_v3(boolean,text);
drop function public._test_raises_v3(text,text);
