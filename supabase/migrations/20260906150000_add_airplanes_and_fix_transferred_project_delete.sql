begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Stabilize the preflight definitions against concurrent constraint DDL.
lock table public.my_stuff_to_project_transfers, public.my_stuff_to_project_expense_copies in share mode;

do $$
declare
  v_transfer_fk text;
  v_copy_fk text;
  v_live_expense_fk text;
begin
  select pg_get_constraintdef(oid) into v_transfer_fk from pg_constraint
   where conrelid='public.my_stuff_to_project_transfers'::regclass and conname='my_stuff_to_project_transfers_project_id_fkey';
  select pg_get_constraintdef(oid) into v_copy_fk from pg_constraint
   where conrelid='public.my_stuff_to_project_expense_copies'::regclass and conname='my_stuff_to_project_expense_copies_project_id_fkey';
  select pg_get_constraintdef(oid) into v_live_expense_fk from pg_constraint
   where conrelid='public.my_stuff_to_project_expense_copies'::regclass and conname='my_stuff_to_project_expense_copies_project_expense_id_fkey';
  if v_transfer_fk is null or v_transfer_fk !~ '^FOREIGN KEY \(project_id\) REFERENCES projects\(id\) DEFERRABLE INITIALLY DEFERRED$' then raise exception 'Unexpected transferred-Project provenance FK definition'; end if;
  if v_copy_fk is null or v_copy_fk !~ '^FOREIGN KEY \(project_id\) REFERENCES projects\(id\) DEFERRABLE INITIALLY DEFERRED$' then raise exception 'Unexpected copied-expense Project provenance FK definition'; end if;
  if v_live_expense_fk is null or v_live_expense_fk !~ '^FOREIGN KEY \(project_expense_id\) REFERENCES expenses\(id\) ON DELETE SET NULL$' then raise exception 'Expected copied live-expense pointer FK is missing or drifted'; end if;
end $$;

-- These Project UUIDs are immutable historical provenance, not live-row ownership.
-- Keep them NOT NULL and remove only the two FKs that block safe Project deletion.
alter table public.my_stuff_to_project_transfers drop constraint my_stuff_to_project_transfers_project_id_fkey;
alter table public.my_stuff_to_project_expense_copies drop constraint my_stuff_to_project_expense_copies_project_id_fkey;

create or replace function public.create_my_stuff_item_v2(p_item jsonb,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_user uuid:=auth.uid(); v_hash text; v_id uuid; v_old_hash text; v_dims text[]; v_item_type text; v_dim text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_item)<>'object' or pg_column_size(p_item)>131072 then raise exception 'Item must be a bounded object'; end if;
  if nullif(trim(p_mutation_id),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required and must not exceed 200 characters'; end if;
  v_hash:=md5(p_item::text); perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  select result_id,request_hash into v_id,v_old_hash from public.my_stuff_v2_mutations where user_id=v_user and mutation_id=trim(p_mutation_id);
  if found then if v_old_hash<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return v_id; end if;
  if not public.user_has_verified_pro_entitlement(v_user) and exists(select 1 from public.my_stuff_items where user_id=v_user) then raise exception 'Free accounts can have one My Stuff item. SideFlip Pro is required for additional items.'; end if;
  if nullif(trim(p_item->>'name'),'') is null or length(p_item->>'name')>200 then raise exception 'Item name is required and must not exceed 200 characters'; end if;
  v_item_type:=coalesce(p_item->>'item_type','other');
  if v_item_type not in ('car','truck','motorcycle','boat','airplane','atv','side_by_side','mower','tractor','trailer','generator','rv','equipment','bicycle','watch','electronics','gaming','tool','exercise','instrument','furniture','house','other') then raise exception 'Invalid item type'; end if;
  select coalesce(array_agg(x),array[]::text[]) into v_dims from jsonb_array_elements_text(coalesce(p_item->'usage_dimensions','[]')) x;
  if cardinality(v_dims)>4 or not v_dims <@ array['mileage','hours','time','cycles']::text[] then raise exception 'Invalid usage dimensions'; end if;
  if v_item_type in ('car','truck','motorcycle','boat','airplane','atv','side_by_side','mower','tractor','trailer','generator','rv','equipment','bicycle','exercise') then
    if cardinality(v_dims)=0 then raise exception 'Usage tracking is required for this item type'; end if;
    if 'time'=any(v_dims) then raise exception 'Usage tracking must use mileage, hours, or cycles for this item type'; end if;
    foreach v_dim in array v_dims loop
      if nullif(trim(case v_dim when 'mileage' then p_item->>'current_mileage' when 'hours' then p_item->>'current_hours' when 'cycles' then p_item->>'current_cycles' end),'') is null then
        raise exception 'Current % is required for every selected usage type',v_dim;
      end if;
    end loop;
    if nullif(trim(p_item->>'purchase_price'),'') is null then raise exception 'Purchase price is required for this item type'; end if;
  end if;
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
    case when v_item_type in ('car','truck','motorcycle','atv','side_by_side','trailer','rv') then nullif(trim(coalesce(p_item->>'vin','')),'') end,nullif(trim(coalesce(p_item->>'hull_number','')),''),nullif(trim(coalesce(p_item->>'registration_number','')),''),
    nullif(p_item->>'purchase_price','')::numeric,upper(nullif(trim(coalesce(p_item->>'purchase_currency','')),'')),nullif(trim(coalesce(p_item->>'purchase_vendor','')),''),
    nullif(trim(coalesce(p_item->>'primary_photo_url','')),''),v_dims,coalesce(p_item->>'usage_profile','normal'),nullif(p_item->>'manufactured_on','')::date,
    nullif(p_item->>'in_service_on','')::date,nullif(p_item->>'origin_mileage','')::numeric,nullif(p_item->>'origin_hours','')::numeric,
    nullif(p_item->>'origin_cycles','')::numeric,v_hash) returning id into v_id;
  insert into public.my_stuff_v2_mutations values(v_user,trim(p_mutation_id),'create_item_v2',v_hash,v_id,now());
  return v_id;
exception when check_violation or numeric_value_out_of_range or invalid_text_representation or datetime_field_overflow then
  raise exception 'Item contains an invalid or out-of-range value';
end $$;

create or replace function public.update_my_stuff_item_v2(p_item_id uuid,p_patch jsonb,p_mutation_id text) returns uuid
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
  if p_patch?'item_type' and p_patch->>'item_type' not in ('car','truck','motorcycle','boat','airplane','atv','side_by_side','mower','tractor','trailer','generator','rv','equipment','bicycle','watch','electronics','gaming','tool','exercise','instrument','furniture','house','other') then raise exception 'Invalid item type'; end if;
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
    vin=case
      when coalesce(p_patch->>'item_type',item_type) not in ('car','truck','motorcycle','atv','side_by_side','trailer','rv') then null
      when p_patch?'vin' then nullif(trim(coalesce(p_patch->>'vin','')),'')
      else vin
    end,
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

create or replace function public.transfer_project_to_my_stuff_v2(p_project_id uuid,p_options jsonb,p_mutation_id text) returns uuid
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
 if v_category not in ('car','truck','motorcycle','boat','airplane','atv','side_by_side','mower','tractor','trailer','generator','rv','equipment','bicycle','watch','electronics','gaming','tool','exercise','instrument','furniture','house','other') then v_category:='other'; end if;
 insert into public.my_stuff_items(user_id,name,category,acquired_on,notes,current_mileage,current_hours,current_cycles,client_mutation_id,item_type,model_year,manufacturer,make,model,model_number,engine_model,serial_number,engine_serial,vin,hull_number,purchase_price,primary_photo_url,usage_dimensions,origin_mileage,origin_hours,origin_cycles,v2_request_hash)
 values(v_user,trim(v_project->>'title'),v_category,nullif(v_project->>'purchase_date','')::date,nullif(trim(coalesce(v_project->>'notes','')),''),nullif(p_options->>'current_mileage','')::numeric,nullif(p_options->>'current_hours','')::numeric,nullif(p_options->>'current_cycles','')::numeric,
 'transfer:'||p_project_id::text,v_category,nullif(v_project->>'vehicle_year','')::integer,nullif(v_project->>'vehicle_make',''),nullif(v_project->>'vehicle_make',''),coalesce(nullif(v_project->>'vehicle_model',''),nullif(v_project->>'model_number','')),nullif(v_project->>'model_number',''),nullif(v_project->>'engine_model',''),nullif(v_project->>'serial_number',''),nullif(v_project->>'engine_serial',''),case when v_category in ('car','truck','motorcycle','atv','side_by_side','trailer','rv') then nullif(v_project->>'vin','') end,nullif(v_project->>'hull_number',''),nullif(v_project->>'purchase_price','')::numeric,nullif(v_project->>'photo',''),array(select jsonb_array_elements_text(coalesce(p_options->'usage_dimensions','[]'))),nullif(p_options->>'current_mileage','')::numeric,nullif(p_options->>'current_hours','')::numeric,nullif(p_options->>'current_cycles','')::numeric,v_hash) returning id into v_id;
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

create or replace function public.transfer_project_to_my_stuff_v3(p_project_id uuid,p_options jsonb,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public,extensions as $$
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
 select p.id,p.title,p.category,p.notes,p.photo,p.before_photo,p.after_photo,p.vehicle_year,p.vehicle_make,p.vehicle_model,p.model_number,p.serial_number,p.engine_model,p.transmission,p.engine_serial,p.vin,p.hull_number,p.purchase_price,p.status,p.created_at
 into v_project from public.projects p where p.id=p_project_id and p.user_id=v_user for update; if not found then raise exception 'Project not found'; end if;
 if exists(select 1 from unnest(v_service_ids) s where not exists(select 1 from public.expenses e where e.id=s and e.project_id=p_project_id and e.user_id=v_user)) then raise exception 'Service expense does not belong to project'; end if;
 -- Adopt an item previously transferred by V2 rather than creating a duplicate.
 select item_id into v_item from public.my_stuff_project_transfers where user_id=v_user and project_id=p_project_id;
 if v_item is null then
   if not public.user_has_verified_pro_entitlement(v_user) and exists(select 1 from public.my_stuff_items where user_id=v_user) then raise exception 'Free accounts can have one My Stuff item. SideFlip Pro is required for additional items.'; end if;
   v_category:=coalesce(nullif(trim(v_project.category),''),'other');
   if v_category not in ('car','truck','motorcycle','boat','airplane','atv','side_by_side','mower','tractor','trailer','generator','rv','equipment','bicycle','watch','electronics','gaming','tool','exercise','instrument','furniture','house','other') then v_category:='other'; end if;
   insert into public.my_stuff_items(user_id,name,category,acquired_on,notes,current_mileage,current_hours,current_cycles,client_mutation_id,item_type,model_year,manufacturer,make,model,model_number,engine_model,transmission,serial_number,engine_serial,vin,hull_number,purchase_price,purchase_currency,primary_photo_url,usage_dimensions,origin_mileage,origin_hours,origin_cycles,v2_request_hash)
   values(v_user,trim(v_project.title),v_category,null,nullif(trim(coalesce(v_project.notes,'')),''),nullif(p_options->>'current_mileage','')::numeric,nullif(p_options->>'current_hours','')::numeric,nullif(p_options->>'current_cycles','')::numeric,
     'transfer-v3:'||p_project_id::text,v_category,case when nullif(trim(v_project.vehicle_year::text),'') ~ '^[0-9]{4}$' then case when trim(v_project.vehicle_year::text)::integer between 1800 and 2200 then trim(v_project.vehicle_year::text)::integer else null end else null end,nullif(v_project.vehicle_make,''),nullif(v_project.vehicle_make,''),coalesce(nullif(v_project.vehicle_model,''),nullif(v_project.model_number,'')),nullif(v_project.model_number,''),nullif(v_project.engine_model,''),nullif(trim(coalesce(v_project.transmission,'')),''),nullif(v_project.serial_number,''),nullif(v_project.engine_serial,''),case when v_category in ('car','truck','motorcycle','atv','side_by_side','trailer','rv') then nullif(v_project.vin,'') end,nullif(v_project.hull_number,''),v_project.purchase_price,'USD',nullif(v_project.photo,''),v_dims,nullif(p_options->>'current_mileage','')::numeric,nullif(p_options->>'current_hours','')::numeric,nullif(p_options->>'current_cycles','')::numeric,v_transfer_hash) returning id into v_item;
   v_project_snapshot:=jsonb_strip_nulls(jsonb_build_object('id',v_project.id,'title',v_project.title,'category',v_project.category,'status',v_project.status,'purchase_price',v_project.purchase_price,'photo',v_project.photo,'before_photo',v_project.before_photo,'after_photo',v_project.after_photo,'notes',v_project.notes,'model_number',v_project.model_number,'serial_number',v_project.serial_number,'engine_model',v_project.engine_model,'transmission',v_project.transmission,'engine_serial',v_project.engine_serial,'vin',v_project.vin,'hull_number',v_project.hull_number,'vehicle_year',v_project.vehicle_year,'vehicle_make',v_project.vehicle_make,'vehicle_model',v_project.vehicle_model,'created_at',v_project.created_at));
   select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',e.id,'project_id',e.project_id,'description',e.description,'amount',e.amount,'category',e.category,'labor_hours',e.labor_hours,'created_at',e.created_at)) order by e.created_at,e.id),'[]'::jsonb)
   into v_expense_snapshot from public.expenses e where e.project_id=p_project_id and e.user_id=v_user;
   insert into public.my_stuff_project_transfers(user_id,project_id,item_id,project_disposition,project_snapshot,selected_expense_snapshot,service_expense_ids,copied_fields,client_mutation_id,request_hash)
   values(v_user,p_project_id,v_item,v_disp,v_project_snapshot,v_expense_snapshot,v_service_ids,array['title','category','notes','photo','before_photo','after_photo','vehicle_year','vehicle_make','vehicle_model','model_number','serial_number','engine_model','transmission','engine_serial','vin','hull_number','purchase_price'],trim(p_mutation_id),v_transfer_hash);
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
    when v_item.item_type in ('car','truck','motorcycle','atv','side_by_side','trailer','rv','boat','airplane','bicycle','watch','electronics','gaming','tool','exercise','instrument','furniture','house','mower') then v_item.item_type
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

revoke all on function public.create_my_stuff_item_v2(jsonb,text) from public,anon;
revoke all on function public.update_my_stuff_item_v2(uuid,jsonb,text) from public,anon;
revoke all on function public.transfer_project_to_my_stuff_v2(uuid,jsonb,text) from public,anon;
revoke all on function public.transfer_project_to_my_stuff_v3(uuid,jsonb,text) from public,anon;
revoke all on function public.transfer_my_stuff_to_project_v1(uuid,text) from public,anon;
grant execute on function public.create_my_stuff_item_v2(jsonb,text) to authenticated;
grant execute on function public.update_my_stuff_item_v2(uuid,jsonb,text) to authenticated;
grant execute on function public.transfer_project_to_my_stuff_v2(uuid,jsonb,text) to authenticated;
grant execute on function public.transfer_project_to_my_stuff_v3(uuid,jsonb,text) to authenticated;
grant execute on function public.transfer_my_stuff_to_project_v1(uuid,text) to authenticated;

commit;
