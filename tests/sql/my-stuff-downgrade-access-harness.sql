\set ON_ERROR_STOP on

create schema auth;
create schema private;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public,auth to anon,authenticated,service_role;
grant usage on schema private to service_role;

create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;

create table public.test_pro_users(user_id uuid primary key);
create function public.user_has_verified_pro_entitlement(p_user uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.test_pro_users where user_id=p_user)
$$;

create table public.my_stuff_items(
  id uuid primary key,
  user_id uuid not null,
  name text not null,
  item_type text not null default 'other',
  custom_name text,
  category text not null default 'other',
  acquired_on date,
  usage_dimensions text[],
  current_mileage numeric,
  current_hours numeric,
  current_cycles numeric,
  effective_current_mileage numeric,
  effective_current_hours numeric,
  effective_current_cycles numeric,
  archived_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table public.my_stuff_attachments(id uuid primary key,user_id uuid not null,item_id uuid not null);
create table public.my_stuff_definition_versions(id uuid primary key,user_id uuid not null,item_id uuid not null);
create table public.my_stuff_expense_audit(id uuid primary key,user_id uuid not null,item_id uuid not null);
create table public.my_stuff_expense_revisions(id uuid primary key,user_id uuid not null,item_id uuid not null);
create table public.my_stuff_expenses(id uuid primary key,user_id uuid not null,item_id uuid not null);
create table public.my_stuff_maintenance_definitions(id uuid primary key,user_id uuid not null,item_id uuid not null);
create table public.my_stuff_occurrence_status_events(id uuid primary key,user_id uuid not null,item_id uuid not null);
create table public.my_stuff_planned_occurrences(id uuid primary key,user_id uuid not null,item_id uuid not null);
create table public.my_stuff_project_transfers(id uuid primary key,user_id uuid not null,item_id uuid not null);
create table public.my_stuff_readings(id uuid primary key,user_id uuid not null,item_id uuid not null);
create table public.my_stuff_schedules(id uuid primary key,user_id uuid not null,item_id uuid not null);
create table public.my_stuff_service_audit(id uuid primary key,user_id uuid not null,item_id uuid not null);
create table public.my_stuff_service_logs(id uuid primary key,user_id uuid not null,item_id uuid not null);
create table public.my_stuff_service_occurrence_revisions(id uuid primary key,user_id uuid not null,item_id uuid not null);
create table public.my_stuff_service_occurrences(id uuid primary key,user_id uuid not null,item_id uuid not null);
create table public.my_stuff_to_project_expense_copies(id uuid primary key,user_id uuid not null,item_id uuid not null);
create table public.my_stuff_to_project_transfers(id uuid primary key,user_id uuid not null,item_id uuid not null);

alter table public.my_stuff_items enable row level security;
create policy my_stuff_items_owner_select on public.my_stuff_items for select to authenticated using (auth.uid()=user_id);
create policy my_stuff_items_owner_update on public.my_stuff_items for update to authenticated using (auth.uid()=user_id) with check(auth.uid()=user_id);
create policy my_stuff_items_owner_delete on public.my_stuff_items for delete to authenticated using (auth.uid()=user_id);
grant select,update,delete on public.my_stuff_items to authenticated;
grant select,insert,update,delete on public.my_stuff_items to service_role;

do $$
declare pair text[]; v_table text; v_policy text;
begin
  foreach pair slice 1 in array array[
    ['my_stuff_attachments','my_stuff_attachments_owner_select'],
    ['my_stuff_definition_versions','my_stuff_definition_versions_owner_select'],
    ['my_stuff_expense_audit','my_stuff_expense_audit_owner_select'],
    ['my_stuff_expense_revisions','my_stuff_expense_revisions_owner_select'],
    ['my_stuff_expenses','my_stuff_expenses_owner_select'],
    ['my_stuff_maintenance_definitions','my_stuff_definitions_owner_select'],
    ['my_stuff_occurrence_status_events','my_stuff_status_owner_select'],
    ['my_stuff_planned_occurrences','my_stuff_planned_owner_select'],
    ['my_stuff_project_transfers','my_stuff_transfers_owner_select'],
    ['my_stuff_readings','my_stuff_readings_owner_select'],
    ['my_stuff_schedules','my_stuff_schedules_owner_select'],
    ['my_stuff_service_audit','my_stuff_audit_owner_select'],
    ['my_stuff_service_logs','my_stuff_logs_owner_select'],
    ['my_stuff_service_occurrence_revisions','my_stuff_revisions_owner_select'],
    ['my_stuff_service_occurrences','my_stuff_occurrences_owner_select'],
    ['my_stuff_to_project_transfers','my_stuff_to_project_transfers_owner_select']
  ] loop
    v_table:=pair[1];v_policy:=pair[2];
    execute format('alter table public.%I enable row level security',v_table);
    execute format('create policy %I on public.%I for select to authenticated using(auth.uid()=user_id)',v_policy,v_table);
    execute format('grant select on public.%I to authenticated',v_table);
    execute format('grant select,insert,update,delete on public.%I to service_role',v_table);
  end loop;
end $$;
alter table public.my_stuff_to_project_expense_copies enable row level security;
grant select,insert,update,delete on public.my_stuff_to_project_expense_copies to service_role;
create policy my_stuff_schedules_owner_delete on public.my_stuff_schedules for delete to authenticated using(auth.uid()=user_id);
grant delete on public.my_stuff_schedules to authenticated;

create function public.get_my_stuff_due_state_v2(p_item_id uuid,p_as_of timestamptz default now())
returns table(definition_id uuid,next_due_at timestamptz,next_due_mileage numeric,next_due_hours numeric,next_due_cycles numeric,due_status text)
language sql stable security definer set search_path=public as $$
 select null::uuid,null::timestamptz,null::numeric,null::numeric,null::numeric,'ok'::text
$$;
create function public.get_my_stuff_due_views_v3(p_item_id uuid,p_as_of timestamptz default now()) returns jsonb language sql stable security definer set search_path=public as $$select '[]'::jsonb$$;
create function public.get_my_stuff_expenses_v3(p_item_id uuid)
returns table(expense_id uuid,source_type text,linked_occurrence_id uuid,voided_at timestamptz,revision_id uuid,revision_number integer,description text,category text,custom_category text,amount numeric,currency text,incurred_on date,vendor text,mileage numeric,hours numeric,notes text)
language sql stable security definer set search_path=public as $$
 select null::uuid,null::text,null::uuid,null::timestamptz,null::uuid,null::integer,null::text,null::text,null::text,null::numeric,null::text,null::date,null::text,null::numeric,null::numeric,null::text where false
$$;
create function public.get_my_stuff_financial_summary_v3(p_item_id uuid) returns jsonb language sql stable security definer set search_path=public as $$select '{}'::jsonb$$;
create function public.list_my_stuff_schedule_groups_v3(p_item_id uuid) returns jsonb language sql stable security definer set search_path=public as $$select '[]'::jsonb$$;
grant execute on function public.get_my_stuff_due_state_v2(uuid,timestamptz),public.get_my_stuff_due_views_v3(uuid,timestamptz),public.get_my_stuff_expenses_v3(uuid),public.get_my_stuff_financial_summary_v3(uuid),public.list_my_stuff_schedule_groups_v3(uuid) to authenticated,service_role;

insert into public.my_stuff_items(id,user_id,name,item_type,category,created_at) values
 ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001','Oldest','car','vehicle','2026-01-01Z'),
 ('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000001','Newest','truck','vehicle','2026-02-01Z'),
 ('00000000-0000-0000-0000-000000000021','00000000-0000-0000-0000-000000000002','Other user','tool','other','2026-01-15Z'),
 ('00000000-0000-0000-0000-000000000031','00000000-0000-0000-0000-000000000003','Transferred oldest','car','vehicle','2026-01-01Z'),
 ('00000000-0000-0000-0000-000000000032','00000000-0000-0000-0000-000000000003','Visible oldest','truck','vehicle','2026-02-01Z'),
 ('00000000-0000-0000-0000-000000000041','00000000-0000-0000-0000-000000000004','Transfer sequence','car','vehicle','2026-01-01Z');
insert into public.my_stuff_to_project_transfers(id,user_id,item_id) values
 ('20000000-0000-0000-0000-000000000031','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000031');
insert into public.my_stuff_schedules(id,user_id,item_id) values
 ('10000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011'),
 ('10000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000012');

\ir ../../supabase/migrations/20260909133000_enforce_my_stuff_downgrade_access.sql

create function public.test_security_definer_locked_update(p_item_id uuid)
returns void language sql security definer set search_path=public as $$
 update public.my_stuff_items set name='bypassed' where id=p_item_id
$$;
revoke all on function public.test_security_definer_locked_update(uuid) from public,anon;
grant execute on function public.test_security_definer_locked_update(uuid) to authenticated;

create function public.test_my_stuff_transfer_sequence(p_item_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid();v_transfer uuid:='20000000-0000-0000-0000-000000000041';
begin
 insert into public.my_stuff_to_project_transfers(id,user_id,item_id) values(v_transfer,v_user,p_item_id);
 insert into public.my_stuff_to_project_expense_copies(id,user_id,item_id) values('30000000-0000-0000-0000-000000000041',v_user,p_item_id);
 update public.my_stuff_items set archived_at=now() where id=p_item_id and user_id=v_user;
end $$;
revoke all on function public.test_my_stuff_transfer_sequence(uuid) from public,anon;
grant execute on function public.test_my_stuff_transfer_sequence(uuid) to authenticated;

set role authenticated;
set "request.jwt.claim.sub"='00000000-0000-0000-0000-000000000001';
do $$
declare v_count integer;v_changed integer;v_locked boolean;begin
 select count(*) into v_count from public.list_my_stuff_items_v4(true,false);
 if v_count<>2 then raise exception 'Free summary did not preserve two cards'; end if;
 select is_locked into v_locked from public.list_my_stuff_items_v4(true,false) where id='00000000-0000-0000-0000-000000000012';
 if v_locked is distinct from true then raise exception 'Newest card was not locked'; end if;
 select count(*) into v_count from public.my_stuff_items;
 if v_count<>1 then raise exception 'Free direct item detail did not retain exactly one row'; end if;
 if not exists(select 1 from public.my_stuff_items where id='00000000-0000-0000-0000-000000000011') then raise exception 'Oldest item was not retained'; end if;
 select count(*) into v_count from public.my_stuff_schedules;
 if v_count<>1 then raise exception 'Free child detail did not retain exactly one row'; end if;
 update public.my_stuff_items set name='blocked' where id='00000000-0000-0000-0000-000000000012';
 get diagnostics v_changed=row_count;
 if v_changed<>0 then raise exception 'Direct locked update unexpectedly succeeded'; end if;
 begin
   perform set_config('sideflip.my_stuff_transfer_item_id','00000000-0000-0000-0000-000000000012',true);
   perform public.test_security_definer_locked_update('00000000-0000-0000-0000-000000000012');
   raise exception 'Security-definer locked update unexpectedly succeeded';
 exception when others then
   if sqlerrm not like '%MY_STUFF_ITEM_LOCKED_PRO_REQUIRED%' then raise; end if;
 end;
 begin
   perform public.get_my_stuff_financial_summary_v3('00000000-0000-0000-0000-000000000012');
   raise exception 'Locked read RPC unexpectedly succeeded';
 exception when others then
   if sqlerrm not like '%MY_STUFF_ITEM_LOCKED_PRO_REQUIRED%' then raise; end if;
 end;
 if public.get_my_stuff_financial_summary_v3('00000000-0000-0000-0000-000000000011')<>'{}'::jsonb then raise exception 'Retained read RPC failed'; end if;
end $$;
reset role;

insert into public.test_pro_users values('00000000-0000-0000-0000-000000000001');
set role authenticated;
set "request.jwt.claim.sub"='00000000-0000-0000-0000-000000000001';
do $$declare v_count integer;v_locked integer;begin
 select count(*) into v_count from public.my_stuff_items;
 if v_count<>2 then raise exception 'Pro direct detail did not restore both rows'; end if;
 select count(*) into v_locked from public.list_my_stuff_items_v4(true,false) where is_locked;
 if v_locked<>0 then raise exception 'Pro summary retained locked rows'; end if;
 perform public.get_my_stuff_financial_summary_v3('00000000-0000-0000-0000-000000000012');
 perform public.test_security_definer_locked_update('00000000-0000-0000-0000-000000000012');
end $$;
reset role;

set role authenticated;
set "request.jwt.claim.sub"='00000000-0000-0000-0000-000000000002';
do $$declare v_count integer;begin
 select count(*) into v_count from public.my_stuff_items where user_id='00000000-0000-0000-0000-000000000001';
 if v_count<>0 then raise exception 'Cross-account rows were visible'; end if;
 select count(*) into v_count from public.list_my_stuff_items_v4(true,false);
 if v_count<>1 then raise exception 'Summary crossed account boundary'; end if;
end $$;
reset role;

set role authenticated;
set "request.jwt.claim.sub"='00000000-0000-0000-0000-000000000003';
do $$declare v_count integer;v_id uuid;v_locked boolean;begin
 select count(*) into v_count from public.list_my_stuff_items_v4(true,true);
 select id,is_locked into v_id,v_locked from public.list_my_stuff_items_v4(true,true) limit 1;
 if v_count<>1 or v_id<>'00000000-0000-0000-0000-000000000032' or v_locked then
   raise exception 'Oldest visible non-transferred item was not retained';
 end if;
 if not public.can_access_my_stuff_item_v1('00000000-0000-0000-0000-000000000032') then
   raise exception 'Visible oldest item was not accessible';
 end if;
 if public.can_access_my_stuff_item_v1('00000000-0000-0000-0000-000000000031') then
   raise exception 'Transferred oldest item remained the Free slot';
 end if;
end $$;
reset role;

set role authenticated;
set "request.jwt.claim.sub"='00000000-0000-0000-0000-000000000004';
select public.test_my_stuff_transfer_sequence('00000000-0000-0000-0000-000000000041');
reset role;
do $$begin
 if not exists(select 1 from public.my_stuff_to_project_transfers where item_id='00000000-0000-0000-0000-000000000041')
    or not exists(select 1 from public.my_stuff_to_project_expense_copies where item_id='00000000-0000-0000-0000-000000000041')
    or not exists(select 1 from public.my_stuff_items where id='00000000-0000-0000-0000-000000000041' and archived_at is not null) then
   raise exception 'Valid My Stuff transfer sequence did not complete atomically';
 end if;
end $$;

set role anon;
do $$begin
 begin
   perform public.list_my_stuff_items_v4(true,false);
   raise exception 'Anonymous summary call unexpectedly succeeded';
 exception when insufficient_privilege then null;
 end;
end $$;
reset role;

set role service_role;
do $$declare v_count integer;begin
 select count(*) into v_count from public.my_stuff_items where user_id='00000000-0000-0000-0000-000000000001';
 if v_count<>2 then raise exception 'Trusted service path lost access'; end if;
end $$;
reset role;

select 'my_stuff_downgrade_access_harness_passed' as result;
