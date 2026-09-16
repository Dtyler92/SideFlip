insert into public.trade_up_goals(id,user_id,name,target_amount,status,created_at)
values('22000000-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222','Concurrent completion',100,'active','2026-04-01Z');
insert into public.goal_ledger(goal_id,user_id,type,amount,note)
values('22000000-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222','personal_contribution',100,'funded');
insert into public.user_entitlements(user_id,source,status,expires_at,last_verified_at)
values
('44444444-4444-4444-8444-444444444444','admin','active',null,now()),
('22222222-2222-4222-8222-222222222222','admin','active',null,now());
insert into public.trade_up_goals(id,user_id,name,target_amount,status,created_at)
values('25000000-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222','Sale versus completion',100,'active','2026-05-01Z');
insert into public.projects(id,user_id,title,category,status,purchase_price,goal_id,out_of_pocket_amount)
values('25100000-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222','Concurrent sale','other','active',100,'25000000-0000-4000-8000-000000000002',100);
