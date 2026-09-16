create or replace function public._goal_concurrency_assert(p_ok boolean,p_message text)
returns void language plpgsql as $$ begin
  if not coalesce(p_ok,false) then raise exception 'assertion failed: %',p_message; end if;
end $$;
select public._goal_concurrency_assert(
  (select status='completed' and completed_at is not null from public.trade_up_goals where id='22000000-0000-4000-8000-000000000002'),
  'one concurrent completion committed');
select public._goal_concurrency_assert(
  (select count(*)=1 from public.trade_up_goal_mutations where user_id='22222222-2222-4222-8222-222222222222'
    and mutation_id in ('concurrent-complete-a','concurrent-complete-b')),
  'losing concurrent completion created no mutation record');
select public._goal_concurrency_assert(
  (select g.status='completed' and p.status='sold' and p.sale_price=100
   from public.trade_up_goals g join public.projects p on p.goal_id=g.id
   where g.id='25000000-0000-4000-8000-000000000002' and p.id='25100000-0000-4000-8000-000000000002'),
  'sale and completion serialized without a deadlock');
select public._goal_concurrency_assert(
  (select target_amount=12 from public.trade_up_goals where id='41000000-0000-4000-8000-000000000004'),
  'mutation holding the entitlement lock committed before downgrade');
select public._goal_concurrency_assert(
  not exists(select 1 from public.user_entitlements where user_id='44444444-4444-4444-8444-444444444444'),
  'concurrent downgrade committed after the in-flight mutation');
set role authenticated;
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',false);
do $$ begin
  begin
    perform public.update_trade_up_goal('41000000-0000-4000-8000-000000000004',null,13,'post-downgrade-denied');
    raise exception 'assertion failed: post-downgrade mutation unexpectedly succeeded';
  exception when others then
    if sqlerrm not like '%Goal locked%' then raise; end if;
  end;
end $$;
reset role;
drop function public._goal_concurrency_assert(boolean,text);
