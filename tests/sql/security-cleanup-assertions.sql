do $$
declare
  function_name text;
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='handle_new_user' and p.prosecdef
      and 'search_path=public'=any(p.proconfig)
  ) then raise exception 'handle_new_user search_path not hardened'; end if;

  insert into auth.users(id) values('00000000-0000-0000-0000-000000000999');
  if not exists (
    select 1 from public.profiles
    where id='00000000-0000-0000-0000-000000000999' and marker='original-body'
  ) then raise exception 'handle_new_user body or trigger behavior changed'; end if;

  if has_function_privilege('anon','public.handle_new_user()','EXECUTE')
     or has_function_privilege('authenticated','public.handle_new_user()','EXECUTE') then
    raise exception 'browser role can execute handle_new_user';
  end if;

  foreach function_name in array array[
    'adjust_trade_up_goal(uuid,text,numeric,text,text)',
    'create_trade_up_project(text,text,numeric,text,text,text,text,text,text,text,text,integer,text,text,uuid,numeric,numeric,text)',
    'delete_trade_up_goal(uuid)',
    'delete_trade_up_project(uuid)',
    'record_trade_up_direct_trade(uuid,text,text,numeric,text,numeric,numeric,numeric,text,text)',
    'record_trade_up_sale(uuid,numeric,numeric)',
    'undo_goal_project_outcome(uuid)'
  ] loop
    if has_function_privilege('anon',('public.'||function_name)::regprocedure,'EXECUTE') then
      raise exception 'anon can execute %',function_name;
    end if;
    if not has_function_privilege('authenticated',('public.'||function_name)::regprocedure,'EXECUTE') then
      raise exception 'authenticated lost required execution on %',function_name;
    end if;
  end loop;

  if exists (
    select 1 from (values ('profiles'),('projects'),('expenses'),('receipts'),('trade_up_goals'),('goal_ledger')) tables(name)
    where has_table_privilege('anon','public.'||name,'TRUNCATE')
       or has_table_privilege('authenticated','public.'||name,'TRUNCATE')
       or has_table_privilege('anon','public.'||name,'TRIGGER')
       or has_table_privilege('authenticated','public.'||name,'TRIGGER')
       or has_table_privilege('anon','public.'||name,'REFERENCES')
       or has_table_privilege('authenticated','public.'||name,'REFERENCES')
  ) then raise exception 'unsafe browser table privileges remain'; end if;
end $$;
