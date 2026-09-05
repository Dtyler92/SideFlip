-- SideFlip My Stuff expenses, planning, and research V3.
-- REVIEW ONLY: additive local candidate; do not apply to Production without approval.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';
create extension if not exists pgcrypto;

-- Typed vehicle identity. Legacy engine remains untouched.
alter table public.my_stuff_items
  add column engine_displacement_liters numeric,
  add column engine_cylinders integer,
  add column vehicle_type text,
  add column body_style text,
  add column plant_name text,
  add column plant_country text,
  add column vehicle_market text,
  add column vin_confirmed_at timestamptz,
  add column vin_confirmation_fingerprint text,
  add column vin_decoder_source text,
  add column vin_decoder_version text;
alter table public.my_stuff_items add constraint my_stuff_vehicle_v3_bounds check(
  (engine_displacement_liters is null or engine_displacement_liters between 0.05 and 100)
  and (engine_cylinders is null or engine_cylinders between 1 and 32)
  and length(coalesce(vehicle_type,''))<=100 and length(coalesce(body_style,''))<=100
  and length(coalesce(plant_name,''))<=200 and length(coalesce(plant_country,''))<=100
  and length(coalesce(vehicle_market,''))<=100 and length(coalesce(vin_decoder_source,''))<=100
  and length(coalesce(vin_decoder_version,''))<=100
  and (vin_confirmation_fingerprint is null or vin_confirmation_fingerprint ~ '^[0-9a-f]{64}$')
) not valid;
alter table public.my_stuff_service_occurrence_revisions
  add constraint my_stuff_service_revision_owner_item_v3 unique(id,user_id,item_id);
-- V2 stored transferred service identity in immutable provenance.  Index both
-- its snapshot shape (`id`) and the V3 shape (`expense_id`) before adoption.
create unique index my_stuff_service_project_source_v3_uq
on public.my_stuff_service_occurrences(
  user_id,(provenance->>'project_id'),(coalesce(provenance->>'expense_id',provenance->>'id'))
)
where provenance_type='project_expense_snapshot';

create table public.my_stuff_v3_mutations(
  user_id uuid not null references auth.users(id) on delete cascade,
  mutation_id text not null,
  operation text not null,
  request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(user_id,mutation_id),
  check(length(trim(mutation_id)) between 1 and 200 and length(operation) between 1 and 100 and pg_column_size(result)<=65536)
);

create table public.my_stuff_expenses(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null,
  source_type text not null check (source_type in ('manual','project_transfer','service')),
  source_project_id uuid,
  source_project_expense_id uuid,
  linked_occurrence_id uuid,
  client_mutation_id text not null,
  request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  unique(id,user_id,item_id),
  foreign key(item_id,user_id) references public.my_stuff_items(id,user_id) on delete cascade,
  foreign key(linked_occurrence_id,user_id,item_id) references public.my_stuff_service_occurrences(id,user_id,item_id),
  check(length(trim(client_mutation_id)) between 1 and 200),
  check(
    (source_type='manual' and source_project_id is null and source_project_expense_id is null and linked_occurrence_id is null)
    or (source_type='service' and source_project_id is null and source_project_expense_id is null and linked_occurrence_id is not null)
    or (source_type='project_transfer' and source_project_id is not null and source_project_expense_id is not null)
  )
);
create unique index my_stuff_expense_project_source_uq on public.my_stuff_expenses(user_id,source_project_expense_id) where source_project_expense_id is not null;
create unique index my_stuff_expense_linked_occurrence_uq on public.my_stuff_expenses(user_id,linked_occurrence_id) where linked_occurrence_id is not null;
create unique index my_stuff_expense_mutation_uq on public.my_stuff_expenses(user_id,client_mutation_id);

create table public.my_stuff_expense_revisions(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null,
  expense_id uuid not null,
  revision_number integer not null check(revision_number between 1 and 1000000),
  description text not null,
  category text not null,
  custom_category text,
  amount numeric not null check(amount between 0 and 1000000000),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  incurred_on date not null check(isfinite(incurred_on) and incurred_on between date '1900-01-01' and date '2200-12-31'),
  vendor text,
  mileage numeric,
  hours numeric,
  notes text,
  reason text,
  client_mutation_id text not null,
  request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique(expense_id,revision_number), unique(user_id,client_mutation_id), unique(id,user_id,item_id),
  foreign key(expense_id,user_id,item_id) references public.my_stuff_expenses(id,user_id,item_id) on delete cascade,
  check(length(trim(description)) between 1 and 500
    and category in ('maintenance','repair','parts','labor','fuel','registration','insurance','upgrade','accessory','transportation','other')
    and (category<>'other' or length(trim(coalesce(custom_category,''))) between 1 and 200)
    and length(coalesce(custom_category,''))<=200 and length(coalesce(vendor,''))<=500
    and length(coalesce(notes,''))<=20000 and length(coalesce(reason,''))<=2000
    and (mileage is null or mileage between 0 and 1000000000) and (hours is null or hours between 0 and 1000000000))
);
create table public.my_stuff_expense_audit(
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null, expense_id uuid not null, revision_id uuid,
  action text not null check(action in ('created','revised','voided')),
  actor_id uuid not null, reason text, created_at timestamptz not null default now(),
  foreign key(expense_id,user_id,item_id) references public.my_stuff_expenses(id,user_id,item_id) on delete cascade,
  foreign key(revision_id,user_id,item_id) references public.my_stuff_expense_revisions(id,user_id,item_id),
  check(length(coalesce(reason,''))<=1000)
);

create table public.my_stuff_definition_versions(
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null, definition_id uuid not null, version_number integer not null,
  definition jsonb not null, provenance_type text not null check(provenance_type in ('manual','ai_research','transfer','import')),
  replaces_version_id uuid, client_mutation_id text not null, request_hash text not null,
  created_at timestamptz not null default now(), unique(definition_id,version_number), unique(user_id,client_mutation_id),
  unique(id,user_id,item_id), foreign key(item_id,user_id) references public.my_stuff_items(id,user_id) on delete cascade,
  foreign key(definition_id,user_id,item_id) references public.my_stuff_maintenance_definitions(id,user_id,item_id) on delete cascade,
  check(jsonb_typeof(definition)='object' and pg_column_size(definition)<=131072 and request_hash ~ '^[0-9a-f]{64}$')
);
create table public.my_stuff_planned_occurrences(
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null, definition_id uuid not null, definition_version_id uuid,
  occurrence_key text not null, status text not null check (status in ('not_completed','completed','not_applicable','skipped','history_unknown')),
  due_at timestamptz, due_mileage numeric, due_hours numeric, due_cycles numeric,
  completed_service_occurrence_id uuid, created_at timestamptz not null default now(),
  unique (definition_id, occurrence_key), unique(id,user_id,item_id),
  foreign key(definition_id,user_id,item_id) references public.my_stuff_maintenance_definitions(id,user_id,item_id) on delete cascade,
  foreign key(definition_version_id,user_id,item_id) references public.my_stuff_definition_versions(id,user_id,item_id),
  foreign key(completed_service_occurrence_id,user_id,item_id) references public.my_stuff_service_occurrences(id,user_id,item_id),
  check(length(trim(occurrence_key)) between 1 and 200 and (due_at is null or isfinite(due_at))
    and (due_mileage is null or due_mileage between 0 and 1000000000) and (due_hours is null or due_hours between 0 and 1000000000)
    and (due_cycles is null or due_cycles between 0 and 1000000000)),
  constraint my_stuff_planned_completion_state_v3 check((status='completed')=(completed_service_occurrence_id is not null))
);
create table public.my_stuff_occurrence_status_events(
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null, planned_occurrence_id uuid not null,
  status text not null check(status in ('not_completed','completed','not_applicable','skipped','history_unknown')),
  source text not null check(source in ('manual','service','transfer','research','system')),
  reason text, actor_id uuid not null, client_mutation_id text not null, request_hash text not null,
  created_at timestamptz not null default now(), unique(user_id,client_mutation_id),
  foreign key(planned_occurrence_id,user_id,item_id) references public.my_stuff_planned_occurrences(id,user_id,item_id) on delete cascade,
  check(length(coalesce(reason,''))<=2000 and request_hash ~ '^[0-9a-f]{64}$')
);

create table public.my_stuff_attachments(
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 item_id uuid not null, expense_revision_id uuid, service_revision_id uuid, storage_path text not null,
 media_type text not null, byte_size bigint not null, sha256 text not null, state text not null check(state in ('reserved','finalized')),
 created_at timestamptz not null default now(), finalized_at timestamptz,
 unique(user_id,storage_path), unique(id,user_id,item_id),
 foreign key(item_id,user_id) references public.my_stuff_items(id,user_id) on delete cascade,
 foreign key(expense_revision_id,user_id,item_id) references public.my_stuff_expense_revisions(id,user_id,item_id),
 foreign key(service_revision_id,user_id,item_id) references public.my_stuff_service_occurrence_revisions(id,user_id,item_id),
 constraint my_stuff_attachment_exactly_one_target_v3 check(num_nonnulls(expense_revision_id,service_revision_id)=1),
 check(length(storage_path) between 1 and 1000 and length(media_type)<=100
   and byte_size between 1 and 15728640 and sha256 ~ '^[0-9a-f]{64}$')
);

create schema if not exists private;
create table private.my_stuff_research_jobs(
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, item_id uuid not null,
 confirmed_fingerprint text not null, status text not null check(status in ('queued','running','awaiting_review','approved','applied','failed','cancelled','superseded','deleted')),
 request_snapshot jsonb not null, reserved_cents integer not null check(reserved_cents>=0),
 lease_owner text, lease_expires_at timestamptz, attempt_count integer not null default 0,
 client_mutation_id text not null, request_hash text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(user_id,client_mutation_id), unique(id,user_id,item_id),
 foreign key(item_id,user_id) references public.my_stuff_items(id,user_id) on delete cascade,
 check(confirmed_fingerprint ~ '^[0-9a-f]{64}$' and jsonb_typeof(request_snapshot)='object' and pg_column_size(request_snapshot)<=32768 and request_hash ~ '^[0-9a-f]{64}$')
);
create table private.my_stuff_research_attempts(
 id uuid primary key default gen_random_uuid(), job_id uuid not null references private.my_stuff_research_jobs(id) on delete cascade,
 attempt_number integer not null, provider text not null, model text not null, retention_policy text not null,
 started_at timestamptz not null default now(), finished_at timestamptz, status text not null, error_code text, usage_cents integer,
 unique(job_id,attempt_number)
);
create table private.my_stuff_research_evidence(
 id uuid primary key default gen_random_uuid(), job_id uuid not null references private.my_stuff_research_jobs(id) on delete cascade,
 evidence_key text not null, title text not null, canonical_url text not null, exact_excerpt text not null,
 page text, section text, accessed_on date not null, applicability text not null,
 source_class text not null check(source_class in ('manufacturer','government_manufacturer','secondary')),
 content_hash text not null, created_at timestamptz not null default now(), unique(job_id,evidence_key),
 check((page is not null or section is not null) and content_hash ~ '^[0-9a-f]{64}$')
);
create table private.my_stuff_research_candidates(
 id uuid primary key default gen_random_uuid(), job_id uuid not null references private.my_stuff_research_jobs(id) on delete cascade,
 candidate jsonb not null, content_hash text not null, created_at timestamptz not null default now(),
 unique(job_id,content_hash), check(jsonb_typeof(candidate)='object' and content_hash ~ '^[0-9a-f]{64}$')
);
create table private.my_stuff_research_approvals(
 id uuid primary key default gen_random_uuid(), job_id uuid not null references private.my_stuff_research_jobs(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade, snapshot jsonb not null, snapshot_hash text not null,
 client_mutation_id text not null, created_at timestamptz not null default now(), unique(user_id,client_mutation_id), unique(job_id,snapshot_hash),
 check(jsonb_typeof(snapshot)='object' and snapshot_hash ~ '^[0-9a-f]{64}$')
);
create table private.my_stuff_research_apply_records(
 id uuid primary key default gen_random_uuid(), approval_id uuid not null references private.my_stuff_research_approvals(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade, definition_ids uuid[] not null,
 client_mutation_id text not null, created_at timestamptz not null default now(), unique(user_id,client_mutation_id), unique(approval_id)
);
create table private.my_stuff_research_budget_ledger(
 id uuid primary key default gen_random_uuid(), job_id uuid not null references private.my_stuff_research_jobs(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade, month_start date not null,
 kind text not null check(kind in ('reservation','settlement','release')), cents integer not null, created_at timestamptz not null default now(),
 unique(job_id,kind), check(cents>=0)
);
create index my_stuff_research_budget_month_idx on private.my_stuff_research_budget_ledger(user_id,month_start);
create table private.my_stuff_research_dead_letters(
 id uuid primary key default gen_random_uuid(), job_id uuid not null references private.my_stuff_research_jobs(id) on delete cascade,
 error_code text not null, error_detail text, payload_hash text not null, created_at timestamptz not null default now(),
 unique(job_id), check(payload_hash ~ '^[0-9a-f]{64}$' and length(coalesce(error_detail,''))<=4000)
);

create function public.prevent_my_stuff_v3_immutable_update() returns trigger language plpgsql set search_path=public as $$
begin if tg_op='DELETE' and pg_trigger_depth()>1 then return old; end if; raise exception '% rows are immutable; append a revision or event',tg_table_name; end $$;
create trigger my_stuff_expense_revisions_immutable before update or delete on public.my_stuff_expense_revisions for each row execute function public.prevent_my_stuff_v3_immutable_update();
create trigger my_stuff_expense_audit_immutable before update or delete on public.my_stuff_expense_audit for each row execute function public.prevent_my_stuff_v3_immutable_update();
create trigger my_stuff_definition_versions_immutable before update or delete on public.my_stuff_definition_versions for each row execute function public.prevent_my_stuff_v3_immutable_update();
create trigger my_stuff_status_events_immutable before update or delete on public.my_stuff_occurrence_status_events for each row execute function public.prevent_my_stuff_v3_immutable_update();

create function private.my_stuff_vehicle_identity_fingerprint_v3(p_item public.my_stuff_items) returns text
language sql immutable set search_path=public,private as $$
 select encode(digest(jsonb_strip_nulls(jsonb_build_object(
   'vin_sha256',case when nullif(upper(regexp_replace(coalesce(p_item.vin,''),'[^A-Z0-9]','','g')),'') is null then null
     else encode(digest(upper(regexp_replace(p_item.vin,'[^A-Z0-9]','','g')),'sha256'),'hex') end,
   'model_year',p_item.model_year,'manufacturer',p_item.manufacturer,'make',p_item.make,'model',p_item.model,'trim',p_item.trim,
   'engine',p_item.engine,'engine_model',p_item.engine_model,'engine_displacement_liters',p_item.engine_displacement_liters,
   'engine_cylinders',p_item.engine_cylinders,'transmission',p_item.transmission,'drivetrain',p_item.drivetrain,
   'fuel_power_type',p_item.fuel_power_type,'vehicle_type',p_item.vehicle_type,'body_style',p_item.body_style,
   'plant_name',p_item.plant_name,'plant_country',p_item.plant_country,'vehicle_market',p_item.vehicle_market
 ))::text,'sha256'),'hex')
$$;

create function public.invalidate_my_stuff_vehicle_confirmation_v3() returns trigger language plpgsql set search_path=public as $$
begin
 if row(new.vin,new.model_year,new.manufacturer,new.make,new.model,new.trim,new.engine,new.engine_model,new.engine_displacement_liters,new.engine_cylinders,
   new.transmission,new.drivetrain,new.fuel_power_type,new.vehicle_type,new.body_style,new.plant_name,new.plant_country,new.vehicle_market) is distinct from
    row(old.vin,old.model_year,old.manufacturer,old.make,old.model,old.trim,old.engine,old.engine_model,old.engine_displacement_liters,old.engine_cylinders,
   old.transmission,old.drivetrain,old.fuel_power_type,old.vehicle_type,old.body_style,old.plant_name,old.plant_country,old.vehicle_market) then
   new.vin_confirmed_at:=null; new.vin_confirmation_fingerprint:=null;
 end if;
 return new;
end $$;
create trigger my_stuff_vehicle_confirmation_invalidate_v3 before update on public.my_stuff_items
for each row execute function public.invalidate_my_stuff_vehicle_confirmation_v3();

create function public.confirm_my_stuff_vehicle_identity_v3(p_item_id uuid,p_identity jsonb,p_mutation_id text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_hash text; v_old text; v_result jsonb; v_key text; v_vin text; v_item public.my_stuff_items%rowtype;
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 if jsonb_typeof(p_identity)<>'object' or pg_column_size(p_identity)>32768 then raise exception 'Identity must be a bounded object'; end if;
 select key into v_key from jsonb_object_keys(p_identity) key where key not in
 ('model_year','manufacturer','make','model','trim','engine_model','engine_displacement_liters','engine_cylinders','transmission','drivetrain','fuel_power_type','vehicle_type','body_style','plant_name','plant_country','vehicle_market','vin_decoder_source','vin_decoder_version') limit 1;
 if v_key is not null then raise exception 'Unsupported identity field: %',v_key; end if;
 if nullif(trim(p_identity->>'make'),'') is null or nullif(trim(p_identity->>'model'),'') is null or nullif(p_identity->>'model_year','')::integer not between 1881 and 2200 then raise exception 'Confirmed identity requires bounded year, make, and model'; end if;
 if nullif(trim(p_mutation_id),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_user::text||':item:'||p_item_id::text,0));
 select vin into v_vin from public.my_stuff_items where id=p_item_id and user_id=v_user for update;
 if not found then raise exception 'My Stuff item not found'; end if;
 v_hash:=encode(digest(jsonb_build_object('item',p_item_id,'vin',v_vin,'identity',p_identity)::text,'sha256'),'hex');
 select request_hash,result into v_old,v_result from public.my_stuff_v3_mutations where user_id=v_user and mutation_id=trim(p_mutation_id);
 if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return v_result; end if;
 update public.my_stuff_items set
  model_year=(p_identity->>'model_year')::integer,manufacturer=nullif(trim(coalesce(p_identity->>'manufacturer','')),''),make=trim(p_identity->>'make'),model=trim(p_identity->>'model'),
  trim=nullif(trim(coalesce(p_identity->>'trim','')),''),engine_model=nullif(trim(coalesce(p_identity->>'engine_model','')),''),
  engine_displacement_liters=nullif(p_identity->>'engine_displacement_liters','')::numeric,engine_cylinders=nullif(p_identity->>'engine_cylinders','')::integer,
  transmission=nullif(trim(coalesce(p_identity->>'transmission','')),''),drivetrain=nullif(trim(coalesce(p_identity->>'drivetrain','')),''),fuel_power_type=nullif(trim(coalesce(p_identity->>'fuel_power_type','')),''),
  vehicle_type=nullif(trim(coalesce(p_identity->>'vehicle_type','')),''),body_style=nullif(trim(coalesce(p_identity->>'body_style','')),''),
  plant_name=nullif(trim(coalesce(p_identity->>'plant_name','')),''),plant_country=nullif(trim(coalesce(p_identity->>'plant_country','')),''),
  vehicle_market=nullif(trim(coalesce(p_identity->>'vehicle_market','')),''),vin_decoder_source=nullif(trim(coalesce(p_identity->>'vin_decoder_source','')),''),
  vin_decoder_version=nullif(trim(coalesce(p_identity->>'vin_decoder_version','')),'') where id=p_item_id and user_id=v_user;
 if not found then raise exception 'My Stuff item not found'; end if;
 select * into v_item from public.my_stuff_items where id=p_item_id and user_id=v_user;
 update public.my_stuff_items set vin_confirmed_at=clock_timestamp(),vin_confirmation_fingerprint=private.my_stuff_vehicle_identity_fingerprint_v3(v_item) where id=p_item_id and user_id=v_user;
 select jsonb_build_object('item_id',id,'fingerprint',vin_confirmation_fingerprint,'confirmed_at',vin_confirmed_at) into v_result from public.my_stuff_items where id=p_item_id;
 insert into public.my_stuff_v3_mutations values(v_user,trim(p_mutation_id),'confirm_vehicle',v_hash,v_result,now()); return v_result;
exception when check_violation or numeric_value_out_of_range or invalid_text_representation then raise exception 'Vehicle identity contains an invalid value';
end $$;

create function private.create_my_stuff_expense_v3_trusted(p_user_id uuid,p_item_id uuid,p_expense jsonb,p_source_type text,p_project_id uuid,p_project_expense_id uuid,p_occurrence_id uuid,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public,private as $$
declare v_hash text; v_old text; v_result jsonb; v_id uuid; v_revision uuid; v_purchase_currency text; v_currency text;
begin
 if p_user_id is null then raise exception 'User ID required'; end if;
 if jsonb_typeof(p_expense)<>'object' or pg_column_size(p_expense)>65536 then raise exception 'Expense must be a bounded object'; end if;
 if nullif(trim(p_mutation_id),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required'; end if;
 if nullif(trim(p_expense->>'description'),'') is null or nullif(p_expense->>'amount','')::numeric not between 0 and 1000000000 then raise exception 'Expense description and bounded amount required'; end if;
 if coalesce(nullif(trim(p_expense->>'category'),''),'other') not in ('maintenance','repair','parts','labor','fuel','registration','insurance','upgrade','accessory','transportation','other') then raise exception 'Invalid expense category'; end if;
 if coalesce(nullif(trim(p_expense->>'category'),''),'other')='other' and nullif(trim(p_expense->>'custom_category'),'') is null then raise exception 'Custom category required for other expenses'; end if;
 v_hash:=encode(digest(jsonb_build_object('item',p_item_id,'expense',p_expense,'source',p_source_type,'project',p_project_id,'project_expense',p_project_expense_id,'occurrence',p_occurrence_id)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':item:'||p_item_id::text,0));
 select request_hash,result into v_old,v_result from public.my_stuff_v3_mutations where user_id=p_user_id and mutation_id=trim(p_mutation_id);
 if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return (v_result->>'expense_id')::uuid; end if;
 select purchase_currency into v_purchase_currency from public.my_stuff_items where id=p_item_id and user_id=p_user_id for update; if not found then raise exception 'My Stuff item not found'; end if;
 v_currency:=upper(coalesce(nullif(trim(p_expense->>'currency'),''),'USD'));
 if v_purchase_currency is not null and v_currency is distinct from v_purchase_currency then raise exception 'Expense currency must match item purchase currency'; end if;
 insert into public.my_stuff_expenses(user_id,item_id,source_type,source_project_id,source_project_expense_id,linked_occurrence_id,client_mutation_id,request_hash)
 values(p_user_id,p_item_id,p_source_type,p_project_id,p_project_expense_id,p_occurrence_id,trim(p_mutation_id),v_hash)
 on conflict(user_id,source_project_expense_id) where source_project_expense_id is not null do nothing returning id into v_id;
 if v_id is null and p_project_expense_id is not null then
   select id into v_id from public.my_stuff_expenses where user_id=p_user_id and source_project_id=p_project_id and source_project_expense_id=p_project_expense_id and item_id=p_item_id;
   if v_id is null then raise exception 'Project expense source already belongs to another transfer'; end if;
   return v_id;
 end if;
 insert into public.my_stuff_expense_revisions(user_id,item_id,expense_id,revision_number,description,category,custom_category,amount,currency,incurred_on,vendor,mileage,hours,notes,reason,client_mutation_id,request_hash)
 values(p_user_id,p_item_id,v_id,1,trim(p_expense->>'description'),coalesce(nullif(trim(p_expense->>'category'),''),'other'),nullif(trim(coalesce(p_expense->>'custom_category','')),''),
 (p_expense->>'amount')::numeric,v_currency,coalesce(nullif(p_expense->>'incurred_on','')::date,current_date),
 nullif(trim(coalesce(p_expense->>'vendor','')),''),nullif(p_expense->>'mileage','')::numeric,nullif(p_expense->>'hours','')::numeric,nullif(trim(coalesce(p_expense->>'notes','')),''),
 null,'expense:'||v_id||':revision:1',v_hash) returning id into v_revision;
 insert into public.my_stuff_expense_audit(user_id,item_id,expense_id,revision_id,action,actor_id) values(p_user_id,p_item_id,v_id,v_revision,'created',p_user_id);
 v_result:=jsonb_build_object('expense_id',v_id,'revision_id',v_revision);
 insert into public.my_stuff_v3_mutations values(p_user_id,trim(p_mutation_id),'create_expense',v_hash,v_result,now()); return v_id;
end $$;

create function public.create_my_stuff_expense_v3(p_item_id uuid,p_expense jsonb,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid();
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 if p_expense ?| array['source_type','source_project_id','source_project_expense_id','linked_occurrence_id','provenance'] then raise exception 'Provenance fields cannot be supplied to manual expense RPC'; end if;
 return private.create_my_stuff_expense_v3_trusted(v_user,p_item_id,p_expense,'manual',null,null,null,p_mutation_id);
end $$;

create function public.revise_my_stuff_expense_v3(p_expense_id uuid,p_patch jsonb,p_reason text,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_exp public.my_stuff_expenses%rowtype; v_latest public.my_stuff_expense_revisions%rowtype; v_hash text; v_old text; v_result jsonb; v_id uuid; v_n integer; v_merged jsonb; v_key text; v_purchase_currency text;
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 if jsonb_typeof(p_patch)<>'object' or pg_column_size(p_patch)>65536 then raise exception 'Expense patch must be a bounded object'; end if;
 if p_patch='{}'::jsonb then raise exception 'Expense patch must change at least one field'; end if;
 select key into v_key from jsonb_object_keys(p_patch) key where key not in ('description','category','custom_category','amount','currency','incurred_on','vendor','mileage','hours','notes') limit 1;
 if v_key is not null then raise exception 'Unsupported expense revision field: %',v_key; end if;
 if nullif(trim(coalesce(p_reason,'')),'') is null or length(p_reason)>2000 then raise exception 'Revision reason required'; end if;
 if nullif(trim(coalesce(p_mutation_id,'')),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required'; end if;
 v_hash:=encode(digest(jsonb_build_object('expense',p_expense_id,'patch',p_patch,'reason',p_reason)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(v_user::text||':expense:'||p_expense_id::text,0));
 select request_hash,result into v_old,v_result from public.my_stuff_v3_mutations where user_id=v_user and mutation_id=trim(p_mutation_id);
 if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return (v_result->>'revision_id')::uuid; end if;
 select * into v_exp from public.my_stuff_expenses where id=p_expense_id and user_id=v_user and voided_at is null for update; if not found then raise exception 'Expense not found'; end if;
 select * into v_latest from public.my_stuff_expense_revisions where expense_id=p_expense_id order by revision_number desc limit 1;
 v_merged:=jsonb_strip_nulls(jsonb_build_object('description',v_latest.description,'category',v_latest.category,'custom_category',v_latest.custom_category,'amount',v_latest.amount,'currency',v_latest.currency,'incurred_on',v_latest.incurred_on,'vendor',v_latest.vendor,'mileage',v_latest.mileage,'hours',v_latest.hours,'notes',v_latest.notes))||p_patch;
 select purchase_currency into v_purchase_currency from public.my_stuff_items where id=v_exp.item_id and user_id=v_user;
 if v_purchase_currency is not null and upper(v_merged->>'currency') is distinct from v_purchase_currency then raise exception 'Expense currency must match item purchase currency'; end if;
 v_n:=v_latest.revision_number+1;
 insert into public.my_stuff_expense_revisions(user_id,item_id,expense_id,revision_number,description,category,custom_category,amount,currency,incurred_on,vendor,mileage,hours,notes,reason,client_mutation_id,request_hash)
 values(v_user,v_exp.item_id,p_expense_id,v_n,trim(v_merged->>'description'),v_merged->>'category',nullif(v_merged->>'custom_category',''),(v_merged->>'amount')::numeric,upper(v_merged->>'currency'),(v_merged->>'incurred_on')::date,nullif(v_merged->>'vendor',''),nullif(v_merged->>'mileage','')::numeric,nullif(v_merged->>'hours','')::numeric,nullif(v_merged->>'notes',''),trim(p_reason),trim(p_mutation_id),v_hash) returning id into v_id;
 insert into public.my_stuff_expense_audit(user_id,item_id,expense_id,revision_id,action,actor_id,reason) values(v_user,v_exp.item_id,p_expense_id,v_id,'revised',v_user,trim(p_reason));
 v_result:=jsonb_build_object('expense_id',p_expense_id,'revision_id',v_id); insert into public.my_stuff_v3_mutations values(v_user,trim(p_mutation_id),'revise_expense',v_hash,v_result,now()); return v_id;
end $$;

create function public.void_my_stuff_expense_v3(p_expense_id uuid,p_reason text,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_hash text; v_old text; v_result jsonb; v_item uuid;
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'Void reason required'; end if;
 if length(p_reason)>1000 then raise exception 'Void reason must not exceed 1000 characters'; end if;
 if nullif(trim(coalesce(p_mutation_id,'')),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required'; end if;
 v_hash:=encode(digest(jsonb_build_object('expense',p_expense_id,'reason',p_reason)::text,'sha256'),'hex'); perform pg_advisory_xact_lock(hashtextextended(v_user::text||':expense:'||p_expense_id::text,0));
 select request_hash,result into v_old,v_result from public.my_stuff_v3_mutations where user_id=v_user and mutation_id=trim(p_mutation_id); if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return p_expense_id; end if;
 update public.my_stuff_expenses set voided_at=coalesce(voided_at,clock_timestamp()) where id=p_expense_id and user_id=v_user returning item_id into v_item; if v_item is null then raise exception 'Expense not found'; end if;
 insert into public.my_stuff_expense_audit(user_id,item_id,expense_id,action,actor_id,reason) values(v_user,v_item,p_expense_id,'voided',v_user,trim(p_reason));
 v_result:=jsonb_build_object('expense_id',p_expense_id); insert into public.my_stuff_v3_mutations values(v_user,trim(p_mutation_id),'void_expense',v_hash,v_result,now()); return p_expense_id;
end $$;

create function public.get_my_stuff_expenses_v3(p_item_id uuid) returns table(expense_id uuid,source_type text,linked_occurrence_id uuid,voided_at timestamptz,revision_id uuid,revision_number integer,description text,category text,custom_category text,amount numeric,currency text,incurred_on date,vendor text,mileage numeric,hours numeric,notes text)
language plpgsql stable security definer set search_path=public as $$
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 return query select e.id,e.source_type,e.linked_occurrence_id,e.voided_at,r.id,r.revision_number,r.description,r.category,r.custom_category,r.amount,r.currency,r.incurred_on,r.vendor,r.mileage,r.hours,r.notes
 from public.my_stuff_expenses e join lateral(select x.* from public.my_stuff_expense_revisions x where x.expense_id=e.id order by x.revision_number desc limit 1) r on true
 where e.item_id=p_item_id and e.user_id=auth.uid() order by r.incurred_on desc,e.created_at desc limit 1000;
end $$;

create function public.get_my_stuff_financial_summary_v3(p_item_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare v_result jsonb;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if not exists(select 1 from public.my_stuff_items where id=p_item_id and user_id=auth.uid()) then raise exception 'My Stuff item not found'; end if;
 with latest as (
   select e.source_type,e.linked_occurrence_id,r.category,r.amount
   from public.my_stuff_expenses e
   join lateral(select x.category,x.amount from public.my_stuff_expense_revisions x where x.expense_id=e.id order by x.revision_number desc limit 1) r on true
   where e.item_id=p_item_id and e.user_id=auth.uid() and e.voided_at is null
 ), totals as (
   select coalesce(sum(amount),0) expense_total,
     coalesce(sum(amount) filter(where source_type='project_transfer'),0) transferred,
     coalesce(sum(amount) filter(where category in ('maintenance','repair','parts','labor')),0) maintenance_repair,
     coalesce(sum(amount) filter(where category in ('upgrade','accessory')),0) upgrades from latest
 ), categories as (
   select coalesce(jsonb_object_agg(category,total),'{}'::jsonb) value from (select category,sum(amount) total from latest group by category) c
 )
 select jsonb_build_object('purchase_price',i.purchase_price,'expense_total',t.expense_total,
   'total_invested',coalesce(i.purchase_price,0)+t.expense_total,
   'maintenance_repair_subtotal',t.maintenance_repair,'upgrades_subtotal',t.upgrades,
   'transferred_project_subtotal',t.transferred,'category_totals',c.value)
 into v_result from public.my_stuff_items i cross join totals t cross join categories c
 where i.id=p_item_id and i.user_id=auth.uid(); return v_result;
end $$;

create function public.record_my_stuff_service_with_expense_v3(p_item_id uuid,p_planned_occurrence_id uuid,p_definition_id uuid,p_service jsonb,p_expense jsonb,p_mutation_id text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_hash text; v_old text; v_result jsonb; v_occ uuid; v_exp uuid; v_plan public.my_stuff_planned_occurrences%rowtype;
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 if nullif(trim(coalesce(p_mutation_id,'')),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required'; end if;
 if jsonb_typeof(p_service)<>'object' or pg_column_size(p_service)>262144 or (p_expense is not null and (jsonb_typeof(p_expense)<>'object' or pg_column_size(p_expense)>65536)) then raise exception 'Service or expense is invalid'; end if;
 if p_service ?| array['provenance','provenance_type'] or (p_expense is not null and p_expense ?| array['source_type','source_project_id','source_project_expense_id','linked_occurrence_id','provenance']) then raise exception 'Provenance fields cannot be supplied to public service RPCs'; end if;
 v_hash:=encode(digest(jsonb_build_object('item',p_item_id,'planned',p_planned_occurrence_id,'definition',p_definition_id,'service',p_service,'expense',p_expense)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(v_user::text||':item:'||p_item_id::text,0));
 select request_hash,result into v_old,v_result from public.my_stuff_v3_mutations where user_id=v_user and mutation_id=trim(p_mutation_id); if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return v_result; end if;
 if p_planned_occurrence_id is not null then select * into v_plan from public.my_stuff_planned_occurrences where id=p_planned_occurrence_id and user_id=v_user and item_id=p_item_id for update; if not found then raise exception 'Planned occurrence not found'; end if; if p_definition_id is distinct from v_plan.definition_id then raise exception 'Planned occurrence definition mismatch'; end if; if v_plan.status='completed' or v_plan.completed_service_occurrence_id is not null then raise exception 'Planned occurrence already completed'; end if; end if;
 v_occ:=private.record_my_stuff_service_occurrence_v2_trusted(v_user,p_item_id,p_definition_id,p_service||jsonb_build_object('provenance_type','user_entered','provenance','{}'::jsonb),'v3-service:'||trim(p_mutation_id));
 if p_expense is not null and p_expense ? 'amount' then v_exp:=private.create_my_stuff_expense_v3_trusted(v_user,p_item_id,p_expense,'service',null,null,v_occ,'v3-expense:'||trim(p_mutation_id)); end if;
 if p_planned_occurrence_id is not null then
   update public.my_stuff_planned_occurrences set status='completed',completed_service_occurrence_id=v_occ where id=p_planned_occurrence_id;
   insert into public.my_stuff_occurrence_status_events(user_id,item_id,planned_occurrence_id,status,source,actor_id,client_mutation_id,request_hash) values(v_user,p_item_id,p_planned_occurrence_id,'completed','service',v_user,'v3-status:'||trim(p_mutation_id),v_hash);
   -- Materialization is part of this RPC transaction: a failure rolls back the
   -- service, linked expense, completion event, and successor together.
   perform public.materialize_my_stuff_next_occurrence_v3(p_definition_id);
 end if;
 v_result:=jsonb_build_object('service_occurrence_id',v_occ,'expense_id',v_exp); insert into public.my_stuff_v3_mutations values(v_user,trim(p_mutation_id),'record_service_expense',v_hash,v_result,now()); return v_result;
end $$;

create function public.revise_my_stuff_service_expense_v3(p_occurrence_id uuid,p_expense_id uuid,p_service_patch jsonb,p_expense_patch jsonb,p_reason text,p_mutation_id text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_hash text; v_old text; v_result jsonb; v_service_revision uuid; v_expense_revision uuid; v_latest public.my_stuff_service_occurrence_revisions%rowtype; v_merged jsonb;
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 if jsonb_typeof(coalesce(p_service_patch,'{}'))<>'object' or jsonb_typeof(coalesce(p_expense_patch,'{}'))<>'object' then raise exception 'Revision patches must be objects'; end if;
 if coalesce(p_service_patch,'{}')='{}'::jsonb and coalesce(p_expense_patch,'{}')='{}'::jsonb then raise exception 'At least one revision patch must change a field'; end if;
 if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'Revision reason required'; end if;
 v_hash:=encode(digest(jsonb_build_object('occurrence',p_occurrence_id,'expense',p_expense_id,'service_patch',p_service_patch,'expense_patch',p_expense_patch,'reason',p_reason)::text,'sha256'),'hex'); perform pg_advisory_xact_lock(hashtextextended(v_user::text||':occurrence:'||p_occurrence_id::text,0));
 select request_hash,result into v_old,v_result from public.my_stuff_v3_mutations where user_id=v_user and mutation_id=trim(p_mutation_id); if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return v_result; end if;
 if not exists(select 1 from public.my_stuff_expenses where id=p_expense_id and user_id=v_user and linked_occurrence_id=p_occurrence_id and voided_at is null) then raise exception 'Linked service expense not found'; end if;
 select * into v_latest from public.my_stuff_service_occurrence_revisions where occurrence_id=p_occurrence_id and user_id=v_user order by revision_number desc limit 1; if not found then raise exception 'Service occurrence not found'; end if;
 if coalesce(p_service_patch,'{}')<>'{}'::jsonb then
   v_merged:=jsonb_build_object('parts',v_latest.parts,'labor',v_latest.labor,'vendor',v_latest.vendor,'warranty',v_latest.warranty,'notes',v_latest.notes,'attachment_metadata',v_latest.attachment_metadata)||p_service_patch;
   v_service_revision:=public.revise_my_stuff_service_occurrence_v2(p_occurrence_id,v_merged,p_reason,'v3-service-revision:'||trim(p_mutation_id));
 else v_service_revision:=v_latest.id; end if;
 if coalesce(p_expense_patch,'{}')<>'{}'::jsonb then
   v_expense_revision:=public.revise_my_stuff_expense_v3(p_expense_id,p_expense_patch,p_reason,'v3-expense-revision:'||trim(p_mutation_id));
 else select id into v_expense_revision from public.my_stuff_expense_revisions where expense_id=p_expense_id and user_id=v_user order by revision_number desc limit 1; end if;
 v_result:=jsonb_build_object('service_revision_id',v_service_revision,'expense_revision_id',v_expense_revision,'service_occurrence_id',p_occurrence_id,'expense_id',p_expense_id); insert into public.my_stuff_v3_mutations values(v_user,trim(p_mutation_id),'revise_service_expense',v_hash,v_result,now()); return v_result;
end $$;

create function public.materialize_my_stuff_next_occurrence_v3(p_definition_id uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_def public.my_stuff_maintenance_definitions%rowtype; v_due record; v_id uuid; v_key text;
begin if v_user is null then raise exception 'Authentication required'; end if; select * into v_def from public.my_stuff_maintenance_definitions where id=p_definition_id and user_id=v_user and enabled; if not found then raise exception 'Maintenance definition not found'; end if; select * into v_due from public.get_my_stuff_due_state_v2(v_def.item_id,now()) where definition_id=p_definition_id;
 v_key:=encode(digest(jsonb_build_object('definition',p_definition_id,'at',v_due.next_due_at,'mileage',v_due.next_due_mileage,'hours',v_due.next_due_hours,'cycles',v_due.next_due_cycles)::text,'sha256'),'hex');
 insert into public.my_stuff_planned_occurrences(user_id,item_id,definition_id,definition_version_id,occurrence_key,status,due_at,due_mileage,due_hours,due_cycles) values(v_user,v_def.item_id,p_definition_id,(select id from public.my_stuff_definition_versions where definition_id=p_definition_id order by version_number desc limit 1),v_key,'not_completed',v_due.next_due_at,v_due.next_due_mileage,v_due.next_due_hours,v_due.next_due_cycles) on conflict(definition_id,occurrence_key) do update set definition_id=excluded.definition_id returning id into v_id; return v_id; end $$;

create function public.create_my_stuff_custom_task_v3(p_item_id uuid,p_definition jsonb,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_def uuid; v_version uuid; v_hash text; v_old text; v_result jsonb;
begin if v_user is null then raise exception 'Authentication required'; end if; if p_definition ?| array['provenance','provenance_type','source_class','citation_url','citation_title','citation_page','citation_section','citation_accessed_on'] then raise exception 'Provenance fields cannot be supplied to manual task RPC'; end if;
 if nullif(trim(coalesce(p_mutation_id,'')),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required'; end if;
 v_hash:=encode(digest(jsonb_build_object('item',p_item_id,'definition',p_definition)::text,'sha256'),'hex'); perform pg_advisory_xact_lock(hashtextextended(v_user::text||':item:'||p_item_id::text,0));
 select request_hash,result into v_old,v_result from public.my_stuff_v3_mutations where user_id=v_user and mutation_id=trim(p_mutation_id); if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return (v_result->>'definition_id')::uuid; end if;
 v_def:=public.create_my_stuff_maintenance_definition_v2(p_item_id,p_definition,'v3-definition:'||trim(p_mutation_id));
 insert into public.my_stuff_definition_versions(user_id,item_id,definition_id,version_number,definition,provenance_type,client_mutation_id,request_hash) values(v_user,p_item_id,v_def,1,p_definition||jsonb_build_object('provenance_type','manual'),'manual',trim(p_mutation_id),v_hash) returning id into v_version; perform public.materialize_my_stuff_next_occurrence_v3(v_def);
 v_result:=jsonb_build_object('definition_id',v_def,'version_id',v_version); insert into public.my_stuff_v3_mutations values(v_user,trim(p_mutation_id),'create_task',v_hash,v_result,now()); return v_def; end $$;

create function public.version_my_stuff_task_v3(p_definition_id uuid,p_patch jsonb,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_old public.my_stuff_maintenance_definitions%rowtype; v_def uuid; v_version uuid; v_n integer; v_hash text; v_prior_hash text; v_result jsonb;
begin if v_user is null then raise exception 'Authentication required'; end if; select * into v_old from public.my_stuff_maintenance_definitions where id=p_definition_id and user_id=v_user; if not found then raise exception 'Maintenance definition not found'; end if;
 if jsonb_typeof(p_patch)<>'object' or p_patch='{}'::jsonb then raise exception 'Task patch must change at least one field'; end if; if nullif(trim(coalesce(p_mutation_id,'')),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required'; end if;
 v_hash:=encode(digest(jsonb_build_object('definition',p_definition_id,'patch',p_patch)::text,'sha256'),'hex'); perform pg_advisory_xact_lock(hashtextextended(v_user::text||':definition:'||p_definition_id::text,0));
 select request_hash,result into v_prior_hash,v_result from public.my_stuff_v3_mutations where user_id=v_user and mutation_id=trim(p_mutation_id); if found then if v_prior_hash<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return (v_result->>'version_id')::uuid; end if;
 v_def:=public.update_my_stuff_maintenance_definition_v2(p_definition_id,p_patch,'v3-definition-update:'||trim(p_mutation_id)); select coalesce(max(version_number),0)+1 into v_n from public.my_stuff_definition_versions where definition_id=p_definition_id;
 insert into public.my_stuff_definition_versions(user_id,item_id,definition_id,version_number,definition,provenance_type,replaces_version_id,client_mutation_id,request_hash) select v_user,v_old.item_id,v_def,v_n,to_jsonb(d),'manual',(select id from public.my_stuff_definition_versions where definition_id=v_def order by version_number desc limit 1),trim(p_mutation_id),v_hash from public.my_stuff_maintenance_definitions d where d.id=v_def returning id into v_version;
 v_result:=jsonb_build_object('definition_id',v_def,'version_id',v_version); insert into public.my_stuff_v3_mutations values(v_user,trim(p_mutation_id),'version_task',v_hash,v_result,now()); return v_version; end $$;

create function public.list_my_stuff_schedule_groups_v3(p_item_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare v_result jsonb; begin if auth.uid() is null then raise exception 'Authentication required'; end if; select coalesce(jsonb_agg(to_jsonb(x) order by x.due_at nulls last,x.id),'[]') into v_result from (select p.* from public.my_stuff_planned_occurrences p where p.item_id=p_item_id and p.user_id=auth.uid() limit 1000)x; return v_result; end $$;
create function public.get_my_stuff_due_views_v3(p_item_id uuid,p_as_of timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare v_result jsonb; begin if auth.uid() is null then raise exception 'Authentication required'; end if; if p_as_of is null or not isfinite(p_as_of) or p_as_of<'1900-01-01Z' or p_as_of>='2200-01-01Z' then raise exception 'As-of date outside supported range'; end if; select coalesce(jsonb_agg(jsonb_build_object('occurrence',to_jsonb(p),'view',case when p.status='completed' and p_as_of-p.created_at<=interval '30 days' then 'completed_recently' when p.status<>'not_completed' then p.status when p.due_at<p_as_of then 'overdue' when p.due_at<=p_as_of+interval '30 days' then 'due_soon' else 'upcoming' end) order by p.due_at nulls last),'[]') into v_result from public.my_stuff_planned_occurrences p where p.item_id=p_item_id and p.user_id=auth.uid(); return v_result; end $$;

create function public.transition_my_stuff_occurrence_status_v3(p_occurrence_id uuid,p_status text,p_reason text,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_plan public.my_stuff_planned_occurrences%rowtype; v_hash text; v_id uuid; v_old text; v_result jsonb;
begin if v_user is null then raise exception 'Authentication required'; end if; if p_status not in ('not_completed','not_applicable','skipped','history_unknown') then raise exception 'Completed status must use completion RPC'; end if; if nullif(trim(coalesce(p_mutation_id,'')),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required'; end if;
 v_hash:=encode(digest(jsonb_build_object('occurrence',p_occurrence_id,'status',p_status,'reason',p_reason)::text,'sha256'),'hex'); perform pg_advisory_xact_lock(hashtextextended(v_user::text||':planned:'||p_occurrence_id::text,0));
 select request_hash,result into v_old,v_result from public.my_stuff_v3_mutations where user_id=v_user and mutation_id=trim(p_mutation_id); if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return (v_result->>'event_id')::uuid; end if;
 select * into v_plan from public.my_stuff_planned_occurrences where id=p_occurrence_id and user_id=v_user for update; if not found then raise exception 'Planned occurrence not found'; end if; if v_plan.status='completed' or v_plan.completed_service_occurrence_id is not null then raise exception 'Planned occurrence already completed'; end if;
 insert into public.my_stuff_occurrence_status_events(user_id,item_id,planned_occurrence_id,status,source,reason,actor_id,client_mutation_id,request_hash) values(v_user,v_plan.item_id,p_occurrence_id,p_status,'manual',nullif(trim(coalesce(p_reason,'')),''),v_user,trim(p_mutation_id),v_hash) returning id into v_id; update public.my_stuff_planned_occurrences set status=p_status where id=p_occurrence_id;
 v_result:=jsonb_build_object('event_id',v_id,'occurrence_id',p_occurrence_id,'status',p_status); insert into public.my_stuff_v3_mutations values(v_user,trim(p_mutation_id),'transition_occurrence',v_hash,v_result,now()); return v_id; end $$;

create function public.complete_my_stuff_planned_occurrence_v3(p_occurrence_id uuid,p_service jsonb,p_expense jsonb,p_mutation_id text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_plan public.my_stuff_planned_occurrences%rowtype; begin if v_user is null then raise exception 'Authentication required'; end if; select * into v_plan from public.my_stuff_planned_occurrences where id=p_occurrence_id and user_id=v_user; if not found then raise exception 'Planned occurrence not found'; end if; return public.record_my_stuff_service_with_expense_v3(v_plan.item_id,p_occurrence_id,v_plan.definition_id,p_service,p_expense,p_mutation_id); end $$;

create function public.transfer_project_to_my_stuff_v3(p_project_id uuid,p_options jsonb,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_item uuid; v_hash text; v_transfer_hash text; v_old text; v_result jsonb; v_project record; v_project_snapshot jsonb; v_expense_snapshot jsonb; v_e record; v_occ uuid; v_exp uuid; v_service_ids uuid[]; v_category text; v_disp text; v_dims text[];
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 if jsonb_typeof(coalesce(p_options,'{}'))<>'object' or pg_column_size(coalesce(p_options,'{}'))>131072 then raise exception 'Transfer options must be a bounded object'; end if;
 if nullif(trim(coalesce(p_mutation_id,'')),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required'; end if;
 v_disp:=coalesce(p_options->>'project_disposition','preserve'); if v_disp not in ('preserve','archive') then raise exception 'Project disposition must be preserve or archive'; end if;
 select coalesce(array_agg(x),array[]::text[]) into v_dims from jsonb_array_elements_text(coalesce(p_options->'usage_dimensions','[]')) x;
 if cardinality(v_dims)>4 or not v_dims <@ array['mileage','hours','time','cycles']::text[] then raise exception 'Invalid usage dimensions'; end if;
 select coalesce(array_agg(x::uuid),array[]::uuid[]) into v_service_ids from jsonb_array_elements_text(coalesce(p_options->'service_expense_ids','[]')) x;
 v_hash:=encode(digest(jsonb_build_object('project',p_project_id,'options',coalesce(p_options,'{}'))::text,'sha256'),'hex');
 v_transfer_hash:=md5(jsonb_build_object('project',p_project_id,'options',coalesce(p_options,'{}'))::text);
 perform pg_advisory_xact_lock(hashtextextended(v_user::text,0)); perform pg_advisory_xact_lock(hashtextextended(v_user::text||':project:'||p_project_id::text,0));
 select request_hash,result into v_old,v_result from public.my_stuff_v3_mutations where user_id=v_user and mutation_id=trim(p_mutation_id); if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return (v_result->>'item_id')::uuid; end if;
 select p.id,p.title,p.category,p.purchase_date,p.notes,p.photo,p.before_photo,p.after_photo,p.vehicle_year,p.vehicle_make,p.vehicle_model,p.model_number,p.serial_number,p.engine_model,p.engine_serial,p.vin,p.hull_number,p.purchase_price,p.status,p.created_at
 into v_project from public.projects p where p.id=p_project_id and p.user_id=v_user for update; if not found then raise exception 'Project not found'; end if;
 if exists(select 1 from unnest(v_service_ids) s where not exists(select 1 from public.expenses e where e.id=s and e.project_id=p_project_id and e.user_id=v_user)) then raise exception 'Service expense does not belong to project'; end if;
 -- Adopt an item previously transferred by V2 rather than creating a duplicate.
 select item_id into v_item from public.my_stuff_project_transfers where user_id=v_user and project_id=p_project_id;
 if v_item is null then
   if not public.user_has_verified_pro_entitlement(v_user) and exists(select 1 from public.my_stuff_items where user_id=v_user) then raise exception 'Free accounts can have one My Stuff item. SideFlip Pro is required for additional items.'; end if;
   v_category:=coalesce(nullif(trim(v_project.category),''),'other');
   if v_category not in ('car','truck','motorcycle','boat','atv','side_by_side','mower','tractor','trailer','generator','rv','equipment','bicycle','watch','electronics','gaming','tool','exercise','instrument','furniture','house','other') then v_category:='other'; end if;
   insert into public.my_stuff_items(user_id,name,category,acquired_on,notes,current_mileage,current_hours,current_cycles,client_mutation_id,item_type,model_year,manufacturer,make,model,model_number,engine_model,serial_number,engine_serial,vin,hull_number,purchase_price,purchase_currency,primary_photo_url,usage_dimensions,origin_mileage,origin_hours,origin_cycles,v2_request_hash)
   values(v_user,trim(v_project.title),v_category,v_project.purchase_date,nullif(trim(coalesce(v_project.notes,'')),''),nullif(p_options->>'current_mileage','')::numeric,nullif(p_options->>'current_hours','')::numeric,nullif(p_options->>'current_cycles','')::numeric,
     'transfer-v3:'||p_project_id::text,v_category,v_project.vehicle_year,nullif(v_project.vehicle_make,''),nullif(v_project.vehicle_make,''),coalesce(nullif(v_project.vehicle_model,''),nullif(v_project.model_number,'')),nullif(v_project.model_number,''),nullif(v_project.engine_model,''),nullif(v_project.serial_number,''),nullif(v_project.engine_serial,''),nullif(v_project.vin,''),nullif(v_project.hull_number,''),v_project.purchase_price,'USD',nullif(v_project.photo,''),v_dims,nullif(p_options->>'current_mileage','')::numeric,nullif(p_options->>'current_hours','')::numeric,nullif(p_options->>'current_cycles','')::numeric,v_transfer_hash) returning id into v_item;
   v_project_snapshot:=jsonb_strip_nulls(jsonb_build_object('id',v_project.id,'title',v_project.title,'category',v_project.category,'status',v_project.status,'purchase_price',v_project.purchase_price,'purchase_date',v_project.purchase_date,'photo',v_project.photo,'before_photo',v_project.before_photo,'after_photo',v_project.after_photo,'notes',v_project.notes,'model_number',v_project.model_number,'serial_number',v_project.serial_number,'engine_model',v_project.engine_model,'engine_serial',v_project.engine_serial,'vin',v_project.vin,'hull_number',v_project.hull_number,'vehicle_year',v_project.vehicle_year,'vehicle_make',v_project.vehicle_make,'vehicle_model',v_project.vehicle_model,'created_at',v_project.created_at));
   select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',e.id,'project_id',e.project_id,'description',e.description,'amount',e.amount,'category',e.category,'labor_hours',e.labor_hours,'created_at',e.created_at)) order by e.created_at,e.id),'[]'::jsonb)
   into v_expense_snapshot from public.expenses e where e.project_id=p_project_id and e.user_id=v_user;
   insert into public.my_stuff_project_transfers(user_id,project_id,item_id,project_disposition,project_snapshot,selected_expense_snapshot,service_expense_ids,copied_fields,client_mutation_id,request_hash)
   values(v_user,p_project_id,v_item,v_disp,v_project_snapshot,v_expense_snapshot,v_service_ids,array['title','category','notes','photo','before_photo','after_photo','vehicle_year','vehicle_make','vehicle_model','model_number','serial_number','engine_model','engine_serial','vin','hull_number','purchase_price'],trim(p_mutation_id),v_transfer_hash);
   if v_disp='archive' then update public.projects set my_stuff_archived_at=coalesce(my_stuff_archived_at,now()) where id=p_project_id and user_id=v_user; end if;
 end if;
 update public.my_stuff_items set purchase_currency=coalesce(purchase_currency,'USD') where id=v_item and user_id=v_user;
 -- Point-in-time import: only expenses present now and not already linked are copied.
 for v_e in select e.id,e.description,e.amount,e.category,e.labor_hours,e.created_at from public.expenses e where e.project_id=p_project_id and e.user_id=v_user order by e.created_at,e.id loop
   v_occ:=null;
   if v_e.id=any(v_service_ids) and not exists(select 1 from public.my_stuff_expenses x where x.user_id=v_user and x.source_project_id=p_project_id and x.source_project_expense_id=v_e.id) then
     select o.id into v_occ from public.my_stuff_service_occurrences o
      where o.user_id=v_user and o.item_id=v_item and o.provenance_type='project_expense_snapshot'
        and o.provenance->>'project_id'=p_project_id::text
        and coalesce(o.provenance->>'expense_id',o.provenance->>'id')=v_e.id::text
      limit 1;
     if v_occ is null then
       v_occ:=private.record_my_stuff_service_occurrence_v2_trusted(v_user,v_item,null,jsonb_build_object('service_name',v_e.description,'service_category',case when v_e.category in ('maintenance','repair') then v_e.category else 'other' end,'service_action','repair','completed_at',v_e.created_at,'provenance_type','project_expense_snapshot','provenance',jsonb_build_object('project_id',p_project_id,'expense_id',v_e.id,'description',v_e.description,'amount',v_e.amount,'category',v_e.category,'created_at',v_e.created_at),'parts','[]'::jsonb,'labor',case when v_e.labor_hours is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('hours',v_e.labor_hours)) end,'vendor','{}'::jsonb,'warranty','{}'::jsonb),'v3-transfer-service:'||v_e.id::text);
     end if;
   end if;
   v_category:=case when v_e.category in ('maintenance','repair','parts','labor','fuel','registration','insurance','upgrade','accessory','transportation') then v_e.category else 'other' end;
   v_exp:=private.create_my_stuff_expense_v3_trusted(v_user,v_item,jsonb_build_object('description',v_e.description,'amount',v_e.amount,'category',v_category,'custom_category',case when v_category='other' then coalesce(nullif(v_e.category,''),'Project expense') end,'currency','USD','incurred_on',v_e.created_at::date,'notes','Imported point-in-time from Project expense'), 'project_transfer',p_project_id,v_e.id,v_occ,'v3-transfer-expense:'||v_e.id::text);
 end loop;
 v_result:=jsonb_build_object('item_id',v_item); insert into public.my_stuff_v3_mutations values(v_user,trim(p_mutation_id),'transfer_project_v3',v_hash,v_result,now()); return v_item;
end $$;

create function public.reserve_my_stuff_attachment_v3(p_item_id uuid,p_expense_revision_id uuid,p_service_revision_id uuid,p_media_type text,p_byte_size bigint,p_sha256 text,p_mutation_id text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_id uuid:=gen_random_uuid(); v_path text; v_hash text; v_result jsonb;
begin if v_user is null then raise exception 'Authentication required'; end if; if not exists(select 1 from public.my_stuff_items where id=p_item_id and user_id=v_user) then raise exception 'My Stuff item not found'; end if; v_path:=v_user::text||'/'||p_item_id::text||'/attachments/'||v_id::text; v_hash:=encode(digest(jsonb_build_object('item',p_item_id,'expense_revision',p_expense_revision_id,'service_revision',p_service_revision_id,'media_type',p_media_type,'byte_size',p_byte_size,'sha256',p_sha256)::text,'sha256'),'hex'); insert into public.my_stuff_attachments(id,user_id,item_id,expense_revision_id,service_revision_id,storage_path,media_type,byte_size,sha256,state) values(v_id,v_user,p_item_id,p_expense_revision_id,p_service_revision_id,v_path,p_media_type,p_byte_size,lower(p_sha256),'reserved'); v_result:=jsonb_build_object('attachment_id',v_id,'bucket','my-stuff-media','storage_path',v_path); insert into public.my_stuff_v3_mutations values(v_user,trim(p_mutation_id),'reserve_attachment',v_hash,v_result,now()); return v_result; end $$;
create function public.finalize_my_stuff_attachment_v3(p_attachment_id uuid,p_storage_path text,p_sha256 text,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_id uuid; begin if v_user is null then raise exception 'Authentication required'; end if; update public.my_stuff_attachments set state='finalized',finalized_at=clock_timestamp() where id=p_attachment_id and user_id=v_user and state='reserved' and storage_path=p_storage_path and sha256=lower(p_sha256) returning id into v_id; if v_id is null then raise exception 'Reserved attachment not found or metadata mismatch'; end if; return v_id; end $$;

create function public.enqueue_my_stuff_research_v3(p_item_id uuid,p_confirmed_fingerprint text,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_item public.my_stuff_items%rowtype;
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 if exists(select 1 from public.account_deletion_tombstones where user_id=v_user) then raise exception 'ACCOUNT_DELETION_PENDING'; end if;
 if not public.user_has_verified_pro_entitlement(v_user) then raise exception 'PRO_REQUIRED'; end if;
 select * into v_item from public.my_stuff_items where id=p_item_id and user_id=v_user;
 if not found then raise exception 'My Stuff item not found'; end if;
 if v_item.vin_confirmation_fingerprint is null or v_item.vin_confirmation_fingerprint is distinct from p_confirmed_fingerprint then raise exception 'IDENTITY_UNCONFIRMED'; end if;
 raise exception 'RESEARCH_PROVIDER_DISABLED';
end $$;

create function private.lease_my_stuff_research_job_v3(p_worker text,p_lease_seconds integer default 300) returns private.my_stuff_research_jobs
language plpgsql security definer set search_path=public,private as $$
begin raise exception 'RESEARCH_PROVIDER_DISABLED'; end $$;
create function private.settle_my_stuff_research_job_v3(p_job_id uuid,p_worker text,p_cost_cents integer,p_evidence jsonb,p_candidates jsonb) returns uuid
language plpgsql security definer set search_path=public,private as $$
begin raise exception 'RESEARCH_PROVIDER_DISABLED'; end $$;

-- RLS and least privilege: authenticated clients can read owned public records but only RPCs write them.
do $$ declare r text; begin foreach r in array array['my_stuff_v3_mutations','my_stuff_expenses','my_stuff_expense_revisions','my_stuff_expense_audit','my_stuff_definition_versions','my_stuff_planned_occurrences','my_stuff_occurrence_status_events','my_stuff_attachments'] loop execute format('alter table public.%I enable row level security',r); execute format('revoke all on table public.%I from public,anon,authenticated',r); end loop; end $$;
create policy my_stuff_expenses_owner_select on public.my_stuff_expenses for select to authenticated using((select auth.uid())=user_id);
create policy my_stuff_expense_revisions_owner_select on public.my_stuff_expense_revisions for select to authenticated using((select auth.uid())=user_id);
create policy my_stuff_expense_audit_owner_select on public.my_stuff_expense_audit for select to authenticated using((select auth.uid())=user_id);
create policy my_stuff_definition_versions_owner_select on public.my_stuff_definition_versions for select to authenticated using((select auth.uid())=user_id);
create policy my_stuff_planned_owner_select on public.my_stuff_planned_occurrences for select to authenticated using((select auth.uid())=user_id);
create policy my_stuff_status_owner_select on public.my_stuff_occurrence_status_events for select to authenticated using((select auth.uid())=user_id);
create policy my_stuff_attachments_owner_select on public.my_stuff_attachments for select to authenticated using((select auth.uid())=user_id);
grant select on public.my_stuff_expenses,public.my_stuff_expense_revisions,public.my_stuff_expense_audit,public.my_stuff_definition_versions,public.my_stuff_planned_occurrences,public.my_stuff_occurrence_status_events,public.my_stuff_attachments to authenticated;

do $$ declare r text; begin foreach r in array array['my_stuff_research_jobs','my_stuff_research_attempts','my_stuff_research_evidence','my_stuff_research_candidates','my_stuff_research_approvals','my_stuff_research_apply_records','my_stuff_research_budget_ledger','my_stuff_research_dead_letters'] loop execute format('alter table private.%I enable row level security',r); execute format('revoke all on table private.%I from public,anon,authenticated',r); end loop; end $$;
revoke all on table private.my_stuff_research_jobs from public,anon,authenticated;
revoke all on table private.my_stuff_research_attempts from public,anon,authenticated;
revoke all on table private.my_stuff_research_evidence from public,anon,authenticated;
revoke all on table private.my_stuff_research_candidates from public,anon,authenticated;
revoke all on table private.my_stuff_research_approvals from public,anon,authenticated;
revoke all on table private.my_stuff_research_apply_records from public,anon,authenticated;
revoke all on table private.my_stuff_research_budget_ledger from public,anon,authenticated;
revoke all on table private.my_stuff_research_dead_letters from public,anon,authenticated;

-- Remove default PUBLIC execution, then expose only narrow authenticated RPCs.
do $$ declare f record; begin for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname like '%my_stuff%v3%' loop execute format('revoke execute on function %s from public,anon,authenticated',f.sig); end loop; end $$;
grant execute on function public.confirm_my_stuff_vehicle_identity_v3(uuid,jsonb,text),public.create_my_stuff_expense_v3(uuid,jsonb,text),public.revise_my_stuff_expense_v3(uuid,jsonb,text,text),public.void_my_stuff_expense_v3(uuid,text,text),public.get_my_stuff_expenses_v3(uuid),public.get_my_stuff_financial_summary_v3(uuid),public.record_my_stuff_service_with_expense_v3(uuid,uuid,uuid,jsonb,jsonb,text),public.revise_my_stuff_service_expense_v3(uuid,uuid,jsonb,jsonb,text,text),public.create_my_stuff_custom_task_v3(uuid,jsonb,text),public.version_my_stuff_task_v3(uuid,jsonb,text),public.materialize_my_stuff_next_occurrence_v3(uuid),public.list_my_stuff_schedule_groups_v3(uuid),public.get_my_stuff_due_views_v3(uuid,timestamptz),public.transition_my_stuff_occurrence_status_v3(uuid,text,text,text),public.complete_my_stuff_planned_occurrence_v3(uuid,jsonb,jsonb,text),public.transfer_project_to_my_stuff_v3(uuid,jsonb,text) to authenticated;
revoke all on function private.create_my_stuff_expense_v3_trusted(uuid,uuid,jsonb,text,uuid,uuid,uuid,text),private.lease_my_stuff_research_job_v3(text,integer),private.settle_my_stuff_research_job_v3(uuid,text,integer,jsonb,jsonb) from public,anon,authenticated;
grant execute on function private.create_my_stuff_expense_v3_trusted(uuid,uuid,jsonb,text,uuid,uuid,uuid,text) to service_role;

commit;
