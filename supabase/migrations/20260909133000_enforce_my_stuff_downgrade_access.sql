begin;

-- Free accounts retain access to exactly their deterministic oldest My Stuff
-- item. Newer items remain visible only through the summary-list RPC below.
do $$
declare
  v_name text;
begin
  if to_regprocedure('public.user_has_verified_pro_entitlement(uuid)') is null then
    raise exception 'Required authoritative entitlement helper is missing';
  end if;

  foreach v_name in array array[
    'my_stuff_items','my_stuff_attachments','my_stuff_definition_versions',
    'my_stuff_expense_audit','my_stuff_expense_revisions','my_stuff_expenses',
    'my_stuff_maintenance_definitions','my_stuff_occurrence_status_events',
    'my_stuff_planned_occurrences','my_stuff_project_transfers','my_stuff_readings',
    'my_stuff_schedules','my_stuff_service_audit','my_stuff_service_logs',
    'my_stuff_service_occurrence_revisions','my_stuff_service_occurrences',
    'my_stuff_to_project_expense_copies','my_stuff_to_project_transfers'
  ] loop
    if to_regclass('public.' || v_name) is null then
      raise exception 'Required table public.% is missing', v_name;
    end if;
  end loop;

  if to_regprocedure('public.get_my_stuff_due_state_v2(uuid,timestamp with time zone)') is null
     or to_regprocedure('public.get_my_stuff_due_views_v3(uuid,timestamp with time zone)') is null
     or to_regprocedure('public.get_my_stuff_expenses_v3(uuid)') is null
     or to_regprocedure('public.get_my_stuff_financial_summary_v3(uuid)') is null
     or to_regprocedure('public.list_my_stuff_schedule_groups_v3(uuid)') is null then
    raise exception 'Required My Stuff read RPC is missing';
  end if;

  if to_regprocedure('private.my_stuff_item_is_accessible_v1(uuid,uuid)') is not null
     or to_regclass('private.my_stuff_transfer_context_v1') is not null
     or to_regprocedure('private.assert_my_stuff_item_access_v1(uuid)') is not null
     or to_regprocedure('private.mark_my_stuff_transfer_transaction_v1()') is not null
     or to_regprocedure('private.guard_my_stuff_locked_mutation_v1()') is not null
     or to_regprocedure('public.can_access_my_stuff_item_v1(uuid)') is not null
     or to_regprocedure('public.list_my_stuff_items_v4(boolean,boolean)') is not null then
    raise exception 'My Stuff downgrade access migration is already partially installed';
  end if;
end $$;

create function private.my_stuff_item_is_accessible_v1(p_user_id uuid,p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path=public,private
as $$
  select p_user_id is not null
    and exists (
      select 1
      from public.my_stuff_items owned
      where owned.id=p_item_id
        and owned.user_id=p_user_id
        and (
          public.user_has_verified_pro_entitlement(p_user_id)
          or (
            not exists (
              select 1 from public.my_stuff_to_project_transfers moved
              where moved.user_id=p_user_id and moved.item_id=owned.id
            )
            and owned.id=(
              select oldest.id
              from public.my_stuff_items oldest
              where oldest.user_id=p_user_id
                and not exists (
                  select 1 from public.my_stuff_to_project_transfers moved
                  where moved.user_id=p_user_id and moved.item_id=oldest.id
                )
              order by oldest.created_at asc,oldest.id asc
              limit 1
            )
          )
        )
    )
$$;
revoke all on function private.my_stuff_item_is_accessible_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function private.my_stuff_item_is_accessible_v1(uuid,uuid) to service_role;

create function private.assert_my_stuff_item_access_v1(p_item_id uuid)
returns void
language plpgsql
stable
security definer
set search_path=public,private
as $$
declare
  v_user_id uuid:=auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if not private.my_stuff_item_is_accessible_v1(v_user_id,p_item_id) then
    raise exception 'MY_STUFF_ITEM_LOCKED_PRO_REQUIRED';
  end if;
end
$$;
revoke all on function private.assert_my_stuff_item_access_v1(uuid) from public,anon,authenticated;
grant execute on function private.assert_my_stuff_item_access_v1(uuid) to service_role;

create function public.can_access_my_stuff_item_v1(p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path=public,private
as $$
  select private.my_stuff_item_is_accessible_v1(auth.uid(),p_item_id)
$$;
revoke all on function public.can_access_my_stuff_item_v1(uuid) from public,anon;
grant execute on function public.can_access_my_stuff_item_v1(uuid) to authenticated,service_role;

create function public.list_my_stuff_items_v4(
  p_include_archived boolean default true,
  p_exclude_transferred boolean default false
)
returns table(
  id uuid,
  user_id uuid,
  name text,
  item_type text,
  custom_name text,
  category text,
  acquired_on date,
  usage_dimensions text[],
  current_mileage numeric,
  current_hours numeric,
  current_cycles numeric,
  effective_current_mileage numeric,
  effective_current_hours numeric,
  effective_current_cycles numeric,
  archived_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  is_locked boolean
)
language plpgsql
stable
security definer
set search_path=public,private
as $$
declare
  v_user_id uuid:=auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  return query
    select i.id,i.user_id,i.name,i.item_type,i.custom_name,i.category,i.acquired_on,
           i.usage_dimensions,i.current_mileage,i.current_hours,i.current_cycles,
           i.effective_current_mileage,i.effective_current_hours,i.effective_current_cycles,
           i.archived_at,i.created_at,i.updated_at,
           not private.my_stuff_item_is_accessible_v1(v_user_id,i.id) as is_locked
    from public.my_stuff_items i
    where i.user_id=v_user_id
      and (p_include_archived or i.archived_at is null)
      and (
        not p_exclude_transferred
        or not exists (
          select 1 from public.my_stuff_to_project_transfers transfer
          where transfer.user_id=v_user_id and transfer.item_id=i.id
        )
      )
    order by i.created_at asc,i.id asc;
end
$$;
revoke all on function public.list_my_stuff_items_v4(boolean,boolean) from public,anon;
grant execute on function public.list_my_stuff_items_v4(boolean,boolean) to authenticated,service_role;

-- Direct item reads and writes expose only the retained item to Free users.
drop policy my_stuff_items_owner_select on public.my_stuff_items;
create policy my_stuff_items_owner_select on public.my_stuff_items
for select to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(id));

drop policy my_stuff_items_owner_update on public.my_stuff_items;
create policy my_stuff_items_owner_update on public.my_stuff_items
for update to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(id))
with check ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(id));

drop policy my_stuff_items_owner_delete on public.my_stuff_items;
create policy my_stuff_items_owner_delete on public.my_stuff_items
for delete to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(id));

-- Child/history rows are details, not list-card summaries.
drop policy my_stuff_attachments_owner_select on public.my_stuff_attachments;
create policy my_stuff_attachments_owner_select on public.my_stuff_attachments for select to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(item_id));
drop policy my_stuff_definition_versions_owner_select on public.my_stuff_definition_versions;
create policy my_stuff_definition_versions_owner_select on public.my_stuff_definition_versions for select to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(item_id));
drop policy my_stuff_expense_audit_owner_select on public.my_stuff_expense_audit;
create policy my_stuff_expense_audit_owner_select on public.my_stuff_expense_audit for select to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(item_id));
drop policy my_stuff_expense_revisions_owner_select on public.my_stuff_expense_revisions;
create policy my_stuff_expense_revisions_owner_select on public.my_stuff_expense_revisions for select to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(item_id));
drop policy my_stuff_expenses_owner_select on public.my_stuff_expenses;
create policy my_stuff_expenses_owner_select on public.my_stuff_expenses for select to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(item_id));
drop policy my_stuff_definitions_owner_select on public.my_stuff_maintenance_definitions;
create policy my_stuff_definitions_owner_select on public.my_stuff_maintenance_definitions for select to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(item_id));
drop policy my_stuff_status_owner_select on public.my_stuff_occurrence_status_events;
create policy my_stuff_status_owner_select on public.my_stuff_occurrence_status_events for select to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(item_id));
drop policy my_stuff_planned_owner_select on public.my_stuff_planned_occurrences;
create policy my_stuff_planned_owner_select on public.my_stuff_planned_occurrences for select to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(item_id));
drop policy my_stuff_transfers_owner_select on public.my_stuff_project_transfers;
create policy my_stuff_transfers_owner_select on public.my_stuff_project_transfers for select to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(item_id));
drop policy my_stuff_readings_owner_select on public.my_stuff_readings;
create policy my_stuff_readings_owner_select on public.my_stuff_readings for select to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(item_id));
drop policy my_stuff_schedules_owner_select on public.my_stuff_schedules;
create policy my_stuff_schedules_owner_select on public.my_stuff_schedules for select to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(item_id));
drop policy my_stuff_audit_owner_select on public.my_stuff_service_audit;
create policy my_stuff_audit_owner_select on public.my_stuff_service_audit for select to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(item_id));
drop policy my_stuff_logs_owner_select on public.my_stuff_service_logs;
create policy my_stuff_logs_owner_select on public.my_stuff_service_logs for select to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(item_id));
drop policy my_stuff_revisions_owner_select on public.my_stuff_service_occurrence_revisions;
create policy my_stuff_revisions_owner_select on public.my_stuff_service_occurrence_revisions for select to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(item_id));
drop policy my_stuff_occurrences_owner_select on public.my_stuff_service_occurrences;
create policy my_stuff_occurrences_owner_select on public.my_stuff_service_occurrences for select to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(item_id));
drop policy my_stuff_to_project_transfers_owner_select on public.my_stuff_to_project_transfers;
create policy my_stuff_to_project_transfers_owner_select on public.my_stuff_to_project_transfers for select to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(item_id));

drop policy my_stuff_schedules_owner_delete on public.my_stuff_schedules;
create policy my_stuff_schedules_owner_delete on public.my_stuff_schedules
for delete to authenticated
using ((select auth.uid())=user_id and public.can_access_my_stuff_item_v1(item_id));

-- SECURITY DEFINER mutation RPCs bypass RLS, so enforce the same rule in triggers.
create table private.my_stuff_transfer_context_v1(
  backend_pid integer not null,
  transaction_id xid8 not null,
  user_id uuid not null,
  item_id uuid not null,
  created_at timestamptz not null default now(),
  primary key(backend_pid,transaction_id,user_id,item_id)
);
revoke all on table private.my_stuff_transfer_context_v1 from public,anon,authenticated,service_role;

create function private.mark_my_stuff_transfer_transaction_v1()
returns trigger
language plpgsql
security definer
set search_path=public,private
as $$
declare
  v_auth_user uuid:=auth.uid();
begin
  -- The transfer RPC writes its marker before expense copies and archival. Mark
  -- only an item that was accessible before this insert, and only for this
  -- transaction, so the remaining atomic transfer steps are not self-blocked.
  if v_auth_user is not null
     and new.user_id=v_auth_user
     and private.my_stuff_item_is_accessible_v1(v_auth_user,new.item_id) then
    insert into private.my_stuff_transfer_context_v1(backend_pid,transaction_id,user_id,item_id)
    values(pg_backend_pid(),pg_current_xact_id(),v_auth_user,new.item_id)
    on conflict do nothing;
  end if;
  return new;
end
$$;
revoke all on function private.mark_my_stuff_transfer_transaction_v1() from public,anon,authenticated;
grant execute on function private.mark_my_stuff_transfer_transaction_v1() to service_role;

create trigger my_stuff_transfer_transaction_context
before insert on public.my_stuff_to_project_transfers
for each row execute function private.mark_my_stuff_transfer_transaction_v1();

create function private.guard_my_stuff_locked_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path=public,private
as $$
declare
  v_user_id uuid;
  v_item_id uuid;
  v_auth_user uuid:=auth.uid();
  v_transfer_context boolean:=false;
begin
  if tg_op='DELETE' then
    v_user_id:=old.user_id;
  else
    v_user_id:=new.user_id;
  end if;

  if tg_table_name='my_stuff_items' then
    if tg_op='DELETE' then v_item_id:=old.id; else v_item_id:=new.id; end if;
  else
    if tg_op='DELETE' then v_item_id:=old.item_id; else v_item_id:=new.item_id; end if;
  end if;

  if v_auth_user is not null then
    select exists(
      select 1 from private.my_stuff_transfer_context_v1 context
      where context.backend_pid=pg_backend_pid()
        and context.transaction_id=pg_current_xact_id()
        and context.user_id=v_auth_user
        and context.item_id=v_item_id
    ) into v_transfer_context;
  end if;

  -- Trusted service/background operations have no end-user auth.uid().
  if v_auth_user is not null then
    if v_user_id is distinct from v_auth_user
       or (
         not v_transfer_context
         and not private.my_stuff_item_is_accessible_v1(v_auth_user,v_item_id)
       ) then
      raise exception 'MY_STUFF_ITEM_LOCKED_PRO_REQUIRED';
    end if;

    if v_transfer_context and tg_table_name='my_stuff_items' and tg_op='UPDATE' then
      delete from private.my_stuff_transfer_context_v1 context
      where context.backend_pid=pg_backend_pid()
        and context.transaction_id=pg_current_xact_id()
        and context.user_id=v_auth_user
        and context.item_id=v_item_id;
    end if;
  end if;

  if tg_op='DELETE' then return old; end if;
  return new;
end
$$;
revoke all on function private.guard_my_stuff_locked_mutation_v1() from public,anon,authenticated;
grant execute on function private.guard_my_stuff_locked_mutation_v1() to service_role;

create trigger my_stuff_locked_access_guard
before update or delete on public.my_stuff_items
for each row execute function private.guard_my_stuff_locked_mutation_v1();

create trigger my_stuff_locked_access_guard before insert or update on public.my_stuff_attachments for each row execute function private.guard_my_stuff_locked_mutation_v1();
create trigger my_stuff_locked_access_guard before insert on public.my_stuff_definition_versions for each row execute function private.guard_my_stuff_locked_mutation_v1();
create trigger my_stuff_locked_access_guard before insert on public.my_stuff_expense_audit for each row execute function private.guard_my_stuff_locked_mutation_v1();
create trigger my_stuff_locked_access_guard before insert on public.my_stuff_expense_revisions for each row execute function private.guard_my_stuff_locked_mutation_v1();
create trigger my_stuff_locked_access_guard before insert or update on public.my_stuff_expenses for each row execute function private.guard_my_stuff_locked_mutation_v1();
create trigger my_stuff_locked_access_guard before insert or update on public.my_stuff_maintenance_definitions for each row execute function private.guard_my_stuff_locked_mutation_v1();
create trigger my_stuff_locked_access_guard before insert on public.my_stuff_occurrence_status_events for each row execute function private.guard_my_stuff_locked_mutation_v1();
create trigger my_stuff_locked_access_guard before insert or update on public.my_stuff_planned_occurrences for each row execute function private.guard_my_stuff_locked_mutation_v1();
create trigger my_stuff_locked_access_guard before insert on public.my_stuff_project_transfers for each row execute function private.guard_my_stuff_locked_mutation_v1();
create trigger my_stuff_locked_access_guard before insert on public.my_stuff_readings for each row execute function private.guard_my_stuff_locked_mutation_v1();
create trigger my_stuff_locked_access_guard before insert or update on public.my_stuff_schedules for each row execute function private.guard_my_stuff_locked_mutation_v1();
create trigger my_stuff_locked_access_guard before insert on public.my_stuff_service_audit for each row execute function private.guard_my_stuff_locked_mutation_v1();
create trigger my_stuff_locked_access_guard before insert or update on public.my_stuff_service_logs for each row execute function private.guard_my_stuff_locked_mutation_v1();
create trigger my_stuff_locked_access_guard before insert on public.my_stuff_service_occurrence_revisions for each row execute function private.guard_my_stuff_locked_mutation_v1();
create trigger my_stuff_locked_access_guard before insert on public.my_stuff_service_occurrences for each row execute function private.guard_my_stuff_locked_mutation_v1();
create trigger my_stuff_locked_access_guard before insert on public.my_stuff_to_project_expense_copies for each row execute function private.guard_my_stuff_locked_mutation_v1();
create trigger my_stuff_locked_access_guard before insert on public.my_stuff_to_project_transfers for each row execute function private.guard_my_stuff_locked_mutation_v1();

-- Preserve exact live implementations under private names and expose guarded wrappers.
alter function public.get_my_stuff_due_state_v2(uuid,timestamptz) rename to get_my_stuff_due_state_v2_pre_access_20260909;
alter function public.get_my_stuff_due_state_v2_pre_access_20260909(uuid,timestamptz) set schema private;
revoke all on function private.get_my_stuff_due_state_v2_pre_access_20260909(uuid,timestamptz) from public,anon,authenticated,service_role;
create function public.get_my_stuff_due_state_v2(p_item_id uuid,p_as_of timestamptz default now())
returns table(definition_id uuid,next_due_at timestamptz,next_due_mileage numeric,next_due_hours numeric,next_due_cycles numeric,due_status text)
language plpgsql stable security definer set search_path=public,private as $$
begin
  perform private.assert_my_stuff_item_access_v1(p_item_id);
  return query select * from private.get_my_stuff_due_state_v2_pre_access_20260909(p_item_id,p_as_of);
end $$;

alter function public.get_my_stuff_due_views_v3(uuid,timestamptz) rename to get_my_stuff_due_views_v3_pre_access_20260909;
alter function public.get_my_stuff_due_views_v3_pre_access_20260909(uuid,timestamptz) set schema private;
revoke all on function private.get_my_stuff_due_views_v3_pre_access_20260909(uuid,timestamptz) from public,anon,authenticated,service_role;
create function public.get_my_stuff_due_views_v3(p_item_id uuid,p_as_of timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path=public,private as $$
begin
  perform private.assert_my_stuff_item_access_v1(p_item_id);
  return private.get_my_stuff_due_views_v3_pre_access_20260909(p_item_id,p_as_of);
end $$;

alter function public.get_my_stuff_expenses_v3(uuid) rename to get_my_stuff_expenses_v3_pre_access_20260909;
alter function public.get_my_stuff_expenses_v3_pre_access_20260909(uuid) set schema private;
revoke all on function private.get_my_stuff_expenses_v3_pre_access_20260909(uuid) from public,anon,authenticated,service_role;
create function public.get_my_stuff_expenses_v3(p_item_id uuid)
returns table(expense_id uuid,source_type text,linked_occurrence_id uuid,voided_at timestamptz,revision_id uuid,revision_number integer,description text,category text,custom_category text,amount numeric,currency text,incurred_on date,vendor text,mileage numeric,hours numeric,notes text)
language plpgsql stable security definer set search_path=public,private as $$
begin
  perform private.assert_my_stuff_item_access_v1(p_item_id);
  return query select * from private.get_my_stuff_expenses_v3_pre_access_20260909(p_item_id);
end $$;

alter function public.get_my_stuff_financial_summary_v3(uuid) rename to get_my_stuff_financial_summary_v3_pre_access_20260909;
alter function public.get_my_stuff_financial_summary_v3_pre_access_20260909(uuid) set schema private;
revoke all on function private.get_my_stuff_financial_summary_v3_pre_access_20260909(uuid) from public,anon,authenticated,service_role;
create function public.get_my_stuff_financial_summary_v3(p_item_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,private as $$
begin
  perform private.assert_my_stuff_item_access_v1(p_item_id);
  return private.get_my_stuff_financial_summary_v3_pre_access_20260909(p_item_id);
end $$;

alter function public.list_my_stuff_schedule_groups_v3(uuid) rename to list_my_stuff_schedule_groups_v3_pre_access_20260909;
alter function public.list_my_stuff_schedule_groups_v3_pre_access_20260909(uuid) set schema private;
revoke all on function private.list_my_stuff_schedule_groups_v3_pre_access_20260909(uuid) from public,anon,authenticated,service_role;
create function public.list_my_stuff_schedule_groups_v3(p_item_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,private as $$
begin
  perform private.assert_my_stuff_item_access_v1(p_item_id);
  return private.list_my_stuff_schedule_groups_v3_pre_access_20260909(p_item_id);
end $$;

revoke all on function public.get_my_stuff_due_state_v2(uuid,timestamptz),
  public.get_my_stuff_due_views_v3(uuid,timestamptz),
  public.get_my_stuff_expenses_v3(uuid),
  public.get_my_stuff_financial_summary_v3(uuid),
  public.list_my_stuff_schedule_groups_v3(uuid)
from public,anon;
grant execute on function public.get_my_stuff_due_state_v2(uuid,timestamptz),
  public.get_my_stuff_due_views_v3(uuid,timestamptz),
  public.get_my_stuff_expenses_v3(uuid),
  public.get_my_stuff_financial_summary_v3(uuid),
  public.list_my_stuff_schedule_groups_v3(uuid)
to authenticated,service_role;

commit;
