-- Harden legacy browser-role privileges without changing released client CRUD.
-- This migration intentionally preserves owner RLS policies and the authenticated
-- DML grants used by web and native clients.
begin;

do $$
begin
  if to_regprocedure('public.handle_new_user()') is not null then
    execute 'alter function public.handle_new_user() set search_path = public';
    execute 'revoke all on function public.handle_new_user() from public, anon, authenticated';
  end if;
end;
$$;

-- PostgREST does not expose these SQL privileges as ordinary CRUD, and no
-- SideFlip client needs them. Remove the inherited privileges and prevent them
-- from returning on future tables created by this migration owner.
revoke truncate, references, trigger on all tables in schema public from public, anon, authenticated;
alter default privileges in schema public revoke truncate, references, trigger on tables from public, anon, authenticated;

-- These owner-scoped functions were intended for authenticated users only.
-- auth.uid() already caused anonymous calls to fail, but the execute grants
-- unnecessarily exposed their contracts and consumed server work.
revoke execute on function public.adjust_trade_up_goal(uuid,text,numeric,text,text) from public, anon;
revoke execute on function public.create_trade_up_project(text,text,numeric,text,text,text,text,text,text,text,text,integer,text,text,uuid,numeric,numeric,text) from public, anon;
revoke execute on function public.delete_trade_up_goal(uuid) from public, anon;
revoke execute on function public.delete_trade_up_project(uuid) from public, anon;
revoke execute on function public.record_trade_up_direct_trade(uuid,text,text,numeric,text,numeric,numeric,numeric,text,text) from public, anon;
revoke execute on function public.record_trade_up_sale(uuid,numeric,numeric) from public, anon;
revoke execute on function public.undo_goal_project_outcome(uuid) from public, anon;

-- Trigger functions are invoked by PostgreSQL, never directly by a browser.
revoke execute on function public.enforce_trade_up_goal_ownership() from public, anon, authenticated;
revoke execute on function public.guard_trade_up_project_mutations() from public, anon, authenticated;
revoke execute on function public.set_freemium_entitlement_updated_at() from public, anon, authenticated;
revoke execute on function public.validate_goal_project_accounting() from public, anon, authenticated;
revoke execute on function public.validate_goal_project_outcome() from public, anon, authenticated;

commit;
