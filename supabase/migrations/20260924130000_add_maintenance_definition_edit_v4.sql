begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Phase 1 is already installed and hash-pinned. This additive migration adds
-- explicit setup anchors, atomic first planning, a bounded one-snapshot export,
-- and the rollout-gated V4 definition editor without changing rollout state.
alter table public.my_stuff_maintenance_baselines add column anchor_mode text;
alter table public.my_stuff_maintenance_baselines add constraint my_stuff_baseline_anchor_mode_v4
 check(anchor_mode is null or anchor_mode in ('known','unknown','never')) not valid;
create or replace function public.get_my_stuff_maintenance_state_v4(p_definition_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public,private as $$
declare
 d public.my_stuff_maintenance_definitions%rowtype;
 i public.my_stuff_items%rowtype;
 b public.my_stuff_maintenance_baselines%rowtype;
 o public.my_stuff_service_occurrences%rowtype;
 s jsonb;
 base_date date;
 bm numeric;
 bh numeric;
 bc numeric;
 im numeric;
 ih numeric;
 ic numeric;
 months integer;
 nd date;
 nm numeric;
 nh numeric;
 nc numeric;
 status text;
 active_plan uuid;
 as_of_date date:=private.my_stuff_server_now_v4()::date;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 perform private.assert_my_stuff_integrity_v4_enabled();
 select * into d from public.my_stuff_maintenance_definitions
  where id=p_definition_id and user_id=auth.uid() and enabled and coalesce(lifecycle_state,'active')='active';
 if not found then raise exception 'Maintenance definition not found'; end if;
 select * into i from public.my_stuff_items where id=d.item_id and user_id=d.user_id;
 select * into b from public.my_stuff_maintenance_baselines where definition_id=d.id;
 select * into o from public.my_stuff_service_occurrences x where x.definition_id=d.id
  order by coalesce(x.received_at,x.created_at) desc,x.created_at desc,x.id desc limit 1;
 if o.id is not null then s:=private.my_stuff_effective_snapshot_v4(o.id); end if;
 if d.cadence_anchor='asset_origin' then
  base_date:=coalesce(i.in_service_on,i.acquired_on,i.created_at::date); bm:=i.origin_mileage; bh:=i.origin_hours; bc:=i.origin_cycles;
 elsif o.id is not null then
  base_date:=nullif(s->>'service_performed_on','')::date; bm:=nullif(s->>'service_mileage','')::numeric;
  bh:=nullif(s->>'service_hours','')::numeric; bc:=nullif(s->>'service_cycles','')::numeric;
 elsif b.definition_id is not null then
  -- A V4 setup baseline is authoritative even when an anchor is explicitly
  -- unknown/never. Never invent purchase/origin anchors for those nulls.
  base_date:=b.last_service_performed_on; bm:=b.last_service_mileage;
  bh:=b.last_service_hours; bc:=b.last_service_cycles;
 else
  base_date:=coalesce(i.in_service_on,i.acquired_on,i.created_at::date);
  bm:=i.origin_mileage; bh:=i.origin_hours; bc:=i.origin_cycles;
 end if;
 im:=case when o.id is null and d.first_interval_miles is not null then d.first_interval_miles when d.active_profile='severe' then coalesce(d.severe_interval_miles,d.normal_interval_miles) else d.normal_interval_miles end;
 ih:=case when o.id is null and d.first_interval_hours is not null then d.first_interval_hours when d.active_profile='severe' then coalesce(d.severe_interval_hours,d.normal_interval_hours) else d.normal_interval_hours end;
 ic:=case when o.id is null and d.first_interval_cycles is not null then d.first_interval_cycles when d.active_profile='severe' then coalesce(d.severe_interval_cycles,d.normal_interval_cycles) else d.normal_interval_cycles end;
 months:=case when o.id is null and d.first_calendar_months is not null then d.first_calendar_months when d.active_profile='severe' then coalesce(d.severe_calendar_months,d.normal_calendar_months) else d.normal_calendar_months end;
 nd:=case when base_date is null or months is null then null else base_date+make_interval(months=>months) end;
 nm:=case when bm is null or im is null then null else bm+im end;
 nh:=case when bh is null or ih is null then null else bh+ih end;
 nc:=case when bc is null or ic is null then null else bc+ic end;
 if months is null and im is null and ih is null and ic is null then status:='upcoming';
 elsif (months is not null and nd is null) or
   (im is not null and (nm is null or coalesce(i.effective_current_mileage,i.current_mileage) is null)) or
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
 select p.id into active_plan from public.my_stuff_planned_occurrences p
  where p.definition_id=d.id and p.user_id=d.user_id and p.status='not_completed'
  order by p.created_at desc,p.id desc limit 1;
 return jsonb_build_object('definition_id',d.id,'item_id',d.item_id,'lifecycle_state',d.lifecycle_state,'due_semantics',d.due_semantics,'active_profile',d.active_profile,
  'anchor_mode',b.anchor_mode,'last_service_performed_on',base_date,'last_service_mileage',bm,'last_service_hours',bh,'last_service_cycles',bc,
  'current_mileage',coalesce(i.effective_current_mileage,i.current_mileage),'current_hours',coalesce(i.effective_current_hours,i.current_hours),'current_cycles',coalesce(i.effective_current_cycles,i.current_cycles),
  'next_due_date',nd,'next_due_mileage',nm,'next_due_hours',nh,'next_due_cycles',nc,'due_status',status,'planned_occurrence_id',active_plan);
end $$;

create or replace function public.setup_my_stuff_maintenance_preset_v4(p_item_id uuid,p_definition jsonb,p_setup jsonb,p_device_now timestamptz,p_mutation_id text) returns jsonb
language plpgsql security definer set search_path=public,private,extensions as $$
declare
 u uuid:=auth.uid();
 t timestamptz:=private.my_stuff_server_now_v4();
 h text;
 prior text;
 result jsonb;
 did uuid;
 existing uuid;
 version_id uuid;
 plan_id uuid;
 plan_key text;
 state jsonb;
 i public.my_stuff_items%rowtype;
 d public.my_stuff_maintenance_definitions%rowtype;
 anchor text:=lower(trim(coalesce(p_setup->>'anchor_mode','')));
 sd date;
 sm numeric;
 sh numeric;
 sc numeric;
 cm numeric;
 ch numeric;
 cc numeric;
 configured_mileage boolean;
 configured_hours boolean;
 configured_cycles boolean;
 normalized_name text;
 action text;
begin
 if u is null then raise exception 'Authentication required'; end if;
 perform private.assert_my_stuff_integrity_v4_enabled();
 if jsonb_typeof(p_definition)<>'object' or jsonb_typeof(p_setup)<>'object' or pg_column_size(p_definition)>131072 or pg_column_size(p_setup)>65536 then raise exception 'INVALID_PRESET_SETUP'; end if;
 if exists(select 1 from jsonb_object_keys(p_setup) k where k not in ('anchor_mode','last_service_performed_on','last_service_mileage','last_service_hours','last_service_cycles','current_mileage','current_hours','current_cycles')) then raise exception 'INVALID_PRESET_SETUP'; end if;
 if anchor not in ('known','unknown','never') then raise exception 'INVALID_ANCHOR_MODE'; end if;
 sd:=nullif(p_setup->>'last_service_performed_on','')::date;
 sm:=nullif(p_setup->>'last_service_mileage','')::numeric;
 sh:=nullif(p_setup->>'last_service_hours','')::numeric;
 sc:=nullif(p_setup->>'last_service_cycles','')::numeric;
 cm:=nullif(p_setup->>'current_mileage','')::numeric;
 ch:=nullif(p_setup->>'current_hours','')::numeric;
 cc:=nullif(p_setup->>'current_cycles','')::numeric;
 if anchor<>'known' and num_nonnulls(sd,sm,sh,sc)>0 then raise exception 'ANCHOR_VALUES_REQUIRE_KNOWN_MODE'; end if;
 if sd is not null and (not isfinite(sd) or sd>t::date or sd<date '1900-01-01') then raise exception 'INVALID_SERVICE_PERFORMED_DATE'; end if;
 if (sm is not null and sm not between 0 and 1000000000) or (sh is not null and sh not between 0 and 1000000000) or (sc is not null and sc not between 0 and 1000000000) then raise exception 'INVALID_LAST_SERVICE_READING'; end if;
 if (cm is not null and cm not between 0 and 1000000000) or (ch is not null and ch not between 0 and 1000000000) or (cc is not null and (cc not between 0 and 1000000000 or trunc(cc)<>cc)) then raise exception 'INVALID_CURRENT_READING'; end if;
 if (sm is not null and cm is not null and sm>cm) or (sh is not null and ch is not null and sh>ch) or (sc is not null and cc is not null and sc>cc) then raise exception 'LAST_SERVICE_READING_EXCEEDS_CURRENT'; end if;
 normalized_name:=lower(regexp_replace(trim(p_definition->>'name'),'[[:space:]]+',' ','g'));
 action:=coalesce(p_definition->>'service_action','service');
 if normalized_name='' or length(trim(coalesce(p_mutation_id,''))) not between 1 and 160 then raise exception 'INVALID_PRESET_SETUP'; end if;
 h:=encode(digest(jsonb_build_object('kind','preset_setup_v4','item',p_item_id,'definition',p_definition,'setup',p_setup)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(u::text||':item:'||p_item_id::text,0));
 select request_hash,m.result into prior,result from public.my_stuff_v3_mutations m where user_id=u and mutation_id=trim(p_mutation_id);
 if found then if prior<>h then raise exception 'Idempotency key reused with different request'; end if; return result; end if;
 perform private.assert_my_stuff_device_clock_v4(p_device_now,t);
 select * into i from public.my_stuff_items where id=p_item_id and user_id=u for update;
 if not found then raise exception 'My Stuff item not found'; end if;
 configured_mileage:=num_nonnulls(nullif(p_definition->>'normal_interval_miles',''),nullif(p_definition->>'severe_interval_miles',''),nullif(p_definition->>'first_interval_miles',''),sm)>0;
 configured_hours:=num_nonnulls(nullif(p_definition->>'normal_interval_hours',''),nullif(p_definition->>'severe_interval_hours',''),nullif(p_definition->>'first_interval_hours',''),sh)>0;
 configured_cycles:=num_nonnulls(nullif(p_definition->>'normal_interval_cycles',''),nullif(p_definition->>'severe_interval_cycles',''),nullif(p_definition->>'first_interval_cycles',''),sc)>0;
 if (configured_mileage and not 'mileage'=any(i.usage_dimensions)) or (configured_hours and not 'hours'=any(i.usage_dimensions)) or (configured_cycles and not 'cycles'=any(i.usage_dimensions)) then raise exception 'READING_TYPE_NOT_TRACKED'; end if;
 if cm is not null and not 'mileage'=any(i.usage_dimensions) or ch is not null and not 'hours'=any(i.usage_dimensions) or cc is not null and not 'cycles'=any(i.usage_dimensions) then raise exception 'READING_TYPE_NOT_TRACKED'; end if;
 if sm is not null and coalesce(cm,i.effective_current_mileage,i.current_mileage) is not null and sm>coalesce(cm,i.effective_current_mileage,i.current_mileage)
    or sh is not null and coalesce(ch,i.effective_current_hours,i.current_hours) is not null and sh>coalesce(ch,i.effective_current_hours,i.current_hours)
    or sc is not null and coalesce(cc,i.effective_current_cycles,i.current_cycles) is not null and sc>coalesce(cc,i.effective_current_cycles,i.current_cycles) then raise exception 'LAST_SERVICE_READING_EXCEEDS_CURRENT'; end if;
 select id into existing from public.my_stuff_maintenance_definitions where user_id=u and item_id=p_item_id and enabled and coalesce(lifecycle_state,'active')='active' and lower(regexp_replace(trim(name),'[[:space:]]+',' ','g'))=normalized_name and service_action=action order by updated_at desc,id desc limit 1;
 if existing is not null then raise exception 'ACTIVE_PRESET_ALREADY_EXISTS'; end if;
 did:=public.create_my_stuff_maintenance_definition_v2(p_item_id,p_definition||jsonb_build_object('enabled',true),'v4-definition:'||trim(p_mutation_id));
 update public.my_stuff_maintenance_definitions set lifecycle_state='active' where id=did returning * into d;
 insert into public.my_stuff_maintenance_baselines(definition_id,user_id,item_id,anchor_mode,last_service_performed_on,last_service_mileage,last_service_hours,last_service_cycles,setup_received_at,device_now_telemetry,client_mutation_id,request_hash)
 values(did,u,p_item_id,anchor,sd,sm,sh,sc,t,p_device_now,trim(p_mutation_id),h);
 if cm is not null then perform public.record_my_stuff_current_reading_v4(p_item_id,'mileage',cm,p_device_now,'v4-setup-reading:mileage:'||h); end if;
 if ch is not null then perform public.record_my_stuff_current_reading_v4(p_item_id,'hours',ch,p_device_now,'v4-setup-reading:hours:'||h); end if;
 if cc is not null then perform public.record_my_stuff_current_reading_v4(p_item_id,'cycles',cc,p_device_now,'v4-setup-reading:cycles:'||h); end if;
 insert into public.my_stuff_definition_versions(user_id,item_id,definition_id,version_number,definition,provenance_type,client_mutation_id,request_hash)
 values(u,p_item_id,did,1,to_jsonb(d),d.provenance_type,'v4-setup-version:'||h,h) returning id into version_id;
 state:=public.get_my_stuff_maintenance_state_v4(did);
 plan_key:=encode(digest(jsonb_build_object('definition',did,'version',version_id,'date',state->'next_due_date','mileage',state->'next_due_mileage','hours',state->'next_due_hours','cycles',state->'next_due_cycles')::text,'sha256'),'hex');
 insert into public.my_stuff_planned_occurrences(user_id,item_id,definition_id,definition_version_id,occurrence_key,status,due_at,due_mileage,due_hours,due_cycles)
 values(u,p_item_id,did,version_id,plan_key,'not_completed',case when state->>'next_due_date' is null then null else (state->>'next_due_date')::date::timestamp at time zone 'UTC' end,nullif(state->>'next_due_mileage','')::numeric,nullif(state->>'next_due_hours','')::numeric,nullif(state->>'next_due_cycles','')::numeric)
 returning id into plan_id;
 result:=public.get_my_stuff_maintenance_state_v4(did)||jsonb_build_object('created_at',t,'anchor_mode',anchor,'version_id',version_id,'planned_occurrence_id',plan_id);
 insert into public.my_stuff_v3_mutations values(u,trim(p_mutation_id),'preset_setup_v4',h,result,t);
 return result;
exception when check_violation or numeric_value_out_of_range or invalid_text_representation or datetime_field_overflow then
 raise exception 'Preset setup contains an invalid or out-of-range value';
end $$;

create function public.update_my_stuff_maintenance_definition_v4(p_definition_id uuid,p_patch jsonb,p_device_now timestamptz,p_mutation_id text) returns jsonb
language plpgsql security definer set search_path=public,private,extensions as $$
declare
 u uuid:=auth.uid();
 t timestamptz:=private.my_stuff_server_now_v4();
 h text;
 prior text;
 result jsonb;
 d public.my_stuff_maintenance_definitions%rowtype;
 merged jsonb;
 unsupported text;
 version_id uuid;
 replaces_id uuid;
 next_version_number integer;
 state jsonb;
 successor_id uuid;
 successor_key text;
 old_plan record;
 i public.my_stuff_items%rowtype;
 configured_mileage boolean;
 configured_hours boolean;
 configured_cycles boolean;
 skipped_count integer:=0;
begin
 if u is null then raise exception 'Authentication required'; end if;
 perform private.assert_my_stuff_integrity_v4_enabled();
 if p_patch is null or jsonb_typeof(p_patch)<>'object' or p_patch='{}'::jsonb or pg_column_size(p_patch)>131072 then raise exception 'INVALID_DEFINITION_PATCH'; end if;
 if p_patch ?| array['enabled','lifecycle_state','id','user_id','item_id','client_mutation_id','request_hash','created_at','updated_at','first_service_completed','provenance','provenance_type','source_class','citation_url','citation_title','citation_page','citation_section','citation_accessed_on']
    or exists(select 1 from jsonb_object_keys(p_patch) k where k like 'provenance_%') then raise exception 'PROTECTED_DEFINITION_FIELD'; end if;
 select key into unsupported from jsonb_object_keys(p_patch) key where key not in
  ('name','description','service_category','service_action','due_semantics','active_profile','cadence_anchor',
   'normal_interval_miles','normal_interval_hours','normal_interval_cycles','normal_calendar_months',
   'severe_interval_miles','severe_interval_hours','severe_interval_cycles','severe_calendar_months',
   'first_interval_miles','first_interval_hours','first_interval_cycles','first_calendar_months',
   'due_soon_miles','due_soon_hours','due_soon_cycles','due_soon_days','uncertain','uncertainty_reason') limit 1;
 if unsupported is not null then raise exception 'Unsupported maintenance definition field: %',unsupported; end if;
 if length(trim(coalesce(p_mutation_id,''))) not between 1 and 160 then raise exception 'Mutation ID required'; end if;
 h:=encode(digest(jsonb_build_object('kind','definition_edit_v4','definition',p_definition_id,'patch',p_patch)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(u::text||':definition:'||p_definition_id::text,0));
 select request_hash,m.result into prior,result from public.my_stuff_v3_mutations m where user_id=u and mutation_id=trim(p_mutation_id);
 if found then
  if prior<>h then raise exception 'Idempotency key reused with different request'; end if;
  return result;
 end if;
 perform private.assert_my_stuff_device_clock_v4(p_device_now,t);
 select * into d from public.my_stuff_maintenance_definitions
  where id=p_definition_id and user_id=u and enabled and coalesce(lifecycle_state,'active')='active'
  for update;
 if not found then raise exception 'Maintenance definition not found'; end if;
 merged:=to_jsonb(d)||p_patch;
 select * into i from public.my_stuff_items where id=d.item_id and user_id=u;
 configured_mileage:=num_nonnulls(nullif(merged->>'normal_interval_miles',''),nullif(merged->>'severe_interval_miles',''),nullif(merged->>'first_interval_miles',''))>0;
 configured_hours:=num_nonnulls(nullif(merged->>'normal_interval_hours',''),nullif(merged->>'severe_interval_hours',''),nullif(merged->>'first_interval_hours',''))>0;
 configured_cycles:=num_nonnulls(nullif(merged->>'normal_interval_cycles',''),nullif(merged->>'severe_interval_cycles',''),nullif(merged->>'first_interval_cycles',''))>0;
 if (configured_mileage and not 'mileage'=any(i.usage_dimensions)) or (configured_hours and not 'hours'=any(i.usage_dimensions)) or (configured_cycles and not 'cycles'=any(i.usage_dimensions)) then raise exception 'READING_TYPE_NOT_TRACKED'; end if;
 update public.my_stuff_maintenance_definitions set
  name=trim(merged->>'name'),description=nullif(trim(coalesce(merged->>'description','')),''),service_category=merged->>'service_category',service_action=merged->>'service_action',
  due_semantics=merged->>'due_semantics',active_profile=merged->>'active_profile',cadence_anchor=merged->>'cadence_anchor',
  normal_interval_miles=nullif(merged->>'normal_interval_miles','')::numeric,normal_interval_hours=nullif(merged->>'normal_interval_hours','')::numeric,
  normal_interval_cycles=nullif(merged->>'normal_interval_cycles','')::numeric,normal_calendar_months=nullif(merged->>'normal_calendar_months','')::integer,
  severe_interval_miles=nullif(merged->>'severe_interval_miles','')::numeric,severe_interval_hours=nullif(merged->>'severe_interval_hours','')::numeric,
  severe_interval_cycles=nullif(merged->>'severe_interval_cycles','')::numeric,severe_calendar_months=nullif(merged->>'severe_calendar_months','')::integer,
  first_interval_miles=nullif(merged->>'first_interval_miles','')::numeric,first_interval_hours=nullif(merged->>'first_interval_hours','')::numeric,
  first_interval_cycles=nullif(merged->>'first_interval_cycles','')::numeric,first_calendar_months=nullif(merged->>'first_calendar_months','')::integer,
  due_soon_miles=(merged->>'due_soon_miles')::numeric,due_soon_hours=(merged->>'due_soon_hours')::numeric,
  due_soon_cycles=(merged->>'due_soon_cycles')::numeric,due_soon_days=(merged->>'due_soon_days')::integer,
  uncertain=(merged->>'uncertain')::boolean,uncertainty_reason=nullif(trim(coalesce(merged->>'uncertainty_reason','')),'')
 where id=p_definition_id;
 select v.id into replaces_id from public.my_stuff_definition_versions v where v.definition_id=p_definition_id order by v.version_number desc,v.id desc limit 1;
 select coalesce(max(v.version_number),0)+1 into next_version_number from public.my_stuff_definition_versions v where v.definition_id=p_definition_id;
 insert into public.my_stuff_definition_versions(user_id,item_id,definition_id,version_number,definition,provenance_type,replaces_version_id,client_mutation_id,request_hash)
 select u,d.item_id,p_definition_id,next_version_number,to_jsonb(current_definition),current_definition.provenance_type,replaces_id,trim(p_mutation_id),h
 from public.my_stuff_maintenance_definitions current_definition where current_definition.id=p_definition_id
 returning id into version_id;
 for old_plan in
  update public.my_stuff_planned_occurrences set status='skipped'
   where definition_id=p_definition_id and user_id=u and status='not_completed'
   returning id,item_id
 loop
  skipped_count:=skipped_count+1;
  insert into public.my_stuff_occurrence_status_events(user_id,item_id,planned_occurrence_id,status,source,reason,actor_id,client_mutation_id,request_hash)
  values(u,old_plan.item_id,old_plan.id,'skipped','system','Superseded by maintenance schedule edit.',u,
   'v4-edit-skip:'||trim(p_mutation_id)||':'||old_plan.id,h);
 end loop;
 state:=public.get_my_stuff_maintenance_state_v4(p_definition_id);
 successor_key:=encode(digest(jsonb_build_object('definition',p_definition_id,'version',version_id,'date',state->'next_due_date','mileage',state->'next_due_mileage','hours',state->'next_due_hours','cycles',state->'next_due_cycles')::text,'sha256'),'hex');
 insert into public.my_stuff_planned_occurrences(user_id,item_id,definition_id,definition_version_id,occurrence_key,status,due_at,due_mileage,due_hours,due_cycles)
 values(u,d.item_id,p_definition_id,version_id,successor_key,'not_completed',
  case when state->>'next_due_date' is null then null else (state->>'next_due_date')::date::timestamp at time zone 'UTC' end,
  nullif(state->>'next_due_mileage','')::numeric,nullif(state->>'next_due_hours','')::numeric,nullif(state->>'next_due_cycles','')::numeric)
 returning id into successor_id;
 result:=jsonb_build_object(
  'definition_id',p_definition_id,
  'version_id',version_id,
  'version_number',next_version_number,
  'updated_at',t,
  'skipped_occurrence_count',skipped_count,
  'planned_occurrence_id',successor_id,
  'state',public.get_my_stuff_maintenance_state_v4(p_definition_id)
 );
 insert into public.my_stuff_v3_mutations values(u,trim(p_mutation_id),'definition_edit_v4',h,result,t);
 return result;
exception when check_violation or numeric_value_out_of_range or invalid_text_representation or datetime_field_overflow then
 raise exception 'Maintenance definition contains an invalid or out-of-range value';
end $$;

create table private.my_stuff_integrity_export_cursor_secret_v4(
 singleton boolean primary key default true check(singleton),
 secret bytea not null check(octet_length(secret)=32),
 created_at timestamptz not null default transaction_timestamp()
);
insert into private.my_stuff_integrity_export_cursor_secret_v4(singleton,secret) values(true,gen_random_bytes(32));
revoke all on private.my_stuff_integrity_export_cursor_secret_v4 from public,anon,authenticated,service_role;

create table private.my_stuff_integrity_export_manifest_v4(
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 item_id uuid not null references public.my_stuff_items(id) on delete cascade,
 snapshot_at timestamptz not null,
 expires_at timestamptz not null,
 item_snapshot jsonb not null check(jsonb_typeof(item_snapshot)='object'),
 entries jsonb not null check(jsonb_typeof(entries)='array'),
 completion_total integer not null check(completion_total>=0),
 correction_total integer not null check(correction_total>=0),
 attachment_total integer not null check(attachment_total>=0)
);
create index my_stuff_integrity_export_manifest_v4_expiry_idx on private.my_stuff_integrity_export_manifest_v4(user_id,expires_at);
revoke all on private.my_stuff_integrity_export_manifest_v4 from public,anon,authenticated,service_role;

create function public.get_my_stuff_maintenance_integrity_export_v4(p_item_id uuid,p_limit integer default 25,p_cursor_token text default null) returns jsonb
language plpgsql volatile security definer set search_path=public,private,extensions as $$
declare
 manifest_id uuid; snapshot_at timestamptz; expires_at timestamptz; offset_count integer:=0;
 item_snapshot jsonb; manifest_entries jsonb; cursor_payload jsonb; cursor_payload_text text; cursor_encoded text;
 cursor_signature text; expected_signature text; cursor_secret bytea;
 entries jsonb; returned_count integer; remaining_count integer; completion_total integer;
 correction_total integer; attachment_total integer; page_correction_count integer; page_attachment_count integer;
 next_offset integer; next_cursor_token text; payload jsonb; canonical_text text; envelope jsonb;
 disclaimer constant text:='Owner-provided maintenance history. Verify records and follow the manufacturer owner’s manual and qualified-service guidance.';
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 perform private.assert_my_stuff_integrity_v4_enabled();
 if p_limit not between 1 and 100 then raise exception 'EXPORT_LIMIT_OUT_OF_RANGE'; end if;
 select secret into cursor_secret from private.my_stuff_integrity_export_cursor_secret_v4 where singleton;
 if cursor_secret is null then raise exception 'EXPORT_CURSOR_SECRET_MISSING'; end if;
 delete from private.my_stuff_integrity_export_manifest_v4 m where m.expires_at<transaction_timestamp();
 if p_cursor_token is null then
  with owned as (
   select i.id,jsonb_build_object('item_id',i.id,'name',i.name,'item_type',i.item_type,
    'effective_current_mileage',coalesce(i.effective_current_mileage,i.current_mileage),
    'effective_current_hours',coalesce(i.effective_current_hours,i.current_hours),
    'effective_current_cycles',coalesce(i.effective_current_cycles,i.current_cycles)) item
   from public.my_stuff_items i where i.id=p_item_id and i.user_id=auth.uid()
  ), built as (
   select coalesce(o.received_at,o.created_at) sort_at,o.id,
    (select count(*) from public.my_stuff_completion_corrections c where c.occurrence_id=o.id) correction_count,
    (select count(*) from public.my_stuff_attachments a join public.my_stuff_service_occurrence_revisions r on r.id=a.service_revision_id where r.occurrence_id=o.id and a.user_id=o.user_id and a.item_id=o.item_id and a.state='finalized') attachment_count,
    jsonb_build_object(
     'occurrence_id',o.id,'definition_id',o.definition_id,'historical_locked_from_window_edit',o.integrity_version is distinct from 4,'historical_correctable',true,
     'original',private.my_stuff_report_snapshot_v4(private.my_stuff_original_snapshot_v4(o.id))||jsonb_build_object('service_name',o.service_name,'received_at',o.received_at,'submitted_at',o.submitted_at,'lock_deadline',o.lock_deadline),
     'original_snapshot_sha256',encode(digest(private.my_stuff_original_snapshot_v4(o.id)::text,'sha256'),'hex'),
     'correction_chain',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'number',c.correction_number,'type',c.correction_type,'reason',c.reason,'received_at',c.received_at,'snapshot',private.my_stuff_report_snapshot_v4(c.service_snapshot),'snapshot_sha256',c.snapshot_sha256) order by c.correction_number,c.id) from public.my_stuff_completion_corrections c where c.occurrence_id=o.id),'[]'::jsonb),
     'correction_count_total',(select count(*) from public.my_stuff_completion_corrections c where c.occurrence_id=o.id),
     'effective',private.my_stuff_report_snapshot_v4(coalesce((select c.service_snapshot from public.my_stuff_completion_corrections c where c.occurrence_id=o.id order by c.correction_number desc,c.id desc limit 1),private.my_stuff_original_snapshot_v4(o.id))),
     'effective_snapshot_sha256',encode(digest(coalesce((select c.service_snapshot from public.my_stuff_completion_corrections c where c.occurrence_id=o.id order by c.correction_number desc,c.id desc limit 1),private.my_stuff_original_snapshot_v4(o.id))::text,'sha256'),'hex'),
     'attachment_hashes',coalesce((select jsonb_agg(jsonb_build_object('sha256',a.sha256,'byte_size',a.byte_size,'media_type',a.media_type) order by a.id) from public.my_stuff_attachments a join public.my_stuff_service_occurrence_revisions r on r.id=a.service_revision_id where r.occurrence_id=o.id and a.user_id=o.user_id and a.item_id=o.item_id and a.state='finalized'),'[]'::jsonb),
     'attachment_count_total',(select count(*) from public.my_stuff_attachments a join public.my_stuff_service_occurrence_revisions r on r.id=a.service_revision_id where r.occurrence_id=o.id and a.user_id=o.user_id and a.item_id=o.item_id and a.state='finalized')
    ) entry
   from public.my_stuff_service_occurrences o join owned i on i.id=o.item_id
  ), aggregate_all as (
   select coalesce(jsonb_agg(entry order by sort_at desc,id desc),'[]'::jsonb) entries,count(*)::integer completion_total,
    coalesce(sum(correction_count),0)::integer correction_total,coalesce(sum(attachment_count),0)::integer attachment_total from built
  )
  insert into private.my_stuff_integrity_export_manifest_v4(user_id,item_id,snapshot_at,expires_at,item_snapshot,entries,completion_total,correction_total,attachment_total)
  select auth.uid(),p_item_id,transaction_timestamp(),transaction_timestamp()+interval '1 hour',owned.item,aggregate_all.entries,aggregate_all.completion_total,aggregate_all.correction_total,aggregate_all.attachment_total
  from owned cross join aggregate_all
  returning id,private.my_stuff_integrity_export_manifest_v4.snapshot_at,private.my_stuff_integrity_export_manifest_v4.expires_at,
   private.my_stuff_integrity_export_manifest_v4.item_snapshot,private.my_stuff_integrity_export_manifest_v4.entries,
   private.my_stuff_integrity_export_manifest_v4.completion_total,private.my_stuff_integrity_export_manifest_v4.correction_total,
   private.my_stuff_integrity_export_manifest_v4.attachment_total
  into manifest_id,snapshot_at,expires_at,item_snapshot,manifest_entries,completion_total,correction_total,attachment_total;
  if manifest_id is null then raise exception 'My Stuff item not found'; end if;
 else
  if length(p_cursor_token)>8192 or p_cursor_token !~ '^[A-Za-z0-9+/=]+[.][0-9a-f]{64}$' then raise exception 'INVALID_EXPORT_CURSOR'; end if;
  cursor_encoded:=split_part(p_cursor_token,'.',1); cursor_signature:=split_part(p_cursor_token,'.',2);
  expected_signature:=encode(hmac(convert_to(cursor_encoded,'UTF8'),cursor_secret,'sha256'),'hex');
  if cursor_signature is distinct from expected_signature then raise exception 'INVALID_EXPORT_CURSOR'; end if;
  begin
   cursor_payload_text:=convert_from(decode(cursor_encoded,'base64'),'UTF8'); cursor_payload:=cursor_payload_text::jsonb;
   manifest_id:=(cursor_payload->>'manifest_id')::uuid; offset_count:=(cursor_payload->>'offset')::integer;
  exception when others then raise exception 'INVALID_EXPORT_CURSOR'; end;
  if (cursor_payload->>'version')::integer<>2 or (cursor_payload->>'user_id')::uuid<>auth.uid() or (cursor_payload->>'item_id')::uuid<>p_item_id or offset_count<0 then raise exception 'INVALID_EXPORT_CURSOR'; end if;
  select m.snapshot_at,m.expires_at,m.item_snapshot,m.entries,m.completion_total,m.correction_total,m.attachment_total
   into snapshot_at,expires_at,item_snapshot,manifest_entries,completion_total,correction_total,attachment_total
   from private.my_stuff_integrity_export_manifest_v4 m
   where m.id=manifest_id and m.user_id=auth.uid() and m.item_id=p_item_id and m.expires_at>=transaction_timestamp();
  if not found then raise exception 'INVALID_EXPORT_CURSOR'; end if;
 end if;
 if offset_count>completion_total then raise exception 'INVALID_EXPORT_CURSOR'; end if;
 select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb),count(*)::integer,
  coalesce(sum(jsonb_array_length(value->'correction_chain')),0)::integer,
  coalesce(sum(jsonb_array_length(value->'attachment_hashes')),0)::integer
 into entries,returned_count,page_correction_count,page_attachment_count
 from (select value,ordinality from jsonb_array_elements(manifest_entries) with ordinality where ordinality>offset_count order by ordinality limit p_limit) page_rows;
 next_offset:=offset_count+returned_count;
 remaining_count:=completion_total-next_offset;
 if next_offset<completion_total then
  cursor_payload:=jsonb_build_object('version',2,'user_id',auth.uid(),'item_id',p_item_id,'manifest_id',manifest_id,'offset',next_offset);
  cursor_encoded:=regexp_replace(encode(convert_to(cursor_payload::text,'UTF8'),'base64'),'[[:space:]]','','g');
  next_cursor_token:=cursor_encoded||'.'||encode(hmac(convert_to(cursor_encoded,'UTF8'),cursor_secret,'sha256'),'hex');
 end if;
 payload:=jsonb_build_object(
  'schema_version',4,'owner_report_disclaimer',disclaimer,'snapshot_at',snapshot_at,'item',item_snapshot,'completions',entries,
  'page',jsonb_build_object('limit',p_limit,'returned_count',returned_count,'remaining_count',remaining_count,'total_count',completion_total,
    'complete',next_offset=completion_total,'truncated',next_offset<completion_total,'next_cursor_token',next_cursor_token,
    'correction_total',correction_total,'correction_returned',page_correction_count,'attachment_total',attachment_total,'attachment_returned',page_attachment_count),
  'canonical_hash_scope','single immutable-manifest export page represented by canonical_payload_text');
 canonical_text:=payload::text;
 envelope:=jsonb_build_object('canonical_payload_text',canonical_text,'canonical_snapshot_sha256',encode(digest(canonical_text,'sha256'),'hex'),'integrity_status','verified');
 if octet_length(convert_to(envelope::text,'UTF8'))>4194304 then raise exception 'EXPORT_PAGE_TOO_LARGE'; end if;
 return envelope;
end $$;

-- Replace the Phase 1 report RPC so already-installed ledgers use after-page remaining counts.
create or replace function public.get_my_stuff_maintenance_report_v4(p_item_id uuid,p_limit integer default 500,p_after_received_at timestamptz default null,p_after_occurrence_id uuid default null) returns jsonb
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
 remaining_count:=remaining_count-returned_count;
 snapshot:=jsonb_build_object('schema_version',4,'owner_report_disclaimer',disclaimer,'generated_at',generated,'item',item_snapshot,'completions',entries,
  'page',jsonb_build_object('limit',p_limit,'returned_count',returned_count,'remaining_count',remaining_count,'total_count',total_count,'complete',remaining_count=0,'truncated',remaining_count>0,
    'next_after_received_at',case when remaining_count>0 then (select coalesce(o.received_at,o.created_at) from public.my_stuff_service_occurrences o where o.id=(entries->-1->>'occurrence_id')::uuid) end,
    'next_after_occurrence_id',case when remaining_count>0 then entries->-1->>'occurrence_id' end));
 return snapshot||jsonb_build_object('snapshot_sha256',encode(digest(snapshot::text,'sha256'),'hex'),'integrity_status','verified');
end $$;

revoke all on function public.setup_my_stuff_maintenance_preset_v4(uuid,jsonb,jsonb,timestamptz,text) from public,anon,authenticated,service_role;
grant execute on function public.setup_my_stuff_maintenance_preset_v4(uuid,jsonb,jsonb,timestamptz,text) to authenticated;
revoke all on function public.get_my_stuff_maintenance_integrity_export_v4(uuid,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.get_my_stuff_maintenance_integrity_export_v4(uuid,integer,text) to authenticated;

revoke all on function public.update_my_stuff_maintenance_definition_v4(uuid,jsonb,timestamptz,text) from public,anon,authenticated,service_role;
grant execute on function public.update_my_stuff_maintenance_definition_v4(uuid,jsonb,timestamptz,text) to authenticated;

commit;
