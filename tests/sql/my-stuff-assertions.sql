create function public._test_assert(p_ok boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if p_ok is not true then
    raise exception 'assertion failed: %', p_message;
  end if;
end;
$$;

-- Fixed public contract: exact table columns, no accidental coupling to project/goal objects.
select public._test_assert(
  (select array_agg(column_name::text order by ordinal_position)
   from information_schema.columns
   where table_schema = 'public' and table_name = 'my_stuff_items') =
  array['id','user_id','name','category','acquired_on','notes','current_mileage','current_hours','client_mutation_id','created_at','updated_at'],
  'my_stuff_items column contract'
);
select public._test_assert(
  (select array_agg(column_name::text order by ordinal_position)
   from information_schema.columns
   where table_schema = 'public' and table_name = 'my_stuff_schedules') =
  array['id','user_id','item_id','name','tracking_type','interval_value','last_completed_at','last_completed_value','next_due_at','next_due_value','client_mutation_id','created_at','updated_at'],
  'my_stuff_schedules column contract'
);
select public._test_assert(
  (select array_agg(column_name::text order by ordinal_position)
   from information_schema.columns
   where table_schema = 'public' and table_name = 'my_stuff_service_logs') =
  array['id','user_id','item_id','schedule_id','name','completed_at','mileage','hours','cost','notes','client_mutation_id','created_at'],
  'my_stuff_service_logs column contract'
);
select public._test_assert(not exists (
  select 1
  from pg_constraint con
  join pg_class child on child.oid = con.conrelid
  join pg_class parent on parent.oid = con.confrelid
  join pg_namespace n on n.oid = child.relnamespace
  where con.contype = 'f' and n.nspname = 'public'
    and child.relname like 'my_stuff_%'
    and parent.relname in ('projects','expenses','trade_up_goals','goal_ledger')
), 'My Stuff has no project/expense/goal foreign keys');
select public._test_assert(not exists (
  select 1
  from public._my_stuff_legacy_object_snapshot s
  join pg_class c on c.oid = s.object_oid
  where s.signature is distinct from jsonb_build_object(
    'columns', (
      select jsonb_agg(jsonb_build_array(a.attname, a.atttypid, a.atttypmod, a.attnotnull, pg_get_expr(d.adbin, d.adrelid)) order by a.attnum)
      from pg_attribute a
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    ),
    'constraints', (
      select jsonb_agg(pg_get_constraintdef(con.oid, true) order by con.conname)
      from pg_constraint con where con.conrelid = c.oid
    ),
    'indexes', (
      select jsonb_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid)
      from pg_index i where i.indrelid = c.oid
    ),
    'triggers', (
      select jsonb_agg(pg_get_triggerdef(t.oid, true) order by t.tgname)
      from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal
    )
  )
), 'project/expense/goal objects unchanged');

select public._test_assert(
  has_function_privilege('authenticated', 'public.create_my_stuff_item(text,text,date,text,numeric,numeric,text)', 'execute')
  and has_function_privilege('authenticated', 'public.create_my_stuff_schedule(uuid,text,text,numeric,timestamptz,numeric,text)', 'execute')
  and has_function_privilege('authenticated', 'public.complete_my_stuff_maintenance(uuid,timestamptz,numeric,numeric,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.create_my_stuff_item(text,text,date,text,numeric,numeric,text)', 'execute')
  and not has_function_privilege('anon', 'public.create_my_stuff_schedule(uuid,text,text,numeric,timestamptz,numeric,text)', 'execute')
  and not has_function_privilege('anon', 'public.complete_my_stuff_maintenance(uuid,timestamptz,numeric,numeric,text,text)', 'execute'),
  'RPC grants are authenticated-only'
);
select public._test_assert(not exists (
  select 1 from pg_proc p,
  lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
  where p.oid in (
    'public.create_my_stuff_item(text,text,date,text,numeric,numeric,text)'::regprocedure,
    'public.create_my_stuff_schedule(uuid,text,text,numeric,timestamptz,numeric,text)'::regprocedure,
    'public.complete_my_stuff_maintenance(uuid,timestamptz,numeric,numeric,text,text)'::regprocedure,
    'public.set_my_stuff_updated_at()'::regprocedure,
    'public.enforce_my_stuff_item_limit()'::regprocedure,
    'public.enforce_my_stuff_item_readings()'::regprocedure,
    'public.enforce_my_stuff_schedule_owner()'::regprocedure,
    'public.enforce_my_stuff_log_owner()'::regprocedure
  ) and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
), 'PUBLIC cannot execute any My Stuff function');
select public._test_assert(
  not has_function_privilege('anon','public.set_my_stuff_updated_at()','execute')
  and not has_function_privilege('authenticated','public.set_my_stuff_updated_at()','execute')
  and not has_function_privilege('anon','public.enforce_my_stuff_item_limit()','execute')
  and not has_function_privilege('authenticated','public.enforce_my_stuff_item_limit()','execute')
  and not has_function_privilege('anon','public.enforce_my_stuff_item_readings()','execute')
  and not has_function_privilege('authenticated','public.enforce_my_stuff_item_readings()','execute')
  and not has_function_privilege('anon','public.enforce_my_stuff_schedule_owner()','execute')
  and not has_function_privilege('authenticated','public.enforce_my_stuff_schedule_owner()','execute')
  and not has_function_privilege('anon','public.enforce_my_stuff_log_owner()','execute')
  and not has_function_privilege('authenticated','public.enforce_my_stuff_log_owner()','execute'),
  'trigger functions are not client-executable'
);
select public._test_assert(not exists (
  select 1 from pg_class c,
  lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
  where c.oid in ('public.my_stuff_items'::regclass,'public.my_stuff_schedules'::regclass,'public.my_stuff_service_logs'::regclass)
    and acl.grantee in (0, (select oid from pg_roles where rolname='anon'))
), 'PUBLIC and anon have no My Stuff table privileges');
select public._test_assert(
  not has_table_privilege('authenticated','public.my_stuff_items','insert')
  and not has_table_privilege('authenticated','public.my_stuff_schedules','insert')
  and not has_table_privilege('authenticated','public.my_stuff_service_logs','insert'),
  'direct insert grants match contract'
);
select public._test_assert(
  has_column_privilege('authenticated','public.my_stuff_items','name','update')
  and has_column_privilege('authenticated','public.my_stuff_items','current_mileage','update')
  and not has_column_privilege('authenticated','public.my_stuff_items','user_id','update')
  and not has_column_privilege('authenticated','public.my_stuff_items','client_mutation_id','update')
  and not has_table_privilege('authenticated','public.my_stuff_schedules','update')
  and not has_table_privilege('authenticated','public.my_stuff_service_logs','update'),
  'authenticated updates are limited to editable item columns'
);
select public._test_assert(
  (select relrowsecurity from pg_class where oid='public.my_stuff_items'::regclass)
  and (select relrowsecurity from pg_class where oid='public.my_stuff_schedules'::regclass)
  and (select relrowsecurity from pg_class where oid='public.my_stuff_service_logs'::regclass),
  'RLS enabled on every My Stuff table'
);
select public._test_assert(
  pg_get_functiondef('public.create_my_stuff_item(text,text,date,text,numeric,numeric,text)'::regprocedure) like '%user_has_verified_pro_entitlement%'
  and pg_get_functiondef('public.create_my_stuff_item(text,text,date,text,numeric,numeric,text)'::regprocedure) like '%pg_advisory_xact_lock%',
  'item creation uses authoritative entitlement and advisory lock'
);
select public._test_assert(
  (select prosecdef and proconfig @> array['search_path=public'] from pg_proc where oid='public.create_my_stuff_item(text,text,date,text,numeric,numeric,text)'::regprocedure)
  and (select prosecdef and proconfig @> array['search_path=public'] from pg_proc where oid='public.create_my_stuff_schedule(uuid,text,text,numeric,timestamptz,numeric,text)'::regprocedure)
  and (select prosecdef and proconfig @> array['search_path=public'] from pg_proc where oid='public.complete_my_stuff_maintenance(uuid,timestamptz,numeric,numeric,text,text)'::regprocedure)
  and (select prosecdef and proconfig @> array['search_path=public'] from pg_proc where oid='public.enforce_my_stuff_item_limit()'::regprocedure)
  and (select prosecdef and proconfig @> array['search_path=public'] from pg_proc where oid='public.enforce_my_stuff_item_readings()'::regprocedure)
  and (select prosecdef and proconfig @> array['search_path=public'] from pg_proc where oid='public.enforce_my_stuff_schedule_owner()'::regprocedure)
  and (select prosecdef and proconfig @> array['search_path=public'] from pg_proc where oid='public.enforce_my_stuff_log_owner()'::regprocedure),
  'SECURITY DEFINER functions use fixed search_path'
);

set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);

do $$
declare first_id uuid; retry_id uuid;
begin
  first_id := public.create_my_stuff_item('Truck','vehicle','2024-01-02','daily driver',12000,50,'free-item-1');
  retry_id := public.create_my_stuff_item('ignored retry','other',null,null,0,0,'free-item-1');
  perform public._test_assert(first_id = retry_id, 'item mutation retry returns same id');
  perform public._test_assert((select count(*) from public.my_stuff_items) = 1, 'item mutation retry does not duplicate');

  begin
    perform public.create_my_stuff_item('Second','other',null,null,0,0,'free-item-2');
    raise exception 'expected Free item limit failure';
  exception when others then
    if sqlerrm = 'expected Free item limit failure' then raise; end if;
    perform public._test_assert(sqlerrm like 'Free accounts can have one My Stuff item%', 'Free item2 blocked by quota');
  end;

  begin
    insert into public.my_stuff_items(user_id,name,category,client_mutation_id)
    values(auth.uid(),'bypass','other','bypass');
    raise exception 'expected direct item insert denial';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.create_my_stuff_item('Infinite','other',null,null,'Infinity'::numeric,0,'invalid-infinity');
    raise exception 'expected finite validation';
  exception when others then
    if sqlerrm = 'expected finite validation' then raise; end if;
    perform public._test_assert(sqlerrm = 'Mileage must be finite and non-negative', 'infinite mileage rejected for the intended reason');
  end;

  begin
    perform public.create_my_stuff_item('Infinite date','other','infinity'::date,null,0,0,'invalid-date');
    raise exception 'expected finite acquisition date validation';
  exception when others then
    if sqlerrm = 'expected finite acquisition date validation' then raise; end if;
    perform public._test_assert(sqlerrm = 'Acquisition date must be between 1900-01-01 and 2200-12-31', 'infinite acquisition date rejected for the intended reason');
  end;
end;
$$;

do $$
declare item_id uuid; first_schedule uuid; retry_schedule uuid;
begin
  select id into item_id from public.my_stuff_items where client_mutation_id='free-item-1';
  first_schedule := public.create_my_stuff_schedule(item_id,'Oil','mileage',5000,null,12000,'schedule-oil');
  retry_schedule := public.create_my_stuff_schedule(item_id,'ignored retry','hours',10,null,0,'schedule-oil');
  perform public._test_assert(first_schedule=retry_schedule, 'schedule mutation retry returns same id');
  perform public._test_assert((select count(*) from public.my_stuff_schedules where client_mutation_id='schedule-oil')=1, 'schedule mutation retry does not duplicate');
  perform public.create_my_stuff_schedule(item_id,'Engine','hours',100,null,50,'schedule-engine');
  perform public.create_my_stuff_schedule(item_id,'Registration','calendar',30,'2026-08-02T00:00:00Z',null,'schedule-registration');
  perform public.create_my_stuff_schedule(item_id,'Boundary calendar','calendar',36500,'2100-01-01T00:00:00Z',null,'schedule-boundary');

  begin
    perform public.create_my_stuff_schedule(item_id,'Oversized calendar','calendar',36501,'2026-08-01T00:00:00Z',null,'schedule-oversized');
    raise exception 'expected calendar interval validation';
  exception when others then
    if sqlerrm = 'expected calendar interval validation' then raise; end if;
    perform public._test_assert(sqlerrm = 'Calendar interval must be a whole number from 1 to 36500 days', 'oversized calendar interval rejected for intended reason');
  end;

  begin
    insert into public.my_stuff_schedules(user_id,item_id,name,tracking_type,interval_value,next_due_value)
    values(auth.uid(),item_id,'direct bypass','mileage',10,10);
    raise exception 'expected direct schedule insert denial';
  exception when insufficient_privilege then null;
  end;
end;
$$;

do $$
declare mileage_id uuid; hours_id uuid; calendar_id uuid; boundary_id uuid; log_id uuid; retry_id uuid;
begin
  select id into mileage_id from public.my_stuff_schedules where name='Oil';
  select id into hours_id from public.my_stuff_schedules where name='Engine';
  select id into calendar_id from public.my_stuff_schedules where name='Registration';
  select id into boundary_id from public.my_stuff_schedules where name='Boundary calendar';

  log_id := public.complete_my_stuff_maintenance(mileage_id,'2026-08-24T10:00:00Z',18000,79.95,'oil change','maint-mileage-1');
  retry_id := public.complete_my_stuff_maintenance(mileage_id,'2026-08-24T10:00:00Z',18000,79.95,'oil change','maint-mileage-1');
  perform public._test_assert(log_id = retry_id, 'maintenance mutation retry returns same log');
  perform public._test_assert((select count(*) from public.my_stuff_service_logs where client_mutation_id='maint-mileage-1')=1, 'maintenance retry does not duplicate');
  perform public._test_assert((select next_due_value=23000 and last_completed_value=18000 from public.my_stuff_schedules where id=mileage_id), 'mileage schedule advances');
  perform public._test_assert((select mileage=18000 and hours is null and cost=79.95 from public.my_stuff_service_logs where id=log_id), 'mileage log values');
  perform public._test_assert((select current_mileage=18000 from public.my_stuff_items where client_mutation_id='free-item-1'), 'item mileage advances');

  begin
    perform public.complete_my_stuff_maintenance(mileage_id,'2025-08-24T10:00:00Z',18000,0,null,'maint-date-backwards');
    raise exception 'expected backwards completion date failure';
  exception when others then
    if sqlerrm = 'expected backwards completion date failure' then raise; end if;
    perform public._test_assert(sqlerrm = 'Completion date cannot move backwards', 'mileage completion date cannot rewind');
  end;

  perform public.complete_my_stuff_maintenance(hours_id,'2026-08-24T11:00:00Z',175,25,'service','maint-hours-1');
  perform public._test_assert((select next_due_value=275 and last_completed_value=175 from public.my_stuff_schedules where id=hours_id), 'hours schedule advances');
  perform public._test_assert((select current_hours=175 from public.my_stuff_items where client_mutation_id='free-item-1'), 'item hours advances');

  perform public.complete_my_stuff_maintenance(calendar_id,'2026-08-24T12:00:00Z',null,10,null,'maint-calendar-1');
  perform public._test_assert((select next_due_at='2026-09-23T12:00:00Z'::timestamptz and next_due_value is null from public.my_stuff_schedules where id=calendar_id), 'calendar schedule advances');

  begin
    perform public.complete_my_stuff_maintenance(mileage_id,now(),17000,1,null,'maint-backwards');
    raise exception 'expected backwards reading failure';
  exception when others then
    if sqlerrm = 'expected backwards reading failure' then raise; end if;
    perform public._test_assert(sqlerrm = 'Maintenance reading cannot move backwards', 'backwards reading rejected for intended reason');
  end;

  begin
    perform public.complete_my_stuff_maintenance(calendar_id,now(),1,1,null,'calendar-reading');
    raise exception 'expected calendar reading failure';
  exception when others then
    if sqlerrm = 'expected calendar reading failure' then raise; end if;
    perform public._test_assert(sqlerrm = 'Calendar maintenance does not accept a reading', 'calendar reading rejected for intended reason');
  end;

  begin
    perform public.complete_my_stuff_maintenance(calendar_id,'2026-08-23T12:00:00Z',null,1,null,'calendar-rewind');
    raise exception 'expected calendar rewind failure';
  exception when others then
    if sqlerrm = 'expected calendar rewind failure' then raise; end if;
    perform public._test_assert(sqlerrm = 'Completion date cannot move backwards', 'calendar rewind rejected for intended reason');
  end;

  begin
    perform public.complete_my_stuff_maintenance(calendar_id,'infinity'::timestamptz,null,1,null,'calendar-infinity');
    raise exception 'expected infinite completion date failure';
  exception when others then
    if sqlerrm = 'expected infinite completion date failure' then raise; end if;
    perform public._test_assert(sqlerrm = 'Completion date must be finite and between 1900 and 2200', 'infinite completion date rejected for intended reason');
  end;

  begin
    perform public.complete_my_stuff_maintenance(boundary_id,'2199-01-01T00:00:00Z',null,1,null,'calendar-overflow');
    raise exception 'expected calculated date range failure';
  exception when others then
    if sqlerrm = 'expected calculated date range failure' then raise; end if;
    perform public._test_assert(sqlerrm = 'Calculated next due date is outside the supported range', 'calculated calendar overflow rejected for intended reason');
  end;

  begin
    insert into public.my_stuff_service_logs(user_id,item_id,name,completed_at)
    select auth.uid(),id,'bypass',now() from public.my_stuff_items limit 1;
    raise exception 'expected direct log insert denial';
  exception when insufficient_privilege then null;
  end;
end;
$$;

do $$
begin
  update public.my_stuff_items set name='Truck updated' where client_mutation_id='free-item-1';
  perform public._test_assert((select name='Truck updated' from public.my_stuff_items where client_mutation_id='free-item-1'), 'editable item columns remain writable');

  begin
    update public.my_stuff_items set current_mileage=1 where client_mutation_id='free-item-1';
    raise exception 'expected direct mileage rewind failure';
  exception when others then
    if sqlerrm = 'expected direct mileage rewind failure' then raise; end if;
    perform public._test_assert(sqlerrm = 'Mileage cannot move backwards', 'direct item reading rewind blocked by trigger');
  end;

  begin
    update public.my_stuff_schedules set last_completed_value=1;
    raise exception 'expected protected schedule update denial';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.my_stuff_service_logs set completed_at='2020-01-01T00:00:00Z';
    raise exception 'expected protected log update denial';
  exception when insufficient_privilege then null;
  end;
end;
$$;

-- Cross-user RLS hides and blocks another owner's rows.
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public._test_assert((select count(*) from public.my_stuff_items)=0, 'cross-user item select hidden');
select public._test_assert((select count(*) from public.my_stuff_schedules)=0, 'cross-user schedule select hidden');
select public._test_assert((select count(*) from public.my_stuff_service_logs)=0, 'cross-user log select hidden');
do $$
begin
  update public.my_stuff_items set name='stolen';
  perform public._test_assert(not found, 'cross-user item update blocked');
  delete from public.my_stuff_schedules;
  perform public._test_assert(not found, 'cross-user schedule delete blocked');
end;
$$;

reset role;
insert into public.user_entitlements(user_id,source,status,expires_at,last_verified_at)
values('33333333-3333-4333-8333-333333333333','stripe','active',now()+interval '30 days',now());
set role authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);

do $$
begin
  perform public.create_my_stuff_item('Pro 1','other',null,null,0,0,'pro-1');
  perform public.create_my_stuff_item('Pro 2','other',null,null,0,0,'pro-2');
  perform public._test_assert((select count(*) from public.my_stuff_items)=2, 'authoritative Pro may create multiple items');
end;
$$;

reset role;
delete from public.user_entitlements where user_id='33333333-3333-4333-8333-333333333333';
set role authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);

-- Downgrade preserves and permits maintenance while gating only new item creation.
update public.my_stuff_items set notes='retained after downgrade' where client_mutation_id='pro-1';
select public.create_my_stuff_schedule(
  (select id from public.my_stuff_items where client_mutation_id='pro-1'),
  'Downgrade mileage','mileage',10,null,0,'downgrade-schedule'
);
select public.complete_my_stuff_maintenance(
  (select id from public.my_stuff_schedules where name='Downgrade mileage'),
  '2026-08-24T12:00:00Z',5,0,null,'downgrade-maintenance'
);
select public._test_assert((select count(*) from public.my_stuff_items)=2, 'downgrade retains items');
select public._test_assert((select count(*) from public.my_stuff_service_logs)=1, 'maintenance remains usable after downgrade');
select public._test_assert((select current_mileage=5 from public.my_stuff_items where client_mutation_id='pro-1'), 'reading maintenance remains writable after downgrade');
do $$
begin
  begin
    perform public.create_my_stuff_item('Pro 3 denied','other',null,null,0,0,'pro-3');
    raise exception 'expected downgraded quota failure';
  exception when others then
    if sqlerrm = 'expected downgraded quota failure' then raise; end if;
    perform public._test_assert(sqlerrm like 'Free accounts can have one My Stuff item%', 'downgraded quota rejected for intended reason');
  end;
end;
$$;

-- Deletion frees the Free slot (fresh Free account for deterministic proof).
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.create_my_stuff_item('Disposable','other',null,null,0,0,'delete-me');
delete from public.my_stuff_items where client_mutation_id='delete-me';
select public.create_my_stuff_item('After delete','other',null,null,0,0,'after-delete');
select public._test_assert((select count(*) from public.my_stuff_items)=1, 'deletion frees Free item slot');

-- Defensive child ownership triggers cannot be bypassed even by a privileged writer.
reset role;
do $$
declare user1_item uuid;
begin
  select id into user1_item from public.my_stuff_items where client_mutation_id='free-item-1';
  begin
    insert into public.my_stuff_schedules(user_id,item_id,name,tracking_type,interval_value,next_due_value)
    values('22222222-2222-4222-8222-222222222222',user1_item,'wrong owner','mileage',1,1);
    raise exception 'expected child ownership trigger failure';
  exception when others then
    if sqlerrm = 'expected child ownership trigger failure' then raise; end if;
    perform public._test_assert(sqlerrm = 'My Stuff item does not belong to this account', 'child ownership rejected for intended reason');
  end;
end;
$$;

-- Cascades remove item descendants and direct user-owned rows.
set role authenticated;
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',false);
select public.create_my_stuff_item('Cascade','other',null,null,0,0,'cascade-item');
select public.create_my_stuff_schedule(
  (select id from public.my_stuff_items where client_mutation_id='cascade-item'),
  'Cascade schedule','hours',10,null,0,'cascade-schedule'
);
select public.complete_my_stuff_maintenance((select id from public.my_stuff_schedules where name='Cascade schedule'),now(),5,0,null,'cascade-log');
reset role;
delete from auth.users where id='44444444-4444-4444-8444-444444444444';
select public._test_assert(not exists(select 1 from public.my_stuff_items where user_id='44444444-4444-4444-8444-444444444444'), 'account deletion cascades items');
select public._test_assert(not exists(select 1 from public.my_stuff_schedules where user_id='44444444-4444-4444-8444-444444444444'), 'account deletion cascades schedules');
select public._test_assert(not exists(select 1 from public.my_stuff_service_logs where user_id='44444444-4444-4444-8444-444444444444'), 'account deletion cascades logs');

drop function public._test_assert(boolean,text);
