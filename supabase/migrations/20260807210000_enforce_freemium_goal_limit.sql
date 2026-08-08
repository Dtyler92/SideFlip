-- Narrow release: enforce one active Trade-Up Goal for Free accounts while
-- preserving the existing goal schema/RPC and allowing verified Pro accounts
-- additional active goals. Receipt functionality is intentionally excluded.
begin;

create or replace function public.user_has_verified_pro_entitlement(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_entitlements e
    where e.user_id = p_user_id
      and e.source in ('stripe', 'apple')
      and e.status in ('active', 'grace_period')
      and e.last_verified_at is not null
      and e.expires_at is not null
      and e.expires_at > now()
  );
$$;

revoke all on function public.user_has_verified_pro_entitlement(uuid) from public;

create or replace function public.enforce_free_active_trade_up_goal_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status <> 'active' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  if not public.user_has_verified_pro_entitlement(new.user_id)
     and exists (
       select 1 from public.trade_up_goals g
       where g.user_id = new.user_id
         and g.status = 'active'
         and g.id is distinct from new.id
     ) then
    raise exception 'Free accounts can have one active Trade-Up Goal. Upgrade to SideFlip Pro for additional goals.';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_free_active_trade_up_goal_limit() from public;

drop trigger if exists trade_up_goals_free_active_limit on public.trade_up_goals;
create trigger trade_up_goals_free_active_limit
before insert or update of status, user_id on public.trade_up_goals
for each row execute function public.enforce_free_active_trade_up_goal_limit();

revoke insert on public.trade_up_goals from authenticated;

create or replace function public.create_trade_up_goal(
  p_name text, p_goal_type text, p_target_item text, p_target_amount numeric,
  p_description text, p_starting_amount numeric, p_mutation_id text
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_user uuid := auth.uid(); v_id uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if nullif(trim(p_mutation_id), '') is null then raise exception 'Mutation ID required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));
  select id into v_id from public.trade_up_goals where user_id = v_user and client_mutation_id = p_mutation_id;
  if v_id is not null then return v_id; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Goal name required'; end if;
  if p_goal_type not in ('item','amount') then raise exception 'Invalid goal type'; end if;
  if p_goal_type = 'item' and nullif(trim(coalesce(p_target_item,'')), '') is null then raise exception 'Target item required'; end if;
  if p_goal_type = 'amount' and coalesce(p_target_amount,0) <= 0 then raise exception 'Target amount required'; end if;
  if coalesce(p_starting_amount,0) < 0 then raise exception 'Starting amount cannot be negative'; end if;

  insert into public.trade_up_goals(user_id,name,goal_type,target_item,target_amount,description,client_mutation_id)
  values(v_user,trim(p_name),p_goal_type,nullif(trim(coalesce(p_target_item,'')),''),coalesce(p_target_amount,0),nullif(trim(coalesce(p_description,'')),''),p_mutation_id)
  returning id into v_id;
  if coalesce(p_starting_amount,0) > 0 then
    insert into public.goal_ledger(goal_id,user_id,type,amount,note,client_mutation_id)
    values(v_id,v_user,'personal_contribution',p_starting_amount,'Starting amount',p_mutation_id || ':starting');
  end if;
  return v_id;
exception when unique_violation then
  select id into v_id from public.trade_up_goals where user_id = v_user and client_mutation_id = p_mutation_id;
  if v_id is not null then return v_id; end if;
  raise;
end;
$$;

revoke all on function public.create_trade_up_goal(text,text,text,numeric,text,numeric,text) from public;
grant execute on function public.create_trade_up_goal(text,text,text,numeric,text,numeric,text) to authenticated;

commit;