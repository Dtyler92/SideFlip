-- LOCAL / UNAPPLIED. History facts are not schedule completions or live readings.
begin;
create table public.my_stuff_service_history (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 item_id uuid not null, definition_id uuid, expense_id uuid unique,
 created_at timestamptz not null default clock_timestamp(),
 unique(id,user_id,item_id),
 foreign key(item_id,user_id) references public.my_stuff_items(id,user_id) on delete cascade,
 foreign key(expense_id,user_id,item_id) references public.my_stuff_expenses(id,user_id,item_id)
);
create table public.my_stuff_service_history_revisions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 item_id uuid not null, history_id uuid not null, revision_number integer not null check(revision_number>0),
 service jsonb not null, details jsonb not null, expense jsonb, reason text not null,
 status text not null default 'pending_history_clarification' check(status='pending_history_clarification'),
 created_at timestamptz not null default clock_timestamp(), unique(history_id,revision_number),
 foreign key(history_id,user_id,item_id) references public.my_stuff_service_history(id,user_id,item_id) on delete cascade
);
alter table public.my_stuff_service_history enable row level security;
alter table public.my_stuff_service_history_revisions enable row level security;
revoke all on public.my_stuff_service_history,public.my_stuff_service_history_revisions from public,anon,authenticated;
grant select on public.my_stuff_service_history,public.my_stuff_service_history_revisions to authenticated;
create policy owner_read on public.my_stuff_service_history for select to authenticated using(user_id=(select auth.uid()));
create policy owner_read on public.my_stuff_service_history_revisions for select to authenticated using(user_id=(select auth.uid()));
create trigger history_revision_immutable before update or delete on public.my_stuff_service_history_revisions for each row execute function public.prevent_my_stuff_v2_immutable_update();
create function public.save_my_stuff_service_history_v1(p_item_id uuid,p_history_id uuid,p_definition_id uuid,p_service jsonb,p_expense jsonb,p_details jsonb,p_reason text,p_mutation_id text) returns jsonb
language plpgsql security definer set search_path=public,extensions as $$
declare u uuid:=auth.uid(); h text; old text; result jsonb; hid uuid; rid uuid; eid uuid; n integer; d timestamptz; k text; dims jsonb; old_expense jsonb;
begin
 if u is null then raise exception 'Authentication required'; end if;
 if nullif(trim(p_mutation_id),'') is null or length(p_mutation_id)>140 then raise exception 'Mutation ID required (max 140)'; end if;
 if nullif(trim(p_reason),'') is null or length(p_reason)>1000 then raise exception 'Reason required'; end if;
 if p_service is null or jsonb_typeof(p_service)<>'object' or pg_column_size(p_service)>32768 then raise exception 'Invalid service'; end if;
 if exists(select 1 from jsonb_object_keys(p_service) x where x not in ('service_name','completed_at','mileage','hours','cycles','notes')) then raise exception 'Unsupported service field'; end if;
 if jsonb_typeof(p_service->'service_name') is distinct from 'string' or length(trim(p_service->>'service_name')) not between 1 and 500 then raise exception 'Service name required'; end if;
 if p_service ? 'notes' and (jsonb_typeof(p_service->'notes') not in ('string','null') or length(p_service->>'notes')>20000) then raise exception 'Invalid notes'; end if;
 if p_service->>'completed_at' is not null then
  if jsonb_typeof(p_service->'completed_at')<>'string' then raise exception 'Invalid completion date'; end if;
  d:=(p_service->>'completed_at')::timestamptz;
  if not isfinite(d) or d<'1900-01-01Z' or d>now() then raise exception 'Invalid completion date'; end if;
 end if;
 if p_details is null or jsonb_typeof(p_details)<>'object' or pg_column_size(p_details)>8192 then raise exception 'Invalid service details'; end if;
 if exists(select 1 from jsonb_each(p_details) e where e.key not in ('oil_specification','oil_viscosity','oil_product') or jsonb_typeof(e.value) not in ('string','null') or length(e.value#>>'{}')>1000) then raise exception 'Unsupported service detail'; end if;
 if p_expense is not null then
  if jsonb_typeof(p_expense)<>'object' or pg_column_size(p_expense)>32768 then raise exception 'Invalid expense'; end if;
  if exists(select 1 from jsonb_object_keys(p_expense) x where x not in ('description','category','custom_category','amount','currency','incurred_on','vendor','mileage','hours','notes')) then raise exception 'Unsupported expense field'; end if;
  if jsonb_typeof(p_expense->'amount') is distinct from 'number' or (p_expense->>'amount')::numeric not between 0 and 1000000000 then raise exception 'Invalid expense amount'; end if;
  if p_expense->>'incurred_on' is not null and (not isfinite((p_expense->>'incurred_on')::date) or (p_expense->>'incurred_on')::date not between date '1900-01-01' and current_date) then raise exception 'Invalid expense date'; end if;
 end if;
 -- Match legacy item advisory lock before row locks to avoid inverted lock order.
 perform pg_advisory_xact_lock(hashtextextended(u::text||':item:'||p_item_id::text,0));
 select to_jsonb(usage_dimensions) into dims from public.my_stuff_items where id=p_item_id and user_id=u for update;
 if not found then raise exception 'My Stuff item not found'; end if;
 foreach k in array array['mileage','hours','cycles'] loop
  if p_service->>k is not null then
   if jsonb_typeof(p_service->k)<>'number' or (p_service->>k)::numeric not between 0 and 1000000000 then raise exception 'Invalid service reading'; end if;
   if not (dims ? k) then raise exception 'Unsupported usage dimension'; end if;
  end if;
 end loop;
 if p_definition_id is not null and not exists(select 1 from public.my_stuff_maintenance_definitions where id=p_definition_id and item_id=p_item_id and user_id=u) then raise exception 'Definition not found for item'; end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text||':history:'||trim(p_mutation_id),0));
 h:=encode(digest(jsonb_build_object('kind','provisional_history','item',p_item_id,'history',p_history_id,'definition',p_definition_id,'service',p_service,'expense',p_expense,'details',p_details,'reason',p_reason)::text,'sha256'),'hex');
 select request_hash,m.result into old,result from public.my_stuff_v3_mutations m where user_id=u and mutation_id=trim(p_mutation_id);
 if found then if old<>h then raise exception 'Idempotency key reused with different request'; end if; return result; end if;
 if p_history_id is null then
  insert into public.my_stuff_service_history(user_id,item_id,definition_id) values(u,p_item_id,p_definition_id) returning id into hid;
 else
  select id,expense_id into hid,eid from public.my_stuff_service_history where id=p_history_id and user_id=u and item_id=p_item_id and definition_id is not distinct from p_definition_id for update;
  if not found then raise exception 'History not found for item/definition'; end if;
 end if;
 select expense into old_expense from public.my_stuff_service_history_revisions where history_id=hid order by revision_number desc limit 1;
 if eid is not null and (p_expense is null or p_expense->>'incurred_on' is null) then raise exception 'Posted expense requires dated snapshot; void separately'; end if;
 if p_expense->>'incurred_on' is not null then
  if eid is null then
   eid:=private.create_my_stuff_expense_v3_trusted(u,p_item_id,p_expense,'manual',null,null,null,'history-expense:'||trim(p_mutation_id));
   update public.my_stuff_service_history set expense_id=eid where id=hid;
  elsif p_expense is distinct from old_expense then
   perform public.revise_my_stuff_expense_v3(eid,jsonb_build_object('description',p_expense->>'description','category',coalesce(p_expense->>'category','other'),'custom_category',null,'currency',coalesce(p_expense->>'currency','USD'),'vendor',null,'mileage',null,'hours',null,'notes',null)||p_expense,p_reason,'history-expense:'||trim(p_mutation_id));
  end if;
 end if;
 select coalesce(max(revision_number),0)+1 into n from public.my_stuff_service_history_revisions where history_id=hid;
 insert into public.my_stuff_service_history_revisions(user_id,item_id,history_id,revision_number,service,details,expense,reason)
 values(u,p_item_id,hid,n,jsonb_build_object('completed_at',null,'mileage',null,'hours',null,'cycles',null)||p_service,p_details,p_expense,trim(p_reason)) returning id into rid;
 result:=jsonb_build_object('history_id',hid,'revision_id',rid,'expense_id',eid,'status','pending_history_clarification','schedule_updated',false);
 insert into public.my_stuff_v3_mutations values(u,trim(p_mutation_id),'provisional_history',h,result,now());
 return result;
end $$;
revoke all on function public.save_my_stuff_service_history_v1(uuid,uuid,uuid,jsonb,jsonb,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.save_my_stuff_service_history_v1(uuid,uuid,uuid,jsonb,jsonb,jsonb,text,text) to authenticated;
commit;
