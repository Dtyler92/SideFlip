-- Correct direct role grants discovered after the approved goal RPC repair.
-- Supabase had explicit anon/authenticated ACL entries, so revoking PUBLIC alone was insufficient.

begin;

revoke execute on function public.link_trade_up_project(uuid, uuid, numeric, text) from anon;
revoke execute on function public.create_trade_up_goal(text, text, text, numeric, text, numeric, text) from anon;
revoke execute on function public.enforce_free_active_trade_up_goal_limit() from anon, authenticated;

grant execute on function public.link_trade_up_project(uuid, uuid, numeric, text) to authenticated;
grant execute on function public.create_trade_up_goal(text, text, text, numeric, text, numeric, text) to authenticated;

commit;
