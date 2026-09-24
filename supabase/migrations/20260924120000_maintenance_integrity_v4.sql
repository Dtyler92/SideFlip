-- SideFlip Maintenance Integrity V4, phase 1 of 2.
-- REVIEW ONLY. Additive install; legacy clients remain fully operational.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';
create schema if not exists private;
revoke all on schema private from public,anon,authenticated;

-- Production cannot use or retain the deterministic test clock. The operator
-- runbook asserts this table is empty both before and after applying this file.
create table private.my_stuff_maintenance_test_clock_v4(
 singleton boolean primary key default true check(singleton),
 server_now timestamptz not null check(isfinite(server_now))
);
revoke all on private.my_stuff_maintenance_test_clock_v4 from public,anon,authenticated,service_role;
create function private.guard_my_stuff_test_clock_v4() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
 if current_database() !~ '^sideflip_maintenance_v4_[0-9]+$' then raise exception 'TEST_CLOCK_FORBIDDEN'; end if;
 return new;
end $$;
create trigger guard_my_stuff_test_clock_v4 before insert or update on private.my_stuff_maintenance_test_clock_v4
for each row execute function private.guard_my_stuff_test_clock_v4();
create function private.assert_my_stuff_test_clock_empty_v4() returns void
language plpgsql security definer set search_path=pg_catalog,private as $$
begin if exists(select 1 from private.my_stuff_maintenance_test_clock_v4) then raise exception 'TEST_CLOCK_MUST_BE_EMPTY'; end if; end $$;
revoke all on function private.guard_my_stuff_test_clock_v4(),private.assert_my_stuff_test_clock_empty_v4() from public,anon,authenticated,service_role;
create function private.my_stuff_server_now_v4() returns timestamptz
language plpgsql volatile security definer set search_path=pg_catalog,private as $$
declare t timestamptz;
begin
 select server_now into t from private.my_stuff_maintenance_test_clock_v4 where singleton;
 if t is not null and current_database() !~ '^sideflip_maintenance_v4_[0-9]+$' then raise exception 'TEST_CLOCK_FORBIDDEN'; end if;
 return coalesce(t,transaction_timestamp());
end $$;
revoke all on function private.my_stuff_server_now_v4() from public,anon,authenticated,service_role;

create table private.my_stuff_integrity_rollout_v4(
 singleton boolean primary key default true check(singleton),
 feature_enabled boolean not null default false,
 legacy_retired boolean not null default false,
 installed_at timestamptz not null default transaction_timestamp(),
 check(not legacy_retired or feature_enabled)
);
insert into private.my_stuff_integrity_rollout_v4(singleton) values(true);
revoke all on private.my_stuff_integrity_rollout_v4 from public,anon,authenticated,service_role;
create function public.get_my_stuff_integrity_rollout_v4() returns jsonb
language sql stable security definer set search_path=private as $$
 select jsonb_build_object('feature_enabled',feature_enabled,'legacy_retired',legacy_retired,
  'installed_at',installed_at,'readiness_enforceable',false)
 from private.my_stuff_integrity_rollout_v4 where singleton
$$;

create function private.assert_my_stuff_integrity_v4_enabled() returns void
language plpgsql stable security definer set search_path=private as $$
begin if not coalesce((select feature_enabled from private.my_stuff_integrity_rollout_v4 where singleton),false) then raise exception 'MAINTENANCE_V4_DISABLED'; end if; end $$;
revoke all on function private.assert_my_stuff_integrity_v4_enabled() from public,anon,authenticated,service_role;
revoke all on function public.get_my_stuff_integrity_rollout_v4() from public,anon,authenticated,service_role;
grant execute on function public.get_my_stuff_integrity_rollout_v4() to authenticated,service_role;

alter table public.my_stuff_service_occurrences
 add column received_at timestamptz,
 add column lock_deadline timestamptz,
 add column submitted_at timestamptz,
 add column device_now_telemetry timestamptz,
 add column integrity_version smallint,
 add column service_performed_on date,
 add column service_timezone text;
alter table public.my_stuff_service_occurrences add constraint my_stuff_occurrence_v4_clock check(
 (integrity_version is null and received_at is null and lock_deadline is null and submitted_at is null)
 or (integrity_version=4 and received_at is not null and submitted_at=received_at and lock_deadline=received_at+interval '24 hours')
) not valid;

alter table public.my_stuff_maintenance_definitions
 add column lifecycle_state text;
alter table public.my_stuff_maintenance_definitions add constraint my_stuff_definition_lifecycle_v4
 check(lifecycle_state is null or lifecycle_state in ('active','archived_legacy','legacy_duplicate')) not valid;

create table public.my_stuff_maintenance_baselines(
 definition_id uuid primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 item_id uuid not null,
 last_service_performed_on date,
 last_service_mileage numeric,last_service_hours numeric,last_service_cycles numeric,
 setup_received_at timestamptz not null,device_now_telemetry timestamptz not null,
 client_mutation_id text not null,request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 unique(user_id,client_mutation_id),
 foreign key(definition_id,user_id,item_id) references public.my_stuff_maintenance_definitions(id,user_id,item_id) on delete cascade,
 check(last_service_performed_on is null or (isfinite(last_service_performed_on) and last_service_performed_on between date '1900-01-01' and date '2200-12-31')),
 check((last_service_mileage is null or last_service_mileage between 0 and 1000000000) and
       (last_service_hours is null or last_service_hours between 0 and 1000000000) and
       (last_service_cycles is null or last_service_cycles between 0 and 1000000000))
);
create table public.my_stuff_completion_corrections(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 item_id uuid not null,occurrence_id uuid not null,correction_number integer not null check(correction_number>0),
 correction_type text not null check(correction_type in ('window_edit','later_correction')),
 service_snapshot jsonb not null check(jsonb_typeof(service_snapshot)='object' and pg_column_size(service_snapshot)<=262144),
 snapshot_sha256 text not null check(snapshot_sha256~'^[0-9a-f]{64}$'),
 reason text,received_at timestamptz not null,device_now_telemetry timestamptz not null,
 client_mutation_id text not null,request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 unique(occurrence_id,correction_number),unique(user_id,client_mutation_id),
 foreign key(occurrence_id,user_id,item_id) references public.my_stuff_service_occurrences(id,user_id,item_id) on delete cascade,
 check((correction_type='window_edit' and length(coalesce(reason,''))<=2000) or
       (correction_type='later_correction' and length(trim(reason)) between 1 and 2000))
);
create index my_stuff_completion_corrections_chain_v4 on public.my_stuff_completion_corrections(user_id,occurrence_id,correction_number);

create function private.prevent_my_stuff_v4_immutable_update() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin if tg_op='DELETE' and pg_trigger_depth()>1 then return old; end if; raise exception '% rows are immutable; append a correction',tg_table_name; end $$;
revoke all on function private.prevent_my_stuff_v4_immutable_update() from public,anon,authenticated,service_role;
create trigger baselines_immutable_v4 before update or delete on public.my_stuff_maintenance_baselines for each row execute function private.prevent_my_stuff_v4_immutable_update();
create trigger corrections_immutable_v4 before update or delete on public.my_stuff_completion_corrections for each row execute function private.prevent_my_stuff_v4_immutable_update();


create function private.assert_my_stuff_device_clock_v4(p_device_now timestamptz,v_now timestamptz) returns void
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if p_device_now is null or not isfinite(p_device_now) then raise exception 'DEVICE_CLOCK_REQUIRED'; end if;
 if abs(extract(epoch from (p_device_now-v_now)))>300 then raise exception 'DEVICE_CLOCK_SKEW'; end if;
end $$;
revoke all on function private.assert_my_stuff_device_clock_v4(timestamptz,timestamptz) from public,anon,authenticated,service_role;

create function private.my_stuff_original_snapshot_v4(p_occurrence_id uuid) returns jsonb
language sql stable security definer set search_path=public as $$
 select jsonb_strip_nulls(jsonb_build_object(
  'service_performed_on',coalesce(o.service_performed_on,(o.completed_at at time zone 'UTC')::date),'service_timezone',o.service_timezone,'service_mileage',o.mileage,'service_hours',o.hours,'service_cycles',o.cycles,
  'current_mileage',o.provenance->'current_mileage','current_hours',o.provenance->'current_hours','current_cycles',o.provenance->'current_cycles',
  'notes',r.notes,'parts',r.parts,'labor',r.labor,'vendor',r.vendor,'warranty',r.warranty,'attachment_metadata',r.attachment_metadata))
 from public.my_stuff_service_occurrences o
 left join lateral(select x.* from public.my_stuff_service_occurrence_revisions x where x.occurrence_id=o.id order by x.revision_number limit 1) r on true
 where o.id=p_occurrence_id
$$;
create function private.my_stuff_effective_snapshot_v4(p_occurrence_id uuid) returns jsonb
language sql stable security definer set search_path=public,private as $$
 select coalesce((select c.service_snapshot from public.my_stuff_completion_corrections c where c.occurrence_id=p_occurrence_id order by c.correction_number desc limit 1),private.my_stuff_original_snapshot_v4(p_occurrence_id))
$$;
create function private.my_stuff_report_snapshot_v4(p_snapshot jsonb) returns jsonb
language sql immutable security definer set search_path=pg_catalog as $$
 select coalesce(p_snapshot,'{}'::jsonb)-'attachment_metadata'-'storage_path'-'path'-'url'
$$;
revoke all on function private.my_stuff_original_snapshot_v4(uuid),private.my_stuff_effective_snapshot_v4(uuid),private.my_stuff_report_snapshot_v4(jsonb) from public,anon,authenticated,service_role;

create function public.get_my_stuff_maintenance_state_v4(p_definition_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public,private as $$
declare d public.my_stuff_maintenance_definitions%rowtype; i public.my_stuff_items%rowtype; b public.my_stuff_maintenance_baselines%rowtype;
 o public.my_stuff_service_occurrences%rowtype; s jsonb; base_date date; bm numeric; bh numeric; bc numeric;
 im numeric; ih numeric; ic numeric; months integer; nd date; nm numeric; nh numeric; nc numeric; status text; as_of_date date:=private.my_stuff_server_now_v4()::date;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if; perform private.assert_my_stuff_integrity_v4_enabled();
 select * into d from public.my_stuff_maintenance_definitions where id=p_definition_id and user_id=auth.uid() and enabled and coalesce(lifecycle_state,'active')='active';
 if not found then raise exception 'Maintenance definition not found'; end if;
 select * into i from public.my_stuff_items where id=d.item_id and user_id=d.user_id;
 select * into b from public.my_stuff_maintenance_baselines where definition_id=d.id;
 select * into o from public.my_stuff_service_occurrences x where x.definition_id=d.id
  order by coalesce(x.received_at,x.created_at) desc,x.created_at desc,x.id desc limit 1;
 if o.id is not null then s:=private.my_stuff_effective_snapshot_v4(o.id); end if;
 if d.cadence_anchor='asset_origin' then
  base_date:=coalesce(i.in_service_on,i.acquired_on,i.created_at::date); bm:=i.origin_mileage; bh:=i.origin_hours; bc:=i.origin_cycles;
 elsif o.id is not null then
  -- Once a completion exists, no stale setup baseline may fill a missing field.
  base_date:=nullif(s->>'service_performed_on','')::date; bm:=nullif(s->>'service_mileage','')::numeric;
  bh:=nullif(s->>'service_hours','')::numeric; bc:=nullif(s->>'service_cycles','')::numeric;
 else
  base_date:=coalesce(b.last_service_performed_on,i.in_service_on,i.acquired_on,i.created_at::date);
  bm:=coalesce(b.last_service_mileage,i.origin_mileage); bh:=coalesce(b.last_service_hours,i.origin_hours); bc:=coalesce(b.last_service_cycles,i.origin_cycles);
 end if;
 im:=case when o.id is null and d.first_interval_miles is not null then d.first_interval_miles when d.active_profile='severe' then coalesce(d.severe_interval_miles,d.normal_interval_miles) else d.normal_interval_miles end;
 ih:=case when o.id is null and d.first_interval_hours is not null then d.first_interval_hours when d.active_profile='severe' then coalesce(d.severe_interval_hours,d.normal_interval_hours) else d.normal_interval_hours end;
 ic:=case when o.id is null and d.first_interval_cycles is not null then d.first_interval_cycles when d.active_profile='severe' then coalesce(d.severe_interval_cycles,d.normal_interval_cycles) else d.normal_interval_cycles end;
 months:=case when o.id is null and d.first_calendar_months is not null then d.first_calendar_months when d.active_profile='severe' then coalesce(d.severe_calendar_months,d.normal_calendar_months) else d.normal_calendar_months end;
 nd:=case when base_date is null or months is null then null else base_date+make_interval(months=>months) end;
 nm:=case when bm is null or im is null then null else bm+im end; nh:=case when bh is null or ih is null then null else bh+ih end; nc:=case when bc is null or ic is null then null else bc+ic end;
 if months is null and im is null and ih is null and ic is null then status:='upcoming';
 elsif (im is not null and (nm is null or coalesce(i.effective_current_mileage,i.current_mileage) is null)) or
    (ih is not null and (nh is null or coalesce(i.effective_current_hours,i.current_hours) is null)) or
    (ic is not null and (nc is null or coalesce(i.effective_current_cycles,i.current_cycles) is null)) then status:='needs_usage_update';
 elsif d.due_semantics='all' then
  if (months is null or as_of_date>nd) and (im is null or coalesce(i.effective_current_mileage,i.current_mileage)>nm) and (ih is null or coalesce(i.effective_current_hours,i.current_hours)>nh) and (ic is null or coalesce(i.effective_current_cycles,i.current_cycles)>nc) then status:='overdue';
  elsif (months is null or as_of_date>=nd) and (im is null or coalesce(i.effective_current_mileage,i.current_mileage)>=nm) and (ih is null or coalesce(i.effective_current_hours,i.current_hours)>=nh) and (ic is null or coalesce(i.effective_current_cycles,i.current_cycles)>=nc) then status:='due_now';
  elsif (months is null or nd<=as_of_date+d.due_soon_days) and (im is null or nm-coalesce(i.effective_current_mileage,i.current_mileage)<=d.due_soon_miles) and (ih is null or nh-coalesce(i.effective_current_hours,i.current_hours)<=d.due_soon_hours) and (ic is null or nc-coalesce(i.effective_current_cycles,i.current_cycles)<=d.due_soon_cycles) then status:='due_soon'; else status:='upcoming'; end if;
 else
  if (months is not null and as_of_date>nd) or (im is not null and coalesce(i.effective_current_mileage,i.current_mileage)>nm) or (ih is not null and coalesce(i.effective_current_hours,i.current_hours)>nh) or (ic is not null and coalesce(i.effective_current_cycles,i.current_cycles)>nc) then status:='overdue';
  elsif (months is not null and as_of_date>=nd) or (im is not null and coalesce(i.effective_current_mileage,i.current_mileage)>=nm) or (ih is not null and coalesce(i.effective_current_hours,i.current_hours)>=nh) or (ic is not null and coalesce(i.effective_current_cycles,i.current_cycles)>=nc) then status:='due_now';
  elsif (months is not null and nd<=as_of_date+d.due_soon_days) or (im is not null and nm-coalesce(i.effective_current_mileage,i.current_mileage)<=d.due_soon_miles) or (ih is not null and nh-coalesce(i.effective_current_hours,i.current_hours)<=d.due_soon_hours) or (ic is not null and nc-coalesce(i.effective_current_cycles,i.current_cycles)<=d.due_soon_cycles) then status:='due_soon'; else status:='upcoming'; end if;
 end if;
 return jsonb_build_object('definition_id',d.id,'item_id',d.item_id,'lifecycle_state',d.lifecycle_state,'due_semantics',d.due_semantics,'active_profile',d.active_profile,
  'last_service_performed_on',base_date,'last_service_mileage',bm,'last_service_hours',bh,'last_service_cycles',bc,
  'current_mileage',coalesce(i.effective_current_mileage,i.current_mileage),'current_hours',coalesce(i.effective_current_hours,i.current_hours),'current_cycles',coalesce(i.effective_current_cycles,i.current_cycles),
  'next_due_date',nd,'next_due_mileage',nm,'next_due_hours',nh,'next_due_cycles',nc,'due_status',status);
end $$;

create function public.record_my_stuff_current_mileage_v4(p_item_id uuid,p_current_mileage numeric,p_device_now timestamptz,p_mutation_id text) returns jsonb
language plpgsql security definer set search_path=public,private,extensions as $$
declare u uuid:=auth.uid(); t timestamptz:=private.my_stuff_server_now_v4(); old_value numeric; rid uuid; h text; prior text; result jsonb;
begin
 if u is null then raise exception 'Authentication required'; end if; perform private.assert_my_stuff_integrity_v4_enabled();
 if p_current_mileage is null or p_current_mileage not between 0 and 1000000000 then raise exception 'INVALID_CURRENT_MILEAGE'; end if;
 if length(trim(coalesce(p_mutation_id,''))) not between 1 and 180 then raise exception 'Mutation ID required'; end if;
 h:=encode(digest(jsonb_build_object('kind','current_mileage_v4','item',p_item_id,'mileage',p_current_mileage)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(u::text||':item:'||p_item_id::text,0));
 select request_hash,m.result into prior,result from public.my_stuff_v3_mutations m where user_id=u and mutation_id=trim(p_mutation_id);
 if found then if prior<>h then raise exception 'Idempotency key reused with different request'; end if; return result; end if;
 perform private.assert_my_stuff_device_clock_v4(p_device_now,t);
 select coalesce(effective_current_mileage,current_mileage) into old_value from public.my_stuff_items where id=p_item_id and user_id=u for update;
 if not found then raise exception 'My Stuff item not found'; end if; if old_value is not null and p_current_mileage<old_value then raise exception 'CURRENT_MILEAGE_CANNOT_DECREASE'; end if;
 insert into public.my_stuff_readings(user_id,item_id,reading_type,reading_value,recorded_at,source,metadata,client_mutation_id)
 values(u,p_item_id,'mileage',p_current_mileage,t,'manual',jsonb_build_object('device_now',p_device_now,'server_received_at',t),'v4-mileage:'||trim(p_mutation_id)) returning id into rid;
 update public.my_stuff_items set current_mileage=p_current_mileage,effective_current_mileage=p_current_mileage where id=p_item_id;
 result:=jsonb_build_object('item_id',p_item_id,'reading_id',rid,'current_mileage',p_current_mileage,'received_at',t);
 insert into public.my_stuff_v3_mutations values(u,trim(p_mutation_id),'current_mileage_v4',h,result,t); return result;
end $$;

create function public.record_my_stuff_current_reading_v4(p_item_id uuid,p_reading_type text,p_current_value numeric,p_device_now timestamptz,p_mutation_id text) returns jsonb
language plpgsql security definer set search_path=public,private,extensions as $$
declare u uuid:=auth.uid(); t timestamptz:=private.my_stuff_server_now_v4(); old_value numeric; dims text[]; rid uuid; h text; prior text; result jsonb; kind text:=lower(trim(coalesce(p_reading_type,'')));
begin
 if u is null then raise exception 'Authentication required'; end if; perform private.assert_my_stuff_integrity_v4_enabled();
 if kind not in ('mileage','hours','cycles') then raise exception 'INVALID_READING_TYPE'; end if;
 if p_current_value is null or p_current_value not between 0 and 1000000000 then raise exception 'INVALID_CURRENT_READING'; end if;
 if length(trim(coalesce(p_mutation_id,''))) not between 1 and 180 then raise exception 'Mutation ID required'; end if;
 h:=encode(digest(jsonb_build_object('kind','current_reading_v4','item',p_item_id,'reading_type',kind,'value',p_current_value)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(u::text||':item:'||p_item_id::text,0));
 select request_hash,m.result into prior,result from public.my_stuff_v3_mutations m where user_id=u and mutation_id=trim(p_mutation_id);
 if found then if prior<>h then raise exception 'Idempotency key reused with different request'; end if; return result; end if;
 perform private.assert_my_stuff_device_clock_v4(p_device_now,t);
 select case kind when 'mileage' then coalesce(effective_current_mileage,current_mileage) when 'hours' then coalesce(effective_current_hours,current_hours) else coalesce(effective_current_cycles,current_cycles) end,usage_dimensions
 into old_value,dims from public.my_stuff_items where id=p_item_id and user_id=u for update;
 if not found then raise exception 'My Stuff item not found'; end if;
 if not kind=any(dims) then raise exception 'READING_TYPE_NOT_TRACKED'; end if;
 if old_value is not null and p_current_value<old_value then raise exception 'CURRENT_READING_CANNOT_DECREASE'; end if;
 insert into public.my_stuff_readings(user_id,item_id,reading_type,reading_value,recorded_at,source,metadata,client_mutation_id)
 values(u,p_item_id,kind,p_current_value,t,'manual',jsonb_build_object('device_now',p_device_now,'server_received_at',t),'v4-reading:'||trim(p_mutation_id)) returning id into rid;
 update public.my_stuff_items set
  current_mileage=case when kind='mileage' then p_current_value else current_mileage end,
  effective_current_mileage=case when kind='mileage' then p_current_value else effective_current_mileage end,
  current_hours=case when kind='hours' then p_current_value else current_hours end,
  effective_current_hours=case when kind='hours' then p_current_value else effective_current_hours end,
  current_cycles=case when kind='cycles' then p_current_value else current_cycles end,
  effective_current_cycles=case when kind='cycles' then p_current_value else effective_current_cycles end
 where id=p_item_id;
 result:=jsonb_build_object('item_id',p_item_id,'reading_id',rid,'reading_type',kind,'current_value',p_current_value,'received_at',t);
 insert into public.my_stuff_v3_mutations values(u,trim(p_mutation_id),'current_reading_v4',h,result,t); return result;
end $$;

create function public.setup_my_stuff_maintenance_preset_v4(p_item_id uuid,p_definition jsonb,p_setup jsonb,p_device_now timestamptz,p_mutation_id text) returns jsonb
language plpgsql security definer set search_path=public,private,extensions as $$
declare u uuid:=auth.uid(); t timestamptz:=private.my_stuff_server_now_v4(); h text; prior text; result jsonb; did uuid; existing uuid;
 sd date; sm numeric; sh numeric; sc numeric; cm numeric; normalized_name text; action text;
begin
 if u is null then raise exception 'Authentication required'; end if; perform private.assert_my_stuff_integrity_v4_enabled();
 if jsonb_typeof(p_definition)<>'object' or jsonb_typeof(p_setup)<>'object' then raise exception 'INVALID_PRESET_SETUP'; end if;
 if exists(select 1 from jsonb_object_keys(p_setup) k where k not in ('last_service_performed_on','last_service_mileage','last_service_hours','last_service_cycles','current_mileage')) then raise exception 'INVALID_PRESET_SETUP'; end if;
 sd:=nullif(p_setup->>'last_service_performed_on','')::date; sm:=nullif(p_setup->>'last_service_mileage','')::numeric; sh:=nullif(p_setup->>'last_service_hours','')::numeric; sc:=nullif(p_setup->>'last_service_cycles','')::numeric; cm:=nullif(p_setup->>'current_mileage','')::numeric;
 if sd is not null and (not isfinite(sd) or sd>t::date or sd<date '1900-01-01') then raise exception 'INVALID_SERVICE_PERFORMED_DATE'; end if;
 if sm is not null and sm not between 0 and 1000000000 then raise exception 'INVALID_LAST_SERVICE_MILEAGE'; end if;
 if sh is not null and sh not between 0 and 1000000000 then raise exception 'INVALID_LAST_SERVICE_HOURS'; end if;
 if sc is not null and sc not between 0 and 1000000000 then raise exception 'INVALID_LAST_SERVICE_CYCLES'; end if;
 if cm is not null and cm not between 0 and 1000000000 then raise exception 'INVALID_CURRENT_MILEAGE'; end if;
 if sm is not null and cm is not null and sm>cm then raise exception 'LAST_SERVICE_MILEAGE_EXCEEDS_CURRENT'; end if;
 normalized_name:=lower(regexp_replace(trim(p_definition->>'name'),'[[:space:]]+',' ','g')); action:=coalesce(p_definition->>'service_action','service');
 if normalized_name='' or length(trim(coalesce(p_mutation_id,''))) not between 1 and 160 then raise exception 'INVALID_PRESET_SETUP'; end if;
 h:=encode(digest(jsonb_build_object('kind','preset_setup_v4','item',p_item_id,'definition',p_definition,'setup',p_setup)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(u::text||':item:'||p_item_id::text,0));
 select request_hash,m.result into prior,result from public.my_stuff_v3_mutations m where user_id=u and mutation_id=trim(p_mutation_id);
 if found then if prior<>h then raise exception 'Idempotency key reused with different request'; end if; return result; end if;
 perform private.assert_my_stuff_device_clock_v4(p_device_now,t);
 perform 1 from public.my_stuff_items where id=p_item_id and user_id=u for update; if not found then raise exception 'My Stuff item not found'; end if;
 select id into existing from public.my_stuff_maintenance_definitions where user_id=u and item_id=p_item_id and enabled and coalesce(lifecycle_state,'active')='active' and lower(regexp_replace(trim(name),'[[:space:]]+',' ','g'))=normalized_name and service_action=action order by updated_at desc,id desc limit 1;
 if existing is not null then raise exception 'ACTIVE_PRESET_ALREADY_EXISTS'; end if;
 did:=public.create_my_stuff_maintenance_definition_v2(p_item_id,p_definition||jsonb_build_object('enabled',true),'v4-definition:'||trim(p_mutation_id));
 update public.my_stuff_maintenance_definitions set lifecycle_state='active' where id=did;
 insert into public.my_stuff_maintenance_baselines(definition_id,user_id,item_id,last_service_performed_on,last_service_mileage,last_service_hours,last_service_cycles,setup_received_at,device_now_telemetry,client_mutation_id,request_hash)
 values(did,u,p_item_id,sd,sm,sh,sc,t,p_device_now,trim(p_mutation_id),h);
 if cm is not null then perform public.record_my_stuff_current_mileage_v4(p_item_id,cm,p_device_now,'v4-setup-mileage:'||trim(p_mutation_id)); end if;
 result:=public.get_my_stuff_maintenance_state_v4(did)||jsonb_build_object('created_at',t);
 insert into public.my_stuff_v3_mutations values(u,trim(p_mutation_id),'preset_setup_v4',h,result,t); return result;
end $$;

create function public.complete_my_stuff_maintenance_v4(p_definition_id uuid,p_completion jsonb,p_device_now timestamptz,p_mutation_id text) returns jsonb
language plpgsql security definer set search_path=public,private,extensions as $$
declare u uuid:=auth.uid(); t timestamptz:=private.my_stuff_server_now_v4(); d public.my_stuff_maintenance_definitions%rowtype; i public.my_stuff_items%rowtype;
 h text; prior text; result jsonb; oid uuid; rid uuid; eid uuid; performed date; service_tz text; sm numeric; sh numeric; sc numeric; cm numeric; ch numeric; cc numeric; em numeric; eh numeric; ec numeric; plan uuid; exp jsonb;
begin
 if u is null then raise exception 'Authentication required'; end if; perform private.assert_my_stuff_integrity_v4_enabled();
 if jsonb_typeof(p_completion)<>'object' or pg_column_size(p_completion)>262144 then raise exception 'INVALID_COMPLETION'; end if;
 if exists(select 1 from jsonb_object_keys(p_completion) k where k not in ('service_performed_on','service_mileage','service_hours','service_cycles','current_mileage','current_hours','current_cycles','notes','parts','labor','vendor','warranty','attachment_metadata','planned_occurrence_id','expense','service_timezone')) then raise exception 'INVALID_COMPLETION_FIELD'; end if;
 performed:=nullif(p_completion->>'service_performed_on','')::date; service_tz:=coalesce(nullif(trim(p_completion->>'service_timezone'),''),'UTC'); sm:=nullif(p_completion->>'service_mileage','')::numeric; sh:=nullif(p_completion->>'service_hours','')::numeric; sc:=nullif(p_completion->>'service_cycles','')::numeric;
 cm:=nullif(p_completion->>'current_mileage','')::numeric; ch:=nullif(p_completion->>'current_hours','')::numeric; cc:=nullif(p_completion->>'current_cycles','')::numeric; plan:=nullif(p_completion->>'planned_occurrence_id','')::uuid; exp:=p_completion->'expense';
 if not exists(select 1 from pg_timezone_names where name=service_tz) then raise exception 'INVALID_SERVICE_TIMEZONE'; end if;
 if performed is null or not isfinite(performed) or performed<date '1900-01-01' or performed>(t at time zone service_tz)::date then raise exception 'INVALID_SERVICE_PERFORMED_DATE'; end if;
 if sm is not null and sm not between 0 and 1000000000 or sh is not null and sh not between 0 and 1000000000 or sc is not null and sc not between 0 and 1000000000 then raise exception 'INVALID_SERVICE_READING'; end if;
 if cm is not null and cm not between 0 and 1000000000 or ch is not null and ch not between 0 and 1000000000 or cc is not null and cc not between 0 and 1000000000 then raise exception 'INVALID_CURRENT_READING'; end if;
 if sm is not null and cm is not null and sm>cm or sh is not null and ch is not null and sh>ch or sc is not null and cc is not null and sc>cc then raise exception 'SERVICE_READING_EXCEEDS_CURRENT'; end if;
 if exp is not null and (jsonb_typeof(exp)<>'object' or pg_column_size(exp)>65536) then raise exception 'INVALID_EXPENSE'; end if;
 if length(trim(coalesce(p_mutation_id,''))) not between 1 and 160 then raise exception 'Mutation ID required'; end if;
 h:=encode(digest(jsonb_build_object('kind','completion_v4','definition',p_definition_id,'completion',p_completion||jsonb_build_object('service_timezone',service_tz))::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(u::text||':definition:'||p_definition_id::text,0));
 select request_hash,m.result into prior,result from public.my_stuff_v3_mutations m where user_id=u and mutation_id=trim(p_mutation_id);
 if found then if prior<>h then raise exception 'Idempotency key reused with different request'; end if; return result; end if;
 perform private.assert_my_stuff_device_clock_v4(p_device_now,t);
 select * into d from public.my_stuff_maintenance_definitions where id=p_definition_id and user_id=u and enabled and coalesce(lifecycle_state,'active')='active' for update; if not found then raise exception 'Maintenance definition not found'; end if;
 select * into i from public.my_stuff_items where id=d.item_id and user_id=u for update;
 if cm is not null and i.effective_current_mileage is not null and cm<i.effective_current_mileage or ch is not null and i.effective_current_hours is not null and ch<i.effective_current_hours or cc is not null and i.effective_current_cycles is not null and cc<i.effective_current_cycles then raise exception 'CURRENT_READING_CANNOT_DECREASE'; end if;
 em:=case when cm is null and sm is null then coalesce(i.effective_current_mileage,i.current_mileage) else greatest(coalesce(i.effective_current_mileage,i.current_mileage,0),coalesce(sm,0),coalesce(cm,0)) end;
 eh:=case when ch is null and sh is null then coalesce(i.effective_current_hours,i.current_hours) else greatest(coalesce(i.effective_current_hours,i.current_hours,0),coalesce(sh,0),coalesce(ch,0)) end;
 ec:=case when cc is null and sc is null then coalesce(i.effective_current_cycles,i.current_cycles) else greatest(coalesce(i.effective_current_cycles,i.current_cycles,0),coalesce(sc,0),coalesce(cc,0)) end;
 if plan is not null and not exists(select 1 from public.my_stuff_planned_occurrences where id=plan and definition_id=d.id and user_id=u and status<>'completed' for update) then raise exception 'Planned occurrence not found or completed'; end if;
 insert into public.my_stuff_service_occurrences(user_id,item_id,definition_id,service_name,service_category,service_action,scheduled,completed_at,service_performed_on,service_timezone,mileage,hours,cycles,provenance_type,provenance,client_mutation_id,request_hash,received_at,lock_deadline,submitted_at,device_now_telemetry,integrity_version)
 values(u,d.item_id,d.id,d.name,d.service_category,d.service_action,true,performed::timestamp at time zone service_tz,performed,service_tz,sm,sh,sc,'user_entered',jsonb_strip_nulls(jsonb_build_object('v4',true,'current_mileage',cm,'current_hours',ch,'current_cycles',cc)),trim(p_mutation_id),substr(h,1,32),t,t+interval '24 hours',t,p_device_now,4) returning id into oid;
 insert into public.my_stuff_service_occurrence_revisions(user_id,item_id,occurrence_id,revision_number,parts,labor,vendor,warranty,notes,attachment_metadata,client_mutation_id,request_hash)
 values(u,d.item_id,oid,1,coalesce(p_completion->'parts','[]'),coalesce(p_completion->'labor','[]'),coalesce(p_completion->'vendor','{}'),coalesce(p_completion->'warranty','{}'),nullif(trim(coalesce(p_completion->>'notes','')),''),coalesce(p_completion->'attachment_metadata','[]'),'v4-occurrence:'||oid||':revision:1',substr(h,1,32)) returning id into rid;
 insert into public.my_stuff_service_audit(user_id,item_id,occurrence_id,revision_id,action,actor_id,metadata) values(u,d.item_id,oid,rid,'created',u,jsonb_build_object('received_at',t,'device_now',p_device_now));
 if em is distinct from coalesce(i.effective_current_mileage,i.current_mileage) then insert into public.my_stuff_readings(user_id,item_id,reading_type,reading_value,recorded_at,source,metadata,client_mutation_id) values(u,d.item_id,'mileage',em,t,'service',jsonb_build_object('occurrence_id',oid),'v4-occurrence:'||oid||':current-mileage'); end if;
 if eh is distinct from coalesce(i.effective_current_hours,i.current_hours) then insert into public.my_stuff_readings(user_id,item_id,reading_type,reading_value,recorded_at,source,metadata,client_mutation_id) values(u,d.item_id,'hours',eh,t,'service',jsonb_build_object('occurrence_id',oid),'v4-occurrence:'||oid||':current-hours'); end if;
 if ec is distinct from coalesce(i.effective_current_cycles,i.current_cycles) then insert into public.my_stuff_readings(user_id,item_id,reading_type,reading_value,recorded_at,source,metadata,client_mutation_id) values(u,d.item_id,'cycles',ec,t,'service',jsonb_build_object('occurrence_id',oid),'v4-occurrence:'||oid||':current-cycles'); end if;
 update public.my_stuff_items set current_mileage=coalesce(em,current_mileage),effective_current_mileage=coalesce(em,effective_current_mileage),current_hours=coalesce(eh,current_hours),effective_current_hours=coalesce(eh,effective_current_hours),current_cycles=coalesce(ec,current_cycles),effective_current_cycles=coalesce(ec,effective_current_cycles) where id=d.item_id;
 update public.my_stuff_maintenance_definitions set first_service_completed=true where id=d.id;
 if exp is not null then eid:=private.create_my_stuff_expense_v3_trusted(u,d.item_id,exp,'service',null,null,oid,'v4-expense:'||trim(p_mutation_id)); end if;
 if plan is not null then
  update public.my_stuff_planned_occurrences set status='completed',completed_service_occurrence_id=oid where id=plan;
  insert into public.my_stuff_occurrence_status_events(user_id,item_id,planned_occurrence_id,status,source,actor_id,client_mutation_id,request_hash)
  values(u,d.item_id,plan,'completed','service',u,'v4-status:'||trim(p_mutation_id),h);
  perform public.materialize_my_stuff_next_occurrence_v3(d.id);
 end if;
 result:=jsonb_build_object('service_occurrence_id',oid,'revision_id',rid,'expense_id',eid,'received_at',t,'submitted_at',t,'lock_deadline',t+interval '24 hours','revision_number',0,'snapshot_sha256',encode(digest(private.my_stuff_original_snapshot_v4(oid)::text,'sha256'),'hex'),'state',public.get_my_stuff_maintenance_state_v4(d.id));
 insert into public.my_stuff_v3_mutations values(u,trim(p_mutation_id),'completion_v4',h,result,t); return result;
end $$;

create function private.append_my_stuff_completion_correction_v4(p_occurrence_id uuid,p_patch jsonb,p_reason text,p_expected_revision integer,p_expected_snapshot_hash text,p_device_now timestamptz,p_mutation_id text,p_window_only boolean) returns jsonb
language plpgsql security definer set search_path=public,private,extensions as $$
declare u uuid:=auth.uid(); t timestamptz:=private.my_stuff_server_now_v4(); o public.my_stuff_service_occurrences%rowtype; latest jsonb; snapshot jsonb; latest_hash text; h text; prior text; result jsonb; cid uuid; n integer;
 item_current numeric; item_hours numeric; item_cycles numeric; new_current numeric; new_hours numeric; new_cycles numeric; new_service numeric; new_service_hours numeric; new_service_cycles numeric;
 previous_mileage_reading uuid; previous_hours_reading uuid; previous_cycles_reading uuid;
begin
 if u is null then raise exception 'Authentication required'; end if; perform private.assert_my_stuff_integrity_v4_enabled();
 if jsonb_typeof(p_patch)<>'object' or p_patch='{}' or exists(select 1 from jsonb_object_keys(p_patch) k where k not in ('service_performed_on','service_mileage','service_hours','service_cycles','current_mileage','current_hours','current_cycles','notes','parts','labor','vendor','warranty','attachment_metadata','service_timezone')) then raise exception 'INVALID_COMPLETION_PATCH'; end if;
 if not p_window_only and (nullif(trim(coalesce(p_reason,'')),'') is null or length(p_reason)>2000) then raise exception 'Correction reason required'; end if;
 if p_window_only and length(coalesce(p_reason,''))>2000 then raise exception 'Edit reason too long'; end if;
 if p_expected_revision is null or p_expected_revision<0 or p_expected_snapshot_hash!~'^[0-9a-f]{64}$' then raise exception 'EXPECTED_REVISION_REQUIRED'; end if;
 if length(trim(coalesce(p_mutation_id,''))) not between 1 and 160 then raise exception 'Mutation ID required'; end if;
 h:=encode(digest(jsonb_build_object('kind',case when p_window_only then 'window_edit' else 'later_correction' end,'occurrence',p_occurrence_id,'patch',p_patch,'reason',nullif(trim(coalesce(p_reason,'')) ,''),'expected_revision',p_expected_revision,'expected_snapshot_hash',lower(p_expected_snapshot_hash))::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(u::text||':occurrence:'||p_occurrence_id::text,0));
 select request_hash,m.result into prior,result from public.my_stuff_v3_mutations m where user_id=u and mutation_id=trim(p_mutation_id); if found then if prior<>h then raise exception 'Idempotency key reused with different request'; end if; return result; end if;
 perform private.assert_my_stuff_device_clock_v4(p_device_now,t);
 select * into o from public.my_stuff_service_occurrences where id=p_occurrence_id and user_id=u for update; if not found then raise exception 'Service occurrence not found'; end if;
 if p_window_only and (o.integrity_version is distinct from 4 or t>=o.lock_deadline) then raise exception 'COMPLETION_LOCKED'; end if;
 select coalesce(max(correction_number),0) into n from public.my_stuff_completion_corrections where occurrence_id=o.id;
 latest:=private.my_stuff_effective_snapshot_v4(o.id); latest_hash:=encode(digest(latest::text,'sha256'),'hex');
 if n<>p_expected_revision or latest_hash<>lower(p_expected_snapshot_hash) then raise exception 'REVISION_CONFLICT'; end if;
 snapshot:=latest||p_patch;
 if nullif(snapshot->>'service_timezone','') is not null and not exists(select 1 from pg_timezone_names where name=snapshot->>'service_timezone') then raise exception 'INVALID_SERVICE_TIMEZONE'; end if;
 if nullif(snapshot->>'service_performed_on','') is null or (snapshot->>'service_performed_on')::date>(t at time zone coalesce(nullif(snapshot->>'service_timezone',''),'UTC'))::date or (snapshot->>'service_performed_on')::date<date '1900-01-01' then raise exception 'INVALID_SERVICE_PERFORMED_DATE'; end if;
 new_service:=nullif(snapshot->>'service_mileage','')::numeric; new_service_hours:=nullif(snapshot->>'service_hours','')::numeric; new_service_cycles:=nullif(snapshot->>'service_cycles','')::numeric;
 new_current:=nullif(snapshot->>'current_mileage','')::numeric; new_hours:=nullif(snapshot->>'current_hours','')::numeric; new_cycles:=nullif(snapshot->>'current_cycles','')::numeric;
 if (new_service is not null and new_service not between 0 and 1000000000) or
    (new_service_hours is not null and new_service_hours not between 0 and 1000000000) or
    (new_service_cycles is not null and new_service_cycles not between 0 and 1000000000) then raise exception 'INVALID_SERVICE_READING'; end if;
 if (new_current is not null and new_current not between 0 and 1000000000) or
    (new_hours is not null and new_hours not between 0 and 1000000000) or
    (new_cycles is not null and new_cycles not between 0 and 1000000000) then raise exception 'INVALID_CURRENT_READING'; end if;
 if jsonb_typeof(snapshot->'parts')<>'array' or jsonb_typeof(snapshot->'labor')<>'array'
    or jsonb_typeof(snapshot->'vendor')<>'object' or jsonb_typeof(snapshot->'warranty')<>'object'
    or jsonb_typeof(snapshot->'attachment_metadata')<>'array' or length(coalesce(snapshot->>'notes',''))>20000
    or pg_column_size(snapshot->'parts')>131072 or pg_column_size(snapshot->'labor')>131072
    or pg_column_size(snapshot->'vendor')>32768 or pg_column_size(snapshot->'warranty')>32768
    or pg_column_size(snapshot->'attachment_metadata')>65536 then raise exception 'INVALID_COMPLETION_DETAILS'; end if;
 select coalesce(effective_current_mileage,current_mileage),coalesce(effective_current_hours,current_hours),coalesce(effective_current_cycles,current_cycles)
 into item_current,item_hours,item_cycles from public.my_stuff_items where id=o.item_id and user_id=u for update;
 if (p_patch?'current_mileage' and new_current is not null and item_current is not null and new_current<item_current)
    or (p_patch?'current_hours' and new_hours is not null and item_hours is not null and new_hours<item_hours)
    or (p_patch?'current_cycles' and new_cycles is not null and item_cycles is not null and new_cycles<item_cycles) then raise exception 'CURRENT_READING_CANNOT_DECREASE'; end if;
 if (new_service is not null and new_current is not null and new_service>new_current)
    or (new_service_hours is not null and new_hours is not null and new_service_hours>new_hours)
    or (new_service_cycles is not null and new_cycles is not null and new_service_cycles>new_cycles)
    or (p_patch?'service_mileage' and new_service is not null and new_current is null and item_current is not null and new_service>item_current)
    or (p_patch?'service_hours' and new_service_hours is not null and new_hours is null and item_hours is not null and new_service_hours>item_hours)
    or (p_patch?'service_cycles' and new_service_cycles is not null and new_cycles is null and item_cycles is not null and new_service_cycles>item_cycles) then raise exception 'SERVICE_READING_EXCEEDS_CURRENT'; end if;
 n:=n+1; latest_hash:=encode(digest(snapshot::text,'sha256'),'hex');
 insert into public.my_stuff_completion_corrections(user_id,item_id,occurrence_id,correction_number,correction_type,service_snapshot,snapshot_sha256,reason,received_at,device_now_telemetry,client_mutation_id,request_hash)
 values(u,o.item_id,o.id,n,case when p_window_only then 'window_edit' else 'later_correction' end,snapshot,latest_hash,nullif(trim(coalesce(p_reason,'')),''),t,p_device_now,trim(p_mutation_id),h) returning id into cid;
 select id into previous_mileage_reading from public.my_stuff_readings where user_id=u and item_id=o.item_id and reading_type='mileage' order by created_at desc,id desc limit 1;
 select id into previous_hours_reading from public.my_stuff_readings where user_id=u and item_id=o.item_id and reading_type='hours' order by created_at desc,id desc limit 1;
 select id into previous_cycles_reading from public.my_stuff_readings where user_id=u and item_id=o.item_id and reading_type='cycles' order by created_at desc,id desc limit 1;
 if p_patch?'current_mileage' and new_current is not null and new_current>coalesce(item_current,-1) then insert into public.my_stuff_readings(user_id,item_id,reading_type,reading_value,recorded_at,source,corrects_reading_id,correction_reason,metadata,client_mutation_id) values(u,o.item_id,'mileage',new_current,t,case when previous_mileage_reading is null then 'service' else 'correction' end,previous_mileage_reading,case when previous_mileage_reading is null then null else coalesce(nullif(trim(coalesce(p_reason,'')),''),'Window edit') end,jsonb_build_object('occurrence_id',o.id,'correction_id',cid),'v4-correction:'||cid||':mileage'); end if;
 if p_patch?'current_hours' and new_hours is not null and new_hours>coalesce(item_hours,-1) then insert into public.my_stuff_readings(user_id,item_id,reading_type,reading_value,recorded_at,source,corrects_reading_id,correction_reason,metadata,client_mutation_id) values(u,o.item_id,'hours',new_hours,t,case when previous_hours_reading is null then 'service' else 'correction' end,previous_hours_reading,case when previous_hours_reading is null then null else coalesce(nullif(trim(coalesce(p_reason,'')),''),'Window edit') end,jsonb_build_object('occurrence_id',o.id,'correction_id',cid),'v4-correction:'||cid||':hours'); end if;
 if p_patch?'current_cycles' and new_cycles is not null and new_cycles>coalesce(item_cycles,-1) then insert into public.my_stuff_readings(user_id,item_id,reading_type,reading_value,recorded_at,source,corrects_reading_id,correction_reason,metadata,client_mutation_id) values(u,o.item_id,'cycles',new_cycles,t,case when previous_cycles_reading is null then 'service' else 'correction' end,previous_cycles_reading,case when previous_cycles_reading is null then null else coalesce(nullif(trim(coalesce(p_reason,'')),''),'Window edit') end,jsonb_build_object('occurrence_id',o.id,'correction_id',cid),'v4-correction:'||cid||':cycles'); end if;
 update public.my_stuff_items set
  current_mileage=case when p_patch?'current_mileage' then coalesce(new_current,current_mileage) else current_mileage end,
  effective_current_mileage=case when p_patch?'current_mileage' then coalesce(new_current,effective_current_mileage) else effective_current_mileage end,
  current_hours=case when p_patch?'current_hours' then coalesce(new_hours,current_hours) else current_hours end,
  effective_current_hours=case when p_patch?'current_hours' then coalesce(new_hours,effective_current_hours) else effective_current_hours end,
  current_cycles=case when p_patch?'current_cycles' then coalesce(new_cycles,current_cycles) else current_cycles end,
  effective_current_cycles=case when p_patch?'current_cycles' then coalesce(new_cycles,effective_current_cycles) else effective_current_cycles end where id=o.item_id;
 result:=jsonb_build_object('correction_id',cid,'correction_number',n,'correction_type',case when p_window_only then 'window_edit' else 'later_correction' end,'received_at',t,'original_preserved',true,'snapshot_sha256',latest_hash,'state',case when exists(select 1 from public.my_stuff_maintenance_definitions d where d.id=o.definition_id and d.user_id=u and d.enabled and coalesce(d.lifecycle_state,'active')='active') then public.get_my_stuff_maintenance_state_v4(o.definition_id) else null end);
 insert into public.my_stuff_v3_mutations values(u,trim(p_mutation_id),'completion_correction_v4',h,result,t); return result;
end $$;
revoke all on function private.append_my_stuff_completion_correction_v4(uuid,jsonb,text,integer,text,timestamptz,text,boolean) from public,anon,authenticated,service_role;
create function public.edit_my_stuff_completion_v4(p_occurrence_id uuid,p_patch jsonb,p_reason text,p_expected_revision integer,p_expected_snapshot_hash text,p_device_now timestamptz,p_mutation_id text) returns jsonb
language sql security definer set search_path=public,private as $$select private.append_my_stuff_completion_correction_v4(p_occurrence_id,p_patch,p_reason,p_expected_revision,p_expected_snapshot_hash,p_device_now,p_mutation_id,true)$$;
create function public.correct_my_stuff_completion_v4(p_occurrence_id uuid,p_patch jsonb,p_reason text,p_expected_revision integer,p_expected_snapshot_hash text,p_device_now timestamptz,p_mutation_id text) returns jsonb
language sql security definer set search_path=public,private as $$select private.append_my_stuff_completion_correction_v4(p_occurrence_id,p_patch,p_reason,p_expected_revision,p_expected_snapshot_hash,p_device_now,p_mutation_id,false)$$;

create function public.get_my_stuff_maintenance_report_v4(p_item_id uuid,p_limit integer default 500,p_after_received_at timestamptz default null,p_after_occurrence_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path=public,private,extensions as $$
declare generated timestamptz:=transaction_timestamp(); entries jsonb; item_snapshot jsonb; total_count integer; remaining_count integer; returned_count integer; snapshot jsonb; disclaimer constant text:='Owner-provided maintenance history. Verify records and follow the manufacturer owner’s manual and qualified-service guidance.';
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if; perform private.assert_my_stuff_integrity_v4_enabled();
 if p_limit not between 1 and 500 then raise exception 'REPORT_LIMIT_OUT_OF_RANGE'; end if;
 if num_nonnulls(p_after_received_at,p_after_occurrence_id) not in (0,2) then raise exception 'INVALID_REPORT_CURSOR'; end if;
 select jsonb_build_object('item_id',i.id,'name',i.name,'item_type',i.item_type,'effective_current_mileage',coalesce(i.effective_current_mileage,i.current_mileage),'effective_current_hours',coalesce(i.effective_current_hours,i.current_hours),'effective_current_cycles',coalesce(i.effective_current_cycles,i.current_cycles)) into item_snapshot from public.my_stuff_items i where i.id=p_item_id and i.user_id=auth.uid();
 if item_snapshot is null then raise exception 'My Stuff item not found'; end if;
 select count(*) into total_count from public.my_stuff_service_occurrences o where o.item_id=p_item_id and o.user_id=auth.uid();
 select count(*) into remaining_count from public.my_stuff_service_occurrences o where o.item_id=p_item_id and o.user_id=auth.uid()
  and (p_after_received_at is null or (coalesce(o.received_at,o.created_at),o.id)<(p_after_received_at,p_after_occurrence_id));
 with page as (
  select o.* from public.my_stuff_service_occurrences o where o.item_id=p_item_id and o.user_id=auth.uid()
   and (p_after_received_at is null or (coalesce(o.received_at,o.created_at),o.id)<(p_after_received_at,p_after_occurrence_id))
   order by coalesce(o.received_at,o.created_at) desc,o.id desc limit p_limit
 ), built as (
  select coalesce(o.received_at,o.created_at) sort_at,o.id,jsonb_build_object(
   'occurrence_id',o.id,'historical_locked_from_window_edit',o.integrity_version is distinct from 4,'historical_correctable',true,
   'original',private.my_stuff_report_snapshot_v4(private.my_stuff_original_snapshot_v4(o.id))||jsonb_build_object('service_name',o.service_name,'received_at',o.received_at,'submitted_at',o.submitted_at,'lock_deadline',o.lock_deadline),
   'original_snapshot_sha256',encode(digest(private.my_stuff_original_snapshot_v4(o.id)::text,'sha256'),'hex'),
   'correction_chain',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'number',c.correction_number,'type',c.correction_type,'reason',c.reason,'received_at',c.received_at,'snapshot',private.my_stuff_report_snapshot_v4(c.service_snapshot),'snapshot_sha256',c.snapshot_sha256) order by c.correction_number) from public.my_stuff_completion_corrections c where c.occurrence_id=o.id),'[]'::jsonb),
   'effective',private.my_stuff_report_snapshot_v4(private.my_stuff_effective_snapshot_v4(o.id)),
   'effective_snapshot_sha256',encode(digest(private.my_stuff_effective_snapshot_v4(o.id)::text,'sha256'),'hex'),
   'attachment_hashes',coalesce((select jsonb_agg(jsonb_build_object('sha256',a.sha256,'byte_size',a.byte_size,'media_type',a.media_type) order by a.id) from public.my_stuff_attachments a where a.user_id=o.user_id and a.item_id=o.item_id and a.state='finalized' and a.service_revision_id in(select r.id from public.my_stuff_service_occurrence_revisions r where r.occurrence_id=o.id)),'[]'::jsonb)
  ) entry from page o
 ) select coalesce(jsonb_agg(entry order by sort_at desc,id desc),'[]'::jsonb),count(*) into entries,returned_count from built;
 snapshot:=jsonb_build_object('schema_version',4,'owner_report_disclaimer',disclaimer,'generated_at',generated,'item',item_snapshot,'completions',entries,
  'page',jsonb_build_object('limit',p_limit,'returned_count',returned_count,'remaining_count',remaining_count,'total_count',total_count,'complete',returned_count=remaining_count,'truncated',returned_count<remaining_count,
    'next_after_received_at',case when returned_count<remaining_count then (select coalesce(o.received_at,o.created_at) from public.my_stuff_service_occurrences o where o.id=(entries->-1->>'occurrence_id')::uuid) end,
    'next_after_occurrence_id',case when returned_count<remaining_count then entries->-1->>'occurrence_id' end));
 return snapshot||jsonb_build_object('snapshot_sha256',encode(digest(snapshot::text,'sha256'),'hex'),'integrity_status','verified');
end $$;

create table public.my_stuff_deleted_definition_history_v4(
 id bigint generated always as identity primary key,
 request_id uuid not null,
 user_id uuid not null references auth.users(id) on delete cascade,
 item_id uuid not null,
 target_definition_id uuid not null,
 source_table text not null,
 source_key text,
 row_snapshot jsonb not null,
 preserved_at timestamptz not null default transaction_timestamp(),
 foreign key(item_id,user_id) references public.my_stuff_items(id,user_id) on delete cascade
);
create index my_stuff_deleted_definition_history_owner_v4 on public.my_stuff_deleted_definition_history_v4(user_id,item_id,target_definition_id,id);

create table public.my_stuff_deletion_requests_v4(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 object_type text not null check(object_type in ('item','definition')),object_id uuid not null,item_id uuid not null,
 status text not null default 'requested' check(status in ('requested','leased','deleting_database','verifying_storage','complete','failed')),
 client_mutation_id text not null,request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 storage_objects_expected integer not null default 0,storage_objects_deleted integer not null default 0,
 database_rows_expected integer not null default 0,database_rows_deleted integer not null default 0,database_rows_detached integer not null default 0,
 lease_worker_id text,lease_token uuid,lease_deadline timestamptz,attempt_count integer not null default 0,
 last_error text,created_at timestamptz not null default transaction_timestamp(),updated_at timestamptz not null default transaction_timestamp(),completed_at timestamptz,
 unique(user_id,client_mutation_id),unique(user_id,object_type,object_id),
 check(storage_objects_expected>=0 and storage_objects_deleted>=0 and database_rows_expected>=0 and database_rows_deleted>=0 and database_rows_detached>=0),
 check(attempt_count>=0),
 check((status in ('leased','deleting_database','verifying_storage'))=(lease_worker_id is not null and lease_token is not null and lease_deadline is not null))
);
create index my_stuff_deletion_queue_v4 on public.my_stuff_deletion_requests_v4(status,lease_deadline,created_at,id) where status in ('requested','leased','deleting_database','verifying_storage','failed');

create function private.count_my_stuff_deletion_rows_v4(p_user_id uuid,p_object_type text,p_object_id uuid,p_item_id uuid) returns integer
language plpgsql stable security definer set search_path=pg_catalog as $$
declare r record; n bigint:=0; c bigint;
begin
 if p_object_type='item' then
  for r in select ns.nspname,c.relname from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
   where ns.nspname in ('public','private') and c.relkind in ('r','p')
    and c.relname<>'my_stuff_deletion_requests_v4'
    and exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='user_id' and a.attnum>0 and not a.attisdropped)
    and exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='item_id' and a.attnum>0 and not a.attisdropped)
  loop execute format('select count(*) from %I.%I where user_id=$1 and item_id=$2',r.nspname,r.relname) into c using p_user_id,p_item_id; n:=n+c; end loop;
  select count(*) into c from public.my_stuff_items where id=p_object_id and user_id=p_user_id; n:=n+c;
 else
  for r in select ns.nspname,c.relname from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
   where ns.nspname in ('public','private') and c.relkind in ('r','p')
    and exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='definition_id' and a.attnum>0 and not a.attisdropped)
  loop execute format('select count(*) from %I.%I where definition_id=$1',r.nspname,r.relname) into c using p_object_id; n:=n+c; end loop;
  -- Count rows deleted indirectly through definition-owned planned/occurrence
  -- graphs. These child tables do not carry definition_id themselves.
  select count(*) into c from public.my_stuff_occurrence_status_events e
   where e.planned_occurrence_id in(select p.id from public.my_stuff_planned_occurrences p where p.definition_id=p_object_id and p.user_id=p_user_id); n:=n+c;
  select count(*) into c from public.my_stuff_maintenance_definitions where id=p_object_id and user_id=p_user_id; n:=n+c;
 end if;
 return n::integer;
end $$;
revoke all on function private.count_my_stuff_deletion_rows_v4(uuid,text,uuid,uuid) from public,anon,authenticated,service_role;

create function public.request_my_stuff_deletion_v4(p_object_type text,p_object_id uuid,p_mutation_id text) returns jsonb
language plpgsql security definer set search_path=public,extensions as $$
declare u uuid:=auth.uid(); iid uuid; rid uuid; h text; prior public.my_stuff_deletion_requests_v4%rowtype; dbcount integer;
begin
 if u is null then raise exception 'Authentication required'; end if; perform private.assert_my_stuff_integrity_v4_enabled();
 if p_object_type not in ('item','definition') then raise exception 'INVALID_DELETION_OBJECT_TYPE'; end if;
 if length(trim(coalesce(p_mutation_id,''))) not between 1 and 160 then raise exception 'Mutation ID required'; end if;
 h:=encode(digest(jsonb_build_object('object_type',p_object_type,'object_id',p_object_id)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(u::text||':delete:'||p_object_type||':'||p_object_id::text,0));
 select * into prior from public.my_stuff_deletion_requests_v4 where user_id=u and client_mutation_id=trim(p_mutation_id);
 if found then if prior.request_hash<>h then raise exception 'Idempotency key reused with different request'; end if; return to_jsonb(prior); end if;
 select * into prior from public.my_stuff_deletion_requests_v4 where user_id=u and object_type=p_object_type and object_id=p_object_id;
 if found then return to_jsonb(prior); end if;
 if p_object_type='item' then select id into iid from public.my_stuff_items where id=p_object_id and user_id=u;
 else select item_id into iid from public.my_stuff_maintenance_definitions where id=p_object_id and user_id=u; end if;
 if iid is null then raise exception 'Deletion target not found'; end if;
 dbcount:=private.count_my_stuff_deletion_rows_v4(u,p_object_type,p_object_id,iid);
 insert into public.my_stuff_deletion_requests_v4(user_id,object_type,object_id,item_id,client_mutation_id,request_hash,database_rows_expected)
 values(u,p_object_type,p_object_id,iid,trim(p_mutation_id),h,dbcount) returning id into rid;
 return (select to_jsonb(r) from public.my_stuff_deletion_requests_v4 r where r.id=rid);
end $$;
create function public.get_my_stuff_deletion_status_v4(p_request_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare r jsonb; begin if auth.uid() is null then raise exception 'Authentication required'; end if; perform private.assert_my_stuff_integrity_v4_enabled(); select to_jsonb(x) into r from public.my_stuff_deletion_requests_v4 x where id=p_request_id and user_id=auth.uid(); if r is null then raise exception 'Deletion request not found'; end if; return r; end $$;

-- The server worker claims a bounded batch. Expired leases are recoverable;
-- every success/failure acknowledgement and finalization is token-fenced.
-- Trusted definition detachment is entered through a trigger on a new private
-- command table. Legacy tables receive no new triggers in Phase 1. Nested
-- deletes are accepted by the existing immutable-row guard; complete snapshots
-- are preserved before cascades, while nullable provisional history is detached.
create table private.my_stuff_definition_detach_commands_v4(
 request_id uuid not null,user_id uuid not null,item_id uuid not null,definition_id uuid not null
);
revoke all on private.my_stuff_definition_detach_commands_v4 from public,anon,authenticated,service_role;
create function private.execute_my_stuff_definition_detach_v4() returns trigger
language plpgsql security definer set search_path=public,private,pg_catalog as $$
declare rel record; has_user boolean; sql text;
begin
 for rel in
  select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','private') and c.relkind in ('r','p')
   and not (n.nspname='public' and c.relname in ('my_stuff_maintenance_definitions','my_stuff_deleted_definition_history_v4'))
   and not (n.nspname='private' and c.relname='my_stuff_definition_detach_commands_v4')
   and exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='definition_id' and a.attnum>0 and not a.attisdropped)
 loop
  select exists(select 1 from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
   where n.nspname=rel.nspname and c.relname=rel.relname and a.attname='user_id' and a.attnum>0 and not a.attisdropped) into has_user;
  sql:=format('insert into public.my_stuff_deleted_definition_history_v4(request_id,user_id,item_id,target_definition_id,source_table,source_key,row_snapshot) select $1,$2,$3,$4,%L,coalesce(to_jsonb(x)->>''id'',to_jsonb(x)->>''definition_id''),to_jsonb(x) from %I.%I x where x.definition_id=$4%s',
   rel.nspname||'.'||rel.relname,rel.nspname,rel.relname,case when has_user then ' and x.user_id=$2' else '' end);
  execute sql using new.request_id,new.user_id,new.item_id,new.definition_id;
 end loop;
 insert into public.my_stuff_deleted_definition_history_v4(request_id,user_id,item_id,target_definition_id,source_table,source_key,row_snapshot)
 select new.request_id,new.user_id,new.item_id,new.definition_id,'public.my_stuff_service_occurrence_bundle',o.id::text,
  jsonb_build_object('occurrence',to_jsonb(o),
   'revisions',coalesce((select jsonb_agg(to_jsonb(x) order by x.revision_number) from public.my_stuff_service_occurrence_revisions x where x.occurrence_id=o.id),'[]'::jsonb),
   'audit',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from public.my_stuff_service_audit x where x.occurrence_id=o.id),'[]'::jsonb),
   'corrections',coalesce((select jsonb_agg(to_jsonb(x) order by x.correction_number) from public.my_stuff_completion_corrections x where x.occurrence_id=o.id),'[]'::jsonb),
   'expenses',coalesce((select jsonb_agg(to_jsonb(e)||jsonb_build_object('revisions',(select coalesce(jsonb_agg(to_jsonb(er) order by er.revision_number),'[]'::jsonb) from public.my_stuff_expense_revisions er where er.expense_id=e.id),'audit',(select coalesce(jsonb_agg(to_jsonb(ea) order by ea.created_at,ea.id),'[]'::jsonb) from public.my_stuff_expense_audit ea where ea.expense_id=e.id))) from public.my_stuff_expenses e where e.linked_occurrence_id=o.id),'[]'::jsonb),
   'attachments',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at,a.id) from public.my_stuff_attachments a where a.service_revision_id in(select x.id from public.my_stuff_service_occurrence_revisions x where x.occurrence_id=o.id) or a.expense_revision_id in(select er.id from public.my_stuff_expense_revisions er where er.expense_id in(select e.id from public.my_stuff_expenses e where e.linked_occurrence_id=o.id))),'[]'::jsonb))
 from public.my_stuff_service_occurrences o where o.definition_id=new.definition_id and o.user_id=new.user_id;
 if to_regclass('public.my_stuff_service_history') is not null then
  execute 'update public.my_stuff_service_history set definition_id=null where definition_id=$1 and user_id=$2 and item_id=$3'
  using new.definition_id,new.user_id,new.item_id;
 end if;
 -- Preserve occurrences, revisions, expenses and attachments physically. The
 -- exact legacy immutable trigger is disabled only inside this fenced transaction;
 -- an error rolls the trigger state back before the exception handler returns.
 execute 'alter table public.my_stuff_service_occurrences disable trigger my_stuff_occurrences_immutable';
 update public.my_stuff_service_occurrences set scheduled=false,definition_id=null
  where definition_id=new.definition_id and user_id=new.user_id and item_id=new.item_id;
 execute 'alter table public.my_stuff_service_occurrences enable trigger my_stuff_occurrences_immutable';
 return null;
end $$;
create trigger execute_my_stuff_definition_detach_v4 before insert on private.my_stuff_definition_detach_commands_v4
for each row execute function private.execute_my_stuff_definition_detach_v4();
revoke all on function private.execute_my_stuff_definition_detach_v4() from public,anon,authenticated,service_role;

create function public.claim_my_stuff_deletions_v4(p_worker_id text,p_batch_size integer default 10,p_lease_seconds integer default 120) returns jsonb
language plpgsql security definer set search_path=public,private,extensions,pg_catalog as $$
declare payload jsonb;
begin
 if length(trim(coalesce(p_worker_id,''))) not between 1 and 120 then raise exception 'INVALID_WORKER_ID'; end if;
 if p_batch_size not between 1 and 100 then raise exception 'INVALID_BATCH_SIZE'; end if;
 if p_lease_seconds not between 30 and 900 then raise exception 'INVALID_LEASE_SECONDS'; end if;
 with candidates as (
  select id from public.my_stuff_deletion_requests_v4
  where status in ('requested','failed') or (status in ('leased','deleting_database','verifying_storage') and lease_deadline<=transaction_timestamp())
  order by created_at,id for update skip locked limit p_batch_size
 ), claimed as (
  update public.my_stuff_deletion_requests_v4 r set status=case when r.status in ('requested','failed') then 'leased' else r.status end,
   lease_worker_id=trim(p_worker_id),lease_token=gen_random_uuid(),
   lease_deadline=transaction_timestamp()+make_interval(secs=>p_lease_seconds),attempt_count=attempt_count+1,
   last_error=null,updated_at=transaction_timestamp()
  from candidates c where r.id=c.id
  returning r.id,r.user_id,r.object_type,r.object_id,r.item_id,r.status,r.lease_worker_id,r.lease_token,r.lease_deadline,r.attempt_count
 ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'user_id',user_id,'object_type',object_type,'object_id',object_id,
   'item_id',item_id,'phase',status,'worker_id',lease_worker_id,'lease_token',lease_token,'lease_deadline',lease_deadline,
   'attempt_count',attempt_count,'bucket_id','my-stuff-media','storage_prefix',
   case when object_type='item' then user_id::text||'/items/'||item_id::text||'/' else null end) order by id),'[]'::jsonb)
 into payload from claimed;
 return payload;
end $$;

create function public.ack_my_stuff_deletion_storage_v4(p_request_id uuid,p_worker_id text,p_lease_token uuid,p_expected integer,p_deleted integer,p_remaining integer,p_error text default null) returns jsonb
language plpgsql security definer set search_path=public,pg_catalog as $$
declare r public.my_stuff_deletion_requests_v4%rowtype;
begin
 if p_expected is null or p_deleted is null or p_remaining is null or least(p_expected,p_deleted,p_remaining)<0
    or p_deleted+p_remaining<>p_expected then raise exception 'INVALID_STORAGE_COUNTS'; end if;
 select * into r from public.my_stuff_deletion_requests_v4 where id=p_request_id for update;
 if not found then raise exception 'Deletion request not found'; end if;
 if r.status not in ('leased','verifying_storage') or r.lease_worker_id is distinct from trim(p_worker_id) or r.lease_token is distinct from p_lease_token
    or r.lease_deadline<=transaction_timestamp() then raise exception 'STALE_DELETION_LEASE'; end if;
 if r.status='verifying_storage' then
  if p_error is not null or p_remaining>0 then
   update public.my_stuff_deletion_requests_v4 set storage_objects_expected=storage_objects_expected+p_deleted,
    storage_objects_deleted=storage_objects_deleted+p_deleted,last_error=left(coalesce(p_error,'STORAGE_OBJECTS_REMAIN'),1000),
    lease_deadline=transaction_timestamp(),updated_at=transaction_timestamp() where id=r.id returning * into r;
  else
   update public.my_stuff_deletion_requests_v4 set status='complete',storage_objects_expected=storage_objects_expected+p_expected,
    storage_objects_deleted=storage_objects_deleted+p_deleted,last_error=null,completed_at=transaction_timestamp(),
    lease_worker_id=null,lease_token=null,lease_deadline=null,updated_at=transaction_timestamp() where id=r.id returning * into r;
  end if;
  return to_jsonb(r);
 end if;
 if p_error is not null or p_remaining>0 then
  update public.my_stuff_deletion_requests_v4 set status='failed',storage_objects_expected=storage_objects_expected+p_deleted,
   storage_objects_deleted=storage_objects_deleted+p_deleted,last_error=left(coalesce(p_error,'STORAGE_OBJECTS_REMAIN'),1000),
   lease_worker_id=null,lease_token=null,lease_deadline=null,updated_at=transaction_timestamp()
  where id=r.id returning * into r;
 else
  update public.my_stuff_deletion_requests_v4 set status='deleting_database',storage_objects_expected=storage_objects_expected+p_expected,
   storage_objects_deleted=storage_objects_deleted+p_deleted,last_error=null,updated_at=transaction_timestamp()
  where id=r.id returning * into r;
 end if;
 return to_jsonb(r);
end $$;

create function public.finalize_my_stuff_deletion_v4(p_request_id uuid,p_worker_id text,p_lease_token uuid) returns jsonb
language plpgsql security definer set search_path=public,private,pg_catalog as $$
declare r public.my_stuff_deletion_requests_v4%rowtype; before_count integer; remain_count integer;
 detached_rows integer:=0; target_deleted integer:=0;
begin
 select * into r from public.my_stuff_deletion_requests_v4 where id=p_request_id for update;
 if not found then raise exception 'Deletion request not found'; end if;
 if r.status='complete' then return to_jsonb(r); end if;
 if r.status<>'deleting_database' or r.lease_worker_id is distinct from trim(p_worker_id) or r.lease_token is distinct from p_lease_token
    or r.lease_deadline<=transaction_timestamp() then raise exception 'STALE_DELETION_LEASE'; end if;
 before_count:=private.count_my_stuff_deletion_rows_v4(r.user_id,r.object_type,r.object_id,r.item_id);
 if r.object_type='definition' then
  select count(*) into detached_rows from public.my_stuff_service_history
   where definition_id=r.object_id and user_id=r.user_id and item_id=r.item_id;
  select detached_rows+count(*) into detached_rows from public.my_stuff_service_occurrences
   where definition_id=r.object_id and user_id=r.user_id and item_id=r.item_id;
  insert into private.my_stuff_definition_detach_commands_v4(request_id,user_id,item_id,definition_id)
  values(r.id,r.user_id,r.item_id,r.object_id);
  delete from public.my_stuff_maintenance_definitions where id=r.object_id and user_id=r.user_id;
  get diagnostics target_deleted=row_count;

 else
  delete from public.my_stuff_to_project_expense_copies where user_id=r.user_id and item_id=r.item_id;
  delete from public.my_stuff_to_project_transfers where user_id=r.user_id and item_id=r.item_id;
  delete from public.my_stuff_items where id=r.item_id and user_id=r.user_id;
  get diagnostics target_deleted=row_count;
 end if;
 if target_deleted=0 then raise exception 'DELETION_TARGET_DISAPPEARED'; end if;
 remain_count:=private.count_my_stuff_deletion_rows_v4(r.user_id,r.object_type,r.object_id,r.item_id);
 if remain_count<>0 then raise exception 'DELETION_DATABASE_REMAINS'; end if;
 update public.my_stuff_deletion_requests_v4 set status=case when r.object_type='item' then 'verifying_storage' else 'complete' end,database_rows_expected=before_count,
  database_rows_detached=detached_rows,database_rows_deleted=greatest(before_count-detached_rows,0),
  completed_at=case when r.object_type='definition' then transaction_timestamp() else null end,
  lease_worker_id=case when r.object_type='definition' then null else lease_worker_id end,
  lease_token=case when r.object_type='definition' then null else lease_token end,
  lease_deadline=case when r.object_type='definition' then null else lease_deadline end,
  last_error=null,updated_at=transaction_timestamp() where id=r.id returning * into r;
 return to_jsonb(r);
exception when others then
 if r.id is not null then update public.my_stuff_deletion_requests_v4 set status='failed',last_error=left(sqlerrm,1000),
  lease_worker_id=null,lease_token=null,lease_deadline=null,updated_at=transaction_timestamp() where id=r.id; end if;
 return jsonb_build_object('request_id',r.id,'status','failed','error',sqlerrm);
end $$;
revoke all on function public.claim_my_stuff_deletions_v4(text,integer,integer),public.ack_my_stuff_deletion_storage_v4(uuid,text,uuid,integer,integer,integer,text),public.finalize_my_stuff_deletion_v4(uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_my_stuff_deletions_v4(text,integer,integer),public.ack_my_stuff_deletion_storage_v4(uuid,text,uuid,integer,integer,integer,text),public.finalize_my_stuff_deletion_v4(uuid,text,uuid) to service_role;

alter table public.my_stuff_maintenance_baselines enable row level security;
alter table public.my_stuff_completion_corrections enable row level security;
alter table public.my_stuff_deletion_requests_v4 enable row level security;
alter table public.my_stuff_deleted_definition_history_v4 enable row level security;
revoke all on table public.my_stuff_maintenance_baselines,public.my_stuff_completion_corrections,public.my_stuff_deletion_requests_v4,public.my_stuff_deleted_definition_history_v4 from public,anon,authenticated;
grant select on public.my_stuff_maintenance_baselines,public.my_stuff_completion_corrections,public.my_stuff_deletion_requests_v4,public.my_stuff_deleted_definition_history_v4 to authenticated;
create policy owner_read on public.my_stuff_maintenance_baselines for select to authenticated using(user_id=(select auth.uid()));
create policy owner_read on public.my_stuff_completion_corrections for select to authenticated using(user_id=(select auth.uid()));
create policy owner_read on public.my_stuff_deletion_requests_v4 for select to authenticated using(user_id=(select auth.uid()));
create policy owner_read on public.my_stuff_deleted_definition_history_v4 for select to authenticated using(user_id=(select auth.uid()));

revoke all on function public.record_my_stuff_current_mileage_v4(uuid,numeric,timestamptz,text),public.record_my_stuff_current_reading_v4(uuid,text,numeric,timestamptz,text),public.get_my_stuff_maintenance_state_v4(uuid),public.setup_my_stuff_maintenance_preset_v4(uuid,jsonb,jsonb,timestamptz,text),public.complete_my_stuff_maintenance_v4(uuid,jsonb,timestamptz,text),public.edit_my_stuff_completion_v4(uuid,jsonb,text,integer,text,timestamptz,text),public.correct_my_stuff_completion_v4(uuid,jsonb,text,integer,text,timestamptz,text),public.get_my_stuff_maintenance_report_v4(uuid,integer,timestamptz,uuid),public.request_my_stuff_deletion_v4(text,uuid,text),public.get_my_stuff_deletion_status_v4(uuid) from public,anon,authenticated,service_role;
grant execute on function public.record_my_stuff_current_mileage_v4(uuid,numeric,timestamptz,text),public.record_my_stuff_current_reading_v4(uuid,text,numeric,timestamptz,text),public.get_my_stuff_maintenance_state_v4(uuid),public.setup_my_stuff_maintenance_preset_v4(uuid,jsonb,jsonb,timestamptz,text),public.complete_my_stuff_maintenance_v4(uuid,jsonb,timestamptz,text),public.edit_my_stuff_completion_v4(uuid,jsonb,text,integer,text,timestamptz,text),public.correct_my_stuff_completion_v4(uuid,jsonb,text,integer,text,timestamptz,text),public.get_my_stuff_maintenance_report_v4(uuid,integer,timestamptz,uuid),public.request_my_stuff_deletion_v4(text,uuid,text),public.get_my_stuff_deletion_status_v4(uuid) to authenticated;
-- No legacy grants, archive RPCs, or old-client writes are revoked in phase 1.
commit;
