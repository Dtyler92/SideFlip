create schema auth;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;
create table auth.users(id uuid primary key);
create table public.profiles(id uuid primary key, marker text not null);
create table public.projects(id uuid primary key);
create table public.expenses(id uuid primary key);
create table public.receipts(id uuid primary key);
create table public.trade_up_goals(id uuid primary key);
create table public.goal_ledger(id uuid primary key);

grant all on all tables in schema public to anon, authenticated;

create function public.handle_new_user() returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles(id, marker) values(new.id, 'original-body');
  return new;
end$$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create function public.adjust_trade_up_goal(uuid,text,numeric,text,text) returns void language sql as $$select$$;
create function public.create_trade_up_project(text,text,numeric,text,text,text,text,text,text,text,text,integer,text,text,uuid,numeric,numeric,text) returns uuid language sql as $$select null::uuid$$;
create function public.delete_trade_up_goal(uuid) returns void language sql as $$select$$;
create function public.delete_trade_up_project(uuid) returns void language sql as $$select$$;
create function public.record_trade_up_direct_trade(uuid,text,text,numeric,text,numeric,numeric,numeric,text,text) returns void language sql as $$select$$;
create function public.record_trade_up_sale(uuid,numeric,numeric) returns void language sql as $$select$$;
create function public.undo_goal_project_outcome(uuid) returns void language sql as $$select$$;

create function public.enforce_trade_up_goal_ownership() returns trigger language plpgsql as $$begin return new; end$$;
create function public.guard_trade_up_project_mutations() returns trigger language plpgsql as $$begin return new; end$$;
create function public.set_freemium_entitlement_updated_at() returns trigger language plpgsql as $$begin return new; end$$;
create function public.validate_goal_project_accounting() returns trigger language plpgsql as $$begin return new; end$$;
create function public.validate_goal_project_outcome() returns trigger language plpgsql as $$begin return new; end$$;

grant execute on all functions in schema public to anon, authenticated;
