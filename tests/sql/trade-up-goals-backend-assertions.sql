create or replace function public._goal_test_assert(p_ok boolean,p_message text)
returns void language plpgsql as $$ begin
  if not coalesce(p_ok,false) then raise exception 'assertion failed: %',p_message; end if;
end $$;
create or replace function public._goal_test_raises(p_sql text,p_expected text)
returns boolean language plpgsql as $$
declare v_message text;
begin
  begin execute p_sql; exception when others then
    get stacked diagnostics v_message=message_text;
    return position(lower(p_expected) in lower(v_message))>0;
  end;
  return false;
end $$;

-- Exact ACL boundary: authenticated only, never anon/PUBLIC.
select public._goal_test_assert(not has_function_privilege('anon','public.update_trade_up_goal(uuid,text,numeric,text)','execute'),'anon cannot update goals');
select public._goal_test_assert(has_function_privilege('authenticated','public.update_trade_up_goal(uuid,text,numeric,text)','execute'),'authenticated can call update RPC');
select public._goal_test_assert(not has_function_privilege('anon','public.adjust_trade_up_goal(uuid,text,numeric,text,text)','execute'),'anon cannot adjust goals');
select public._goal_test_assert(not has_function_privilege('anon','public.create_trade_up_project(text,text,numeric,text,text,text,text,text,text,text,text,integer,text,text,uuid,numeric,numeric,text)','execute'),'anon cannot create linked projects');
select public._goal_test_assert(not has_function_privilege('anon','public.link_trade_up_project(uuid,uuid,numeric,text)','execute'),'anon cannot link projects');
select public._goal_test_assert(not has_function_privilege('anon','public.record_trade_up_sale(uuid,numeric,numeric)','execute'),'anon cannot record sales');
select public._goal_test_assert(not has_function_privilege('anon','public.record_trade_up_direct_trade(uuid,text,text,numeric,text,numeric,numeric,numeric,text,text)','execute'),'anon cannot record trades');
select public._goal_test_assert(not has_function_privilege('anon','public.undo_goal_project_outcome(uuid)','execute'),'anon cannot undo outcomes');
select public._goal_test_assert(not has_function_privilege('anon','public.delete_trade_up_goal(uuid)','execute'),'anon cannot delete goals');
select public._goal_test_assert(not has_function_privilege('anon','public.delete_trade_up_project(uuid)','execute'),'anon cannot delete projects');
select public._goal_test_assert(has_table_privilege('authenticated','public.trade_up_goals','update'),'legacy authenticated goal updates remain available');
select public._goal_test_assert(not has_table_privilege('anon','public.trade_up_goals','update'),'anon cannot update goals');
select public._goal_test_assert(not has_function_privilege('authenticated','public.assert_trade_up_goal_mutable(uuid,boolean)','execute'),'internal assertion helper is not callable');

-- User 1 creates multiple active goals while Pro, then loses Pro. Equal timestamps
-- prove UUID is the deterministic tie-breaker.
insert into public.user_entitlements(user_id,source,status,expires_at,last_verified_at)
values('11111111-1111-4111-8111-111111111111','admin','active',null,now());
insert into public.trade_up_goals(id,user_id,name,target_amount,status,created_at) values
('10000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','Retained',100,'active','2026-01-01Z'),
('20000000-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','Locked',100,'active','2026-01-01Z');
insert into public.projects(id,user_id,title,category,status,purchase_price,goal_id,out_of_pocket_amount) values
('21000000-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','Locked project','tool','active',20,'20000000-0000-4000-8000-000000000002',20);
delete from public.user_entitlements where user_id='11111111-1111-4111-8111-111111111111';

set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
-- Arbitrary custom GUCs are not capabilities, including within a transaction
-- that has already completed a legitimate RPC.
begin;
select set_config('sideflip.trade_up_rpc','on',true);
select public._goal_test_assert(public._goal_test_raises(
  $$update public.projects set title='spoofed' where id='21000000-0000-4000-8000-000000000002'$$,
  'Goal locked'),'spoofed GUC cannot bypass project guard');
select public._goal_test_assert(public._goal_test_raises(
  $$insert into public.expenses(project_id,user_id,description,amount) values('21000000-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','spoofed',1)$$,
  'Goal locked'),'spoofed GUC cannot bypass expense guard');
select public._goal_test_assert(public._goal_test_raises(
  $$update public.trade_up_goals set status='completed' where id='10000000-0000-4000-8000-000000000001'$$,
  'not fully funded'),'spoofed GUC cannot bypass direct completion guard');
select public.update_trade_up_goal('10000000-0000-4000-8000-000000000001',null,100,'authorization-probe');
select public._goal_test_assert(public._goal_test_raises(
  $$update public.trade_up_goals set target_amount=1 where id='20000000-0000-4000-8000-000000000002'$$,
  'Goal locked'),'successful RPC leaves no authorization behind');
rollback;
select public.adjust_trade_up_goal('10000000-0000-4000-8000-000000000001','personal_contribution',10,'seed','adjust-1') as retained_adjustment \gset
select public._goal_test_assert(
  public.adjust_trade_up_goal('10000000-0000-4000-8000-000000000001','personal_contribution',10,'seed','adjust-1')=:'retained_adjustment',
  'identical adjustment retry returns the original row');
select public._goal_test_assert(public._goal_test_raises(
  $$select public.adjust_trade_up_goal('10000000-0000-4000-8000-000000000001','personal_contribution',11,'seed','adjust-1')$$,
  'Conflicting retry for adjustment'),'adjustment retry payload equality is enforced');
select public._goal_test_assert(public._goal_test_raises(
  $$select public.adjust_trade_up_goal('20000000-0000-4000-8000-000000000002','personal_contribution',1,null,'locked-adjust')$$,
  'Goal locked'),'later active goal is locked after downgrade');
select public._goal_test_assert(public._goal_test_raises(
  $$insert into public.expenses(project_id,user_id,description,amount) values('21000000-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','bypass',1)$$,
  'Goal locked'),'direct expense mutation cannot bypass a locked goal');
update public.trade_up_goals set name='  Legacy renamed  ',description='legacy description',target_amount=101.004
where id='10000000-0000-4000-8000-000000000001';
select public._goal_test_assert((select name='Legacy renamed' and description='legacy description' and target_amount=101.00
  from public.trade_up_goals where id='10000000-0000-4000-8000-000000000001'),
  'legacy client direct name/description/target update is guarded and normalized');
select public._goal_test_assert(public._goal_test_raises(
  $$update public.trade_up_goals set target_amount=1 where id='20000000-0000-4000-8000-000000000002'$$,
  'Goal locked'),'legacy direct update honors retained-goal access');
select public._goal_test_assert(public._goal_test_raises(
  $$update public.trade_up_goals set user_id='22222222-2222-4222-8222-222222222222' where id='10000000-0000-4000-8000-000000000001'$$,
  'Goal not found'),'legacy direct update cannot change ownership');
reset role;

-- Ownership is resolved from auth.uid(), never caller-supplied IDs.
set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public._goal_test_assert(public._goal_test_raises(
  $$select public.adjust_trade_up_goal('10000000-0000-4000-8000-000000000001','personal_contribution',1,null,'cross-owner')$$,
  'Goal not found'),'cross-owner adjustment is denied');
reset role;

-- Completion uses ledger + active project purchase + active project expenses,
-- all locked in the same transaction. Underfunded completion fails.
insert into public.trade_up_goals(id,user_id,name,target_amount,status,created_at) values
('30000000-0000-4000-8000-000000000003','33333333-3333-4333-8333-333333333333','Completion',120,'active','2026-02-01Z');
insert into public.goal_ledger(goal_id,user_id,type,amount,note) values
('30000000-0000-4000-8000-000000000003','33333333-3333-4333-8333-333333333333','personal_contribution',50,'funds');
insert into public.projects(id,user_id,title,category,status,purchase_price,goal_id,out_of_pocket_amount) values
('31000000-0000-4000-8000-000000000003','33333333-3333-4333-8333-333333333333','Active asset','tool','active',40,'30000000-0000-4000-8000-000000000003',40);
insert into public.expenses(id,project_id,user_id,description,amount) values
('32000000-0000-4000-8000-000000000003','31000000-0000-4000-8000-000000000003','33333333-3333-4333-8333-333333333333','repair',10);
set role authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
select public._goal_test_assert(public._goal_test_raises(
  $$select public.update_trade_up_goal('30000000-0000-4000-8000-000000000003','completed',120,'complete-underfunded')$$,
  'not fully funded'),'underfunded completion is denied');
select public.update_trade_up_goal('30000000-0000-4000-8000-000000000003',null,100,'target-1');
select public._goal_test_assert(
  public.update_trade_up_goal('30000000-0000-4000-8000-000000000003',null,100,'target-1')='30000000-0000-4000-8000-000000000003',
  'identical goal update retry is idempotent');
select public._goal_test_assert(public._goal_test_raises(
  $$select public.update_trade_up_goal('30000000-0000-4000-8000-000000000003',null,101,'target-1')$$,
  'Conflicting retry for goal update'),'goal update retry payload equality is enforced');
select public.update_trade_up_goal('30000000-0000-4000-8000-000000000003','completed',100,'complete-funded');
select public._goal_test_assert((select status='completed' and completed_at is not null from public.trade_up_goals where id='30000000-0000-4000-8000-000000000003'),'fully funded completion succeeds');
reset role;

-- Reopening is a new activation and must fail closed when another Free goal is active.
insert into public.user_entitlements(user_id,source,status,expires_at,last_verified_at)
values('33333333-3333-4333-8333-333333333333','admin','active',null,now());
insert into public.trade_up_goals(id,user_id,name,target_amount,status,created_at) values
('33000000-0000-4000-8000-000000000003','33333333-3333-4333-8333-333333333333','Other active',10,'active','2026-03-01Z');
delete from public.user_entitlements where user_id='33333333-3333-4333-8333-333333333333';
set role authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
select public._goal_test_assert(public._goal_test_raises(
  $$select public.update_trade_up_goal('30000000-0000-4000-8000-000000000003','active',100,'reopen-denied')$$,
  'one active'),'Free reopen cannot create a second active goal');
reset role;
delete from public.trade_up_goals where id='33000000-0000-4000-8000-000000000003';
set role authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
select public.update_trade_up_goal('30000000-0000-4000-8000-000000000003','active',100,'reopen-ok');
select public._goal_test_assert((select status='active' and completed_at is null from public.trade_up_goals where id='30000000-0000-4000-8000-000000000003'),'reopen succeeds when the Free slot is available');
reset role;

-- A downgrade committed before the mutation boundary is observed and denied.
insert into public.user_entitlements(user_id,source,status,expires_at,last_verified_at)
values('44444444-4444-4444-8444-444444444444','admin','active',null,now());
insert into public.trade_up_goals(id,user_id,name,target_amount,status,created_at) values
('40000000-0000-4000-8000-000000000004','44444444-4444-4444-8444-444444444444','Old',10,'active','2026-01-01Z'),
('41000000-0000-4000-8000-000000000004','44444444-4444-4444-8444-444444444444','Later',10,'active','2026-02-01Z');
delete from public.user_entitlements where user_id='44444444-4444-4444-8444-444444444444';
set role authenticated;
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',false);
select public._goal_test_assert(public._goal_test_raises(
  $$select public.update_trade_up_goal('41000000-0000-4000-8000-000000000004',null,11,'downgraded-update')$$,
  'Goal locked'),'downgrade is authoritative at mutation time');
reset role;

select public._goal_test_assert(
  pg_get_functiondef('public.assert_trade_up_goal_mutable(uuid,boolean)'::regprocedure) ilike '%for share%',
  'entitlement rows are locked against a concurrent downgrade');
select public._goal_test_assert(
  pg_get_functiondef('public.update_trade_up_goal(uuid,text,numeric,text)'::regprocedure) ilike '%for update%',
  'completion inputs are locked against concurrent mutations');

-- Legacy direct completion gets the same authoritative funding check.
insert into public.trade_up_goals(id,user_id,name,target_amount,status,created_at)
values('23000000-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222','Legacy direct underfunded',50,'active','2026-01-01Z');
set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public._goal_test_assert(public._goal_test_raises(
  $$update public.trade_up_goals set status='completed',completed_at=now() where id='23000000-0000-4000-8000-000000000002'$$,
  'not fully funded'),'legacy direct completion cannot bypass funding');
reset role;
delete from public.trade_up_goals where id='23000000-0000-4000-8000-000000000002';

-- New expenses must be finite and must reference an owned project. The NOT
-- VALID check leaves legacy corruption installable but blocks every new write.
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public._goal_test_assert(public._goal_test_raises(
  $$insert into public.expenses(project_id,user_id,description,amount) values('21000000-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','nan','NaN'::numeric)$$,
  'finite'),'authenticated NaN expense is rejected at the DB boundary');
select public._goal_test_assert(public._goal_test_raises(
  $$insert into public.expenses(project_id,user_id,description,amount) values('51000000-0000-4000-8000-000000000005','11111111-1111-4111-8111-111111111111','foreign',1)$$,
  'Owned project not found'),'foreign project expense is rejected');
select public._goal_test_assert(public._goal_test_raises(
  $$insert into public.expenses(project_id,user_id,description,amount) values('99999999-9999-4999-8999-999999999999','11111111-1111-4111-8111-111111111111','missing',1)$$,
  'Owned project not found'),'missing project expense is rejected');
reset role;
select public._goal_test_assert((select convalidated=false from pg_constraint where conname='expenses_amount_finite'),
  'finite expense check is legacy-safe NOT VALID');

-- A retained legacy NaN may exist, but it can never make completion succeed.
insert into public.trade_up_goals(id,user_id,name,target_amount,status,created_at)
values('50000000-0000-4000-8000-000000000005','55555555-5555-4555-8555-555555555555','Legacy NaN goal',1,'active','2026-01-01Z');
update public.projects set goal_id='50000000-0000-4000-8000-000000000005',goal_funding_amount=0,out_of_pocket_amount=0
where id='51000000-0000-4000-8000-000000000005';
set role authenticated;
select set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555555',false);
select public._goal_test_assert(public._goal_test_raises(
  $$select public.update_trade_up_goal('50000000-0000-4000-8000-000000000005','completed',1,'legacy-nan-complete')$$,
  'non-finite'),'non-finite completion sums are rejected explicitly');
reset role;

-- Canonical idempotency records reject payload and cross-operation conflicts,
-- while currency-equivalent normalized retries return the original result.
set role authenticated;
select set_config('request.jwt.claim.sub','66666666-6666-4666-8666-666666666666',false);
select public._goal_test_assert(public._goal_test_raises(
  $$select public.create_trade_up_goal('Bad','amount',null,'NaN'::numeric,null,0,'bad-nan-goal')$$,
  'finite'),'goal creation rejects NaN target');
select public._goal_test_assert(public._goal_test_raises(
  $$select public.create_trade_up_goal('Bad','amount',null,10,null,'Infinity'::numeric,'bad-inf-goal')$$,
  'finite'),'goal creation rejects infinite starting amount');
select public.create_trade_up_goal(' Canonical ','amount',null,100.004,' ',20.004,'canonical-create') as canonical_goal \gset
select public._goal_test_assert(public.create_trade_up_goal('Canonical','amount',null,100.00,null,20.00,'canonical-create')=:'canonical_goal',
  'normalized goal creation retry returns prior result');
select public._goal_test_assert(public._goal_test_raises(
  $$select public.create_trade_up_goal('Changed','amount',null,100,null,20,'canonical-create')$$,
  'Conflicting retry'),'goal creation payload conflict is rejected');
select public._goal_test_assert(public._goal_test_raises(
  format('select public.adjust_trade_up_goal(%L,''personal_contribution'',1,null,''canonical-create'')',:'canonical_goal'),
  'Conflicting retry'),'cross-operation mutation ID conflict is rejected');

select public.adjust_trade_up_goal(:'canonical_goal','personal_contribution',5.004,' note ','canonical-adjust') as canonical_adjust \gset
select public._goal_test_assert(public.adjust_trade_up_goal(:'canonical_goal','personal_contribution',5.00,'note','canonical-adjust')=:'canonical_adjust',
  'normalized adjustment retry returns prior result');
select public._goal_test_assert(public._goal_test_raises(
  format('select public.adjust_trade_up_goal(%L,''personal_contribution'',5.02,''note'',''canonical-adjust'')',:'canonical_goal'),
  'Conflicting retry'),'adjustment payload conflict is rejected');

select public.create_trade_up_project(' Canonical project ','other',10.004,null,' ',null,null,null,null,null,null,null,null,null,
  :'canonical_goal',10.004,0,'canonical-project') as canonical_project \gset
select public._goal_test_assert(public.create_trade_up_project('Canonical project','other',10.00,null,null,null,null,null,null,null,null,null,null,null,
  :'canonical_goal',10.00,0.00,'canonical-project')=:'canonical_project','normalized project creation retry returns prior result');
select public._goal_test_assert(public._goal_test_raises(
  format('select public.create_trade_up_project(''Changed'',''other'',10,null,null,null,null,null,null,null,null,null,null,null,%L,10,0,''canonical-project'')',:'canonical_goal'),
  'Conflicting retry'),'project creation payload conflict is rejected');

insert into public.projects(id,user_id,title,category,status,purchase_price)
values('61000000-0000-4000-8000-000000000006','66666666-6666-4666-8666-666666666666','Link me','other','active',5);
select public.link_trade_up_project('61000000-0000-4000-8000-000000000006',:'canonical_goal',5.004,'canonical-link') as canonical_link \gset
select public._goal_test_assert(public.link_trade_up_project('61000000-0000-4000-8000-000000000006',:'canonical_goal',5.00,'canonical-link')=:'canonical_link',
  'normalized link retry returns prior result');
select public._goal_test_assert(public._goal_test_raises(
  format('select public.link_trade_up_project(''61000000-0000-4000-8000-000000000006'',%L,4,''canonical-link'')',:'canonical_goal'),
  'Conflicting retry'),'link payload conflict is rejected');

select public.record_trade_up_direct_trade(:'canonical_project',' Received ','other',10.004,'none',0,0,0,' ','canonical-trade') as canonical_trade \gset
select public._goal_test_assert(public.record_trade_up_direct_trade(:'canonical_project','Received','other',10.00,'none',0.00,0.00,0.00,null,'canonical-trade')=:'canonical_trade',
  'normalized direct-trade retry returns prior result');
select public._goal_test_assert(public._goal_test_raises(
  format('select public.record_trade_up_direct_trade(%L,''Different'',''other'',10,''none'',0,0,0,null,''canonical-trade'')',:'canonical_project'),
  'Conflicting retry'),'direct-trade payload conflict is rejected');

select public.update_trade_up_goal(:'canonical_goal',null,100.004,'canonical-update');
select public._goal_test_assert(public.update_trade_up_goal(:'canonical_goal',null,100.00,'canonical-update')=:'canonical_goal',
  'normalized update retry returns prior result');
select public._goal_test_assert(public._goal_test_raises(
  format('select public.update_trade_up_goal(%L,null,100.02,''canonical-update'')',:'canonical_goal'),
  'Conflicting retry'),'update payload conflict is rejected');
reset role;

select public._goal_test_assert((select count(*)=6 from public.trade_up_goal_mutations
  where user_id='66666666-6666-4666-8666-666666666666'),
  'all mutation-ID operations persist canonical operation/payload/result records');

-- Canonical history is installed before the RPCs are replaced.  It survives
-- state changes and deletion, and remains strict about payload/operation reuse.
set role authenticated;
select set_config('request.jwt.claim.sub','77777777-7777-4777-8777-777777777777',false);
select public._goal_test_assert(public.create_trade_up_goal('Historical goal','amount',null,100,'before migration',20,'historical-goal')
  ='70000000-0000-4000-8000-000000000007','historical goal creation retry resolves to its original ID');
select public._goal_test_assert(public.adjust_trade_up_goal('70000000-0000-4000-8000-000000000007','personal_contribution',5,'historical note','historical-adjust')
  ='72000000-0000-4000-8000-000000000007','historical adjustment retry resolves to its original ledger ID');
select public._goal_test_assert(public.create_trade_up_project('Historical project','other',10,null,null,null,null,null,null,null,null,null,null,null,
  '70000000-0000-4000-8000-000000000007',10,0,'historical-project')='73000000-0000-4000-8000-000000000007',
  'historical project creation retry resolves before current project state checks');
select public._goal_test_assert(public.link_trade_up_project('74000000-0000-4000-8000-000000000007','70000000-0000-4000-8000-000000000007',5,'historical-link')
  ='74000000-0000-4000-8000-000000000007','historical link retry resolves before already-linked checks');
select public._goal_test_assert(public._goal_test_raises(
  $$select public.adjust_trade_up_goal('70000000-0000-4000-8000-000000000007','personal_contribution',1,null,'historical-goal')$$,
  'Conflicting retry'),'historical IDs cannot be reused across operations');
select public.delete_trade_up_goal('70000000-0000-4000-8000-000000000007');
select public._goal_test_assert(public.create_trade_up_goal('Historical goal','amount',null,100,'before migration',20,'historical-goal')
  ='70000000-0000-4000-8000-000000000007','deleted goal retry returns the stable tombstoned result');
select public._goal_test_assert(public._goal_test_raises(
  $$select public.create_trade_up_goal('Replacement','amount',null,100,null,0,'historical-goal')$$,
  'Conflicting retry'),'deleted mutation ID cannot be reused with another payload');
reset role;
select public._goal_test_assert((select goal_id is null and result_id='70000000-0000-4000-8000-000000000007'
  from public.trade_up_goal_mutations where user_id='77777777-7777-4777-8777-777777777777' and mutation_id='historical-goal'),
  'goal deletion preserves a mutation tombstone and stable result ID');

-- Every canonical retry resolves immediately after the owner lock, before a
-- completed/locked goal or changed project state can reject it.
insert into public.user_entitlements(user_id,source,status,expires_at,last_verified_at)
values('88888888-8888-4888-8888-888888888888','admin','active',null,now());
set role authenticated;
select set_config('request.jwt.claim.sub','88888888-8888-4888-8888-888888888888',false);
select public.create_trade_up_goal('Retained','amount',null,10,null,10,'retry-retained') as retry_retained \gset
select public.create_trade_up_goal('Will lock','amount',null,100,null,100,'retry-goal') as retry_goal \gset
select public.adjust_trade_up_goal(:'retry_goal','personal_contribution',5,null,'retry-adjust') as retry_adjust \gset
select public.create_trade_up_project('Retry project','other',10,null,null,null,null,null,null,null,null,null,null,null,
  :'retry_goal',10,0,'retry-project') as retry_project \gset
insert into public.projects(id,user_id,title,category,status,purchase_price)
values('81000000-0000-4000-8000-000000000008','88888888-8888-4888-8888-888888888888','Retry link','other','active',5);
select public.link_trade_up_project('81000000-0000-4000-8000-000000000008',:'retry_goal',5,'retry-link');
select public.record_trade_up_direct_trade(:'retry_project','Retry incoming','other',10,'none',0,0,0,null,'retry-trade') as retry_trade \gset
select public.update_trade_up_goal(:'retry_goal','completed',100,'retry-complete');
reset role;
delete from public.user_entitlements where user_id='88888888-8888-4888-8888-888888888888';
set role authenticated;
select set_config('request.jwt.claim.sub','88888888-8888-4888-8888-888888888888',false);
select public._goal_test_assert(public.create_trade_up_goal('Will lock','amount',null,100,null,100,'retry-goal')=:'retry_goal','create retry survives downgrade');
select public._goal_test_assert(public.adjust_trade_up_goal(:'retry_goal','personal_contribution',5,null,'retry-adjust')=:'retry_adjust','adjust retry survives completion and downgrade');
select public._goal_test_assert(public.create_trade_up_project('Retry project','other',10,null,null,null,null,null,null,null,null,null,null,null,
  :'retry_goal',10,0,'retry-project')=:'retry_project','project retry survives completion and downgrade');
select public._goal_test_assert(public.link_trade_up_project('81000000-0000-4000-8000-000000000008',:'retry_goal',5,'retry-link')
  ='81000000-0000-4000-8000-000000000008','link retry survives completion and downgrade');
select public._goal_test_assert(public.record_trade_up_direct_trade(:'retry_project','Retry incoming','other',10,'none',0,0,0,null,'retry-trade')=:'retry_trade',
  'trade retry survives completion, downgrade, and outgoing state change');
select public._goal_test_assert(public.update_trade_up_goal(:'retry_goal','completed',100,'retry-complete')=:'retry_goal','completion retry survives completion and downgrade');

-- Currency precision is applied before validation and replay comparison.
select public._goal_test_assert(public._goal_test_raises(
  format('select public.record_trade_up_direct_trade(%L,''Sub-cent'',''other'',0.004,''none'',0,0,0,null,''sub-cent-trade'')',:'retry_trade'),
  'trade value required'),'sub-cent direct trade value rounds to zero and is rejected');
select public.update_trade_up_goal(:'retry_retained',null,20,'sale-target');
select public.create_trade_up_project('Sale rounding','other',0,null,null,null,null,null,null,null,null,null,null,null,
  :'retry_retained',0,0,'sale-round-project') as sale_round_project \gset
select public.record_trade_up_sale(:'sale_round_project',10.004,5.004);
select public.record_trade_up_sale(:'sale_round_project',10.00,5.00);
select public._goal_test_assert((select sale_price=10.00 from public.projects where id=:'sale_round_project'),'sale price persists in cents');
select public._goal_test_assert((select bool_and(amount in (10.00,-5.00)) and count(*)=2 from public.goal_ledger where project_id=:'sale_round_project'),
  'sale ledger persists normalized proceeds and allocation exactly once');
reset role;

-- Legacy NaN in the available-balance sum fails explicitly in every accounting
-- comparison instead of bypassing ordinary numeric inequalities.
insert into public.goal_ledger(goal_id,user_id,type,amount,note)
values('50000000-0000-4000-8000-000000000005','55555555-5555-4555-8555-555555555555','personal_contribution','NaN'::numeric,'legacy corruption');
insert into public.projects(id,user_id,title,category,status,purchase_price)
values('83000000-0000-4000-8000-000000000008','55555555-5555-4555-8555-555555555555','NaN link candidate','other','active',1);
insert into public.projects(id,user_id,title,category,status,purchase_price,goal_id,out_of_pocket_amount)
values('84000000-0000-4000-8000-000000000008','55555555-5555-4555-8555-555555555555','NaN trade candidate','other','active',1,'50000000-0000-4000-8000-000000000005',1);
set role authenticated;
select set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555555',false);
select public._goal_test_assert(public._goal_test_raises(
  $$select public.adjust_trade_up_goal('50000000-0000-4000-8000-000000000005','cash_out',1,null,'nan-adjust')$$,'non-finite'),
  'adjust rejects a non-finite available balance');
select public._goal_test_assert(public._goal_test_raises(
  $$select public.create_trade_up_project('NaN create','other',1,null,null,null,null,null,null,null,null,null,null,null,'50000000-0000-4000-8000-000000000005',1,0,'nan-create')$$,'non-finite'),
  'project creation rejects a non-finite available balance');
select public._goal_test_assert(public._goal_test_raises(
  $$select public.link_trade_up_project('83000000-0000-4000-8000-000000000008','50000000-0000-4000-8000-000000000005',1,'nan-link')$$,'non-finite'),
  'project link rejects a non-finite available balance');
select public._goal_test_assert(public._goal_test_raises(
  $$select public.record_trade_up_direct_trade('84000000-0000-4000-8000-000000000008','NaN incoming','other',1,'paid',1,1,0,null,'nan-trade')$$,'non-finite'),
  'direct trade rejects a non-finite available balance');
reset role;

-- ACL checks cover every SECURITY DEFINER helper/trigger and every public RPC.
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
insert into public.projects(id,user_id,title,category,status,purchase_price)
values('99000000-0000-4000-8000-000000000099','11111111-1111-4111-8111-111111111111','Ordinary project','other','active',1);
insert into public.expenses(project_id,user_id,description,amount)
values('99000000-0000-4000-8000-000000000099','11111111-1111-4111-8111-111111111111','Ordinary expense',1);
select public._goal_test_assert(exists(
  select 1 from public.expenses where project_id='99000000-0000-4000-8000-000000000099' and amount=1
),'authenticated owners can write finite ordinary expenses');
reset role;

select public._goal_test_assert((select bool_and(not has_function_privilege('anon',p.oid,'execute'))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prosecdef and p.proname in (
    'assert_trade_up_goal_mutable','enforce_free_active_trade_up_goal_limit','create_trade_up_goal','update_trade_up_goal',
    'adjust_trade_up_goal','create_trade_up_project','link_trade_up_project','record_trade_up_sale','record_trade_up_direct_trade',
    'undo_goal_project_outcome','delete_trade_up_goal','delete_trade_up_project','guard_trade_up_project_mutations',
    'guard_trade_up_expense_mutations','guard_direct_trade_up_goal_updates','enforce_trade_up_goal_ownership')),'anon executes none of the SECURITY DEFINER functions');
select public._goal_test_assert((select bool_and(not has_function_privilege('authenticated',p.oid,'execute'))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prosecdef and p.proname in (
    'assert_trade_up_goal_mutable','enforce_free_active_trade_up_goal_limit','guard_trade_up_project_mutations',
    'guard_trade_up_expense_mutations','guard_direct_trade_up_goal_updates','enforce_trade_up_goal_ownership')),'authenticated cannot execute internal SECURITY DEFINER helpers');
select public._goal_test_assert(not has_function_privilege('authenticated','public.assert_trade_up_goal_mutable(uuid,boolean)','execute'),
  'assert helper remains internal');
select public._goal_test_assert((select bool_and(p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public'])
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('assert_trade_up_goal_mutable','create_trade_up_goal','update_trade_up_goal',
    'adjust_trade_up_goal','create_trade_up_project','link_trade_up_project','record_trade_up_direct_trade','guard_direct_trade_up_goal_updates',
    'enforce_trade_up_goal_ownership')),
  'security-definer functions pin the hardened search_path');

drop function public._goal_test_raises(text,text);
drop function public._goal_test_assert(boolean,text);
