-- Rows written by the pre-authoritative RPCs.  The new migration must turn
-- these identifiers into immutable canonical retry records before replacing
-- those RPCs.
begin;
insert into public.trade_up_goals(id,user_id,name,goal_type,target_amount,description,status,client_mutation_id,created_at)
values('70000000-0000-4000-8000-000000000007','77777777-7777-4777-8777-777777777777','Historical goal','amount',100,'before migration','active','historical-goal','2026-01-01Z');
insert into public.goal_ledger(id,goal_id,user_id,type,amount,note,client_mutation_id,created_at) values
('71000000-0000-4000-8000-000000000007','70000000-0000-4000-8000-000000000007','77777777-7777-4777-8777-777777777777','personal_contribution',20,'Starting amount','historical-goal:starting','2026-01-01Z'),
('72000000-0000-4000-8000-000000000007','70000000-0000-4000-8000-000000000007','77777777-7777-4777-8777-777777777777','personal_contribution',5,'historical note','historical-adjust','2026-01-02Z');
insert into public.projects(id,user_id,title,category,status,purchase_price,notes,goal_id,goal_funding_amount,out_of_pocket_amount,trade_up_mutation_id,created_at)
values
('73000000-0000-4000-8000-000000000007','77777777-7777-4777-8777-777777777777','Historical project','other','active',10,null,'70000000-0000-4000-8000-000000000007',10,0,'historical-project','2026-01-03Z'),
('74000000-0000-4000-8000-000000000007','77777777-7777-4777-8777-777777777777','Historical link','other','active',5,null,'70000000-0000-4000-8000-000000000007',5,0,'historical-link','2026-01-04Z');
insert into public.goal_ledger(goal_id,user_id,project_id,type,amount,note,client_mutation_id,created_at) values
('70000000-0000-4000-8000-000000000007','77777777-7777-4777-8777-777777777777','73000000-0000-4000-8000-000000000007','goal_purchase',-10,'Goal funds used for Historical project','historical-project:funding','2026-01-03Z'),
('70000000-0000-4000-8000-000000000007','77777777-7777-4777-8777-777777777777','74000000-0000-4000-8000-000000000007','goal_purchase',-5,'Goal funds allocated to existing project Historical link','historical-link:funding','2026-01-04Z');
commit;