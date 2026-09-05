begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create or replace function public.enforce_free_active_project_limit()
returns trigger language plpgsql security definer set search_path=public,extensions as $$
begin
  if new.status <> 'active' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text,0));
  if not public.user_has_verified_pro_entitlement(new.user_id)
     and (select count(*) from public.projects p where p.user_id=new.user_id and p.status='active' and p.id<>new.id)>=6 then
    raise exception 'Free accounts can have up to 6 active projects. Mark a project sold or upgrade to SideFlip Pro.';
  end if;
  return new;
end $$;
revoke all on function public.enforce_free_active_project_limit() from public,anon,authenticated;
drop trigger if exists projects_free_active_limit on public.projects;
create trigger projects_free_active_limit before insert or update of status,user_id on public.projects
for each row execute function public.enforce_free_active_project_limit();

create table if not exists public.my_stuff_to_project_transfers(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null references public.my_stuff_items(id) on delete no action deferrable initially deferred,
  project_id uuid not null references public.projects(id) on delete no action deferrable initially deferred,
  item_snapshot jsonb not null,
  copied_fields text[] not null,
  client_mutation_id text not null,
  request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique(user_id,item_id),
  unique(user_id,project_id),
  unique(user_id,client_mutation_id),
  check(length(trim(client_mutation_id)) between 1 and 200),
  check(jsonb_typeof(item_snapshot)='object' and pg_column_size(item_snapshot)<=65536)
);

create table if not exists public.my_stuff_to_project_expense_copies(
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.my_stuff_to_project_transfers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null references public.my_stuff_items(id) on delete no action deferrable initially deferred,
  project_id uuid not null references public.projects(id) on delete no action deferrable initially deferred,
  source_expense_id uuid not null references public.my_stuff_expenses(id) on delete no action deferrable initially deferred,
  source_revision_id uuid not null references public.my_stuff_expense_revisions(id) on delete no action deferrable initially deferred,
  project_expense_id uuid references public.expenses(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(user_id,source_expense_id),
  unique(user_id,project_expense_id)
);

alter table public.my_stuff_to_project_transfers enable row level security;
drop policy if exists my_stuff_to_project_transfers_owner_select on public.my_stuff_to_project_transfers;
create policy my_stuff_to_project_transfers_owner_select on public.my_stuff_to_project_transfers
  for select to authenticated using((select auth.uid())=user_id);
create or replace trigger my_stuff_to_project_transfers_immutable
  before update on public.my_stuff_to_project_transfers
  for each row execute function public.prevent_my_stuff_v2_immutable_update();

alter table public.my_stuff_to_project_expense_copies enable row level security;

create or replace function public.guard_my_stuff_expense_after_archive()
returns trigger language plpgsql security definer set search_path=public,extensions as $$
declare
  v_user uuid:=coalesce(new.user_id,old.user_id);
  v_item uuid:=coalesce(new.item_id,old.item_id);
begin
  perform pg_advisory_xact_lock(hashtextextended(v_user::text||':item:'||v_item::text,0));
  if exists(select 1 from public.my_stuff_items i where i.id=v_item and i.user_id=v_user and i.archived_at is not null) then
    raise exception 'Restore this My Stuff item before changing its expenses';
  end if;
  return new;
end $$;
revoke all on function public.guard_my_stuff_expense_after_archive() from public,anon,authenticated;
drop trigger if exists my_stuff_expenses_archive_guard on public.my_stuff_expenses;
create trigger my_stuff_expenses_archive_guard before insert or update on public.my_stuff_expenses
for each row execute function public.guard_my_stuff_expense_after_archive();
drop trigger if exists my_stuff_expense_revisions_archive_guard on public.my_stuff_expense_revisions;
create trigger my_stuff_expense_revisions_archive_guard before insert on public.my_stuff_expense_revisions
for each row execute function public.guard_my_stuff_expense_after_archive();

create or replace function public.transfer_my_stuff_to_project_v1(p_item_id uuid,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public,extensions
as $$
declare
  v_user uuid:=auth.uid();
  v_item public.my_stuff_items%rowtype;
  v_project uuid;
  v_mutation_project uuid;
  v_request_hash text;
  v_item_snapshot jsonb;
  v_transfer uuid;
  v_project_expense uuid;
  v_exp record;
  v_category text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_item_id is null then raise exception 'Item required'; end if;
  if nullif(trim(p_mutation_id),'') is null or length(trim(p_mutation_id))>200 then raise exception 'Mutation ID required'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text||':transfer-mutation:'||trim(p_mutation_id),0));
  v_request_hash:=encode(digest(p_item_id::text,'sha256'),'hex');
  select project_id into v_mutation_project
    from public.my_stuff_to_project_transfers
    where user_id=v_user and client_mutation_id=trim(p_mutation_id);
  if v_mutation_project is not null then
    if exists(select 1 from public.my_stuff_to_project_transfers where user_id=v_user and client_mutation_id=trim(p_mutation_id) and request_hash=v_request_hash) then return v_mutation_project; end if;
    raise exception 'Mutation ID was already used with different transfer data';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text||':item:'||p_item_id::text,0));
  select * into v_item from public.my_stuff_items where id=p_item_id and user_id=v_user for update;
  if v_item.id is null then raise exception 'Item not found'; end if;

  select project_id into v_project from public.my_stuff_to_project_transfers where user_id=v_user and item_id=p_item_id;
  if v_project is not null then raise exception 'Item was already moved to Projects'; end if;
  if v_item.archived_at is not null then raise exception 'Restore this My Stuff item before moving it to Projects'; end if;
  if coalesce(v_item.purchase_currency,'USD') is distinct from 'USD' then raise exception 'Only USD items can be moved to Projects'; end if;
  if v_item.purchase_price is distinct from round(v_item.purchase_price,2) then raise exception 'Purchase price must use no more than two decimal places'; end if;
  if exists(
    select 1 from public.my_stuff_expenses e
    cross join lateral (
      select r.* from public.my_stuff_expense_revisions r
      where r.user_id=v_user and r.item_id=p_item_id and r.expense_id=e.id
      order by r.revision_number desc limit 1
    ) r
    where e.voided_at is null and e.user_id=v_user and e.item_id=p_item_id
      and (r.currency is distinct from 'USD' or r.amount is distinct from round(r.amount,2))
  ) then raise exception 'Every transferred expense must use USD and no more than two decimal places'; end if;

  v_category:=case
    when v_item.item_type in ('car','truck','motorcycle','atv','side_by_side','trailer','rv','boat','bicycle','watch','electronics','gaming','tool','exercise','instrument','furniture','house','mower') then v_item.item_type
    else 'other'
  end;

  insert into public.projects(
    user_id,title,category,status,purchase_price,photo,notes,model_number,serial_number,
    engine_model,engine_serial,vin,hull_number,vehicle_year,vehicle_make,vehicle_model,
    transmission,goal_funding_amount,out_of_pocket_amount,trade_credit_amount,trade_up_mutation_id
  ) values (
    v_user,trim(v_item.name),v_category,'active',coalesce(v_item.purchase_price,0),v_item.primary_photo_url,null,
    v_item.model_number,v_item.serial_number,v_item.engine_model,v_item.engine_serial,
    case when v_item.item_type in ('car','truck','motorcycle','atv','side_by_side','trailer','rv') then v_item.vin else null end,
    v_item.hull_number,v_item.model_year,coalesce(v_item.make,v_item.manufacturer),v_item.model,
    case when v_item.item_type in ('car','truck','motorcycle','atv','side_by_side','trailer','rv') then v_item.transmission else null end,
    0,0,0,'my-stuff-transfer:'||p_item_id::text
  ) returning id into v_project;

  v_item_snapshot:=jsonb_strip_nulls(jsonb_build_object(
    'id',v_item.id,'item_type',v_item.item_type,'category',v_item.category,
    'purchase_price',v_item.purchase_price,'purchase_currency',coalesce(v_item.purchase_currency,'USD')
  ));
  insert into public.my_stuff_to_project_transfers(
    user_id,item_id,project_id,item_snapshot,copied_fields,client_mutation_id,request_hash
  ) values (
    v_user,p_item_id,v_project,v_item_snapshot,
    array['name','item_type','category','purchase_price','purchase_currency','primary_photo_url','model_year','manufacturer','make','model','model_number','serial_number','engine_model','engine_serial','transmission','vin','hull_number','current_non_voided_expense_revisions'],
    trim(p_mutation_id),v_request_hash
  ) returning id into v_transfer;

  for v_exp in
    select e.id expense_id,r.id revision_id,e.created_at,r.description,r.amount,r.category,r.custom_category,r.incurred_on
    from public.my_stuff_expenses e
    cross join lateral (
      select r.* from public.my_stuff_expense_revisions r
      where r.user_id=v_user and r.item_id=p_item_id and r.expense_id=e.id
      order by r.revision_number desc limit 1
    ) r
    where e.voided_at is null and e.user_id=v_user and e.item_id=p_item_id
    order by e.created_at,e.id
  loop
    insert into public.expenses(project_id,user_id,description,amount,category,created_at)
    values(v_project,v_user,v_exp.description,v_exp.amount,
      case when v_exp.category='other' then coalesce(nullif(v_exp.custom_category,''),'other') else v_exp.category end,
      v_exp.incurred_on::timestamp at time zone 'UTC')
    returning id into v_project_expense;
    insert into public.my_stuff_to_project_expense_copies(
      transfer_id,user_id,item_id,project_id,source_expense_id,source_revision_id,project_expense_id
    ) values(v_transfer,v_user,p_item_id,v_project,v_exp.expense_id,v_exp.revision_id,v_project_expense);
  end loop;

  update public.my_stuff_items set archived_at=coalesce(archived_at,clock_timestamp()) where id=p_item_id and user_id=v_user;
  return v_project;
end;
$$;

revoke all on table public.my_stuff_to_project_transfers from public,anon,authenticated;
grant select on table public.my_stuff_to_project_transfers to authenticated;
revoke all on table public.my_stuff_to_project_expense_copies from public,anon,authenticated;
revoke all on function public.transfer_my_stuff_to_project_v1(uuid,text) from public,anon;
grant execute on function public.transfer_my_stuff_to_project_v1(uuid,text) to authenticated;

commit;
