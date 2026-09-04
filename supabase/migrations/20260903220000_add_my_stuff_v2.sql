-- SideFlip My Stuff V2 additive schema and authoritative RPCs.
-- REVIEW ONLY: never apply to Production without separate approval.
-- Installed V1 tables and RPC signatures/definitions are intentionally preserved.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regclass('public.my_stuff_items') is null
     or to_regclass('public.my_stuff_schedules') is null
     or to_regclass('public.my_stuff_service_logs') is null then
    raise exception 'My Stuff V1 must be installed before My Stuff V2';
  end if;
  if to_regprocedure('public.user_has_verified_pro_entitlement(uuid)') is null then
    raise exception 'Required authoritative entitlement helper is missing';
  end if;
end $$;

-- Trusted provenance writers live outside the API-exposed public schema.
create schema if not exists private;
revoke all on schema private from public,anon,authenticated;
grant usage on schema private to service_role;

-- Additive project marker. Old clients ignore it; transfer never changes accounting.
alter table public.projects add column if not exists my_stuff_archived_at timestamptz;

alter table public.my_stuff_items
  add column item_type text,
  add column custom_name text,
  add column model_year integer,
  add column manufacturer text,
  add column make text,
  add column model text,
  add column trim text,
  add column model_number text,
  add column engine text,
  add column engine_model text,
  add column transmission text,
  add column drivetrain text,
  add column fuel_power_type text,
  add column serial_number text,
  add column engine_serial text,
  add column vin text,
  add column hull_number text,
  add column registration_number text,
  add column purchase_price numeric,
  add column purchase_currency text,
  add column purchase_vendor text,
  add column primary_photo_url text,
  add column usage_dimensions text[] not null default '{}'::text[],
  add column current_cycles numeric,
  add column usage_profile text not null default 'normal',
  add column manufactured_on date,
  add column in_service_on date,
  add column origin_mileage numeric,
  add column origin_hours numeric,
  add column origin_cycles numeric,
  -- V1 meter columns remain monotonic. Corrections change only these protected
  -- effective values and append an immutable reading.
  add column effective_current_mileage numeric,
  add column effective_current_hours numeric,
  add column effective_current_cycles numeric,
  add column archived_at timestamptz,
  add column archive_reason text,
  add column v2_request_hash text;

-- NOT VALID avoids scanning/rejecting historical V1 rows. These constraints involve
-- only V2 columns; rich V2 RPCs also validate before writing friendly errors.
alter table public.my_stuff_items
  add constraint my_stuff_items_v2_identity_bounds check (
    length(coalesce(item_type,'')) <= 40 and length(coalesce(custom_name,'')) <= 200
    and length(coalesce(manufacturer,'')) <= 200 and length(coalesce(make,'')) <= 200
    and length(coalesce(model,'')) <= 200 and length(coalesce(trim,'')) <= 200
    and length(coalesce(model_number,'')) <= 200 and length(coalesce(engine,'')) <= 500
    and length(coalesce(engine_model,'')) <= 200 and length(coalesce(transmission,'')) <= 200
    and length(coalesce(drivetrain,'')) <= 100 and length(coalesce(fuel_power_type,'')) <= 100
    and length(coalesce(serial_number,'')) <= 200 and length(coalesce(engine_serial,'')) <= 200
    and length(coalesce(vin,'')) <= 64 and length(coalesce(hull_number,'')) <= 100
    and length(coalesce(registration_number,'')) <= 100 and length(coalesce(purchase_vendor,'')) <= 500
    and length(coalesce(primary_photo_url,'')) <= 2048 and length(coalesce(archive_reason,'')) <= 2000
    and length(coalesce(v2_request_hash,'')) <= 32
  ) not valid,
  add constraint my_stuff_items_v2_values check (
    (model_year is null or model_year between 1800 and 2200)
    and (purchase_price is null or (purchase_price >= 0 and purchase_price <= 1000000000))
    and (purchase_currency is null or purchase_currency ~ '^[A-Z]{3}$')
    and usage_profile in ('normal','severe')
    and usage_dimensions <@ array['mileage','hours','time','cycles']::text[]
    and cardinality(usage_dimensions) <= 4
    and (current_cycles is null or (current_cycles >= 0 and current_cycles <= 1000000000))
    and (origin_mileage is null or (origin_mileage >= 0 and origin_mileage <= 1000000000))
    and (origin_hours is null or (origin_hours >= 0 and origin_hours <= 1000000000))
    and (origin_cycles is null or (origin_cycles >= 0 and origin_cycles <= 1000000000))
    and (effective_current_mileage is null or (effective_current_mileage >= 0 and effective_current_mileage <= 1000000000))
    and (effective_current_hours is null or (effective_current_hours >= 0 and effective_current_hours <= 1000000000))
    and (effective_current_cycles is null or (effective_current_cycles >= 0 and effective_current_cycles <= 1000000000))
  ) not valid,
  add constraint my_stuff_items_v2_dates check (
    (manufactured_on is null or (isfinite(manufactured_on) and manufactured_on between date '1800-01-01' and date '2200-12-31'))
    and (in_service_on is null or (isfinite(in_service_on) and in_service_on between date '1800-01-01' and date '2200-12-31'))
    and (archived_at is null or (isfinite(archived_at) and archived_at between timestamptz '1900-01-01Z' and timestamptz '2200-12-31 23:59:59Z'))
  ) not valid;
create index my_stuff_items_active_owner_idx on public.my_stuff_items(user_id,created_at desc) where archived_at is null;

create table public.my_stuff_v2_mutations (
  user_id uuid not null references auth.users(id) on delete cascade,
  mutation_id text not null,
  operation text not null,
  request_hash text not null,
  result_id uuid not null,
  created_at timestamptz not null default now(),
  primary key(user_id,mutation_id),
  check(length(trim(mutation_id)) between 1 and 200),
  check(length(operation) between 1 and 80),
  check(request_hash ~ '^[0-9a-f]{32}$')
);

create table public.my_stuff_readings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null,
  reading_type text not null check(reading_type in ('mileage','hours','cycles')),
  reading_value numeric not null check(reading_value between 0 and 1000000000),
  recorded_at timestamptz not null check(isfinite(recorded_at) and recorded_at between timestamptz '1900-01-01Z' and timestamptz '2200-12-31 23:59:59Z'),
  source text not null check(source in ('manual','service','transfer','import','correction')),
  corrects_reading_id uuid,
  correction_reason text,
  metadata jsonb not null default '{}'::jsonb,
  client_mutation_id text not null,
  created_at timestamptz not null default now(),
  unique(user_id,client_mutation_id), unique(id,user_id,item_id),
  foreign key(item_id,user_id) references public.my_stuff_items(id,user_id) on delete cascade,
  foreign key(corrects_reading_id,user_id,item_id) references public.my_stuff_readings(id,user_id,item_id),
  check(length(trim(client_mutation_id)) between 1 and 200),
  check(length(coalesce(correction_reason,'')) <= 2000),
  check(jsonb_typeof(metadata)='object' and pg_column_size(metadata)<=32768),
  check((source='correction' and corrects_reading_id is not null and length(trim(correction_reason))>0)
     or (source<>'correction' and corrects_reading_id is null and correction_reason is null))
);
create index my_stuff_readings_effective_idx on public.my_stuff_readings(user_id,item_id,reading_type,created_at desc,id desc);

create table public.my_stuff_maintenance_definitions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null,
  name text not null,
  description text,
  service_category text not null default 'other',
  service_action text not null default 'service' check(service_action in ('inspect','check','adjust','replace','repair','service','lubricate','clean','other')),
  due_semantics text not null default 'whichever_first' check(due_semantics in ('whichever_first','all')),
  active_profile text not null default 'normal' check(active_profile in ('normal','severe')),
  cadence_anchor text not null default 'last_completion' check(cadence_anchor in ('asset_origin','last_completion')),
  normal_interval_miles numeric, normal_interval_hours numeric, normal_interval_cycles numeric, normal_calendar_months integer,
  severe_interval_miles numeric, severe_interval_hours numeric, severe_interval_cycles numeric, severe_calendar_months integer,
  first_interval_miles numeric, first_interval_hours numeric, first_interval_cycles numeric, first_calendar_months integer,
  due_soon_miles numeric not null default 500, due_soon_hours numeric not null default 10,
  due_soon_cycles numeric not null default 10, due_soon_days integer not null default 30,
  first_service_completed boolean not null default false,
  provenance_type text not null default 'manual' check(provenance_type in ('manual','ai_research','transfer','import')),
  source_class text check(source_class in ('manufacturer_manual','manufacturer_guide','manufacturer_service','dealer','secondary','user')),
  citation_url text, citation_title text, citation_page text, citation_section text, citation_accessed_on date,
  uncertain boolean not null default false, uncertainty_reason text,
  enabled boolean not null default true,
  client_mutation_id text not null,
  request_hash text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id,client_mutation_id), unique(id,user_id,item_id),
  foreign key(item_id,user_id) references public.my_stuff_items(id,user_id) on delete cascade,
  check(length(trim(name)) between 1 and 200 and length(coalesce(description,''))<=10000),
  check(length(service_category) between 1 and 80),
  check(length(coalesce(citation_url,''))<=2048 and length(coalesce(citation_title,''))<=500
    and length(coalesce(citation_page,''))<=100 and length(coalesce(citation_section,''))<=500
    and length(coalesce(uncertainty_reason,''))<=2000),
  check((not uncertain) or length(trim(coalesce(uncertainty_reason,'')))>0),
  check(citation_accessed_on is null or (isfinite(citation_accessed_on) and citation_accessed_on between date '1900-01-01' and date '2200-12-31')),
  check(num_nonnulls(normal_interval_miles,normal_interval_hours,normal_interval_cycles,normal_calendar_months,
                     severe_interval_miles,severe_interval_hours,severe_interval_cycles,severe_calendar_months,
                     first_interval_miles,first_interval_hours,first_interval_cycles,first_calendar_months)>0),
  check((normal_interval_miles is null or normal_interval_miles between 1 and 10000000)
    and (normal_interval_hours is null or normal_interval_hours between 1 and 10000000)
    and (normal_interval_cycles is null or normal_interval_cycles between 1 and 1000000000)
    and (normal_calendar_months is null or normal_calendar_months between 1 and 1200)
    and (severe_interval_miles is null or severe_interval_miles between 1 and 10000000)
    and (severe_interval_hours is null or severe_interval_hours between 1 and 10000000)
    and (severe_interval_cycles is null or severe_interval_cycles between 1 and 1000000000)
    and (severe_calendar_months is null or severe_calendar_months between 1 and 1200)
    and (first_interval_miles is null or first_interval_miles between 1 and 10000000)
    and (first_interval_hours is null or first_interval_hours between 1 and 10000000)
    and (first_interval_cycles is null or first_interval_cycles between 1 and 1000000000)
    and (first_calendar_months is null or first_calendar_months between 1 and 1200)
    and due_soon_miles between 0 and 10000000 and due_soon_hours between 0 and 10000000
    and due_soon_cycles between 0 and 1000000000 and due_soon_days between 0 and 36500)
);
create index my_stuff_definition_item_idx on public.my_stuff_maintenance_definitions(user_id,item_id,enabled);
create trigger my_stuff_maintenance_definitions_set_updated_at before update on public.my_stuff_maintenance_definitions
for each row execute function public.set_my_stuff_updated_at();

create table public.my_stuff_service_occurrences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null,
  definition_id uuid,
  service_name text not null,
  service_category text not null default 'other',
  service_action text not null default 'service',
  scheduled boolean not null,
  completed_at timestamptz not null,
  mileage numeric, hours numeric, cycles numeric,
  provenance_type text not null default 'user_entered' check(provenance_type in ('user_entered','project_expense_snapshot','import')),
  provenance jsonb not null default '{}'::jsonb,
  client_mutation_id text not null,
  request_hash text not null,
  created_at timestamptz not null default now(),
  unique(user_id,client_mutation_id), unique(id,user_id,item_id),
  foreign key(item_id,user_id) references public.my_stuff_items(id,user_id) on delete cascade,
  foreign key(definition_id,user_id,item_id) references public.my_stuff_maintenance_definitions(id,user_id,item_id) on delete set null(definition_id),
  check(length(trim(service_name)) between 1 and 200 and length(service_category) between 1 and 80),
  check(service_action in ('inspect','check','adjust','replace','repair','service','lubricate','clean','other')),
  check((scheduled and definition_id is not null) or (not scheduled and definition_id is null)),
  check(isfinite(completed_at) and completed_at between timestamptz '1900-01-01Z' and timestamptz '2200-12-31 23:59:59Z'),
  check((mileage is null or mileage between 0 and 1000000000) and (hours is null or hours between 0 and 1000000000) and (cycles is null or cycles between 0 and 1000000000)),
  check(jsonb_typeof(provenance)='object' and pg_column_size(provenance)<=65536),
  check(length(trim(client_mutation_id)) between 1 and 200)
);
create index my_stuff_occurrence_item_time_idx on public.my_stuff_service_occurrences(user_id,item_id,completed_at desc,created_at desc);

create table public.my_stuff_service_occurrence_revisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null,
  occurrence_id uuid not null,
  revision_number integer not null check(revision_number between 1 and 1000000),
  parts jsonb not null default '[]', labor jsonb not null default '[]', vendor jsonb not null default '{}',
  warranty jsonb not null default '{}', notes text, attachment_metadata jsonb not null default '[]',
  revision_reason text, client_mutation_id text not null, request_hash text not null,
  created_at timestamptz not null default now(),
  unique(occurrence_id,revision_number), unique(user_id,client_mutation_id),
  foreign key(occurrence_id,user_id,item_id) references public.my_stuff_service_occurrences(id,user_id,item_id) on delete cascade,
  check(jsonb_typeof(parts)='array' and jsonb_typeof(labor)='array' and jsonb_typeof(vendor)='object'
    and jsonb_typeof(warranty)='object' and jsonb_typeof(attachment_metadata)='array'),
  check(pg_column_size(parts)<=131072 and pg_column_size(labor)<=131072 and pg_column_size(vendor)<=32768
    and pg_column_size(warranty)<=32768 and pg_column_size(attachment_metadata)<=65536),
  check(length(coalesce(notes,''))<=20000 and length(coalesce(revision_reason,''))<=2000 and length(trim(client_mutation_id)) between 1 and 200)
);

create table public.my_stuff_service_audit (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null, occurrence_id uuid not null, revision_id uuid not null,
  action text not null check(action in ('created','revised')), actor_id uuid not null,
  metadata jsonb not null default '{}', created_at timestamptz not null default now(),
  foreign key(occurrence_id,user_id,item_id) references public.my_stuff_service_occurrences(id,user_id,item_id) on delete cascade,
  foreign key(revision_id) references public.my_stuff_service_occurrence_revisions(id) on delete cascade,
  check(jsonb_typeof(metadata)='object' and pg_column_size(metadata)<=32768)
);

create table public.my_stuff_project_transfers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null, -- deliberately no FK: provenance survives project deletion
  item_id uuid not null,
  project_disposition text not null check(project_disposition in ('preserve','archive')),
  project_snapshot jsonb not null,
  selected_expense_snapshot jsonb not null default '[]',
  service_expense_ids uuid[] not null default '{}',
  copied_fields text[] not null,
  client_mutation_id text not null,
  request_hash text not null,
  created_at timestamptz not null default now(),
  unique(user_id,project_id), unique(user_id,client_mutation_id), unique(item_id),
  foreign key(item_id,user_id) references public.my_stuff_items(id,user_id) on delete cascade,
  check(length(trim(client_mutation_id)) between 1 and 200 and cardinality(copied_fields) between 1 and 64),
  check(jsonb_typeof(project_snapshot)='object' and pg_column_size(project_snapshot)<=262144),
  check(jsonb_typeof(selected_expense_snapshot)='array' and pg_column_size(selected_expense_snapshot)<=524288)
);

create function public.prevent_my_stuff_v2_immutable_update() returns trigger language plpgsql set search_path=public
as $$
begin
  -- FK cascades must still remove owned history when its item/account is deleted.
  if tg_op='DELETE' and pg_trigger_depth()>1 then return old; end if;
  raise exception '% rows are immutable; append a correction or revision',tg_table_name;
end $$;
create trigger my_stuff_readings_immutable before update or delete on public.my_stuff_readings for each row execute function public.prevent_my_stuff_v2_immutable_update();
create trigger my_stuff_occurrences_immutable before update or delete on public.my_stuff_service_occurrences for each row execute function public.prevent_my_stuff_v2_immutable_update();
create trigger my_stuff_occurrence_revisions_immutable before update or delete on public.my_stuff_service_occurrence_revisions for each row execute function public.prevent_my_stuff_v2_immutable_update();
create trigger my_stuff_service_audit_immutable before update or delete on public.my_stuff_service_audit for each row execute function public.prevent_my_stuff_v2_immutable_update();
create trigger my_stuff_transfers_immutable before update or delete on public.my_stuff_project_transfers for each row execute function public.prevent_my_stuff_v2_immutable_update();

-- Shadow V1 meter changes into protected effective values. Authenticated clients
-- have no column grant for these fields and this trigger function is not executable,
-- so no session setting can authorize a rewind.
create function public.sync_my_stuff_effective_readings_v2() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if tg_op='INSERT' or new.current_mileage is distinct from old.current_mileage then new.effective_current_mileage:=new.current_mileage; end if;
  if tg_op='INSERT' or new.current_hours is distinct from old.current_hours then new.effective_current_hours:=new.current_hours; end if;
  if tg_op='INSERT' or new.current_cycles is distinct from old.current_cycles then new.effective_current_cycles:=new.current_cycles; end if;
  return new;
end $$;
create trigger my_stuff_items_sync_effective_readings_v2
before insert or update of current_mileage,current_hours,current_cycles on public.my_stuff_items
for each row execute function public.sync_my_stuff_effective_readings_v2();

create function public.create_my_stuff_item_v2(p_item jsonb,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_hash text; v_id uuid; v_old_hash text; v_dims text[];
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_item)<>'object' or pg_column_size(p_item)>131072 then raise exception 'Item must be a bounded object'; end if;
  if nullif(trim(p_mutation_id),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required and must not exceed 200 characters'; end if;
  v_hash:=md5(p_item::text); perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  select result_id,request_hash into v_id,v_old_hash from public.my_stuff_v2_mutations where user_id=v_user and mutation_id=trim(p_mutation_id);
  if found then if v_old_hash<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return v_id; end if;
  if not public.user_has_verified_pro_entitlement(v_user) and exists(select 1 from public.my_stuff_items where user_id=v_user) then raise exception 'Free accounts can have one My Stuff item. SideFlip Pro is required for additional items.'; end if;
  if nullif(trim(p_item->>'name'),'') is null or length(p_item->>'name')>200 then raise exception 'Item name is required and must not exceed 200 characters'; end if;
  if coalesce(p_item->>'item_type','other') not in ('car','truck','motorcycle','boat','atv','side_by_side','mower','tractor','trailer','generator','rv','equipment','bicycle','watch','electronics','gaming','tool','exercise','instrument','furniture','house','other') then raise exception 'Invalid item type'; end if;
  select coalesce(array_agg(x),array[]::text[]) into v_dims from jsonb_array_elements_text(coalesce(p_item->'usage_dimensions','[]')) x;
  if cardinality(v_dims)>4 or not v_dims <@ array['mileage','hours','time','cycles']::text[] then raise exception 'Invalid usage dimensions'; end if;
  insert into public.my_stuff_items(user_id,name,category,acquired_on,notes,current_mileage,current_hours,current_cycles,client_mutation_id,
    item_type,custom_name,model_year,manufacturer,make,model,trim,model_number,engine,engine_model,transmission,drivetrain,fuel_power_type,
    serial_number,engine_serial,vin,hull_number,registration_number,purchase_price,purchase_currency,purchase_vendor,primary_photo_url,
    usage_dimensions,usage_profile,manufactured_on,in_service_on,origin_mileage,origin_hours,origin_cycles,v2_request_hash)
  values(v_user,trim(p_item->>'name'),coalesce(nullif(trim(p_item->>'category'),''),coalesce(p_item->>'item_type','other')),
    nullif(p_item->>'acquired_on','')::date,nullif(trim(coalesce(p_item->>'notes','')),''),nullif(p_item->>'current_mileage','')::numeric,
    nullif(p_item->>'current_hours','')::numeric,nullif(p_item->>'current_cycles','')::numeric,'v2:'||trim(p_mutation_id),
    coalesce(p_item->>'item_type','other'),nullif(trim(coalesce(p_item->>'custom_name','')),''),nullif(p_item->>'model_year','')::integer,
    nullif(trim(coalesce(p_item->>'manufacturer','')),''),nullif(trim(coalesce(p_item->>'make','')),''),nullif(trim(coalesce(p_item->>'model','')),''),
    nullif(trim(coalesce(p_item->>'trim','')),''),nullif(trim(coalesce(p_item->>'model_number','')),''),nullif(trim(coalesce(p_item->>'engine','')),''),
    nullif(trim(coalesce(p_item->>'engine_model','')),''),nullif(trim(coalesce(p_item->>'transmission','')),''),nullif(trim(coalesce(p_item->>'drivetrain','')),''),
    nullif(trim(coalesce(p_item->>'fuel_power_type','')),''),nullif(trim(coalesce(p_item->>'serial_number','')),''),nullif(trim(coalesce(p_item->>'engine_serial','')),''),
    nullif(trim(coalesce(p_item->>'vin','')),''),nullif(trim(coalesce(p_item->>'hull_number','')),''),nullif(trim(coalesce(p_item->>'registration_number','')),''),
    nullif(p_item->>'purchase_price','')::numeric,upper(nullif(trim(coalesce(p_item->>'purchase_currency','')),'')),nullif(trim(coalesce(p_item->>'purchase_vendor','')),''),
    nullif(trim(coalesce(p_item->>'primary_photo_url','')),''),v_dims,coalesce(p_item->>'usage_profile','normal'),nullif(p_item->>'manufactured_on','')::date,
    nullif(p_item->>'in_service_on','')::date,nullif(p_item->>'origin_mileage','')::numeric,nullif(p_item->>'origin_hours','')::numeric,
    nullif(p_item->>'origin_cycles','')::numeric,v_hash) returning id into v_id;
  insert into public.my_stuff_v2_mutations values(v_user,trim(p_mutation_id),'create_item_v2',v_hash,v_id,now());
  return v_id;
exception when check_violation or numeric_value_out_of_range or invalid_text_representation or datetime_field_overflow then
  raise exception 'Item contains an invalid or out-of-range value';
end $$;

create function public.update_my_stuff_item_v2(p_item_id uuid,p_patch jsonb,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_hash text; v_id uuid; v_old text; v_key text; v_dims text[];
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_patch)<>'object' or pg_column_size(p_patch)>131072 then raise exception 'Item patch must be a bounded object'; end if;
  if nullif(trim(p_mutation_id),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required and must not exceed 200 characters'; end if;
  select key into v_key from jsonb_object_keys(p_patch) key where key in
    ('id','user_id','client_mutation_id','created_at','updated_at','current_mileage','current_hours','current_cycles',
     'origin_mileage','origin_hours','origin_cycles','effective_current_mileage','effective_current_hours','effective_current_cycles',
     'archived_at','archive_reason','v2_request_hash') limit 1;
  if v_key is not null then raise exception 'Protected item field cannot be edited: %',v_key; end if;
  select key into v_key from jsonb_object_keys(p_patch) key where key not in
    ('name','category','acquired_on','notes','item_type','custom_name','model_year','manufacturer','make','model','trim','model_number',
     'engine','engine_model','transmission','drivetrain','fuel_power_type','serial_number','engine_serial','vin','hull_number',
     'registration_number','purchase_price','purchase_currency','purchase_vendor','primary_photo_url','usage_dimensions','usage_profile',
     'manufactured_on','in_service_on') limit 1;
  if v_key is not null then raise exception 'Unsupported item field: %',v_key; end if;
  if p_patch?'usage_dimensions' then
    select coalesce(array_agg(x),array[]::text[]) into v_dims from jsonb_array_elements_text(coalesce(p_patch->'usage_dimensions','[]')) x;
    if cardinality(v_dims)>4 or not v_dims <@ array['mileage','hours','time','cycles']::text[] then raise exception 'Invalid usage dimensions'; end if;
  end if;
  if p_patch?'item_type' and p_patch->>'item_type' not in ('car','truck','motorcycle','boat','atv','side_by_side','mower','tractor','trailer','generator','rv','equipment','bicycle','watch','electronics','gaming','tool','exercise','instrument','furniture','house','other') then raise exception 'Invalid item type'; end if;
  v_hash:=md5(jsonb_build_object('item_id',p_item_id,'patch',p_patch)::text); perform pg_advisory_xact_lock(hashtextextended(v_user::text||':item:'||p_item_id::text,0));
  select result_id,request_hash into v_id,v_old from public.my_stuff_v2_mutations where user_id=v_user and mutation_id=trim(p_mutation_id);
  if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return v_id; end if;
  perform 1 from public.my_stuff_items where id=p_item_id and user_id=v_user for update; if not found then raise exception 'My Stuff item not found'; end if;
  update public.my_stuff_items set
    name=case when p_patch?'name' then trim(p_patch->>'name') else name end,
    category=case when p_patch?'category' then trim(p_patch->>'category') else category end,
    acquired_on=case when p_patch?'acquired_on' then nullif(p_patch->>'acquired_on','')::date else acquired_on end,
    notes=case when p_patch?'notes' then nullif(trim(coalesce(p_patch->>'notes','')),'') else notes end,
    item_type=case when p_patch?'item_type' then p_patch->>'item_type' else item_type end,
    custom_name=case when p_patch?'custom_name' then nullif(trim(coalesce(p_patch->>'custom_name','')),'') else custom_name end,
    model_year=case when p_patch?'model_year' then nullif(p_patch->>'model_year','')::integer else model_year end,
    manufacturer=case when p_patch?'manufacturer' then nullif(trim(coalesce(p_patch->>'manufacturer','')),'') else manufacturer end,
    make=case when p_patch?'make' then nullif(trim(coalesce(p_patch->>'make','')),'') else make end,
    model=case when p_patch?'model' then nullif(trim(coalesce(p_patch->>'model','')),'') else model end,
    trim=case when p_patch?'trim' then nullif(trim(coalesce(p_patch->>'trim','')),'') else trim end,
    model_number=case when p_patch?'model_number' then nullif(trim(coalesce(p_patch->>'model_number','')),'') else model_number end,
    engine=case when p_patch?'engine' then nullif(trim(coalesce(p_patch->>'engine','')),'') else engine end,
    engine_model=case when p_patch?'engine_model' then nullif(trim(coalesce(p_patch->>'engine_model','')),'') else engine_model end,
    transmission=case when p_patch?'transmission' then nullif(trim(coalesce(p_patch->>'transmission','')),'') else transmission end,
    drivetrain=case when p_patch?'drivetrain' then nullif(trim(coalesce(p_patch->>'drivetrain','')),'') else drivetrain end,
    fuel_power_type=case when p_patch?'fuel_power_type' then nullif(trim(coalesce(p_patch->>'fuel_power_type','')),'') else fuel_power_type end,
    serial_number=case when p_patch?'serial_number' then nullif(trim(coalesce(p_patch->>'serial_number','')),'') else serial_number end,
    engine_serial=case when p_patch?'engine_serial' then nullif(trim(coalesce(p_patch->>'engine_serial','')),'') else engine_serial end,
    vin=case when p_patch?'vin' then nullif(trim(coalesce(p_patch->>'vin','')),'') else vin end,
    hull_number=case when p_patch?'hull_number' then nullif(trim(coalesce(p_patch->>'hull_number','')),'') else hull_number end,
    registration_number=case when p_patch?'registration_number' then nullif(trim(coalesce(p_patch->>'registration_number','')),'') else registration_number end,
    primary_photo_url=case when p_patch?'primary_photo_url' then nullif(trim(coalesce(p_patch->>'primary_photo_url','')),'') else primary_photo_url end,
    usage_dimensions=case when p_patch?'usage_dimensions' then v_dims else usage_dimensions end,
    usage_profile=case when p_patch?'usage_profile' then p_patch->>'usage_profile' else usage_profile end,
    manufactured_on=case when p_patch?'manufactured_on' then nullif(p_patch->>'manufactured_on','')::date else manufactured_on end,
    in_service_on=case when p_patch?'in_service_on' then nullif(p_patch->>'in_service_on','')::date else in_service_on end,
    purchase_price=case when p_patch?'purchase_price' then nullif(p_patch->>'purchase_price','')::numeric else purchase_price end,
    purchase_currency=case when p_patch?'purchase_currency' then upper(nullif(trim(coalesce(p_patch->>'purchase_currency','')),'')) else purchase_currency end,
    purchase_vendor=case when p_patch?'purchase_vendor' then nullif(trim(coalesce(p_patch->>'purchase_vendor','')),'') else purchase_vendor end
  where id=p_item_id and user_id=v_user;
  insert into public.my_stuff_v2_mutations values(v_user,trim(p_mutation_id),'update_item_v2',v_hash,p_item_id,now()); return p_item_id;
exception when check_violation or numeric_value_out_of_range or invalid_text_representation or datetime_field_overflow then raise exception 'Item contains an invalid or out-of-range value';
end $$;

create function public.record_my_stuff_reading_v2(p_item_id uuid,p_reading_type text,p_value numeric,p_recorded_at timestamptz,p_corrects_reading_id uuid,p_correction_reason text,p_metadata jsonb,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_hash text; v_id uuid; v_old text; v_current numeric; v_latest uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if nullif(trim(p_mutation_id),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required and must not exceed 200 characters'; end if;
  v_hash:=md5(jsonb_build_object('item',p_item_id,'type',p_reading_type,'value',p_value,'at',p_recorded_at,'corrects',p_corrects_reading_id,'reason',p_correction_reason,'metadata',p_metadata)::text);
  perform pg_advisory_xact_lock(hashtextextended(v_user::text||':item:'||p_item_id::text,0));
  select result_id,request_hash into v_id,v_old from public.my_stuff_v2_mutations where user_id=v_user and mutation_id=trim(p_mutation_id);
  if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return v_id; end if;
  select case p_reading_type when 'mileage' then coalesce(effective_current_mileage,current_mileage) when 'hours' then coalesce(effective_current_hours,current_hours) when 'cycles' then coalesce(effective_current_cycles,current_cycles) end into v_current from public.my_stuff_items where id=p_item_id and user_id=v_user for update;
  if not found then raise exception 'My Stuff item not found'; end if;
  if p_reading_type not in ('mileage','hours','cycles') or p_value is null or p_value<0 or p_value>1000000000 then raise exception 'Reading must be a supported, bounded non-negative value'; end if;
  if p_recorded_at is null or not isfinite(p_recorded_at) or p_recorded_at<timestamptz '1900-01-01Z' or p_recorded_at>timestamptz '2200-12-31 23:59:59Z' then raise exception 'Reading date is outside the supported range'; end if;
  if p_corrects_reading_id is not null then
    select id into v_latest from public.my_stuff_readings where user_id=v_user and item_id=p_item_id and reading_type=p_reading_type order by created_at desc,id desc limit 1 for update;
    if v_latest is distinct from p_corrects_reading_id then raise exception 'Only the current effective reading can be corrected'; end if;
    if nullif(trim(coalesce(p_correction_reason,'')),'') is null then raise exception 'Correction reason required'; end if;
  elsif p_value<coalesce(v_current,0) then raise exception 'Reading cannot move backwards; append a correction instead';
  end if;
  insert into public.my_stuff_readings(user_id,item_id,reading_type,reading_value,recorded_at,source,corrects_reading_id,correction_reason,metadata,client_mutation_id)
  values(v_user,p_item_id,p_reading_type,p_value,p_recorded_at,case when p_corrects_reading_id is null then 'manual' else 'correction' end,p_corrects_reading_id,
    case when p_corrects_reading_id is null then null else trim(p_correction_reason) end,coalesce(p_metadata,'{}'),trim(p_mutation_id)) returning id into v_id;
  update public.my_stuff_items set
    current_mileage=case when p_corrects_reading_id is null and p_reading_type='mileage' then greatest(current_mileage,p_value) else current_mileage end,
    current_hours=case when p_corrects_reading_id is null and p_reading_type='hours' then greatest(current_hours,p_value) else current_hours end,
    current_cycles=case when p_corrects_reading_id is null and p_reading_type='cycles' then greatest(current_cycles,p_value) else current_cycles end,
    effective_current_mileage=case when p_reading_type='mileage' then p_value else effective_current_mileage end,
    effective_current_hours=case when p_reading_type='hours' then p_value else effective_current_hours end,
    effective_current_cycles=case when p_reading_type='cycles' then p_value else effective_current_cycles end
  where id=p_item_id;
  insert into public.my_stuff_v2_mutations values(v_user,trim(p_mutation_id),'record_reading_v2',v_hash,v_id,now()); return v_id;
end $$;

create function private.create_my_stuff_maintenance_definition_v2_trusted(p_user_id uuid,p_item_id uuid,p_definition jsonb,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public,private as $$
declare v_hash text; v_id uuid; v_old text; v_key text;
begin
  if p_user_id is null then raise exception 'User ID required'; end if;
  if jsonb_typeof(p_definition)<>'object' or pg_column_size(p_definition)>131072 then raise exception 'Definition must be a bounded object'; end if;
  select key into v_key from jsonb_object_keys(p_definition) key where key not in
    ('name','description','service_category','service_action','due_semantics','active_profile','cadence_anchor',
     'normal_interval_miles','normal_interval_hours','normal_interval_cycles','normal_calendar_months',
     'severe_interval_miles','severe_interval_hours','severe_interval_cycles','severe_calendar_months',
     'first_interval_miles','first_interval_hours','first_interval_cycles','first_calendar_months',
     'due_soon_miles','due_soon_hours','due_soon_cycles','due_soon_days','provenance_type','source_class',
     'citation_url','citation_title','citation_page','citation_section','citation_accessed_on','uncertain',
     'uncertainty_reason','enabled') limit 1;
  if v_key is not null then raise exception 'Unsupported maintenance definition field: %',v_key; end if;
  if nullif(trim(p_mutation_id),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required and must not exceed 200 characters'; end if;
  v_hash:=md5(jsonb_build_object('item',p_item_id,'definition',p_definition)::text); perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':item:'||p_item_id::text,0));
  select result_id,request_hash into v_id,v_old from public.my_stuff_v2_mutations where user_id=p_user_id and mutation_id=trim(p_mutation_id);
  if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return v_id; end if;
  if not exists(select 1 from public.my_stuff_items where id=p_item_id and user_id=p_user_id) then raise exception 'My Stuff item not found'; end if;
  insert into public.my_stuff_maintenance_definitions(user_id,item_id,name,description,service_category,service_action,due_semantics,active_profile,cadence_anchor,
    normal_interval_miles,normal_interval_hours,normal_interval_cycles,normal_calendar_months,severe_interval_miles,severe_interval_hours,severe_interval_cycles,severe_calendar_months,
    first_interval_miles,first_interval_hours,first_interval_cycles,first_calendar_months,due_soon_miles,due_soon_hours,due_soon_cycles,due_soon_days,
    provenance_type,source_class,citation_url,citation_title,citation_page,citation_section,citation_accessed_on,uncertain,uncertainty_reason,enabled,client_mutation_id,request_hash)
  values(p_user_id,p_item_id,trim(p_definition->>'name'),nullif(trim(coalesce(p_definition->>'description','')),''),coalesce(p_definition->>'service_category','other'),
    coalesce(p_definition->>'service_action','service'),coalesce(p_definition->>'due_semantics','whichever_first'),coalesce(p_definition->>'active_profile','normal'),
    coalesce(p_definition->>'cadence_anchor','last_completion'),nullif(p_definition->>'normal_interval_miles','')::numeric,nullif(p_definition->>'normal_interval_hours','')::numeric,
    nullif(p_definition->>'normal_interval_cycles','')::numeric,nullif(p_definition->>'normal_calendar_months','')::integer,nullif(p_definition->>'severe_interval_miles','')::numeric,
    nullif(p_definition->>'severe_interval_hours','')::numeric,nullif(p_definition->>'severe_interval_cycles','')::numeric,nullif(p_definition->>'severe_calendar_months','')::integer,
    nullif(p_definition->>'first_interval_miles','')::numeric,nullif(p_definition->>'first_interval_hours','')::numeric,nullif(p_definition->>'first_interval_cycles','')::numeric,
    nullif(p_definition->>'first_calendar_months','')::integer,coalesce(nullif(p_definition->>'due_soon_miles','')::numeric,500),coalesce(nullif(p_definition->>'due_soon_hours','')::numeric,10),
    coalesce(nullif(p_definition->>'due_soon_cycles','')::numeric,10),coalesce(nullif(p_definition->>'due_soon_days','')::integer,30),coalesce(p_definition->>'provenance_type','manual'),
    nullif(p_definition->>'source_class',''),nullif(p_definition->>'citation_url',''),nullif(p_definition->>'citation_title',''),nullif(p_definition->>'citation_page',''),
    nullif(p_definition->>'citation_section',''),nullif(p_definition->>'citation_accessed_on','')::date,coalesce((p_definition->>'uncertain')::boolean,false),
    nullif(trim(coalesce(p_definition->>'uncertainty_reason','')),''),coalesce((p_definition->>'enabled')::boolean,true),trim(p_mutation_id),v_hash) returning id into v_id;
  insert into public.my_stuff_v2_mutations values(p_user_id,trim(p_mutation_id),'create_definition_v2',v_hash,v_id,now()); return v_id;
exception when check_violation or numeric_value_out_of_range or invalid_text_representation or datetime_field_overflow then raise exception 'Maintenance definition contains an invalid or out-of-range value';
end $$;

create function public.create_my_stuff_maintenance_definition_v2(p_item_id uuid,p_definition jsonb,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_key text; v_definition jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_definition)<>'object' or pg_column_size(p_definition)>131072 then raise exception 'Definition must be a bounded object'; end if;
  if p_definition ?| array['provenance','provenance_type','source_class','citation_url','citation_title','citation_page','citation_section','citation_accessed_on']
     or exists(select 1 from jsonb_object_keys(p_definition) k where k like 'provenance_%') then
    raise exception 'Provenance fields cannot be supplied to public maintenance definition RPCs';
  end if;
  select key into v_key from jsonb_object_keys(p_definition) key where key not in
    ('name','description','service_category','service_action','due_semantics','active_profile','cadence_anchor',
     'normal_interval_miles','normal_interval_hours','normal_interval_cycles','normal_calendar_months',
     'severe_interval_miles','severe_interval_hours','severe_interval_cycles','severe_calendar_months',
     'first_interval_miles','first_interval_hours','first_interval_cycles','first_calendar_months',
     'due_soon_miles','due_soon_hours','due_soon_cycles','due_soon_days','uncertain','uncertainty_reason','enabled') limit 1;
  if v_key is not null then raise exception 'Unsupported maintenance definition field: %',v_key; end if;
  v_definition:=p_definition||jsonb_build_object('provenance_type','manual','source_class','user','citation_url',null,'citation_title',null,'citation_page',null,'citation_section',null,'citation_accessed_on',null);
  return private.create_my_stuff_maintenance_definition_v2_trusted(v_user,p_item_id,v_definition,p_mutation_id);
end $$;

create function public.update_my_stuff_maintenance_definition_v2(p_definition_id uuid,p_definition jsonb,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_old_row public.my_stuff_maintenance_definitions%rowtype; v_merged jsonb; v_hash text; v_id uuid; v_old text; v_key text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_definition)<>'object' or pg_column_size(p_definition)>131072 then raise exception 'Definition patch must be a bounded object'; end if;
  if p_definition ?| array['provenance','provenance_type','source_class','citation_url','citation_title','citation_page','citation_section','citation_accessed_on']
     or exists(select 1 from jsonb_object_keys(p_definition) k where k like 'provenance_%') then
    raise exception 'Provenance fields cannot be supplied to public maintenance definition RPCs';
  end if;
  if p_definition ?| array['id','user_id','item_id','client_mutation_id','request_hash','created_at','updated_at','first_service_completed'] then raise exception 'Protected definition field cannot be edited'; end if;
  select key into v_key from jsonb_object_keys(p_definition) key where key not in
    ('name','description','service_category','service_action','due_semantics','active_profile','cadence_anchor',
     'normal_interval_miles','normal_interval_hours','normal_interval_cycles','normal_calendar_months',
     'severe_interval_miles','severe_interval_hours','severe_interval_cycles','severe_calendar_months',
     'first_interval_miles','first_interval_hours','first_interval_cycles','first_calendar_months',
     'due_soon_miles','due_soon_hours','due_soon_cycles','due_soon_days','uncertain',
     'uncertainty_reason','enabled') limit 1;
  if v_key is not null then raise exception 'Unsupported maintenance definition field: %',v_key; end if;
  if nullif(trim(p_mutation_id),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required and must not exceed 200 characters'; end if;
  v_hash:=md5(jsonb_build_object('definition_id',p_definition_id,'patch',p_definition)::text); perform pg_advisory_xact_lock(hashtextextended(v_user::text||':definition:'||p_definition_id::text,0));
  select result_id,request_hash into v_id,v_old from public.my_stuff_v2_mutations where user_id=v_user and mutation_id=trim(p_mutation_id);
  if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return v_id; end if;
  select * into v_old_row from public.my_stuff_maintenance_definitions where id=p_definition_id and user_id=v_user for update; if not found then raise exception 'Maintenance definition not found'; end if;
  v_merged:=to_jsonb(v_old_row)||p_definition;
  -- Reuse the table constraints as the single complete validator.
  update public.my_stuff_maintenance_definitions set
    name=trim(v_merged->>'name'),description=nullif(trim(coalesce(v_merged->>'description','')),''),service_category=v_merged->>'service_category',service_action=v_merged->>'service_action',
    due_semantics=v_merged->>'due_semantics',active_profile=v_merged->>'active_profile',cadence_anchor=v_merged->>'cadence_anchor',
    normal_interval_miles=nullif(v_merged->>'normal_interval_miles','')::numeric,normal_interval_hours=nullif(v_merged->>'normal_interval_hours','')::numeric,
    normal_interval_cycles=nullif(v_merged->>'normal_interval_cycles','')::numeric,normal_calendar_months=nullif(v_merged->>'normal_calendar_months','')::integer,
    severe_interval_miles=nullif(v_merged->>'severe_interval_miles','')::numeric,severe_interval_hours=nullif(v_merged->>'severe_interval_hours','')::numeric,
    severe_interval_cycles=nullif(v_merged->>'severe_interval_cycles','')::numeric,severe_calendar_months=nullif(v_merged->>'severe_calendar_months','')::integer,
    first_interval_miles=nullif(v_merged->>'first_interval_miles','')::numeric,first_interval_hours=nullif(v_merged->>'first_interval_hours','')::numeric,
    first_interval_cycles=nullif(v_merged->>'first_interval_cycles','')::numeric,first_calendar_months=nullif(v_merged->>'first_calendar_months','')::integer,
    due_soon_miles=(v_merged->>'due_soon_miles')::numeric,due_soon_hours=(v_merged->>'due_soon_hours')::numeric,due_soon_cycles=(v_merged->>'due_soon_cycles')::numeric,due_soon_days=(v_merged->>'due_soon_days')::integer,
    provenance_type='manual',source_class='user',citation_url=null,citation_title=null,citation_page=null,citation_section=null,citation_accessed_on=null,
    uncertain=(v_merged->>'uncertain')::boolean,uncertainty_reason=nullif(trim(coalesce(v_merged->>'uncertainty_reason','')),''),enabled=(v_merged->>'enabled')::boolean
  where id=p_definition_id;
  insert into public.my_stuff_v2_mutations values(v_user,trim(p_mutation_id),'update_definition_v2',v_hash,p_definition_id,now()); return p_definition_id;
exception when check_violation or numeric_value_out_of_range or invalid_text_representation or datetime_field_overflow then raise exception 'Maintenance definition contains an invalid or out-of-range value';
end $$;

create function public.get_my_stuff_due_state_v2(p_item_id uuid,p_as_of timestamptz default now())
returns table(definition_id uuid,next_due_at timestamptz,next_due_mileage numeric,next_due_hours numeric,next_due_cycles numeric,due_status text)
language plpgsql stable security definer set search_path=public as $$
begin
  -- Supported business horizon is inclusive 1900-01-01 and exclusive 2200-01-01.
  if p_as_of is null or not isfinite(p_as_of)
     or p_as_of<timestamptz '1900-01-01 00:00:00+00'
     or p_as_of>=timestamptz '2200-01-01 00:00:00+00' then
    raise exception 'Due-state as-of is outside the supported range [1900-01-01, 2200-01-01)';
  end if;
  return query
with owned as (
  select i.*,
    coalesce((select r.reading_value from public.my_stuff_readings r where r.item_id=i.id and r.user_id=i.user_id and r.reading_type='mileage' and r.recorded_at<=p_as_of order by r.recorded_at desc,r.created_at desc,r.id desc limit 1),i.origin_mileage) as_asof_mileage,
    coalesce((select r.reading_value from public.my_stuff_readings r where r.item_id=i.id and r.user_id=i.user_id and r.reading_type='hours' and r.recorded_at<=p_as_of order by r.recorded_at desc,r.created_at desc,r.id desc limit 1),i.origin_hours) as_asof_hours,
    coalesce((select r.reading_value from public.my_stuff_readings r where r.item_id=i.id and r.user_id=i.user_id and r.reading_type='cycles' and r.recorded_at<=p_as_of order by r.recorded_at desc,r.created_at desc,r.id desc limit 1),i.origin_cycles) as_asof_cycles
  from public.my_stuff_items i where i.id=p_item_id and i.user_id=auth.uid()
),
d as (select x.* from public.my_stuff_maintenance_definitions x join owned i on i.id=x.item_id where x.enabled),
lasts as (
  select d.id,
    (select o.completed_at from public.my_stuff_service_occurrences o where o.definition_id=d.id and o.completed_at<=p_as_of order by o.completed_at desc,o.created_at desc,o.id desc limit 1) completed_at,
    (select o.mileage from public.my_stuff_service_occurrences o where o.definition_id=d.id and o.completed_at<=p_as_of and o.mileage is not null order by o.completed_at desc,o.created_at desc,o.id desc limit 1) mileage,
    (select o.hours from public.my_stuff_service_occurrences o where o.definition_id=d.id and o.completed_at<=p_as_of and o.hours is not null order by o.completed_at desc,o.created_at desc,o.id desc limit 1) hours,
    (select o.cycles from public.my_stuff_service_occurrences o where o.definition_id=d.id and o.completed_at<=p_as_of and o.cycles is not null order by o.completed_at desc,o.created_at desc,o.id desc limit 1) cycles
  from d
),
calc as (
  select d.id,d.due_semantics,d.due_soon_days,d.due_soon_miles,d.due_soon_hours,d.due_soon_cycles,
    i.as_asof_mileage current_mileage,i.as_asof_hours current_hours,i.as_asof_cycles current_cycles,
    case when l.completed_at is null and d.first_calendar_months is not null then d.first_calendar_months when d.active_profile='severe' and d.severe_calendar_months is not null then d.severe_calendar_months else d.normal_calendar_months end months,
    case when l.completed_at is null and d.first_interval_miles is not null then d.first_interval_miles when d.active_profile='severe' and d.severe_interval_miles is not null then d.severe_interval_miles else d.normal_interval_miles end im,
    case when l.completed_at is null and d.first_interval_hours is not null then d.first_interval_hours when d.active_profile='severe' and d.severe_interval_hours is not null then d.severe_interval_hours else d.normal_interval_hours end ih,
    case when l.completed_at is null and d.first_interval_cycles is not null then d.first_interval_cycles when d.active_profile='severe' and d.severe_interval_cycles is not null then d.severe_interval_cycles else d.normal_interval_cycles end ic,
    case when d.cadence_anchor='asset_origin' then coalesce(i.in_service_on::timestamptz,i.acquired_on::timestamptz,i.created_at) else coalesce(l.completed_at,i.in_service_on::timestamptz,i.acquired_on::timestamptz,i.created_at) end base_at,
    case when d.cadence_anchor='asset_origin' then i.origin_mileage else coalesce(l.mileage,i.origin_mileage) end base_mileage,
    case when d.cadence_anchor='asset_origin' then i.origin_hours else coalesce(l.hours,i.origin_hours) end base_hours,
    case when d.cadence_anchor='asset_origin' then i.origin_cycles else coalesce(l.cycles,i.origin_cycles) end base_cycles
  from d join owned i on i.id=d.item_id left join lasts l on l.id=d.id
),
due as (
  select *,case when months is null then null else base_at+make_interval(months=>months) end nda,
    case when im is null or base_mileage is null then null else base_mileage+im end ndm,
    case when ih is null or base_hours is null then null else base_hours+ih end ndh,
    case when ic is null or base_cycles is null then null else base_cycles+ic end ndc
  from calc
), flags as (
  select *,
    ((months is not null and p_as_of>nda) or (im is not null and current_mileage>ndm) or (ih is not null and current_hours>ndh) or (ic is not null and current_cycles>ndc)) any_overdue,
    ((months is null or p_as_of>nda) and (im is null or current_mileage>ndm) and (ih is null or current_hours>ndh) and (ic is null or current_cycles>ndc)) all_overdue,
    ((months is not null and p_as_of>=nda) or (im is not null and current_mileage>=ndm) or (ih is not null and current_hours>=ndh) or (ic is not null and current_cycles>=ndc)) any_due,
    ((months is null or p_as_of>=nda) and (im is null or current_mileage>=ndm) and (ih is null or current_hours>=ndh) and (ic is null or current_cycles>=ndc)) all_due,
    ((months is not null and nda<=p_as_of+make_interval(days=>due_soon_days)) or (im is not null and ndm-current_mileage<=due_soon_miles) or (ih is not null and ndh-current_hours<=due_soon_hours) or (ic is not null and ndc-current_cycles<=due_soon_cycles)) any_soon,
    ((months is null or nda<=p_as_of+make_interval(days=>due_soon_days)) and (im is null or ndm-current_mileage<=due_soon_miles) and (ih is null or ndh-current_hours<=due_soon_hours) and (ic is null or ndc-current_cycles<=due_soon_cycles)) all_soon
  from due
)
select id,nda,ndm,ndh,ndc,
  case
    when (im is not null and (ndm is null or current_mileage is null)) or (ih is not null and (ndh is null or current_hours is null)) or (ic is not null and (ndc is null or current_cycles is null)) then 'needs_usage_update'
    when due_semantics='all' and all_overdue then 'overdue'
    when due_semantics='whichever_first' and any_overdue then 'overdue'
    when due_semantics='all' and all_due then 'due_now'
    when due_semantics='whichever_first' and any_due then 'due_now'
    when due_semantics='all' and all_soon then 'due_soon'
    when due_semantics='whichever_first' and any_soon then 'due_soon'
    else 'upcoming'
  end
from flags order by id;
end $$;

create function private.record_my_stuff_service_occurrence_v2_trusted(p_user_id uuid,p_item_id uuid,p_definition_id uuid,p_service jsonb,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public,private as $$
declare v_item public.my_stuff_items%rowtype; v_def public.my_stuff_maintenance_definitions%rowtype; v_hash text; v_id uuid; v_old text; v_revision uuid; v_completed timestamptz; v_name text; v_scheduled boolean; v_key text;
begin
 if p_user_id is null then raise exception 'User ID required'; end if;
 if jsonb_typeof(p_service)<>'object' or pg_column_size(p_service)>262144 then raise exception 'Service must be a bounded object'; end if;
 select key into v_key from jsonb_object_keys(p_service) key where key not in
   ('service_name','service_category','service_action','completed_at','mileage','hours','cycles','parts','labor','vendor','warranty','notes','attachment_metadata','provenance_type','provenance') limit 1;
 if v_key is not null then raise exception 'Unsupported service field: %',v_key; end if;
 if nullif(trim(p_mutation_id),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required and must not exceed 200 characters'; end if;
 v_hash:=md5(jsonb_build_object('item',p_item_id,'definition',p_definition_id,'service',p_service)::text); perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':item:'||p_item_id::text,0));
 select result_id,request_hash into v_id,v_old from public.my_stuff_v2_mutations where user_id=p_user_id and mutation_id=trim(p_mutation_id);
 if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return v_id; end if;
 select * into v_item from public.my_stuff_items where id=p_item_id and user_id=p_user_id for update; if not found then raise exception 'My Stuff item not found'; end if;
 if (p_service ? 'mileage' and (p_service->>'mileage')::numeric<coalesce(v_item.effective_current_mileage,v_item.current_mileage))
    or (p_service ? 'hours' and (p_service->>'hours')::numeric<coalesce(v_item.effective_current_hours,v_item.current_hours))
    or (p_service ? 'cycles' and (p_service->>'cycles')::numeric<coalesce(v_item.effective_current_cycles,v_item.current_cycles)) then
   raise exception 'Service readings cannot move backwards';
 end if;
 v_scheduled:=p_definition_id is not null;
 if v_scheduled then select * into v_def from public.my_stuff_maintenance_definitions where id=p_definition_id and item_id=p_item_id and user_id=p_user_id for update; if not found then raise exception 'Maintenance definition not found'; end if; end if;
 v_name:=coalesce(nullif(trim(p_service->>'service_name'),''),v_def.name); if v_name is null then raise exception 'Service name required for unscheduled service'; end if;
 v_completed:=coalesce(nullif(p_service->>'completed_at','')::timestamptz,now());
 insert into public.my_stuff_service_occurrences(user_id,item_id,definition_id,service_name,service_category,service_action,scheduled,completed_at,mileage,hours,cycles,provenance_type,provenance,client_mutation_id,request_hash)
 values(p_user_id,p_item_id,p_definition_id,v_name,coalesce(p_service->>'service_category',v_def.service_category,'other'),coalesce(p_service->>'service_action',v_def.service_action,'service'),v_scheduled,v_completed,
 nullif(p_service->>'mileage','')::numeric,nullif(p_service->>'hours','')::numeric,nullif(p_service->>'cycles','')::numeric,coalesce(p_service->>'provenance_type','user_entered'),coalesce(p_service->'provenance','{}'),trim(p_mutation_id),v_hash) returning id into v_id;
 insert into public.my_stuff_service_occurrence_revisions(user_id,item_id,occurrence_id,revision_number,parts,labor,vendor,warranty,notes,attachment_metadata,client_mutation_id,request_hash)
 values(p_user_id,p_item_id,v_id,1,coalesce(p_service->'parts','[]'),coalesce(p_service->'labor','[]'),coalesce(p_service->'vendor','{}'),coalesce(p_service->'warranty','{}'),
 nullif(trim(coalesce(p_service->>'notes','')),''),coalesce(p_service->'attachment_metadata','[]'),'occurrence:'||v_id::text||':revision:1',v_hash) returning id into v_revision;
 insert into public.my_stuff_service_audit(user_id,item_id,occurrence_id,revision_id,action,actor_id) values(p_user_id,p_item_id,v_id,v_revision,'created',p_user_id);
 if p_service ? 'mileage' then insert into public.my_stuff_readings(user_id,item_id,reading_type,reading_value,recorded_at,source,metadata,client_mutation_id) values(p_user_id,p_item_id,'mileage',(p_service->>'mileage')::numeric,v_completed,'service',jsonb_build_object('occurrence_id',v_id),'occurrence:'||v_id::text||':mileage'); end if;
 if p_service ? 'hours' then insert into public.my_stuff_readings(user_id,item_id,reading_type,reading_value,recorded_at,source,metadata,client_mutation_id) values(p_user_id,p_item_id,'hours',(p_service->>'hours')::numeric,v_completed,'service',jsonb_build_object('occurrence_id',v_id),'occurrence:'||v_id::text||':hours'); end if;
 if p_service ? 'cycles' then insert into public.my_stuff_readings(user_id,item_id,reading_type,reading_value,recorded_at,source,metadata,client_mutation_id) values(p_user_id,p_item_id,'cycles',(p_service->>'cycles')::numeric,v_completed,'service',jsonb_build_object('occurrence_id',v_id),'occurrence:'||v_id::text||':cycles'); end if;
 update public.my_stuff_items set
   current_mileage=greatest(current_mileage,nullif(p_service->>'mileage','')::numeric),
   current_hours=greatest(current_hours,nullif(p_service->>'hours','')::numeric),
   current_cycles=greatest(current_cycles,nullif(p_service->>'cycles','')::numeric),
   effective_current_mileage=case when p_service?'mileage' then (p_service->>'mileage')::numeric else effective_current_mileage end,
   effective_current_hours=case when p_service?'hours' then (p_service->>'hours')::numeric else effective_current_hours end,
   effective_current_cycles=case when p_service?'cycles' then (p_service->>'cycles')::numeric else effective_current_cycles end
 where id=p_item_id;
 if v_scheduled then update public.my_stuff_maintenance_definitions set first_service_completed=true where id=p_definition_id; end if;
 insert into public.my_stuff_v2_mutations values(p_user_id,trim(p_mutation_id),'record_occurrence_v2',v_hash,v_id,now()); return v_id;
exception when check_violation or numeric_value_out_of_range or invalid_text_representation or datetime_field_overflow then raise exception 'Service contains an invalid or out-of-range value';
end $$;

create function public.record_my_stuff_service_occurrence_v2(p_item_id uuid,p_definition_id uuid,p_service jsonb,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_key text; v_service jsonb;
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 if jsonb_typeof(p_service)<>'object' or pg_column_size(p_service)>262144 then raise exception 'Service must be a bounded object'; end if;
 if p_service ?| array['provenance','provenance_type']
    or exists(select 1 from jsonb_object_keys(p_service) k where k like 'provenance_%') then
   raise exception 'Provenance fields cannot be supplied to public service RPCs';
 end if;
 select key into v_key from jsonb_object_keys(p_service) key where key not in
   ('service_name','service_category','service_action','completed_at','mileage','hours','cycles','parts','labor','vendor','warranty','notes','attachment_metadata') limit 1;
 if v_key is not null then raise exception 'Unsupported service field: %',v_key; end if;
 v_service:=p_service||jsonb_build_object('provenance_type','user_entered','provenance','{}'::jsonb);
 return private.record_my_stuff_service_occurrence_v2_trusted(v_user,p_item_id,p_definition_id,v_service,p_mutation_id);
end $$;

create function public.revise_my_stuff_service_occurrence_v2(p_occurrence_id uuid,p_details jsonb,p_reason text,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_occ public.my_stuff_service_occurrences%rowtype; v_hash text; v_id uuid; v_old text; v_n integer; v_key text;
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 if jsonb_typeof(p_details)<>'object' or pg_column_size(p_details)>262144 then raise exception 'Revision must be a bounded object'; end if;
 if p_details ?| array['provenance','provenance_type']
    or exists(select 1 from jsonb_object_keys(p_details) k where k like 'provenance_%') then
   raise exception 'Provenance fields cannot be supplied to public service RPCs';
 end if;
 select key into v_key from jsonb_object_keys(p_details) key where key not in ('parts','labor','vendor','warranty','notes','attachment_metadata') limit 1;
 if v_key is not null then raise exception 'Unsupported service revision field: %',v_key; end if;
 if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'Revision reason required'; end if;
 if nullif(trim(p_mutation_id),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required and must not exceed 200 characters'; end if;
 v_hash:=md5(jsonb_build_object('occurrence',p_occurrence_id,'details',p_details,'reason',p_reason)::text); perform pg_advisory_xact_lock(hashtextextended(v_user::text||':occurrence:'||p_occurrence_id::text,0));
 select result_id,request_hash into v_id,v_old from public.my_stuff_v2_mutations where user_id=v_user and mutation_id=trim(p_mutation_id); if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return v_id; end if;
 select * into v_occ from public.my_stuff_service_occurrences where id=p_occurrence_id and user_id=v_user; if not found then raise exception 'Service occurrence not found'; end if;
 select coalesce(max(revision_number),0)+1 into v_n from public.my_stuff_service_occurrence_revisions where occurrence_id=p_occurrence_id;
 insert into public.my_stuff_service_occurrence_revisions(user_id,item_id,occurrence_id,revision_number,parts,labor,vendor,warranty,notes,attachment_metadata,revision_reason,client_mutation_id,request_hash)
 values(v_user,v_occ.item_id,p_occurrence_id,v_n,coalesce(p_details->'parts','[]'),coalesce(p_details->'labor','[]'),coalesce(p_details->'vendor','{}'),coalesce(p_details->'warranty','{}'),nullif(trim(coalesce(p_details->>'notes','')),''),coalesce(p_details->'attachment_metadata','[]'),trim(p_reason),trim(p_mutation_id),v_hash) returning id into v_id;
 insert into public.my_stuff_service_audit(user_id,item_id,occurrence_id,revision_id,action,actor_id) values(v_user,v_occ.item_id,p_occurrence_id,v_id,'revised',v_user);
 insert into public.my_stuff_v2_mutations values(v_user,trim(p_mutation_id),'revise_occurrence_v2',v_hash,v_id,now()); return v_id;
end $$;

create function public.set_my_stuff_item_archived_v2(p_item_id uuid,p_archived boolean,p_reason text,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_hash text; v_id uuid; v_old text;
begin
 if v_user is null then raise exception 'Authentication required'; end if; if p_archived is null then raise exception 'Archive state required'; end if;
 if nullif(trim(p_mutation_id),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required and must not exceed 200 characters'; end if;
 v_hash:=md5(jsonb_build_object('item',p_item_id,'archived',p_archived,'reason',p_reason)::text); perform pg_advisory_xact_lock(hashtextextended(v_user::text||':item:'||p_item_id::text,0));
 select result_id,request_hash into v_id,v_old from public.my_stuff_v2_mutations where user_id=v_user and mutation_id=trim(p_mutation_id); if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return v_id; end if;
 update public.my_stuff_items set archived_at=case when p_archived then coalesce(archived_at,now()) else null end,archive_reason=case when p_archived then nullif(trim(coalesce(p_reason,'')),'') else null end where id=p_item_id and user_id=v_user returning id into v_id;
 if v_id is null then raise exception 'My Stuff item not found'; end if; insert into public.my_stuff_v2_mutations values(v_user,trim(p_mutation_id),'archive_item_v2',v_hash,v_id,now()); return v_id;
end $$;

create function public.preview_project_to_my_stuff_v2(p_project_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_project jsonb; v_expenses jsonb;
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 select to_jsonb(p) into v_project from public.projects p where p.id=p_project_id and p.user_id=v_user;
 if v_project is null then raise exception 'Project not found'; end if;
 select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at,e.id),'[]') into v_expenses from public.expenses e where e.project_id=p_project_id and e.user_id=v_user;
 return jsonb_build_object('project',v_project,'expenses',v_expenses,'default_project_disposition','preserve','already_transferred',exists(select 1 from public.my_stuff_project_transfers where user_id=v_user and project_id=p_project_id));
end $$;

create function public.transfer_project_to_my_stuff_v2(p_project_id uuid,p_options jsonb,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_project jsonb; v_hash text; v_id uuid; v_old text; v_existing_hash text; v_disp text; v_selected uuid[]; v_service uuid[]; v_expenses jsonb; v_expense jsonb; v_occ uuid; v_category text;
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 if jsonb_typeof(coalesce(p_options,'{}'))<>'object' or pg_column_size(coalesce(p_options,'{}'))>131072 then raise exception 'Transfer options must be a bounded object'; end if;
 if nullif(trim(p_mutation_id),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required and must not exceed 200 characters'; end if;
 v_disp:=coalesce(p_options->>'project_disposition','preserve'); if v_disp not in ('preserve','archive') then raise exception 'Project disposition must be preserve or archive'; end if;
 select coalesce(array_agg(x::uuid),array[]::uuid[]) into v_selected from jsonb_array_elements_text(coalesce(p_options->'selected_expense_ids','[]')) x;
 select coalesce(array_agg(x::uuid),array[]::uuid[]) into v_service from jsonb_array_elements_text(coalesce(p_options->'service_expense_ids','[]')) x;
 if not v_service <@ v_selected then raise exception 'Service expenses must be selected expenses'; end if;
 v_hash:=md5(jsonb_build_object('project',p_project_id,'options',coalesce(p_options,'{}'))::text);
 perform pg_advisory_xact_lock(hashtextextended(v_user::text,0)); perform pg_advisory_xact_lock(hashtextextended(v_user::text||':project:'||p_project_id::text,0));
 select result_id,request_hash into v_id,v_old from public.my_stuff_v2_mutations where user_id=v_user and mutation_id=trim(p_mutation_id);
 if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return v_id; end if;
 select item_id,request_hash into v_id,v_existing_hash from public.my_stuff_project_transfers where user_id=v_user and project_id=p_project_id;
 if found then if v_existing_hash<>v_hash then raise exception 'Project already transferred with different options'; end if; return v_id; end if;
 select to_jsonb(p) into v_project from public.projects p where p.id=p_project_id and p.user_id=v_user for update; if v_project is null then raise exception 'Project not found'; end if;
 if not public.user_has_verified_pro_entitlement(v_user) and exists(select 1 from public.my_stuff_items where user_id=v_user) then raise exception 'Free accounts can have one My Stuff item. SideFlip Pro is required for additional items.'; end if;
 if exists(select 1 from unnest(v_selected) x where not exists(select 1 from public.expenses e where e.id=x and e.project_id=p_project_id and e.user_id=v_user)) then raise exception 'Selected expense does not belong to project'; end if;
 select coalesce(jsonb_agg(to_jsonb(exp) order by exp.created_at,exp.id),'[]') into v_expenses from public.expenses exp where exp.id=any(v_selected) and exp.project_id=p_project_id and exp.user_id=v_user;
 v_category:=coalesce(nullif(trim(v_project->>'category'),''),'other');
 if v_category not in ('car','truck','motorcycle','boat','atv','side_by_side','mower','tractor','trailer','generator','rv','equipment','bicycle','watch','electronics','gaming','tool','exercise','instrument','furniture','house','other') then v_category:='other'; end if;
 insert into public.my_stuff_items(user_id,name,category,acquired_on,notes,current_mileage,current_hours,current_cycles,client_mutation_id,item_type,model_year,manufacturer,make,model,model_number,engine_model,serial_number,engine_serial,vin,hull_number,purchase_price,primary_photo_url,usage_dimensions,origin_mileage,origin_hours,origin_cycles,v2_request_hash)
 values(v_user,trim(v_project->>'title'),v_category,nullif(v_project->>'purchase_date','')::date,nullif(trim(coalesce(v_project->>'notes','')),''),nullif(p_options->>'current_mileage','')::numeric,nullif(p_options->>'current_hours','')::numeric,nullif(p_options->>'current_cycles','')::numeric,
 'transfer:'||p_project_id::text,v_category,nullif(v_project->>'vehicle_year','')::integer,nullif(v_project->>'vehicle_make',''),nullif(v_project->>'vehicle_make',''),coalesce(nullif(v_project->>'vehicle_model',''),nullif(v_project->>'model_number','')),nullif(v_project->>'model_number',''),nullif(v_project->>'engine_model',''),nullif(v_project->>'serial_number',''),nullif(v_project->>'engine_serial',''),nullif(v_project->>'vin',''),nullif(v_project->>'hull_number',''),nullif(v_project->>'purchase_price','')::numeric,nullif(v_project->>'photo',''),array(select jsonb_array_elements_text(coalesce(p_options->'usage_dimensions','[]'))),nullif(p_options->>'current_mileage','')::numeric,nullif(p_options->>'current_hours','')::numeric,nullif(p_options->>'current_cycles','')::numeric,v_hash) returning id into v_id;
 insert into public.my_stuff_project_transfers(user_id,project_id,item_id,project_disposition,project_snapshot,selected_expense_snapshot,service_expense_ids,copied_fields,client_mutation_id,request_hash)
 values(v_user,p_project_id,v_id,v_disp,v_project,v_expenses,v_service,array['title','category','notes','photo','before_photo','after_photo','vehicle_year','vehicle_make','vehicle_model','model_number','serial_number','engine_model','engine_serial','vin','hull_number','purchase_price'],trim(p_mutation_id),v_hash);
 for v_expense in select value from jsonb_array_elements(v_expenses) loop
   if (v_expense->>'id')::uuid=any(v_service) then
     v_occ:=private.record_my_stuff_service_occurrence_v2_trusted(v_user,v_id,null,jsonb_build_object('service_name',coalesce(nullif(v_expense->>'description',''),'Transferred project expense'),'service_category',coalesce(v_expense->>'category','other'),'service_action','repair','completed_at',coalesce(v_expense->>'created_at',now()::text),'provenance_type','project_expense_snapshot','provenance',v_expense,'parts','[]'::jsonb,'labor','[]'::jsonb,'vendor','{}'::jsonb,'warranty','{}'::jsonb),
       'transfer-service:'||(v_expense->>'id'));
   end if;
 end loop;
 if v_disp='archive' then update public.projects set my_stuff_archived_at=coalesce(my_stuff_archived_at,now()) where id=p_project_id and user_id=v_user; end if;
 insert into public.my_stuff_v2_mutations values(v_user,trim(p_mutation_id),'transfer_project_v2',v_hash,v_id,now()); return v_id;
exception when check_violation or numeric_value_out_of_range or invalid_text_representation or datetime_field_overflow then raise exception 'Transfer contains an invalid or out-of-range value';
end $$;

-- RLS and least privilege. No browser role can forge immutable/provenance rows.
do $$ declare r text; begin
 foreach r in array array['my_stuff_v2_mutations','my_stuff_readings','my_stuff_maintenance_definitions','my_stuff_service_occurrences','my_stuff_service_occurrence_revisions','my_stuff_service_audit','my_stuff_project_transfers'] loop
   execute format('alter table public.%I enable row level security',r);
   execute format('revoke all on table public.%I from public,anon,authenticated',r);
 end loop;
end $$;
create policy my_stuff_readings_owner_select on public.my_stuff_readings for select to authenticated using((select auth.uid())=user_id);
create policy my_stuff_definitions_owner_select on public.my_stuff_maintenance_definitions for select to authenticated using((select auth.uid())=user_id);
create policy my_stuff_occurrences_owner_select on public.my_stuff_service_occurrences for select to authenticated using((select auth.uid())=user_id);
create policy my_stuff_revisions_owner_select on public.my_stuff_service_occurrence_revisions for select to authenticated using((select auth.uid())=user_id);
create policy my_stuff_audit_owner_select on public.my_stuff_service_audit for select to authenticated using((select auth.uid())=user_id);
create policy my_stuff_transfers_owner_select on public.my_stuff_project_transfers for select to authenticated using((select auth.uid())=user_id);
grant select on public.my_stuff_readings,public.my_stuff_maintenance_definitions,public.my_stuff_service_occurrences,public.my_stuff_service_occurrence_revisions,public.my_stuff_service_audit,public.my_stuff_project_transfers to authenticated;

-- Explicitly remove default PUBLIC and any stale direct anon/authenticated grants.
do $$ declare f record; begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like '%my_stuff%' loop
   execute format('revoke execute on function %s from public,anon,authenticated',f.sig);
 end loop;
end $$;
grant execute on function public.create_my_stuff_item_v2(jsonb,text),public.update_my_stuff_item_v2(uuid,jsonb,text),
 public.record_my_stuff_reading_v2(uuid,text,numeric,timestamptz,uuid,text,jsonb,text),
 public.create_my_stuff_maintenance_definition_v2(uuid,jsonb,text),public.update_my_stuff_maintenance_definition_v2(uuid,jsonb,text),
 public.get_my_stuff_due_state_v2(uuid,timestamptz),public.record_my_stuff_service_occurrence_v2(uuid,uuid,jsonb,text),
 public.revise_my_stuff_service_occurrence_v2(uuid,jsonb,text,text),public.set_my_stuff_item_archived_v2(uuid,boolean,text,text),
 public.preview_project_to_my_stuff_v2(uuid),public.transfer_project_to_my_stuff_v2(uuid,jsonb,text) to authenticated;
-- Private provenance writers are callable only by the database owner and service role.
revoke all on function private.create_my_stuff_maintenance_definition_v2_trusted(uuid,uuid,jsonb,text),
 private.record_my_stuff_service_occurrence_v2_trusted(uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function private.create_my_stuff_maintenance_definition_v2_trusted(uuid,uuid,jsonb,text),
 private.record_my_stuff_service_occurrence_v2_trusted(uuid,uuid,uuid,jsonb,text) to service_role;
-- Restore the three unchanged installed-client RPC grants after the blanket hardening.
grant execute on function public.create_my_stuff_item(text,text,date,text,numeric,numeric,text),
 public.create_my_stuff_schedule(uuid,text,text,numeric,timestamptz,numeric,text),
 public.complete_my_stuff_maintenance(uuid,timestamptz,numeric,numeric,text,text) to authenticated;

commit;
