-- Trade-Up Goals: multiple goals, linked projects, direct trades, and a tracking-only ledger.
-- SideFlip does not hold or transfer funds; these rows are private bookkeeping records.

begin;

create table if not exists public.trade_up_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 120),
  goal_type text not null default 'amount' check (goal_type in ('amount', 'item')),
  target_item text,
  target_amount numeric(14,2) not null default 0 check (target_amount >= 0),
  description text,
  status text not null default 'active' check (status in ('active', 'completed', 'archived')),
  client_mutation_id text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.goal_ledger (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.trade_up_goals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  type text not null check (type in (
    'personal_contribution', 'goal_purchase', 'sale_proceeds', 'cash_out',
    'trade_cash_received', 'trade_cash_paid', 'trade_cash_out_of_pocket', 'adjustment'
  )),
  amount numeric(14,2) not null check (amount <> 0),
  note text,
  client_mutation_id text,
  created_at timestamptz not null default now()
);

alter table public.projects add column if not exists goal_id uuid references public.trade_up_goals(id) on delete set null;
alter table public.projects add column if not exists goal_funding_amount numeric(14,2) not null default 0 check (goal_funding_amount >= 0);
alter table public.projects add column if not exists out_of_pocket_amount numeric(14,2) not null default 0 check (out_of_pocket_amount >= 0);
alter table public.projects add column if not exists trade_credit_amount numeric(14,2) not null default 0 check (trade_credit_amount >= 0);
alter table public.projects add column if not exists traded_from_project_id uuid references public.projects(id) on delete set null;
alter table public.projects add column if not exists trade_up_mutation_id text;

create index if not exists trade_up_goals_user_status_idx on public.trade_up_goals(user_id, status, created_at desc);
create index if not exists goal_ledger_goal_created_idx on public.goal_ledger(goal_id, created_at);
create index if not exists goal_ledger_user_idx on public.goal_ledger(user_id);
create index if not exists projects_goal_idx on public.projects(goal_id, status);
create unique index if not exists goals_client_mutation_idx on public.trade_up_goals(user_id, client_mutation_id) where client_mutation_id is not null;
create unique index if not exists ledger_client_mutation_idx on public.goal_ledger(user_id, client_mutation_id) where client_mutation_id is not null;
create unique index if not exists projects_trade_up_mutation_idx on public.projects(user_id, trade_up_mutation_id) where trade_up_mutation_id is not null;
create unique index if not exists goal_sale_once_idx on public.goal_ledger(project_id) where type = 'sale_proceeds';
create unique index if not exists direct_trade_once_idx on public.projects(traded_from_project_id) where traded_from_project_id is not null;

alter table public.trade_up_goals enable row level security;
alter table public.goal_ledger enable row level security;

drop policy if exists "Users manage own trade up goals" on public.trade_up_goals;
create policy "Users manage own trade up goals" on public.trade_up_goals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users manage own goal ledger" on public.goal_ledger;
create policy "Users manage own goal ledger" on public.goal_ledger
  for all
  using (
    auth.uid() = user_id
    and exists (select 1 from public.trade_up_goals g where g.id = goal_id and g.user_id = auth.uid())
  )
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.trade_up_goals g where g.id = goal_id and g.user_id = auth.uid())
    and (project_id is null or exists (
      select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()
    ))
  );

create or replace function public.enforce_trade_up_goal_ownership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.goal_id is not null and not exists (
    select 1 from public.trade_up_goals g where g.id = new.goal_id and g.user_id = new.user_id
  ) then
    raise exception 'Trade-Up Goal must belong to the same user';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_trade_up_goal_owner on public.projects;
create trigger projects_trade_up_goal_owner
  before insert or update of goal_id, user_id on public.projects
  for each row execute function public.enforce_trade_up_goal_ownership();

create or replace function public.guard_trade_up_project_mutations()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' and new.goal_id is not null then
      raise exception 'Create goal-linked projects through the Trade-Up workflow';
    elsif tg_op = 'DELETE' and old.goal_id is not null then
      raise exception 'Delete goal-linked projects through the Trade-Up workflow';
    elsif tg_op = 'UPDATE' and (old.goal_id is not null or new.goal_id is not null) and (
      new.user_id is distinct from old.user_id
      or new.goal_id is distinct from old.goal_id
      or new.status is distinct from old.status
      or new.purchase_price is distinct from old.purchase_price
      or new.sale_price is distinct from old.sale_price
      or new.sold_at is distinct from old.sold_at
      or new.goal_funding_amount is distinct from old.goal_funding_amount
      or new.out_of_pocket_amount is distinct from old.out_of_pocket_amount
      or new.trade_credit_amount is distinct from old.trade_credit_amount
      or new.traded_from_project_id is distinct from old.traded_from_project_id
      or new.trade_up_mutation_id is distinct from old.trade_up_mutation_id
    ) then
      raise exception 'Update goal accounting through the Trade-Up workflow';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists projects_trade_up_mutation_guard on public.projects;
create trigger projects_trade_up_mutation_guard
  before insert or update or delete on public.projects
  for each row execute function public.guard_trade_up_project_mutations();

create or replace function public.validate_goal_project_accounting()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.goal_id is null then return null; end if;
  if coalesce(new.goal_funding_amount, 0) > 0 and not exists (
    select 1 from public.goal_ledger
    where goal_id = new.goal_id and project_id = new.id and type = 'goal_purchase'
      and amount = -new.goal_funding_amount
  ) then
    raise exception 'Goal-funded projects require a matching goal ledger allocation';
  end if;
  if coalesce(new.trade_credit_amount, 0) = 0
     and abs(coalesce(new.purchase_price, 0) - coalesce(new.goal_funding_amount, 0) - coalesce(new.out_of_pocket_amount, 0)) > 0.009 then
    raise exception 'Project funding sources must equal its purchase price';
  end if;
  return null;
end $$;

drop trigger if exists projects_trade_up_accounting on public.projects;
create constraint trigger projects_trade_up_accounting
  after insert or update of goal_id, goal_funding_amount, out_of_pocket_amount, purchase_price on public.projects
  deferrable initially deferred for each row execute function public.validate_goal_project_accounting();

create or replace function public.validate_goal_project_outcome()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.goal_id is not null and new.status = 'sold' and not exists (
    select 1 from public.goal_ledger where project_id = new.id and type = 'sale_proceeds'
  ) and not exists (
    select 1 from public.projects where traded_from_project_id = new.id
  ) then
    raise exception 'Sold goal projects require sale proceeds or a received trade item';
  end if;
  return null;
end $$;

drop trigger if exists projects_trade_up_outcome on public.projects;
create constraint trigger projects_trade_up_outcome
  after insert or update of status, goal_id on public.projects
  deferrable initially deferred for each row execute function public.validate_goal_project_outcome();

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
  select id into v_id from public.trade_up_goals where user_id = v_user and client_mutation_id = p_mutation_id;
  if v_id is not null then return v_id; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Goal name required'; end if;
  if p_goal_type not in ('item','amount') then raise exception 'Invalid goal type'; end if;
  if p_goal_type = 'item' and nullif(trim(coalesce(p_target_item,'')), '') is null then raise exception 'Target item required'; end if;
  if p_goal_type = 'amount' and coalesce(p_target_amount,0) <= 0 then raise exception 'Target amount required'; end if;
  if coalesce(p_starting_amount,0) < 0 then raise exception 'Starting amount cannot be negative'; end if;
  begin
    insert into public.trade_up_goals(user_id,name,goal_type,target_item,target_amount,description,client_mutation_id)
    values(v_user,trim(p_name),p_goal_type,nullif(trim(coalesce(p_target_item,'')),''),coalesce(p_target_amount,0),nullif(trim(coalesce(p_description,'')),''),p_mutation_id)
    returning id into v_id;
  exception when unique_violation then
    select id into v_id from public.trade_up_goals where user_id = v_user and client_mutation_id = p_mutation_id;
    return v_id;
  end;
  if coalesce(p_starting_amount,0) > 0 then
    insert into public.goal_ledger(goal_id,user_id,type,amount,note,client_mutation_id)
    values(v_id,v_user,'personal_contribution',p_starting_amount,'Starting amount',p_mutation_id || ':starting');
  end if;
  return v_id;
end;
$$;

create or replace function public.create_trade_up_project(
  p_title text, p_category text, p_purchase_price numeric, p_photo text, p_notes text,
  p_model_number text, p_serial_number text, p_engine_model text, p_engine_serial text,
  p_vin text, p_hull_number text, p_vehicle_year integer, p_vehicle_make text, p_vehicle_model text,
  p_goal_id uuid, p_goal_funding numeric, p_out_of_pocket numeric, p_mutation_id text
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_user uuid := auth.uid(); v_id uuid; v_available numeric; v_status text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if nullif(trim(p_mutation_id), '') is null then raise exception 'Mutation ID required'; end if;
  select id into v_id from public.projects where user_id = v_user and trade_up_mutation_id = p_mutation_id;
  if v_id is not null then return v_id; end if;
  select status into v_status from public.trade_up_goals where id = p_goal_id and user_id = v_user for update;
  if v_status is null then raise exception 'Goal not found'; end if;
  select id into v_id from public.projects where user_id = v_user and trade_up_mutation_id = p_mutation_id;
  if v_id is not null then return v_id; end if;
  if v_status <> 'active' then raise exception 'Goal is not active'; end if;
  if nullif(trim(p_title), '') is null then raise exception 'Project title required'; end if;
  if coalesce(p_purchase_price,0) < 0 or coalesce(p_goal_funding,0) < 0 or coalesce(p_out_of_pocket,0) < 0 then raise exception 'Amounts cannot be negative'; end if;
  if round(coalesce(p_goal_funding,0) + coalesce(p_out_of_pocket,0),2) <> round(coalesce(p_purchase_price,0),2) then raise exception 'Funding must equal purchase price'; end if;
  select coalesce(sum(amount),0) into v_available from public.goal_ledger where goal_id = p_goal_id and user_id = v_user;
  if coalesce(p_goal_funding,0) > v_available then raise exception 'Insufficient amount available toward goal'; end if;
  begin
    insert into public.projects(
      user_id,title,category,status,purchase_price,photo,notes,model_number,serial_number,
      engine_model,engine_serial,vin,hull_number,vehicle_year,vehicle_make,vehicle_model,
      goal_id,goal_funding_amount,out_of_pocket_amount,trade_up_mutation_id
    ) values (
      v_user,trim(p_title),coalesce(p_category,'other'),'active',coalesce(p_purchase_price,0),p_photo,nullif(trim(coalesce(p_notes,'')),''),
      p_model_number,p_serial_number,p_engine_model,p_engine_serial,p_vin,p_hull_number,p_vehicle_year,p_vehicle_make,p_vehicle_model,
      p_goal_id,coalesce(p_goal_funding,0),coalesce(p_out_of_pocket,0),p_mutation_id
    ) returning id into v_id;
  exception when unique_violation then
    select id into v_id from public.projects where user_id = v_user and trade_up_mutation_id = p_mutation_id;
    return v_id;
  end;
  if coalesce(p_goal_funding,0) > 0 then
    insert into public.goal_ledger(goal_id,user_id,project_id,type,amount,note,client_mutation_id)
    values(p_goal_id,v_user,v_id,'goal_purchase',-p_goal_funding,'Goal funds used for ' || trim(p_title),p_mutation_id || ':funding');
  end if;
  return v_id;
end;
$$;

create or replace function public.adjust_trade_up_goal(
  p_goal_id uuid, p_type text, p_amount numeric, p_note text, p_mutation_id text
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_user uuid := auth.uid(); v_id uuid; v_status text; v_available numeric; v_signed numeric;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if nullif(trim(p_mutation_id), '') is null then raise exception 'Mutation ID required'; end if;
  select id into v_id from public.goal_ledger where user_id = v_user and client_mutation_id = p_mutation_id;
  if v_id is not null then return v_id; end if;
  if p_type not in ('personal_contribution','cash_out') or coalesce(p_amount,0) <= 0 then raise exception 'Invalid adjustment'; end if;
  select status into v_status from public.trade_up_goals where id = p_goal_id and user_id = v_user for update;
  if v_status is null then raise exception 'Goal not found'; end if;
  select id into v_id from public.goal_ledger where user_id = v_user and client_mutation_id = p_mutation_id;
  if v_id is not null then return v_id; end if;
  if v_status <> 'active' then raise exception 'Goal is not active'; end if;
  select coalesce(sum(amount),0) into v_available from public.goal_ledger where goal_id = p_goal_id and user_id = v_user;
  if p_type = 'cash_out' and p_amount > v_available then raise exception 'Insufficient amount available toward goal'; end if;
  v_signed := case when p_type = 'cash_out' then -p_amount else p_amount end;
  begin
    insert into public.goal_ledger(goal_id,user_id,type,amount,note,client_mutation_id)
    values(p_goal_id,v_user,p_type,v_signed,nullif(trim(coalesce(p_note,'')),''),p_mutation_id)
    returning id into v_id;
  exception when unique_violation then
    select id into v_id from public.goal_ledger where user_id = v_user and client_mutation_id = p_mutation_id;
  end;
  return v_id;
end;
$$;

create or replace function public.record_trade_up_sale(
  p_project_id uuid, p_sale_price numeric, p_keep_amount numeric
) returns void
language plpgsql security definer set search_path = public
as $$
declare v_user uuid := auth.uid(); v_project public.projects%rowtype; v_status text; v_existing_sale numeric; v_existing_keep numeric;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_project from public.projects where id = p_project_id and user_id = v_user for update;
  if v_project.id is null then raise exception 'Project not found'; end if;
  if v_project.status <> 'active' then
    if v_project.status = 'sold' and v_project.goal_id is null
       and v_project.sale_price = p_sale_price and coalesce(p_keep_amount,0) = 0 then return; end if;
    if exists(select 1 from public.goal_ledger where project_id=p_project_id and type='sale_proceeds') then
      select max(amount) filter (where type='sale_proceeds'),
             coalesce(sum(amount) filter (where type in ('sale_proceeds','cash_out')),0)
      into v_existing_sale, v_existing_keep
      from public.goal_ledger where project_id=p_project_id;
      if v_existing_sale = p_sale_price and v_existing_keep = p_keep_amount then return; end if;
      raise exception 'Sale was already recorded with different values';
    end if;
    raise exception 'Project is not active';
  end if;
  if coalesce(p_sale_price,-1) < 0 or coalesce(p_keep_amount,-1) < 0 or p_keep_amount > p_sale_price then raise exception 'Invalid sale allocation'; end if;
  if v_project.goal_id is not null then
    select status into v_status from public.trade_up_goals where id=v_project.goal_id and user_id=v_user for update;
    if v_status <> 'active' then raise exception 'Goal is not active'; end if;
  end if;
  update public.projects set status='sold',sale_price=p_sale_price,sold_at=now() where id=p_project_id and user_id=v_user;
  if v_project.goal_id is not null then
    insert into public.goal_ledger(goal_id,user_id,project_id,type,amount,note)
    values(v_project.goal_id,v_user,p_project_id,'sale_proceeds',p_sale_price,'Sale of ' || v_project.title);
    if p_keep_amount < p_sale_price then
      insert into public.goal_ledger(goal_id,user_id,project_id,type,amount,note)
      values(v_project.goal_id,v_user,p_project_id,'cash_out',-(p_sale_price-p_keep_amount),'Taken out after selling ' || v_project.title);
    end if;
  end if;
end;
$$;

create or replace function public.record_trade_up_direct_trade(
  p_outgoing_id uuid, p_incoming_title text, p_category text, p_trade_credit numeric,
  p_cash_direction text, p_cash_amount numeric, p_goal_cash numeric, p_keep_cash numeric,
  p_notes text, p_mutation_id text
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_user uuid := auth.uid(); v_out public.projects%rowtype; v_id uuid; v_status text; v_available numeric; v_basis numeric; v_out_pocket numeric;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if nullif(trim(p_mutation_id), '') is null then raise exception 'Mutation ID required'; end if;
  select id into v_id from public.projects where user_id=v_user and trade_up_mutation_id=p_mutation_id;
  if v_id is not null then return v_id; end if;
  select * into v_out from public.projects where id=p_outgoing_id and user_id=v_user for update;
  if v_out.id is null then raise exception 'Outgoing project not found'; end if;
  if v_out.status <> 'active' then
    select id into v_id from public.projects where user_id=v_user and trade_up_mutation_id=p_mutation_id;
    if v_id is not null then return v_id; end if;
    raise exception 'Outgoing project is not active';
  end if;
  if v_out.goal_id is null then raise exception 'Outgoing project is not linked to a goal'; end if;
  select status into v_status from public.trade_up_goals where id=v_out.goal_id and user_id=v_user for update;
  if v_status <> 'active' then raise exception 'Goal is not active'; end if;
  if nullif(trim(p_incoming_title),'') is null or coalesce(p_trade_credit,0) <= 0 then raise exception 'Incoming item and trade value required'; end if;
  if p_cash_direction not in ('none','paid','received') or coalesce(p_cash_amount,0) < 0 or coalesce(p_goal_cash,0) < 0 or coalesce(p_keep_cash,0) < 0 then raise exception 'Invalid trade amounts'; end if;
  if p_cash_direction <> 'paid' and coalesce(p_goal_cash,0) <> 0 then raise exception 'Goal cash is only valid when cash is paid'; end if;
  if p_cash_direction <> 'received' and coalesce(p_keep_cash,0) <> 0 then raise exception 'Kept cash is only valid when cash is received'; end if;
  if p_cash_direction = 'none' and coalesce(p_cash_amount,0) <> 0 then raise exception 'No-cash trades cannot include a cash amount'; end if;
  if p_cash_direction <> 'none' and coalesce(p_cash_amount,0) <= 0 then raise exception 'Cash difference must be greater than zero'; end if;
  if p_goal_cash > p_cash_amount or p_keep_cash > p_cash_amount then raise exception 'Invalid trade allocation'; end if;
  select coalesce(sum(amount),0) into v_available from public.goal_ledger where goal_id=v_out.goal_id and user_id=v_user;
  if p_goal_cash > v_available then raise exception 'Insufficient amount available toward goal'; end if;
  v_basis := p_trade_credit + case when p_cash_direction='paid' then p_cash_amount when p_cash_direction='received' then -p_cash_amount else 0 end;
  if v_basis < 0 then raise exception 'Received item basis cannot be negative'; end if;
  v_out_pocket := case when p_cash_direction='paid' then p_cash_amount-p_goal_cash else 0 end;
  update public.projects set status='sold',sale_price=p_trade_credit,sold_at=now() where id=p_outgoing_id and user_id=v_user;
  insert into public.projects(user_id,title,category,status,purchase_price,notes,goal_id,goal_funding_amount,out_of_pocket_amount,trade_credit_amount,traded_from_project_id,trade_up_mutation_id)
  values(v_user,trim(p_incoming_title),coalesce(p_category,'other'),'active',v_basis,coalesce(nullif(trim(coalesce(p_notes,'')),''),'Received in trade for ' || v_out.title),v_out.goal_id,p_goal_cash,v_out_pocket,p_trade_credit,p_outgoing_id,p_mutation_id)
  returning id into v_id;
  if p_goal_cash > 0 then
    insert into public.goal_ledger(goal_id,user_id,project_id,type,amount,note,client_mutation_id)
    values(v_out.goal_id,v_user,v_id,'goal_purchase',-p_goal_cash,'Goal funds used for trade',p_mutation_id || ':funding');
  end if;
  if p_cash_direction='received' and p_cash_amount > 0 then
    insert into public.goal_ledger(goal_id,user_id,project_id,type,amount,note,client_mutation_id)
    values(v_out.goal_id,v_user,v_id,'trade_cash_received',p_cash_amount,'Cash received trading ' || v_out.title,p_mutation_id || ':cash');
    if p_keep_cash < p_cash_amount then
      insert into public.goal_ledger(goal_id,user_id,project_id,type,amount,note,client_mutation_id)
      values(v_out.goal_id,v_user,v_id,'cash_out',-(p_cash_amount-p_keep_cash),'Trade cash taken out',p_mutation_id || ':cashout');
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.undo_goal_project_outcome(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_project public.projects%rowtype;
  v_goal_status text;
  v_incoming_id uuid;
  v_incoming_status text;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select * into v_project from public.projects
  where id = p_project_id and user_id = v_user_id for update;
  if v_project.id is null then raise exception 'Project not found'; end if;
  if v_project.status <> 'sold' then raise exception 'Project has no sale or trade to undo'; end if;

  if v_project.goal_id is not null then
    select status into v_goal_status from public.trade_up_goals
    where id = v_project.goal_id and user_id = v_user_id for update;
    if v_goal_status <> 'active' then raise exception 'Reopen the Trade-Up Goal before undoing this outcome'; end if;
  end if;

  select id, status into v_incoming_id, v_incoming_status
  from public.projects
  where traded_from_project_id = p_project_id and user_id = v_user_id
  order by created_at desc
  limit 1
  for update;

  if v_incoming_id is not null then
    if v_incoming_status <> 'active' or exists (
      select 1 from public.projects where traded_from_project_id = v_incoming_id and user_id = v_user_id
    ) or exists (
      select 1 from public.goal_ledger where project_id = v_incoming_id and type = 'sale_proceeds'
    ) then
      raise exception 'Undo the received item''s later sale or trade first';
    end if;
    delete from public.goal_ledger where project_id = v_incoming_id and user_id = v_user_id;
    delete from public.projects where id = v_incoming_id and user_id = v_user_id;
  end if;

  delete from public.goal_ledger
  where project_id = p_project_id
    and user_id = v_user_id
    and type in ('sale_proceeds', 'cash_out');

  update public.projects
  set status = 'active', sale_price = null, sold_at = null
  where id = p_project_id and user_id = v_user_id;
end;
$$;

create or replace function public.delete_trade_up_goal(p_goal_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  perform 1 from public.trade_up_goals where id = p_goal_id and user_id = v_user_id for update;
  if not found then raise exception 'Goal not found'; end if;
  delete from public.trade_up_goals where id = p_goal_id and user_id = v_user_id;
end;
$$;

create or replace function public.delete_trade_up_project(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_project public.projects%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select * into v_project from public.projects
  where id = p_project_id and user_id = v_user_id for update;
  if v_project.id is null then raise exception 'Project not found'; end if;
  if v_project.goal_id is not null and v_project.status <> 'active' then
    raise exception 'Undo this project''s sale or trade before deleting it';
  end if;
  if v_project.traded_from_project_id is not null then
    raise exception 'Undo the direct trade from the previous item instead of deleting the received item';
  end if;
  if exists (select 1 from public.projects where traded_from_project_id = p_project_id and user_id = v_user_id) then
    raise exception 'Undo this project''s direct trade before deleting it';
  end if;
  delete from public.goal_ledger where project_id = p_project_id and user_id = v_user_id;
  delete from public.projects where id = p_project_id and user_id = v_user_id;
end;
$$;

revoke insert, delete on public.trade_up_goals from anon, authenticated;
grant select, update on public.trade_up_goals to authenticated;
revoke insert, update, delete on public.goal_ledger from anon, authenticated;
grant select on public.goal_ledger to authenticated;
revoke all on function public.create_trade_up_goal(text,text,text,numeric,text,numeric,text) from public;
revoke all on function public.create_trade_up_project(text,text,numeric,text,text,text,text,text,text,text,text,integer,text,text,uuid,numeric,numeric,text) from public;
revoke all on function public.adjust_trade_up_goal(uuid,text,numeric,text,text) from public;
revoke all on function public.record_trade_up_sale(uuid,numeric,numeric) from public;
revoke all on function public.record_trade_up_direct_trade(uuid,text,text,numeric,text,numeric,numeric,numeric,text,text) from public;
revoke all on function public.undo_goal_project_outcome(uuid) from public;
revoke all on function public.delete_trade_up_goal(uuid) from public;
revoke all on function public.delete_trade_up_project(uuid) from public;
grant execute on function public.create_trade_up_goal(text,text,text,numeric,text,numeric,text) to authenticated;
grant execute on function public.create_trade_up_project(text,text,numeric,text,text,text,text,text,text,text,text,integer,text,text,uuid,numeric,numeric,text) to authenticated;
grant execute on function public.adjust_trade_up_goal(uuid,text,numeric,text,text) to authenticated;
grant execute on function public.record_trade_up_sale(uuid,numeric,numeric) to authenticated;
grant execute on function public.record_trade_up_direct_trade(uuid,text,text,numeric,text,numeric,numeric,numeric,text,text) to authenticated;
grant execute on function public.undo_goal_project_outcome(uuid) to authenticated;
grant execute on function public.delete_trade_up_goal(uuid) to authenticated;
grant execute on function public.delete_trade_up_project(uuid) to authenticated;

commit;
