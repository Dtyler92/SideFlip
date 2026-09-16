-- Authoritative Trade-Up Goal access and accounting enforcement for iOS build 20.
-- Additive only: retained data remains visible, while mutations are owner and entitlement scoped.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists public.trade_up_goal_mutations (
  user_id uuid not null references auth.users(id) on delete cascade,
  mutation_id text not null,
  operation text not null,
  request_payload jsonb not null,
  goal_id uuid references public.trade_up_goals(id) on delete set null,
  result_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, mutation_id)
);
alter table public.trade_up_goal_mutations
  drop constraint if exists trade_up_goal_mutations_goal_id_fkey;
alter table public.trade_up_goal_mutations
  add constraint trade_up_goal_mutations_goal_id_fkey
  foreign key (goal_id) references public.trade_up_goals(id) on delete set null;
alter table public.trade_up_goal_mutations enable row level security;
revoke all on table public.trade_up_goal_mutations from public, anon, authenticated;
grant select, insert, update, delete on table public.trade_up_goal_mutations to service_role;

-- Preserve idempotency across this migration.  Legacy RPCs stored mutation IDs
-- on their result rows; materialize their canonical requests before any result
-- can later be completed, locked, or deleted.  A key used by two historical
-- operations is ambiguous, so fail the transaction instead of choosing one.
create temporary table trade_up_goal_mutation_backfill_candidates (
  user_id uuid not null,
  mutation_id text not null,
  operation text not null,
  request_payload jsonb not null,
  goal_id uuid,
  result_id uuid not null,
  created_at timestamptz not null
) on commit drop;

insert into trade_up_goal_mutation_backfill_candidates
select g.user_id, trim(g.client_mutation_id), 'create_goal',
  jsonb_build_object(
    'name',trim(g.name),'goal_type',g.goal_type,
    'target_item',case when g.goal_type='amount' then null else nullif(trim(coalesce(g.target_item,'')),'') end,
    'target_amount',round(g.target_amount,2),'description',nullif(trim(coalesce(g.description,'')),''),
    'starting_amount',coalesce((select round(abs(l.amount),2) from public.goal_ledger l
      where l.user_id=g.user_id and l.goal_id=g.id
        and l.client_mutation_id=trim(g.client_mutation_id)||':starting'
      order by l.created_at,l.id limit 1),0)
  ), g.id, g.id, g.created_at
from public.trade_up_goals g
where nullif(trim(g.client_mutation_id),'') is not null;

insert into trade_up_goal_mutation_backfill_candidates
select l.user_id, trim(l.client_mutation_id), 'adjustment',
  jsonb_build_object('goal_id',l.goal_id,'type',l.type,'amount',round(abs(l.amount),2),
    'note',nullif(trim(coalesce(l.note,'')),'')),
  l.goal_id,l.id,l.created_at
from public.goal_ledger l
where nullif(trim(l.client_mutation_id),'') is not null
  and l.project_id is null
  and l.type in ('personal_contribution','cash_out')
  and not exists (
    select 1 from public.trade_up_goals g
    where g.user_id=l.user_id and trim(g.client_mutation_id)||':starting'=trim(l.client_mutation_id)
  );

insert into trade_up_goal_mutation_backfill_candidates
select p.user_id,trim(p.trade_up_mutation_id),
  case
    when p.traded_from_project_id is not null then 'direct_trade'
    when exists(select 1 from public.goal_ledger l where l.user_id=p.user_id and l.project_id=p.id
      and l.client_mutation_id=trim(p.trade_up_mutation_id)||':funding'
      and l.note like 'Goal funds allocated to existing project %') then 'link_project'
    else 'create_project'
  end,
  case
    when p.traded_from_project_id is not null then jsonb_build_object(
      'outgoing_id',p.traded_from_project_id,'incoming_title',trim(p.title),'category',coalesce(p.category,'other'),
      'trade_credit',round(p.trade_credit_amount,2),
      'cash_direction',case
        when exists(select 1 from public.goal_ledger l where l.user_id=p.user_id and l.project_id=p.id and l.type='trade_cash_received') then 'received'
        when round(p.purchase_price,2)>round(p.trade_credit_amount,2) then 'paid' else 'none' end,
      'cash_amount',case
        when exists(select 1 from public.goal_ledger l where l.user_id=p.user_id and l.project_id=p.id and l.type='trade_cash_received')
          then coalesce((select round(sum(l.amount),2) from public.goal_ledger l where l.user_id=p.user_id and l.project_id=p.id and l.type='trade_cash_received'),0)
        else greatest(round(p.purchase_price,2)-round(p.trade_credit_amount,2),0) end,
      'goal_cash',case when round(p.purchase_price,2)>round(p.trade_credit_amount,2) then round(p.goal_funding_amount,2) else 0 end,
      'keep_cash',case when exists(select 1 from public.goal_ledger l where l.user_id=p.user_id and l.project_id=p.id and l.type='trade_cash_received')
        then coalesce((select round(sum(l.amount),2) from public.goal_ledger l where l.user_id=p.user_id and l.project_id=p.id
          and l.type in ('trade_cash_received','cash_out')),0) else 0 end,
      'notes',case when p.notes='Received in trade for '||(select o.title from public.projects o where o.id=p.traded_from_project_id)
        then null else nullif(trim(coalesce(p.notes,'')),'') end)
    when exists(select 1 from public.goal_ledger l where l.user_id=p.user_id and l.project_id=p.id
      and l.client_mutation_id=trim(p.trade_up_mutation_id)||':funding'
      and l.note like 'Goal funds allocated to existing project %') then
      jsonb_build_object('project_id',p.id,'goal_id',p.goal_id,'goal_funding',round(p.goal_funding_amount,2))
    else jsonb_build_object(
      'title',trim(p.title),'category',coalesce(p.category,'other'),'purchase_price',round(p.purchase_price,2),
      'photo',p.photo,'notes',nullif(trim(coalesce(p.notes,'')),'') ,'model_number',p.model_number,
      'serial_number',p.serial_number,'engine_model',p.engine_model,'engine_serial',p.engine_serial,
      'vin',p.vin,'hull_number',p.hull_number,'vehicle_year',p.vehicle_year,'vehicle_make',p.vehicle_make,
      'vehicle_model',p.vehicle_model,'goal_id',p.goal_id,'goal_funding',round(p.goal_funding_amount,2),
      'out_of_pocket',round(p.out_of_pocket_amount,2))
  end,
  p.goal_id,p.id,p.created_at
from public.projects p
where nullif(trim(p.trade_up_mutation_id),'') is not null;

do $$
declare v_collision record;
begin
  select user_id,mutation_id,array_agg(operation order by operation) operations
  into v_collision
  from trade_up_goal_mutation_backfill_candidates
  group by user_id,mutation_id having count(*)>1
  order by user_id,mutation_id limit 1;
  if found then
    raise exception 'Historical Trade-Up mutation ID collision for owner % key % operations %',
      v_collision.user_id,v_collision.mutation_id,v_collision.operations;
  end if;
end;
$$;

insert into public.trade_up_goal_mutations(user_id,mutation_id,operation,request_payload,goal_id,result_id,created_at)
select user_id,mutation_id,operation,request_payload,goal_id,result_id,created_at
from trade_up_goal_mutation_backfill_candidates
on conflict (user_id,mutation_id) do nothing;

create or replace function public.trade_up_amount_is_finite(p_amount numeric)
returns boolean
language sql immutable
set search_path = pg_catalog
as $$
  select p_amount is not null
     and p_amount > '-Infinity'::numeric
     and p_amount < 'Infinity'::numeric
$$;
revoke all on function public.trade_up_amount_is_finite(numeric) from public, anon, authenticated;

-- Serialize goal decisions per owner, lock entitlement rows against a concurrent
-- downgrade, and allow a Free owner to mutate only the deterministic oldest
-- active goal. Pro owners may mutate every active goal.
create or replace function public.assert_trade_up_goal_mutable(
  p_goal_id uuid,
  p_allow_nonactive boolean default false
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_status text;
  v_retained_id uuid;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

  perform 1 from public.user_entitlements e
  where e.user_id = v_user_id
  order by e.id
  for share;

  select g.status into v_status
  from public.trade_up_goals g
  where g.id = p_goal_id and g.user_id = v_user_id
  for update;
  if not found then raise exception 'Goal not found'; end if;

  perform 1 from public.trade_up_goals g
  where g.user_id = v_user_id and g.status = 'active'
  order by g.created_at, g.id
  for update;

  if v_status <> 'active' then
    if p_allow_nonactive then return; end if;
    raise exception 'Goal is not active';
  end if;

  if not public.user_has_verified_pro_entitlement(v_user_id) then
    select g.id into v_retained_id
    from public.trade_up_goals g
    where g.user_id = v_user_id and g.status = 'active'
    order by g.created_at, g.id
    limit 1;
    if v_retained_id is distinct from p_goal_id then
      raise exception 'Goal locked. SideFlip Pro is required to change this retained goal.';
    end if;
  end if;
end;
$$;
revoke all on function public.assert_trade_up_goal_mutable(uuid,boolean) from public, anon, authenticated;

-- Creation and reopen use the same entitlement lock and one-active-Free rule.
create or replace function public.enforce_free_active_trade_up_goal_limit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status <> 'active' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  perform 1 from public.user_entitlements e
  where e.user_id = new.user_id
  order by e.id
  for share;
  perform 1 from public.trade_up_goals g
  where g.user_id = new.user_id and g.status = 'active' and g.id is distinct from new.id
  order by g.created_at, g.id
  for update;
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
revoke all on function public.enforce_free_active_trade_up_goal_limit() from public, anon, authenticated;

create or replace function public.create_trade_up_goal(
  p_name text, p_goal_type text, p_target_item text, p_target_amount numeric,
  p_description text, p_starting_amount numeric, p_mutation_id text
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_user uuid := auth.uid(); v_id uuid; v_existing public.trade_up_goal_mutations%rowtype;
  v_name text := trim(coalesce(p_name,''));
  v_target_item text := nullif(trim(coalesce(p_target_item,'')),'');
  v_description text := nullif(trim(coalesce(p_description,'')),'');
  v_target numeric; v_start numeric; v_payload jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if nullif(trim(p_mutation_id),'') is null then raise exception 'Mutation ID required'; end if;
  if not public.trade_up_amount_is_finite(p_target_amount)
     or not public.trade_up_amount_is_finite(p_starting_amount) then
    raise exception 'Goal amounts must be finite';
  end if;
  v_target := round(p_target_amount,2); v_start := round(p_starting_amount,2);
  if v_name='' then raise exception 'Goal name required'; end if;
  if p_goal_type not in ('item','amount') then raise exception 'Invalid goal type'; end if;
  if p_goal_type='item' and v_target_item is null then raise exception 'Target item required'; end if;
  if p_goal_type='amount' and v_target<=0 then raise exception 'Target amount required'; end if;
  if v_target<0 or v_start<0 then raise exception 'Goal amounts cannot be negative'; end if;
  if p_goal_type='amount' then v_target_item := null; end if;
  v_payload := jsonb_build_object('name',v_name,'goal_type',p_goal_type,'target_item',v_target_item,
    'target_amount',v_target,'description',v_description,'starting_amount',v_start);
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  select * into v_existing from public.trade_up_goal_mutations
    where user_id=v_user and mutation_id=trim(p_mutation_id) for update;
  if found then
    if v_existing.operation='create_goal' and v_existing.request_payload=v_payload then return v_existing.result_id; end if;
    raise exception 'Conflicting retry for goal creation';
  end if;
  insert into public.trade_up_goals(user_id,name,goal_type,target_item,target_amount,description,client_mutation_id)
  values(v_user,v_name,p_goal_type,v_target_item,v_target,v_description,trim(p_mutation_id)) returning id into v_id;
  if v_start>0 then
    insert into public.goal_ledger(goal_id,user_id,type,amount,note,client_mutation_id)
    values(v_id,v_user,'personal_contribution',v_start,'Starting amount',trim(p_mutation_id)||':starting');
  end if;
  insert into public.trade_up_goal_mutations(user_id,mutation_id,operation,request_payload,goal_id,result_id)
  values(v_user,trim(p_mutation_id),'create_goal',v_payload,v_id,v_id);
  return v_id;
end;
$$;

create or replace function public.update_trade_up_goal(
  p_goal_id uuid,
  p_status text,
  p_target_amount numeric,
  p_mutation_id text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_goal public.trade_up_goals%rowtype;
  v_next_status text;
  v_next_target numeric;
  v_payload jsonb;
  v_existing public.trade_up_goal_mutations%rowtype;
  v_progress numeric;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  perform set_config('sideflip.trade_up_rpc','on',true);
  if nullif(trim(p_mutation_id), '') is null then raise exception 'Mutation ID required'; end if;
  if p_status is not null and p_status not in ('active', 'completed') then raise exception 'Invalid goal status'; end if;
  if p_target_amount is not null and (
    not public.trade_up_amount_is_finite(p_target_amount) or p_target_amount <= 0
  ) then raise exception 'Target amount must be a positive finite amount'; end if;
  if p_status is null and p_target_amount is null then raise exception 'Goal update is empty'; end if;

  v_payload := jsonb_build_object(
    'goal_id', p_goal_id,
    'status', p_status,
    'target_amount', case when p_target_amount is null then null else round(p_target_amount,2) end
  );
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text,0));
  select * into v_existing from public.trade_up_goal_mutations
  where user_id = v_user_id and mutation_id = trim(p_mutation_id)
  for update;
  if found then
    if v_existing.operation = 'update' and v_existing.request_payload = v_payload then
      return v_existing.result_id;
    end if;
    raise exception 'Conflicting retry for goal update';
  end if;

  perform public.assert_trade_up_goal_mutable(p_goal_id, true);
  select * into strict v_goal from public.trade_up_goals
  where id = p_goal_id and user_id = v_user_id;

  v_next_status := coalesce(p_status, v_goal.status);
  v_next_target := coalesce(round(p_target_amount,2), v_goal.target_amount);
  if not public.trade_up_amount_is_finite(v_next_target) or v_next_target <= 0 then
    raise exception 'Target amount must be a positive finite amount';
  end if;
  if v_goal.status <> 'active' and v_next_status <> 'active' then
    raise exception 'Reopen the Trade-Up Goal before changing it';
  end if;

  insert into public.trade_up_goal_mutations(user_id, mutation_id, operation, request_payload, goal_id, result_id)
  values(v_user_id, trim(p_mutation_id), 'update', v_payload, p_goal_id, p_goal_id)
  on conflict (user_id, mutation_id) do nothing;
  select * into strict v_existing from public.trade_up_goal_mutations
  where user_id = v_user_id and mutation_id = trim(p_mutation_id)
  for update;
  if v_existing.operation <> 'update' or v_existing.goal_id <> p_goal_id
     or v_existing.request_payload <> v_payload then
    raise exception 'Conflicting retry for goal update';
  end if;

  if v_goal.status = 'completed' and v_next_status = 'active' then
    if not public.user_has_verified_pro_entitlement(v_user_id)
       and exists (
         select 1 from public.trade_up_goals g
         where g.user_id = v_user_id and g.status = 'active' and g.id <> p_goal_id
       ) then
      raise exception 'Free accounts can have one active Trade-Up Goal. Upgrade to SideFlip Pro for additional goals.';
    end if;
  end if;

  if v_next_status = 'completed' and v_goal.status <> 'completed' then
    perform 1 from public.goal_ledger l
    where l.goal_id = p_goal_id and l.user_id = v_user_id
    order by l.id for update;
    perform 1 from public.projects p
    where p.goal_id = p_goal_id and p.user_id = v_user_id
    order by p.id for update;
    perform 1 from public.expenses e
    where e.user_id = v_user_id
      and exists (
        select 1 from public.projects p
        where p.id = e.project_id and p.goal_id = p_goal_id and p.user_id = v_user_id
      )
    order by e.id for update;

    if exists(select 1 from public.goal_ledger l where l.goal_id=p_goal_id and l.user_id=v_user_id
              and not public.trade_up_amount_is_finite(l.amount))
       or exists(select 1 from public.projects p where p.goal_id=p_goal_id and p.user_id=v_user_id
                 and p.status='active' and not public.trade_up_amount_is_finite(p.purchase_price))
       or exists(select 1 from public.expenses e join public.projects p on p.id=e.project_id
                 where p.goal_id=p_goal_id and p.user_id=v_user_id and e.user_id=v_user_id
                   and p.status='active' and not public.trade_up_amount_is_finite(e.amount)) then
      raise exception 'Goal progress contains a non-finite amount';
    end if;
    select greatest(0,
      coalesce((select sum(l.amount) from public.goal_ledger l
                where l.goal_id = p_goal_id and l.user_id = v_user_id), 0)
      + coalesce((select sum(p.purchase_price) from public.projects p
                  where p.goal_id = p_goal_id and p.user_id = v_user_id and p.status = 'active'), 0)
      + coalesce((select sum(e.amount)
                  from public.expenses e
                  join public.projects p on p.id = e.project_id
                  where p.goal_id = p_goal_id and p.user_id = v_user_id
                    and e.user_id = v_user_id and p.status = 'active'), 0)
    ) into v_progress;
    if not public.trade_up_amount_is_finite(v_progress) then
      raise exception 'Goal progress contains a non-finite amount';
    end if;
    if round(v_progress, 2) < round(v_next_target, 2) then
      raise exception 'Goal is not fully funded';
    end if;
  end if;

  update public.trade_up_goals
  set status = v_next_status,
      target_amount = v_next_target,
      completed_at = case
        when v_next_status = 'completed' and v_goal.status <> 'completed' then now()
        when v_next_status = 'active' then null
        else completed_at
      end
  where id = p_goal_id and user_id = v_user_id;
  return p_goal_id;
end;
$$;

create or replace function public.adjust_trade_up_goal(
  p_goal_id uuid, p_type text, p_amount numeric, p_note text, p_mutation_id text
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_user uuid := auth.uid(); v_id uuid; v_available numeric; v_signed numeric;
  v_note text := nullif(trim(coalesce(p_note,'')),'');
  v_existing public.trade_up_goal_mutations%rowtype; v_amount numeric; v_payload jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if nullif(trim(p_mutation_id), '') is null then raise exception 'Mutation ID required'; end if;
  if p_type not in ('personal_contribution','cash_out')
     or not public.trade_up_amount_is_finite(p_amount) or p_amount <= 0 then
    raise exception 'Invalid adjustment';
  end if;
  v_amount := round(p_amount,2);
  if v_amount<=0 then raise exception 'Invalid adjustment'; end if;
  v_signed := case when p_type = 'cash_out' then -v_amount else v_amount end;
  v_payload:=jsonb_build_object('goal_id',p_goal_id,'type',p_type,'amount',v_amount,'note',v_note);
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  select * into v_existing from public.trade_up_goal_mutations
  where user_id = v_user and mutation_id = trim(p_mutation_id) for update;
  if found then
    if v_existing.operation='adjustment' and v_existing.request_payload=v_payload then
      return v_existing.result_id;
    end if;
    raise exception 'Conflicting retry for adjustment';
  end if;

  perform public.assert_trade_up_goal_mutable(p_goal_id);
  select coalesce(sum(amount),0) into v_available from public.goal_ledger
  where goal_id = p_goal_id and user_id = v_user;
  if not public.trade_up_amount_is_finite(v_available) then
    raise exception 'Goal available balance is non-finite';
  end if;
  if p_type = 'cash_out' and v_amount > v_available then
    raise exception 'Insufficient amount available toward goal';
  end if;
  insert into public.goal_ledger(goal_id,user_id,type,amount,note,client_mutation_id)
  values(p_goal_id,v_user,p_type,v_signed,v_note,trim(p_mutation_id)) returning id into v_id;
  insert into public.trade_up_goal_mutations(user_id,mutation_id,operation,request_payload,goal_id,result_id)
  values(v_user,trim(p_mutation_id),'adjustment',v_payload,p_goal_id,v_id);
  return v_id;
end;
$$;

create or replace function public.create_trade_up_project(
  p_title text, p_category text, p_purchase_price numeric, p_photo text, p_notes text,
  p_model_number text, p_serial_number text, p_engine_model text, p_engine_serial text,
  p_vin text, p_hull_number text, p_vehicle_year integer, p_vehicle_make text, p_vehicle_model text,
  p_goal_id uuid, p_goal_funding numeric, p_out_of_pocket numeric, p_mutation_id text
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_user uuid := auth.uid(); v_id uuid; v_available numeric;
  v_purchase numeric; v_goal_funding numeric; v_out_of_pocket numeric;
  v_existing public.trade_up_goal_mutations%rowtype; v_payload jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform set_config('sideflip.trade_up_rpc','on',true);
  if nullif(trim(p_mutation_id), '') is null then raise exception 'Mutation ID required'; end if;
  if nullif(trim(p_title), '') is null then raise exception 'Project title required'; end if;
  if not public.trade_up_amount_is_finite(p_purchase_price)
     or not public.trade_up_amount_is_finite(p_goal_funding)
     or not public.trade_up_amount_is_finite(p_out_of_pocket)
     or p_purchase_price < 0 or p_goal_funding < 0 or p_out_of_pocket < 0 then
    raise exception 'Amounts must be finite and nonnegative';
  end if;
  v_purchase:=round(p_purchase_price,2); v_goal_funding:=round(p_goal_funding,2); v_out_of_pocket:=round(p_out_of_pocket,2);
  if v_goal_funding+v_out_of_pocket <> v_purchase then
    raise exception 'Funding must equal purchase price';
  end if;
  v_payload:=jsonb_build_object(
    'title',trim(p_title),'category',coalesce(p_category,'other'),'purchase_price',v_purchase,
    'photo',p_photo,'notes',nullif(trim(coalesce(p_notes,'')),''),'model_number',p_model_number,
    'serial_number',p_serial_number,'engine_model',p_engine_model,'engine_serial',p_engine_serial,
    'vin',p_vin,'hull_number',p_hull_number,'vehicle_year',p_vehicle_year,'vehicle_make',p_vehicle_make,
    'vehicle_model',p_vehicle_model,'goal_id',p_goal_id,'goal_funding',v_goal_funding,'out_of_pocket',v_out_of_pocket);
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  select * into v_existing from public.trade_up_goal_mutations
    where user_id=v_user and mutation_id=trim(p_mutation_id) for update;
  if found then
    if v_existing.operation='create_project' and v_existing.request_payload=v_payload then return v_existing.result_id; end if;
    raise exception 'Conflicting retry for project creation';
  end if;
  perform public.assert_trade_up_goal_mutable(p_goal_id);
  select coalesce(sum(amount),0) into v_available from public.goal_ledger
  where goal_id=p_goal_id and user_id=v_user;
  if not public.trade_up_amount_is_finite(v_available) then
    raise exception 'Goal available balance is non-finite';
  end if;
  if v_goal_funding > v_available then raise exception 'Insufficient amount available toward goal'; end if;
  insert into public.projects(
    user_id,title,category,status,purchase_price,photo,notes,model_number,serial_number,
    engine_model,engine_serial,vin,hull_number,vehicle_year,vehicle_make,vehicle_model,
    goal_id,goal_funding_amount,out_of_pocket_amount,trade_up_mutation_id
  ) values (
    v_user,trim(p_title),coalesce(p_category,'other'),'active',v_purchase,p_photo,nullif(trim(coalesce(p_notes,'')),''),
    p_model_number,p_serial_number,p_engine_model,p_engine_serial,p_vin,p_hull_number,p_vehicle_year,p_vehicle_make,p_vehicle_model,
    p_goal_id,v_goal_funding,v_out_of_pocket,trim(p_mutation_id)
  ) returning id into v_id;
  if v_goal_funding > 0 then
    insert into public.goal_ledger(goal_id,user_id,project_id,type,amount,note,client_mutation_id)
    values(p_goal_id,v_user,v_id,'goal_purchase',-v_goal_funding,'Goal funds used for '||trim(p_title),trim(p_mutation_id)||':funding');
  end if;
  insert into public.trade_up_goal_mutations(user_id,mutation_id,operation,request_payload,goal_id,result_id)
  values(v_user,trim(p_mutation_id),'create_project',v_payload,p_goal_id,v_id);
  return v_id;
end;
$$;

create or replace function public.link_trade_up_project(
  p_project_id uuid, p_goal_id uuid, p_goal_funding numeric, p_mutation_id text
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid(); v_project public.projects%rowtype; v_available numeric;
  v_existing public.trade_up_goal_mutations%rowtype; v_goal_funding numeric; v_payload jsonb;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  perform set_config('sideflip.trade_up_rpc','on',true);
  if nullif(trim(p_mutation_id), '') is null then raise exception 'Mutation ID required'; end if;
  if not public.trade_up_amount_is_finite(p_goal_funding) or p_goal_funding < 0 then raise exception 'Goal funds used must be finite and nonnegative'; end if;
  v_goal_funding:=round(p_goal_funding,2);
  v_payload:=jsonb_build_object('project_id',p_project_id,'goal_id',p_goal_id,'goal_funding',v_goal_funding);
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text,0));
  select * into v_existing from public.trade_up_goal_mutations
    where user_id=v_user_id and mutation_id=trim(p_mutation_id) for update;
  if found then
    if v_existing.operation='link_project' and v_existing.request_payload=v_payload then return v_existing.result_id; end if;
    raise exception 'Conflicting retry for project link';
  end if;
  perform public.assert_trade_up_goal_mutable(p_goal_id);
  select * into v_project from public.projects where id=p_project_id and user_id=v_user_id for update;
  if v_project.id is null then raise exception 'Project not found'; end if;
  if v_project.status <> 'active' then raise exception 'Only active projects can be added to a goal'; end if;
  if v_project.goal_id is not null then raise exception 'Project already belongs to a Trade-Up Goal'; end if;
  if v_project.traded_from_project_id is not null or coalesce(v_project.trade_credit_amount,0) <> 0 then raise exception 'Trade-linked projects cannot be reassigned'; end if;
  if v_goal_funding > coalesce(v_project.purchase_price,0) then raise exception 'Goal funds used cannot exceed the project purchase price'; end if;
  select coalesce(sum(amount),0) into v_available from public.goal_ledger where goal_id=p_goal_id and user_id=v_user_id;
  if not public.trade_up_amount_is_finite(v_available) then
    raise exception 'Goal available balance is non-finite';
  end if;
  if v_goal_funding > v_available then raise exception 'Goal funds used cannot exceed the amount available toward the goal'; end if;
  if v_goal_funding > 0 then
    insert into public.goal_ledger(goal_id,user_id,project_id,type,amount,note,client_mutation_id)
    values(p_goal_id,v_user_id,p_project_id,'goal_purchase',-v_goal_funding,'Goal funds allocated to existing project '||v_project.title,trim(p_mutation_id)||':funding');
  end if;
  update public.projects set goal_id=p_goal_id,goal_funding_amount=v_goal_funding,
    out_of_pocket_amount=coalesce(v_project.purchase_price,0)-v_goal_funding,trade_up_mutation_id=trim(p_mutation_id)
  where id=p_project_id and user_id=v_user_id;
  insert into public.trade_up_goal_mutations(user_id,mutation_id,operation,request_payload,goal_id,result_id)
  values(v_user_id,trim(p_mutation_id),'link_project',v_payload,p_goal_id,p_project_id);
  return p_project_id;
end;
$$;

create or replace function public.record_trade_up_sale(
  p_project_id uuid, p_sale_price numeric, p_keep_amount numeric
) returns void
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_user uuid:=auth.uid(); v_project public.projects%rowtype;
  v_existing_sale numeric; v_existing_keep numeric; v_sale numeric; v_keep numeric;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform set_config('sideflip.trade_up_rpc','on',true);
  if not public.trade_up_amount_is_finite(p_sale_price) or not public.trade_up_amount_is_finite(p_keep_amount) then
    raise exception 'Invalid sale allocation';
  end if;
  v_sale:=round(p_sale_price,2); v_keep:=round(p_keep_amount,2);
  if v_sale<0 or v_keep<0 or v_keep>v_sale then raise exception 'Invalid sale allocation'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  select * into v_project from public.projects where id=p_project_id and user_id=v_user for update;
  if v_project.id is null then raise exception 'Project not found'; end if;
  if v_project.goal_id is not null then perform public.assert_trade_up_goal_mutable(v_project.goal_id); end if;
  if v_project.status <> 'active' then
    if v_project.status='sold' and v_project.goal_id is null and v_project.sale_price=v_sale and v_keep=0 then return; end if;
    if exists(select 1 from public.goal_ledger where project_id=p_project_id and type='sale_proceeds') then
      select max(amount) filter(where type='sale_proceeds'),coalesce(sum(amount) filter(where type in ('sale_proceeds','cash_out')),0)
      into v_existing_sale,v_existing_keep from public.goal_ledger where project_id=p_project_id;
      if v_existing_sale=v_sale and v_existing_keep=v_keep then return; end if;
      raise exception 'Sale was already recorded with different values';
    end if;
    raise exception 'Project is not active';
  end if;
  update public.projects set status='sold',sale_price=v_sale,sold_at=now() where id=p_project_id and user_id=v_user;
  if v_project.goal_id is not null then
    insert into public.goal_ledger(goal_id,user_id,project_id,type,amount,note)
    values(v_project.goal_id,v_user,p_project_id,'sale_proceeds',v_sale,'Sale of '||v_project.title);
    if v_keep < v_sale then
      insert into public.goal_ledger(goal_id,user_id,project_id,type,amount,note)
      values(v_project.goal_id,v_user,p_project_id,'cash_out',-(v_sale-v_keep),'Taken out after selling '||v_project.title);
    end if;
  end if;
end;
$$;

create or replace function public.record_trade_up_direct_trade(
  p_outgoing_id uuid, p_incoming_title text, p_category text, p_trade_credit numeric,
  p_cash_direction text, p_cash_amount numeric, p_goal_cash numeric, p_keep_cash numeric,
  p_notes text, p_mutation_id text
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_user uuid:=auth.uid(); v_out public.projects%rowtype; v_id uuid; v_available numeric; v_basis numeric; v_out_pocket numeric;
  v_trade_credit numeric; v_cash_amount numeric; v_goal_cash numeric; v_keep_cash numeric;
  v_existing public.trade_up_goal_mutations%rowtype; v_payload jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform set_config('sideflip.trade_up_rpc','on',true);
  if nullif(trim(p_mutation_id),'') is null then raise exception 'Mutation ID required'; end if;
  if nullif(trim(p_incoming_title),'') is null then raise exception 'Incoming item and trade value required'; end if;
  if not public.trade_up_amount_is_finite(p_trade_credit)
     or not public.trade_up_amount_is_finite(p_cash_amount)
     or not public.trade_up_amount_is_finite(p_goal_cash)
     or not public.trade_up_amount_is_finite(p_keep_cash) then
    raise exception 'Invalid trade amounts';
  end if;
  v_trade_credit:=round(p_trade_credit,2); v_cash_amount:=round(p_cash_amount,2);
  v_goal_cash:=round(p_goal_cash,2); v_keep_cash:=round(p_keep_cash,2);
  if v_trade_credit<=0 then raise exception 'Incoming item and trade value required'; end if;
  if p_cash_direction not in ('none','paid','received')
     or v_cash_amount<0 or v_goal_cash<0 or v_keep_cash<0 then raise exception 'Invalid trade amounts'; end if;
  if p_cash_direction<>'paid' and v_goal_cash<>0 then raise exception 'Goal cash is only valid when cash is paid'; end if;
  if p_cash_direction<>'received' and v_keep_cash<>0 then raise exception 'Kept cash is only valid when cash is received'; end if;
  if p_cash_direction='none' and v_cash_amount<>0 then raise exception 'No-cash trades cannot include a cash amount'; end if;
  if p_cash_direction<>'none' and v_cash_amount<=0 then raise exception 'Cash difference must be greater than zero'; end if;
  if v_goal_cash>v_cash_amount or v_keep_cash>v_cash_amount then raise exception 'Invalid trade allocation'; end if;
  v_payload:=jsonb_build_object('outgoing_id',p_outgoing_id,'incoming_title',trim(p_incoming_title),
    'category',coalesce(p_category,'other'),'trade_credit',v_trade_credit,'cash_direction',p_cash_direction,
    'cash_amount',v_cash_amount,'goal_cash',v_goal_cash,'keep_cash',v_keep_cash,
    'notes',nullif(trim(coalesce(p_notes,'')),''));
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  select * into v_existing from public.trade_up_goal_mutations
    where user_id=v_user and mutation_id=trim(p_mutation_id) for update;
  if found then
    if v_existing.operation='direct_trade' and v_existing.request_payload=v_payload then return v_existing.result_id; end if;
    raise exception 'Conflicting retry for direct trade';
  end if;
  select * into v_out from public.projects where id=p_outgoing_id and user_id=v_user for update;
  if v_out.id is null then raise exception 'Outgoing project not found'; end if;
  if v_out.goal_id is null then raise exception 'Outgoing project is not linked to a goal'; end if;
  perform public.assert_trade_up_goal_mutable(v_out.goal_id);
  if v_out.status <> 'active' then raise exception 'Outgoing project is not active'; end if;
  select coalesce(sum(amount),0) into v_available from public.goal_ledger where goal_id=v_out.goal_id and user_id=v_user;
  if not public.trade_up_amount_is_finite(v_available) then
    raise exception 'Goal available balance is non-finite';
  end if;
  if v_goal_cash>v_available then raise exception 'Insufficient amount available toward goal'; end if;
  v_basis:=v_trade_credit+case when p_cash_direction='paid' then v_cash_amount when p_cash_direction='received' then -v_cash_amount else 0 end;
  if not public.trade_up_amount_is_finite(v_basis) then raise exception 'Received item basis is non-finite'; end if;
  if v_basis<0 then raise exception 'Received item basis cannot be negative'; end if;
  v_out_pocket:=case when p_cash_direction='paid' then v_cash_amount-v_goal_cash else 0 end;
  if not public.trade_up_amount_is_finite(v_out_pocket) then raise exception 'Trade out-of-pocket amount is non-finite'; end if;
  update public.projects set status='sold',sale_price=v_trade_credit,sold_at=now() where id=p_outgoing_id and user_id=v_user;
  insert into public.projects(user_id,title,category,status,purchase_price,notes,goal_id,goal_funding_amount,out_of_pocket_amount,trade_credit_amount,traded_from_project_id,trade_up_mutation_id)
  values(v_user,trim(p_incoming_title),coalesce(p_category,'other'),'active',v_basis,coalesce(nullif(trim(coalesce(p_notes,'')),''),'Received in trade for '||v_out.title),v_out.goal_id,v_goal_cash,v_out_pocket,v_trade_credit,p_outgoing_id,trim(p_mutation_id))
  returning id into v_id;
  if v_goal_cash>0 then insert into public.goal_ledger(goal_id,user_id,project_id,type,amount,note,client_mutation_id)
    values(v_out.goal_id,v_user,v_id,'goal_purchase',-v_goal_cash,'Goal funds used for trade',trim(p_mutation_id)||':funding'); end if;
  if p_cash_direction='received' and v_cash_amount>0 then
    insert into public.goal_ledger(goal_id,user_id,project_id,type,amount,note,client_mutation_id)
    values(v_out.goal_id,v_user,v_id,'trade_cash_received',v_cash_amount,'Cash received trading '||v_out.title,trim(p_mutation_id)||':cash');
    if v_keep_cash<v_cash_amount then insert into public.goal_ledger(goal_id,user_id,project_id,type,amount,note,client_mutation_id)
      values(v_out.goal_id,v_user,v_id,'cash_out',-(v_cash_amount-v_keep_cash),'Trade cash taken out',trim(p_mutation_id)||':cashout'); end if;
  end if;
  insert into public.trade_up_goal_mutations(user_id,mutation_id,operation,request_payload,goal_id,result_id)
  values(v_user,trim(p_mutation_id),'direct_trade',v_payload,v_out.goal_id,v_id);
  return v_id;
end;
$$;

create or replace function public.undo_goal_project_outcome(p_project_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_user_id uuid:=auth.uid(); v_project public.projects%rowtype; v_incoming_id uuid; v_incoming_status text;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  perform set_config('sideflip.trade_up_rpc','on',true);
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text,0));
  select * into v_project from public.projects where id=p_project_id and user_id=v_user_id for update;
  if v_project.id is null then raise exception 'Project not found'; end if;
  if v_project.goal_id is not null then perform public.assert_trade_up_goal_mutable(v_project.goal_id); end if;
  if v_project.status<>'sold' then raise exception 'Project has no sale or trade to undo'; end if;
  select id,status into v_incoming_id,v_incoming_status from public.projects
  where traded_from_project_id=p_project_id and user_id=v_user_id order by created_at desc limit 1 for update;
  if v_incoming_id is not null then
    if v_incoming_status<>'active' or exists(select 1 from public.projects where traded_from_project_id=v_incoming_id and user_id=v_user_id)
       or exists(select 1 from public.goal_ledger where project_id=v_incoming_id and type='sale_proceeds') then
      raise exception 'Undo the received item''s later sale or trade first';
    end if;
    delete from public.goal_ledger where project_id=v_incoming_id and user_id=v_user_id;
    delete from public.projects where id=v_incoming_id and user_id=v_user_id;
  end if;
  delete from public.goal_ledger where project_id=p_project_id and user_id=v_user_id and type in ('sale_proceeds','cash_out');
  update public.projects set status='active',sale_price=null,sold_at=null where id=p_project_id and user_id=v_user_id;
end;
$$;

create or replace function public.delete_trade_up_goal(p_goal_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_user_id uuid:=auth.uid();
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  perform set_config('sideflip.trade_up_rpc','on',true);
  perform public.assert_trade_up_goal_mutable(p_goal_id, true);
  delete from public.trade_up_goals where id=p_goal_id and user_id=v_user_id;
  if not found then raise exception 'Goal not found'; end if;
end;
$$;

create or replace function public.delete_trade_up_project(p_project_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_user_id uuid:=auth.uid(); v_project public.projects%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  perform set_config('sideflip.trade_up_rpc','on',true);
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text,0));
  select * into v_project from public.projects where id=p_project_id and user_id=v_user_id for update;
  if v_project.id is null then raise exception 'Project not found'; end if;
  if v_project.goal_id is not null then perform public.assert_trade_up_goal_mutable(v_project.goal_id); end if;
  if v_project.goal_id is not null and v_project.status<>'active' then raise exception 'Undo this project''s sale or trade before deleting it'; end if;
  if v_project.traded_from_project_id is not null then raise exception 'Undo the direct trade from the previous item instead of deleting the received item'; end if;
  if exists(select 1 from public.projects where traded_from_project_id=p_project_id and user_id=v_user_id) then raise exception 'Undo this project''s direct trade before deleting it'; end if;
  delete from public.goal_ledger where project_id=p_project_id and user_id=v_user_id;
  delete from public.projects where id=p_project_id and user_id=v_user_id;
end;
$$;

-- Browser table writes may edit ordinary unlinked projects, but a retained Goal's
-- projects and expenses must pass the same live entitlement/status predicate.
create or replace function public.guard_trade_up_project_mutations()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if current_setting('sideflip.trade_up_rpc',true)='on' then return case when tg_op='DELETE' then old else new end; end if;
  if current_setting('role',true) in ('anon','authenticated') then
    if tg_op='INSERT' and new.goal_id is not null then
      raise exception 'Create goal-linked projects through the Trade-Up workflow';
    end if;
    if tg_op in ('UPDATE','DELETE') and old.goal_id is not null then
      perform public.assert_trade_up_goal_mutable(old.goal_id);
    end if;
    if tg_op='UPDATE' and new.goal_id is not null and new.goal_id is distinct from old.goal_id then
      perform public.assert_trade_up_goal_mutable(new.goal_id);
    end if;
    if tg_op='DELETE' and old.goal_id is not null then
      raise exception 'Delete goal-linked projects through the Trade-Up workflow';
    elsif tg_op='UPDATE' and (old.goal_id is not null or new.goal_id is not null) and (
      new.user_id is distinct from old.user_id or new.goal_id is distinct from old.goal_id
      or new.status is distinct from old.status or new.purchase_price is distinct from old.purchase_price
      or new.sale_price is distinct from old.sale_price or new.sold_at is distinct from old.sold_at
      or new.goal_funding_amount is distinct from old.goal_funding_amount
      or new.out_of_pocket_amount is distinct from old.out_of_pocket_amount
      or new.trade_credit_amount is distinct from old.trade_credit_amount
      or new.traded_from_project_id is distinct from old.traded_from_project_id
      or new.trade_up_mutation_id is distinct from old.trade_up_mutation_id
    ) then
      raise exception 'Update goal accounting through the Trade-Up workflow';
    end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;
revoke all on function public.guard_trade_up_project_mutations() from public, anon, authenticated;

create or replace function public.guard_trade_up_expense_mutations()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_goal_id uuid; v_project_user_id uuid; v_user_id uuid:=auth.uid();
begin
  if current_setting('sideflip.trade_up_rpc',true)='on' then return case when tg_op='DELETE' then old else new end; end if;
  if current_setting('role',true) not in ('anon','authenticated') then return case when tg_op='DELETE' then old else new end; end if;
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if tg_op<>'DELETE' and not public.trade_up_amount_is_finite(new.amount) then
    raise exception 'Expense amount must be finite';
  end if;
  if tg_op<>'DELETE' and new.user_id is distinct from v_user_id then raise exception 'Expense owner mismatch'; end if;
  select p.goal_id,p.user_id into v_goal_id,v_project_user_id from public.projects p
  where p.id=case when tg_op='DELETE' then old.project_id else new.project_id end
    and p.user_id=v_user_id;
  if not found or v_project_user_id is distinct from v_user_id then raise exception 'Owned project not found'; end if;
  if v_goal_id is not null then perform public.assert_trade_up_goal_mutable(v_goal_id); end if;
  if tg_op='UPDATE' and new.project_id is distinct from old.project_id then
    select p.goal_id,p.user_id into v_goal_id,v_project_user_id from public.projects p where p.id=old.project_id and p.user_id=v_user_id;
    if not found or v_project_user_id is distinct from v_user_id then raise exception 'Owned project not found'; end if;
    if v_goal_id is not null then perform public.assert_trade_up_goal_mutable(v_goal_id); end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;
revoke all on function public.guard_trade_up_expense_mutations() from public, anon, authenticated;
drop trigger if exists expenses_trade_up_mutation_guard on public.expenses;
create trigger expenses_trade_up_mutation_guard before insert or update or delete on public.expenses
for each row execute function public.guard_trade_up_expense_mutations();

alter table public.expenses drop constraint if exists expenses_amount_finite;
alter table public.expenses add constraint expenses_amount_finite
  check (amount is not null and amount > '-Infinity'::numeric and amount < 'Infinity'::numeric) not valid;

-- Legacy web clients update this table directly. Keep that path available, but
-- make the database enforce exactly the same ownership/access/accounting rules.
create or replace function public.guard_direct_trade_up_goal_updates()
returns trigger language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_user uuid:=auth.uid(); v_progress numeric;
begin
  if current_setting('sideflip.trade_up_rpc',true)='on' then return new; end if;
  if current_setting('role',true)<>'authenticated' then return new; end if;
  if v_user is null then raise exception 'Authentication required'; end if;
  if old.user_id<>v_user or new.user_id is distinct from old.user_id then raise exception 'Goal not found'; end if;
  perform public.assert_trade_up_goal_mutable(old.id,true);
  if new.id is distinct from old.id or new.goal_type is distinct from old.goal_type
     or new.target_item is distinct from old.target_item
     or new.client_mutation_id is distinct from old.client_mutation_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Unsafe Trade-Up Goal field update';
  end if;
  new.name:=trim(new.name);
  if char_length(new.name) not between 1 and 120 then raise exception 'Goal name required'; end if;
  if new.status not in ('active','completed') then raise exception 'Invalid goal status'; end if;
  if not public.trade_up_amount_is_finite(new.target_amount) or new.target_amount<=0 then
    raise exception 'Target amount must be a positive finite amount';
  end if;
  new.target_amount:=round(new.target_amount,2);
  if old.status<>'active' and new.status<>'active' and row(new.name,new.description,new.target_amount)
     is distinct from row(old.name,old.description,old.target_amount) then
    raise exception 'Reopen the Trade-Up Goal before changing it';
  end if;
  if old.status='completed' and new.status='active' and not public.user_has_verified_pro_entitlement(v_user)
     and exists(select 1 from public.trade_up_goals g where g.user_id=v_user and g.status='active' and g.id<>old.id) then
    raise exception 'Free accounts can have one active Trade-Up Goal. Upgrade to SideFlip Pro for additional goals.';
  end if;
  if old.status<>'completed' and new.status='completed' then
    perform 1 from public.goal_ledger l where l.goal_id=old.id and l.user_id=v_user order by l.id for update;
    perform 1 from public.projects p where p.goal_id=old.id and p.user_id=v_user order by p.id for update;
    perform 1 from public.expenses e where e.user_id=v_user and exists(
      select 1 from public.projects p where p.id=e.project_id and p.goal_id=old.id and p.user_id=v_user
    ) order by e.id for update;
    if exists(select 1 from public.goal_ledger l where l.goal_id=old.id and l.user_id=v_user and not public.trade_up_amount_is_finite(l.amount))
       or exists(select 1 from public.projects p where p.goal_id=old.id and p.user_id=v_user and p.status='active' and not public.trade_up_amount_is_finite(p.purchase_price))
       or exists(select 1 from public.expenses e join public.projects p on p.id=e.project_id
                 where p.goal_id=old.id and p.user_id=v_user and e.user_id=v_user and p.status='active'
                   and not public.trade_up_amount_is_finite(e.amount)) then
      raise exception 'Goal progress contains a non-finite amount';
    end if;
    select greatest(0,
      coalesce((select sum(l.amount) from public.goal_ledger l where l.goal_id=old.id and l.user_id=v_user),0)
      +coalesce((select sum(p.purchase_price) from public.projects p where p.goal_id=old.id and p.user_id=v_user and p.status='active'),0)
      +coalesce((select sum(e.amount) from public.expenses e join public.projects p on p.id=e.project_id
                 where p.goal_id=old.id and p.user_id=v_user and e.user_id=v_user and p.status='active'),0)
    ) into v_progress;
    if not public.trade_up_amount_is_finite(v_progress) then raise exception 'Goal progress contains a non-finite amount'; end if;
    if round(v_progress,2)<new.target_amount then raise exception 'Goal is not fully funded'; end if;
    new.completed_at:=now();
  elsif new.status='active' then new.completed_at:=null;
  else new.completed_at:=old.completed_at;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_direct_trade_up_goal_updates() from public,anon,authenticated;
drop trigger if exists trade_up_goals_direct_update_guard on public.trade_up_goals;
create trigger trade_up_goals_direct_update_guard before update on public.trade_up_goals
for each row execute function public.guard_direct_trade_up_goal_updates();

-- Harden the retained ownership trigger from the original Trade-Up migration.
-- Trigger execution does not require browser roles to execute its function directly.
alter function public.enforce_trade_up_goal_ownership() set search_path = pg_catalog, public;
revoke all on function public.enforce_trade_up_goal_ownership() from public, anon, authenticated;

revoke update on table public.trade_up_goals from anon;
grant update on table public.trade_up_goals to authenticated;

revoke all on function public.create_trade_up_goal(text,text,text,numeric,text,numeric,text) from public, anon, authenticated;
revoke all on function public.update_trade_up_goal(uuid,text,numeric,text) from public, anon, authenticated;
revoke all on function public.adjust_trade_up_goal(uuid,text,numeric,text,text) from public, anon, authenticated;
revoke all on function public.create_trade_up_project(text,text,numeric,text,text,text,text,text,text,text,text,integer,text,text,uuid,numeric,numeric,text) from public, anon, authenticated;
revoke all on function public.link_trade_up_project(uuid,uuid,numeric,text) from public, anon, authenticated;
revoke all on function public.record_trade_up_sale(uuid,numeric,numeric) from public, anon, authenticated;
revoke all on function public.record_trade_up_direct_trade(uuid,text,text,numeric,text,numeric,numeric,numeric,text,text) from public, anon, authenticated;
revoke all on function public.undo_goal_project_outcome(uuid) from public, anon, authenticated;
revoke all on function public.delete_trade_up_goal(uuid) from public, anon, authenticated;
revoke all on function public.delete_trade_up_project(uuid) from public, anon, authenticated;

grant execute on function public.create_trade_up_goal(text,text,text,numeric,text,numeric,text) to authenticated;
grant execute on function public.update_trade_up_goal(uuid,text,numeric,text) to authenticated;
grant execute on function public.adjust_trade_up_goal(uuid,text,numeric,text,text) to authenticated;
grant execute on function public.create_trade_up_project(text,text,numeric,text,text,text,text,text,text,text,text,integer,text,text,uuid,numeric,numeric,text) to authenticated;
grant execute on function public.link_trade_up_project(uuid,uuid,numeric,text) to authenticated;
grant execute on function public.record_trade_up_sale(uuid,numeric,numeric) to authenticated;
grant execute on function public.record_trade_up_direct_trade(uuid,text,text,numeric,text,numeric,numeric,numeric,text,text) to authenticated;
grant execute on function public.undo_goal_project_outcome(uuid) to authenticated;
grant execute on function public.delete_trade_up_goal(uuid) to authenticated;
grant execute on function public.delete_trade_up_project(uuid) to authenticated;

commit;
