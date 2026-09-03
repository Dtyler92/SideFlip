create table public._my_stuff_v1_rpc_snapshot as
select p.oid object_oid,p.proname,pg_get_function_identity_arguments(p.oid) identity_arguments,
 pg_get_function_result(p.oid) result_type,p.prosrc,p.prosecdef,p.proconfig
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in('create_my_stuff_item','create_my_stuff_schedule','complete_my_stuff_maintenance');
create table public._my_stuff_v1_column_snapshot as
select table_name,array_agg(column_name::text order by ordinal_position) columns from information_schema.columns
where table_schema='public' and table_name in('my_stuff_items','my_stuff_schedules','my_stuff_service_logs') group by table_name;

-- Historical rows deliberately violate new V2 business bounds. The additive
-- migration must install without rewriting or rejecting them.
insert into public.my_stuff_items(user_id,name,category,current_mileage,current_hours,client_mutation_id)
values('cccccccc-0000-4000-8000-000000000000',repeat('legacy-',60),'legacy-category',1000000000000,1000000000000,'legacy-dirty-v1');

insert into public.trade_up_goals(id,user_id,name,goal_type,target_amount,status,client_mutation_id)
values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','88888888-8888-4888-8888-888888888888','Real truck goal','amount',15000,'active','goal-realistic');
insert into public.projects(id,user_id,title,category,status,purchase_price,purchase_date,sale_price,sold_at,photo,before_photo,after_photo,notes,
 model_number,serial_number,engine_model,engine_serial,vin,hull_number,vehicle_year,vehicle_make,vehicle_model,goal_id,goal_funding_amount,out_of_pocket_amount,trade_credit_amount)
values
('80000000-0000-4000-8000-000000000001','88888888-8888-4888-8888-888888888888','Project Truck','truck','sold',1234.50,'2024-02-03',9999,'2026-01-01Z','main.jpg','before.jpg','after.jpg','private note','M1','S1','E1','ES1','VIN1','H1',2020,'Maker','Model X','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',700,534.50,111),
('80000000-0000-4000-8000-000000000002','88888888-8888-4888-8888-888888888888','Second Project','generator','active',50,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,0,50,0),
('90000000-0000-4000-8000-000000000001','99999999-9999-4999-8999-999999999999','Pro One','tool','active',10,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,0,10,0),
('90000000-0000-4000-8000-000000000002','99999999-9999-4999-8999-999999999999','Pro Two','boat','active',20,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,0,20,0);
insert into public.expenses(id,project_id,user_id,description,amount,category,labor_hours,created_at) values
('e0000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000001','88888888-8888-4888-8888-888888888888','Oil and filter',79.95,'maintenance',1.25,'2025-04-01Z'),
('e0000000-0000-4000-8000-000000000002','80000000-0000-4000-8000-000000000001','88888888-8888-4888-8888-888888888888','Paint supplies',200,'cosmetic',2,'2025-05-01Z');
insert into public.goal_ledger(id,goal_id,user_id,project_id,type,amount,note,client_mutation_id) values
('d0000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','88888888-8888-4888-8888-888888888888',null,'personal_contribution',700,'Starting amount','ledger-start'),
('d0000000-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','88888888-8888-4888-8888-888888888888','80000000-0000-4000-8000-000000000001','goal_purchase',-700,'Project funding','ledger-buy'),
('d0000000-0000-4000-8000-000000000003','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','88888888-8888-4888-8888-888888888888','80000000-0000-4000-8000-000000000001','sale_proceeds',9999,'Project sale','ledger-sale');

create table public._accounting_value_snapshot as
select p.id,p.status,p.purchase_price,p.sale_price,p.sold_at,p.goal_id,p.goal_funding_amount,p.out_of_pocket_amount,p.trade_credit_amount,
 (select coalesce(sum(e.amount),0) from public.expenses e where e.project_id=p.id) expense_total,
 (select coalesce(sum(l.amount),0) from public.goal_ledger l where l.project_id=p.id) ledger_total
from public.projects p where p.id='80000000-0000-4000-8000-000000000001';
