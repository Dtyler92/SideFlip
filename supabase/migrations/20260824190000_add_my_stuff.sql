-- SideFlip My Stuff: isolated owned-item maintenance tracking.
-- Additive only. This migration does not alter or reference projects, expenses,
-- trade_up_goals, or goal_ledger. It depends on the existing authoritative
-- public.user_has_verified_pro_entitlement(uuid) helper.
begin;

do $$
begin
  if to_regprocedure('public.user_has_verified_pro_entitlement(uuid)') is null then
    raise exception 'Required authoritative entitlement helper is missing';
  end if;
  if to_regclass('public.my_stuff_items') is not null
     or to_regclass('public.my_stuff_schedules') is not null
     or to_regclass('public.my_stuff_service_logs') is not null then
    raise exception 'My Stuff schema already exists; inspect Production before applying';
  end if;
end;
$$;

create table public.my_stuff_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  category text not null default 'other',
  acquired_on date,
  notes text,
  current_mileage numeric,
  current_hours numeric,
  client_mutation_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint my_stuff_items_name_nonempty check (length(trim(name)) > 0),
  constraint my_stuff_items_category_nonempty check (length(trim(category)) > 0),
  constraint my_stuff_items_acquired_on_valid check (
    acquired_on is null or (isfinite(acquired_on) and acquired_on between date '1900-01-01' and date '2200-12-31')
  ),
  constraint my_stuff_items_mileage_valid check (
    current_mileage is null or (current_mileage >= 0 and current_mileage::text not in ('NaN','Infinity','-Infinity'))
  ),
  constraint my_stuff_items_hours_valid check (
    current_hours is null or (current_hours >= 0 and current_hours::text not in ('NaN','Infinity','-Infinity'))
  ),
  constraint my_stuff_items_mutation_nonempty check (length(trim(client_mutation_id)) > 0),
  constraint my_stuff_items_owner_id_unique unique (id, user_id),
  constraint my_stuff_items_owner_mutation_unique unique (user_id, client_mutation_id)
);

create index my_stuff_items_owner_created_idx
  on public.my_stuff_items(user_id, created_at desc);

create table public.my_stuff_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null,
  name text not null,
  tracking_type text not null check (tracking_type in ('mileage','hours','calendar')),
  interval_value numeric not null,
  last_completed_at timestamptz,
  last_completed_value numeric,
  next_due_at timestamptz,
  next_due_value numeric,
  client_mutation_id text not null default gen_random_uuid()::text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint my_stuff_schedules_name_nonempty check (length(trim(name)) > 0),
  constraint my_stuff_schedules_interval_valid check (
    interval_value > 0 and interval_value::text not in ('NaN','Infinity','-Infinity')
  ),
  constraint my_stuff_schedules_dates_valid check (
    (last_completed_at is null or (isfinite(last_completed_at) and last_completed_at between timestamptz '1900-01-01 00:00:00Z' and timestamptz '2200-12-31 23:59:59Z'))
    and (next_due_at is null or (isfinite(next_due_at) and next_due_at between timestamptz '1900-01-01 00:00:00Z' and timestamptz '2200-12-31 23:59:59Z'))
  ),
  constraint my_stuff_schedules_last_value_valid check (
    last_completed_value is null or (last_completed_value >= 0 and last_completed_value::text not in ('NaN','Infinity','-Infinity'))
  ),
  constraint my_stuff_schedules_next_value_valid check (
    next_due_value is null or (next_due_value >= 0 and next_due_value::text not in ('NaN','Infinity','-Infinity'))
  ),
  constraint my_stuff_schedules_mutation_nonempty check (length(trim(client_mutation_id)) > 0),
  constraint my_stuff_schedules_mode_values check (
    (tracking_type = 'calendar'
      and interval_value = trunc(interval_value)
      and interval_value <= 36500
      and last_completed_value is null
      and next_due_value is null
      and next_due_at is not null)
    or
    (tracking_type in ('mileage','hours')
      and next_due_value is not null
      and next_due_at is null)
  ),
  constraint my_stuff_schedules_owner_id_unique unique (id, user_id),
  constraint my_stuff_schedules_owner_mutation_unique unique (user_id, client_mutation_id),
  constraint my_stuff_schedules_item_owner_fk
    foreign key (item_id, user_id)
    references public.my_stuff_items(id, user_id) on delete cascade
);

create index my_stuff_schedules_item_created_idx
  on public.my_stuff_schedules(user_id, item_id, created_at);
create index my_stuff_schedules_due_value_idx
  on public.my_stuff_schedules(user_id, tracking_type, next_due_value)
  where next_due_value is not null;
create index my_stuff_schedules_due_at_idx
  on public.my_stuff_schedules(user_id, next_due_at)
  where next_due_at is not null;

create table public.my_stuff_service_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null,
  schedule_id uuid,
  name text not null,
  completed_at timestamptz not null,
  mileage numeric,
  hours numeric,
  cost numeric,
  notes text,
  client_mutation_id text not null,
  created_at timestamptz not null default now(),
  constraint my_stuff_logs_name_nonempty check (length(trim(name)) > 0),
  constraint my_stuff_logs_completed_at_valid check (
    isfinite(completed_at) and completed_at between timestamptz '1900-01-01 00:00:00Z' and timestamptz '2200-12-31 23:59:59Z'
  ),
  constraint my_stuff_logs_mileage_valid check (
    mileage is null or (mileage >= 0 and mileage::text not in ('NaN','Infinity','-Infinity'))
  ),
  constraint my_stuff_logs_hours_valid check (
    hours is null or (hours >= 0 and hours::text not in ('NaN','Infinity','-Infinity'))
  ),
  constraint my_stuff_logs_cost_valid check (
    cost is null or (cost >= 0 and cost::text not in ('NaN','Infinity','-Infinity'))
  ),
  constraint my_stuff_logs_mutation_nonempty check (length(trim(client_mutation_id)) > 0),
  constraint my_stuff_logs_owner_mutation_unique unique (user_id, client_mutation_id),
  constraint my_stuff_logs_item_owner_fk
    foreign key (item_id, user_id)
    references public.my_stuff_items(id, user_id) on delete cascade,
  constraint my_stuff_logs_schedule_fk
    foreign key (schedule_id) references public.my_stuff_schedules(id) on delete set null
);

create index my_stuff_logs_item_completed_idx
  on public.my_stuff_service_logs(user_id, item_id, completed_at desc);

create function public.set_my_stuff_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger my_stuff_items_set_updated_at
before update on public.my_stuff_items
for each row execute function public.set_my_stuff_updated_at();
create trigger my_stuff_schedules_set_updated_at
before update on public.my_stuff_schedules
for each row execute function public.set_my_stuff_updated_at();

create function public.enforce_my_stuff_item_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_id is null then raise exception 'Item owner is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  if not public.user_has_verified_pro_entitlement(new.user_id)
     and exists (
       select 1 from public.my_stuff_items i
       where i.user_id = new.user_id and i.id is distinct from new.id
     ) then
    raise exception 'Free accounts can have one My Stuff item. SideFlip Pro is required for additional items.';
  end if;
  return new;
end;
$$;

create trigger my_stuff_items_free_limit
before insert or update of user_id on public.my_stuff_items
for each row execute function public.enforce_my_stuff_item_limit();

create function public.enforce_my_stuff_item_readings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.current_mileage is not null and (new.current_mileage is null or new.current_mileage < old.current_mileage) then
    raise exception 'Mileage cannot move backwards';
  end if;
  if old.current_hours is not null and (new.current_hours is null or new.current_hours < old.current_hours) then
    raise exception 'Operating hours cannot move backwards';
  end if;
  return new;
end;
$$;

create trigger my_stuff_items_readings_monotonic
before update of current_mileage, current_hours on public.my_stuff_items
for each row execute function public.enforce_my_stuff_item_readings();

create function public.enforce_my_stuff_schedule_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.my_stuff_items i
    where i.id = new.item_id and i.user_id = new.user_id
  ) then
    raise exception 'My Stuff item does not belong to this account';
  end if;
  return new;
end;
$$;

create function public.enforce_my_stuff_log_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.my_stuff_items i
    where i.id = new.item_id and i.user_id = new.user_id
  ) then
    raise exception 'My Stuff item does not belong to this account';
  end if;
  if new.schedule_id is not null and not exists (
    select 1 from public.my_stuff_schedules s
    where s.id = new.schedule_id and s.item_id = new.item_id and s.user_id = new.user_id
  ) then
    raise exception 'Maintenance schedule does not belong to this item';
  end if;
  return new;
end;
$$;

create trigger my_stuff_schedules_owner_guard
before insert or update of user_id, item_id on public.my_stuff_schedules
for each row execute function public.enforce_my_stuff_schedule_owner();
create trigger my_stuff_logs_owner_guard
before insert or update of user_id, item_id, schedule_id on public.my_stuff_service_logs
for each row execute function public.enforce_my_stuff_log_owner();

alter table public.my_stuff_items enable row level security;
alter table public.my_stuff_schedules enable row level security;
alter table public.my_stuff_service_logs enable row level security;

create policy my_stuff_items_owner_select on public.my_stuff_items
for select to authenticated using ((select auth.uid()) = user_id);
create policy my_stuff_items_owner_update on public.my_stuff_items
for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy my_stuff_items_owner_delete on public.my_stuff_items
for delete to authenticated using ((select auth.uid()) = user_id);

create policy my_stuff_schedules_owner_select on public.my_stuff_schedules
for select to authenticated using ((select auth.uid()) = user_id);
create policy my_stuff_schedules_owner_delete on public.my_stuff_schedules
for delete to authenticated using ((select auth.uid()) = user_id);

create policy my_stuff_logs_owner_select on public.my_stuff_service_logs
for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.my_stuff_items, public.my_stuff_schedules, public.my_stuff_service_logs from public, anon, authenticated;
grant select, delete on public.my_stuff_items to authenticated;
grant update (name, category, acquired_on, notes, current_mileage, current_hours) on public.my_stuff_items to authenticated;
grant select, delete on public.my_stuff_schedules to authenticated;
grant select on public.my_stuff_service_logs to authenticated;

create function public.create_my_stuff_item(
  p_name text,
  p_category text,
  p_acquired_on date,
  p_notes text,
  p_current_mileage numeric,
  p_current_hours numeric,
  p_mutation_id text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if nullif(trim(p_mutation_id), '') is null then raise exception 'Mutation ID required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));
  select id into v_id from public.my_stuff_items
    where user_id = v_user and client_mutation_id = p_mutation_id;
  if v_id is not null then return v_id; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Item name required'; end if;
  if p_acquired_on is not null and (not isfinite(p_acquired_on) or p_acquired_on < date '1900-01-01' or p_acquired_on > date '2200-12-31') then
    raise exception 'Acquisition date must be between 1900-01-01 and 2200-12-31';
  end if;
  if p_current_mileage is not null and (p_current_mileage < 0 or p_current_mileage::text in ('NaN','Infinity','-Infinity')) then
    raise exception 'Mileage must be finite and non-negative';
  end if;
  if p_current_hours is not null and (p_current_hours < 0 or p_current_hours::text in ('NaN','Infinity','-Infinity')) then
    raise exception 'Operating hours must be finite and non-negative';
  end if;
  if not public.user_has_verified_pro_entitlement(v_user)
     and exists (select 1 from public.my_stuff_items where user_id = v_user) then
    raise exception 'Free accounts can have one My Stuff item. SideFlip Pro is required for additional items.';
  end if;
  insert into public.my_stuff_items(
    user_id, name, category, acquired_on, notes, current_mileage, current_hours, client_mutation_id
  ) values (
    v_user, trim(p_name), coalesce(nullif(trim(p_category), ''), 'other'), p_acquired_on,
    nullif(trim(coalesce(p_notes, '')), ''), p_current_mileage, p_current_hours, p_mutation_id
  ) returning id into v_id;
  return v_id;
exception when unique_violation then
  select id into v_id from public.my_stuff_items
    where user_id = v_user and client_mutation_id = p_mutation_id;
  if v_id is not null then return v_id; end if;
  raise;
end;
$$;

create function public.create_my_stuff_schedule(
  p_item_id uuid,
  p_name text,
  p_tracking_type text,
  p_interval_value numeric,
  p_last_completed_at timestamptz,
  p_last_completed_value numeric,
  p_mutation_id text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
  v_next_at timestamptz;
  v_next_value numeric;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if nullif(trim(p_mutation_id), '') is null then raise exception 'Mutation ID required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));
  select id into v_id from public.my_stuff_schedules
    where user_id = v_user and client_mutation_id = trim(p_mutation_id);
  if v_id is not null then return v_id; end if;
  if not exists (select 1 from public.my_stuff_items where id = p_item_id and user_id = v_user) then
    raise exception 'My Stuff item not found';
  end if;
  if nullif(trim(p_name), '') is null then raise exception 'Maintenance name required'; end if;
  if p_tracking_type not in ('mileage','hours','calendar') then raise exception 'Invalid maintenance tracking type'; end if;
  if p_interval_value is null or p_interval_value <= 0 or p_interval_value::text in ('NaN','Infinity','-Infinity') then
    raise exception 'Maintenance interval must be finite and positive';
  end if;

  if p_tracking_type = 'calendar' then
    if p_interval_value <> trunc(p_interval_value) or p_interval_value > 36500 then
      raise exception 'Calendar interval must be a whole number from 1 to 36500 days';
    end if;
    if p_last_completed_value is not null then raise exception 'Calendar maintenance does not accept a reading'; end if;
    if p_last_completed_at is null or not isfinite(p_last_completed_at)
       or p_last_completed_at < timestamptz '1900-01-01 00:00:00Z'
       or p_last_completed_at > timestamptz '2200-12-31 23:59:59Z' then
      raise exception 'Last completion date must be finite and between 1900 and 2200';
    end if;
    begin
      v_next_at := p_last_completed_at + make_interval(days => p_interval_value::integer);
    exception when datetime_field_overflow or numeric_value_out_of_range then
      raise exception 'Calculated next due date is outside the supported range';
    end;
    if not isfinite(v_next_at) or v_next_at > timestamptz '2200-12-31 23:59:59Z' then
      raise exception 'Calculated next due date is outside the supported range';
    end if;
  else
    if p_last_completed_at is not null then raise exception 'Mileage and hours maintenance use a reading, not a date'; end if;
    if p_last_completed_value is null or p_last_completed_value < 0
       or p_last_completed_value::text in ('NaN','Infinity','-Infinity') then
      raise exception 'Last completed reading must be finite and non-negative';
    end if;
    v_next_value := p_last_completed_value + p_interval_value;
  end if;

  insert into public.my_stuff_schedules(
    user_id, item_id, name, tracking_type, interval_value, last_completed_at,
    last_completed_value, next_due_at, next_due_value, client_mutation_id
  ) values (
    v_user, p_item_id, trim(p_name), p_tracking_type, p_interval_value, p_last_completed_at,
    p_last_completed_value, v_next_at, v_next_value, trim(p_mutation_id)
  ) returning id into v_id;
  return v_id;
exception when unique_violation then
  select id into v_id from public.my_stuff_schedules
    where user_id = v_user and client_mutation_id = trim(p_mutation_id);
  if v_id is not null then return v_id; end if;
  raise;
end;
$$;

create function public.complete_my_stuff_maintenance(
  p_schedule_id uuid,
  p_completed_at timestamptz,
  p_reading numeric,
  p_cost numeric,
  p_notes text,
  p_mutation_id text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_schedule public.my_stuff_schedules;
  v_item public.my_stuff_items;
  v_log_id uuid;
  v_mileage numeric;
  v_hours numeric;
  v_next_at timestamptz;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if nullif(trim(p_mutation_id), '') is null then raise exception 'Mutation ID required'; end if;
  select id into v_log_id from public.my_stuff_service_logs
    where user_id = v_user and client_mutation_id = p_mutation_id;
  if v_log_id is not null then return v_log_id; end if;
  if p_completed_at is null then raise exception 'Completion date required'; end if;
  if not isfinite(p_completed_at) or p_completed_at < timestamptz '1900-01-01 00:00:00Z' or p_completed_at > timestamptz '2200-12-31 23:59:59Z' then
    raise exception 'Completion date must be finite and between 1900 and 2200';
  end if;
  if p_cost is not null and (p_cost < 0 or p_cost::text in ('NaN','Infinity','-Infinity')) then
    raise exception 'Cost must be finite and non-negative';
  end if;

  select * into v_schedule from public.my_stuff_schedules
    where id = p_schedule_id and user_id = v_user for update;
  if not found then raise exception 'Maintenance schedule not found'; end if;
  select * into v_item from public.my_stuff_items
    where id = v_schedule.item_id and user_id = v_user for update;
  if not found then raise exception 'My Stuff item not found'; end if;

  if v_schedule.last_completed_at is not null and p_completed_at < v_schedule.last_completed_at then
    raise exception 'Completion date cannot move backwards';
  end if;

  if v_schedule.tracking_type = 'calendar' then
    if p_reading is not null then raise exception 'Calendar maintenance does not accept a reading'; end if;
    begin
      v_next_at := p_completed_at + make_interval(days => v_schedule.interval_value::integer);
    exception when datetime_field_overflow or numeric_value_out_of_range then
      raise exception 'Calculated next due date is outside the supported range';
    end;
    if not isfinite(v_next_at) or v_next_at > timestamptz '2200-12-31 23:59:59Z' then
      raise exception 'Calculated next due date is outside the supported range';
    end if;
    update public.my_stuff_schedules
      set last_completed_at = p_completed_at,
          last_completed_value = null,
          next_due_at = v_next_at,
          next_due_value = null
      where id = v_schedule.id;
  else
    if p_reading is null or p_reading < 0 or p_reading::text in ('NaN','Infinity','-Infinity') then
      raise exception 'Maintenance reading must be finite and non-negative';
    end if;
    if v_schedule.last_completed_value is not null and p_reading < v_schedule.last_completed_value then
      raise exception 'Maintenance reading cannot move backwards';
    end if;
    if v_schedule.tracking_type = 'mileage' and v_item.current_mileage is not null and p_reading < v_item.current_mileage then
      raise exception 'Mileage cannot move backwards';
    end if;
    if v_schedule.tracking_type = 'hours' and v_item.current_hours is not null and p_reading < v_item.current_hours then
      raise exception 'Operating hours cannot move backwards';
    end if;
    update public.my_stuff_schedules
      set last_completed_at = p_completed_at,
          last_completed_value = p_reading,
          next_due_at = null,
          next_due_value = p_reading + v_schedule.interval_value
      where id = v_schedule.id;
    if v_schedule.tracking_type = 'mileage' then
      v_mileage := p_reading;
      update public.my_stuff_items set current_mileage = p_reading where id = v_item.id;
    else
      v_hours := p_reading;
      update public.my_stuff_items set current_hours = p_reading where id = v_item.id;
    end if;
  end if;

  insert into public.my_stuff_service_logs(
    user_id, item_id, schedule_id, name, completed_at, mileage, hours, cost, notes, client_mutation_id
  ) values (
    v_user, v_schedule.item_id, v_schedule.id, v_schedule.name, p_completed_at,
    v_mileage, v_hours, p_cost, nullif(trim(coalesce(p_notes, '')), ''), p_mutation_id
  ) returning id into v_log_id;
  return v_log_id;
exception when unique_violation then
  select id into v_log_id from public.my_stuff_service_logs
    where user_id = v_user and client_mutation_id = p_mutation_id;
  if v_log_id is not null then return v_log_id; end if;
  raise;
end;
$$;

revoke all on function public.create_my_stuff_item(text,text,date,text,numeric,numeric,text) from public, anon, authenticated;
grant execute on function public.create_my_stuff_item(text,text,date,text,numeric,numeric,text) to authenticated;
revoke all on function public.create_my_stuff_schedule(uuid,text,text,numeric,timestamptz,numeric,text) from public, anon, authenticated;
grant execute on function public.create_my_stuff_schedule(uuid,text,text,numeric,timestamptz,numeric,text) to authenticated;
revoke all on function public.complete_my_stuff_maintenance(uuid,timestamptz,numeric,numeric,text,text) from public, anon, authenticated;
grant execute on function public.complete_my_stuff_maintenance(uuid,timestamptz,numeric,numeric,text,text) to authenticated;
revoke all on function public.set_my_stuff_updated_at() from public, anon, authenticated;
revoke all on function public.enforce_my_stuff_item_limit() from public, anon, authenticated;
revoke all on function public.enforce_my_stuff_item_readings() from public, anon, authenticated;
revoke all on function public.enforce_my_stuff_schedule_owner() from public, anon, authenticated;
revoke all on function public.enforce_my_stuff_log_owner() from public, anon, authenticated;

commit;
