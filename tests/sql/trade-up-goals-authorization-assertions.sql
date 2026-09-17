-- Exercise real role privileges and bounded capability lifetime, not just SQL text.
begin;
create function public._goal_test_assert(p_ok boolean,p_message text)
returns void language plpgsql as $$ begin
  if not coalesce(p_ok,false) then raise exception 'assertion failed: %',p_message; end if;
end $$;
create function public._goal_test_raises(p_sql text,p_expected text)
returns boolean language plpgsql as $$
declare v_message text;
begin
  begin execute p_sql; exception when others then
    get stacked diagnostics v_message=message_text;
    return position(lower(p_expected) in lower(v_message))>0;
  end;
  return false;
end $$;
select public._goal_test_assert(not exists(select 1 from sideflip_trade_up_private.rpc_context),
  'all preceding successful RPCs and replays cleaned their capability');
insert into public.user_entitlements(user_id,source,status,expires_at,last_verified_at)
values('88888888-8888-4888-8888-888888888888','admin','active',null,now());
insert into public.trade_up_goals(id,user_id,name,target_amount,status,created_at) values
('91000000-0000-4000-8000-000000000001','88888888-8888-4888-8888-888888888888','Auth retained',100,'active','2020-01-01Z'),
('91000000-0000-4000-8000-000000000002','88888888-8888-4888-8888-888888888888','Auth locked',100,'active','2020-02-01Z');
insert into public.projects(id,user_id,title,purchase_price,goal_id,out_of_pocket_amount) values
('92000000-0000-4000-8000-000000000001','88888888-8888-4888-8888-888888888888','Retained project',10,'91000000-0000-4000-8000-000000000001',10),
('92000000-0000-4000-8000-000000000002','88888888-8888-4888-8888-888888888888','Locked project',10,'91000000-0000-4000-8000-000000000002',10);
delete from public.user_entitlements where user_id='88888888-8888-4888-8888-888888888888';

select public._goal_test_assert(not has_table_privilege('authenticated','sideflip_trade_up_private.rpc_context','INSERT')
  and not has_table_privilege('service_role','sideflip_trade_up_private.rpc_context','INSERT')
  and not has_function_privilege('authenticated','sideflip_trade_up_private.has_rpc_context(uuid,uuid,uuid)','EXECUTE'),
  'private object ACLs deny access independently of schema ACL');
-- An error after capability installation must roll back the capability as well.
create function public._goal_auth_fail_after_context() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if new.title='fail-after-context' then
    perform public._goal_test_assert(sideflip_trade_up_private.has_rpc_context(new.user_id,new.goal_id,new.id),
      'injected failure occurs inside protected RPC context');
    raise exception 'injected post-context failure';
  end if;
  return new;
end $$;
create trigger zz_goal_auth_failure before insert on public.projects
for each row execute function public._goal_auth_fail_after_context();

-- SET SESSION AUTHORIZATION reproduces a real authenticated session, including
-- role=none and the inability to SET ROLE into a privileged service/owner role.
set session authorization authenticated;
select set_config('request.jwt.claim.sub','88888888-8888-4888-8888-888888888888',true);
select set_config('sideflip.trade_up_rpc','on',true);
select public._goal_test_assert(public._goal_test_raises(
  $$update public.projects set title='forbidden' where id='92000000-0000-4000-8000-000000000002'$$,
  'Goal locked'),'direct authenticated session cannot bypass locked project');
select public._goal_test_assert(public._goal_test_raises($$set role service_role$$,'permission denied'),
  'authenticated cannot become service role');
select public._goal_test_assert(public._goal_test_raises(
  $$insert into sideflip_trade_up_private.rpc_context values(pg_backend_pid(),txid_current(),auth.uid(),null,'{}')$$,
  'permission denied'),'authenticated cannot mint context');
select public._goal_test_assert(public._goal_test_raises(
  $$select sideflip_trade_up_private.has_rpc_context(auth.uid(),null,null)$$,
  'permission denied'),'authenticated cannot invoke private context helper');
select public._goal_test_assert(public._goal_test_raises(
  $$update public.trade_up_goals set status='completed' where id='91000000-0000-4000-8000-000000000001'$$,
  'not fully funded'),'direct authenticated session cannot complete underfunded goal');
select public._goal_test_assert(public._goal_test_raises(
  $$insert into public.expenses(project_id,user_id,description,amount) values('92000000-0000-4000-8000-000000000002',auth.uid(),'forbidden',1)$$,
  'Goal locked'),'direct authenticated session cannot expense locked goal');

-- Legacy direct metadata/target updates and ordinary writes remain usable.
update public.trade_up_goals set name=' Renamed ',description='legacy',target_amount=90
where id='91000000-0000-4000-8000-000000000001';
update public.projects set title='Allowed title' where id='92000000-0000-4000-8000-000000000001';
insert into public.projects(id,user_id,title,purchase_price)
values('92000000-0000-4000-8000-000000000003',auth.uid(),'Ordinary',1);
update public.projects set purchase_price=2 where id='92000000-0000-4000-8000-000000000003';
insert into public.expenses(id,project_id,user_id,description,amount) values
('93000000-0000-4000-8000-000000000003','92000000-0000-4000-8000-000000000003',auth.uid(),'Ordinary',1);
update public.expenses set amount=2 where id='93000000-0000-4000-8000-000000000003';
delete from public.expenses where id='93000000-0000-4000-8000-000000000003';
delete from public.projects where id='92000000-0000-4000-8000-000000000003';
select public._goal_test_assert((select name='Renamed' and description='legacy' and target_amount=90
  from public.trade_up_goals where id='91000000-0000-4000-8000-000000000001'),'legacy fields preserved and normalized');

-- Privileged work succeeds in a real authenticated session, but lends no
-- authority to the next statement, even while the caller's forged GUC stays on.
select public._goal_test_assert(public._goal_test_raises(
  $$select public.create_trade_up_project('fail-after-context','other',1,null,null,null,null,null,null,null,null,null,null,null,'91000000-0000-4000-8000-000000000001',0,1,'auth-injected-failure')$$,
  'injected post-context failure'),'post-context failure is rolled back');
select public.update_trade_up_goal('91000000-0000-4000-8000-000000000001',null,100,'auth-target');
select public._goal_test_assert(public._goal_test_raises(
  $$update public.projects set purchase_price=500 where id='92000000-0000-4000-8000-000000000001'$$,
  'Trade-Up workflow'),'RPC success does not permit direct accounting changes');
select public._goal_test_assert(public._goal_test_raises(
  $$update public.trade_up_goals set client_mutation_id='forged' where id='91000000-0000-4000-8000-000000000001'$$,
  'Unsafe'),'mutation identity stays immutable after RPC');
select public.create_trade_up_project('Cascade test','other',1,null,null,null,null,null,null,null,null,null,null,null,
  '91000000-0000-4000-8000-000000000001',0,1,'auth-cascade-project') as auth_cascade_project \gset
select public.record_trade_up_direct_trade(:'auth_cascade_project','Incoming cascade','other',1,'none',0,0,0,null,'auth-cascade-trade') as auth_cascade_incoming \gset
insert into public.expenses(project_id,user_id,description,amount) values(:'auth_cascade_incoming',auth.uid(),'Incoming expense',1);
select public.undo_goal_project_outcome(:'auth_cascade_project');
select public._goal_test_assert(not exists(select 1 from public.projects where id=:'auth_cascade_incoming')
  and not exists(select 1 from public.expenses where project_id=:'auth_cascade_incoming'),
  'undo authorizes cascading incoming project expense deletion');
insert into public.expenses(project_id,user_id,description,amount) values(:'auth_cascade_project',auth.uid(),'Original expense',1);
select public.delete_trade_up_project(:'auth_cascade_project');
select public._goal_test_assert(not exists(select 1 from public.projects where id=:'auth_cascade_project')
  and not exists(select 1 from public.expenses where project_id=:'auth_cascade_project'),
  'project RPC authorizes expense cascade without leaking authority');
select public.adjust_trade_up_goal('91000000-0000-4000-8000-000000000001','personal_contribution',100,null,'auth-fund');
update public.trade_up_goals set status='completed' where id='91000000-0000-4000-8000-000000000001';
select public._goal_test_assert((select completed_at is not null from public.trade_up_goals where id='91000000-0000-4000-8000-000000000001'),
  'legacy funded completion succeeds');
select public._goal_test_assert(public._goal_test_raises(
  $$update public.trade_up_goals set status='active' where id='91000000-0000-4000-8000-000000000001'$$,
  'one active'),'legacy reopening still obeys Free activation limit');
reset session authorization;
select public._goal_test_assert(not exists(select 1 from sideflip_trade_up_private.rpc_context),
  'successful and denied operations leave no capability');

-- Service writes retain their existing operational authority, but BYPASSRLS
-- alone cannot grant access to the new private capability table/schema.
grant select,insert,update,delete on public.projects,public.expenses,public.trade_up_goals to service_role;
set session authorization service_role;
select public._goal_test_assert(public._goal_test_raises(
  $$insert into sideflip_trade_up_private.rpc_context values(pg_backend_pid(),txid_current(),'88888888-8888-4888-8888-888888888888',null,'{}')$$,
  'permission denied'),'service cannot mint RPC capability');
update public.projects set title='Service correction' where id='92000000-0000-4000-8000-000000000002';
insert into public.expenses(project_id,user_id,description,amount)
values('92000000-0000-4000-8000-000000000002','88888888-8888-4888-8888-888888888888','Service correction',2);
update public.trade_up_goals set description='Service correction' where id='91000000-0000-4000-8000-000000000002';
select public._goal_test_assert((select title='Service correction' from public.projects where id='92000000-0000-4000-8000-000000000002'),
  'service operational correction persisted');
reset session authorization;
set session authorization anon;
select public._goal_test_assert(public._goal_test_raises(
  $$select public.update_trade_up_goal('91000000-0000-4000-8000-000000000001',null,1,'anon')$$,
  'permission denied'),'anonymous RPC denied by actual privilege');
reset session authorization;
rollback;
