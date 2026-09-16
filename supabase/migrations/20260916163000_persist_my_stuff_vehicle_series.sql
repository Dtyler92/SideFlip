begin;

alter table public.my_stuff_items
  add column if not exists series text;

alter table public.my_stuff_items
  add constraint my_stuff_items_series_length_check
  check (length(coalesce(series,'')) <= 200) not valid;

create or replace function private.my_stuff_vehicle_identity_fingerprint_v3(p_item public.my_stuff_items) returns text
language sql immutable set search_path=public,private,extensions as $$
 select encode(digest(jsonb_strip_nulls(jsonb_build_object(
   'item_type',p_item.item_type,
   'vin_sha256',case when nullif(upper(regexp_replace(coalesce(p_item.vin,''),'[^A-Z0-9]','','g')),'') is null then null
     else encode(digest(upper(regexp_replace(p_item.vin,'[^A-Z0-9]','','g')),'sha256'),'hex') end,
   'model_year',p_item.model_year,'manufacturer',p_item.manufacturer,'make',p_item.make,'model',p_item.model,'series',p_item.series,'trim',p_item.trim,
   'engine',p_item.engine,'engine_model',p_item.engine_model,'engine_displacement_liters',p_item.engine_displacement_liters,
   'engine_cylinders',p_item.engine_cylinders,'transmission',p_item.transmission,'drivetrain',p_item.drivetrain,
   'fuel_power_type',p_item.fuel_power_type,'vehicle_type',p_item.vehicle_type,'body_style',p_item.body_style,
   'plant_name',p_item.plant_name,'plant_country',p_item.plant_country,'vehicle_market',p_item.vehicle_market
 ))::text,'sha256'),'hex')
$$;

create or replace function public.invalidate_my_stuff_vehicle_confirmation_v3() returns trigger
language plpgsql set search_path=public,extensions as $$
begin
 if row(new.item_type,new.vin,new.model_year,new.manufacturer,new.make,new.model,new.series,new.trim,new.engine,new.engine_model,new.engine_displacement_liters,new.engine_cylinders,
   new.transmission,new.drivetrain,new.fuel_power_type,new.vehicle_type,new.body_style,new.plant_name,new.plant_country,new.vehicle_market) is distinct from
    row(old.item_type,old.vin,old.model_year,old.manufacturer,old.make,old.model,old.series,old.trim,old.engine,old.engine_model,old.engine_displacement_liters,old.engine_cylinders,
   old.transmission,old.drivetrain,old.fuel_power_type,old.vehicle_type,old.body_style,old.plant_name,old.plant_country,old.vehicle_market) then
   new.vin_confirmed_at:=null;
   new.vin_confirmation_fingerprint:=null;
 end if;
 return new;
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
     'archived_at','archive_reason','v2_request_hash','vin_confirmed_at','vin_confirmation_fingerprint') limit 1;
  if v_key is not null then raise exception 'Protected item field cannot be edited: %',v_key; end if;
  select key into v_key from jsonb_object_keys(p_patch) key where key not in
    ('name','category','acquired_on','notes','item_type','custom_name','model_year','manufacturer','make','model','series','trim','model_number',
     'engine','engine_model','engine_displacement_liters','engine_cylinders','transmission','drivetrain','fuel_power_type','vehicle_type','body_style',
     'plant_name','plant_country','vehicle_market','serial_number','engine_serial','vin','hull_number','registration_number','purchase_price',
     'purchase_currency','purchase_vendor','primary_photo_url','usage_dimensions','usage_profile','manufactured_on','in_service_on') limit 1;
  if v_key is not null then raise exception 'Unsupported item field: %',v_key; end if;
  if p_patch?'usage_dimensions' then
    select coalesce(array_agg(x),array[]::text[]) into v_dims from jsonb_array_elements_text(coalesce(p_patch->'usage_dimensions','[]')) x;
    if cardinality(v_dims)>4 or not v_dims <@ array['mileage','hours','time','cycles']::text[] then raise exception 'Invalid usage dimensions'; end if;
  end if;
  if p_patch?'item_type' and p_patch->>'item_type' not in ('car','truck','motorcycle','boat','airplane','atv','side_by_side','mower','tractor','trailer','generator','rv','equipment','bicycle','watch','electronics','gaming','tool','exercise','instrument','furniture','house','other') then raise exception 'Invalid item type'; end if;
  v_hash:=md5(jsonb_build_object('item_id',p_item_id,'patch',p_patch)::text);
  perform pg_advisory_xact_lock(hashtextextended(v_user::text||':item:'||p_item_id::text,0));
  select result_id,request_hash into v_id,v_old from public.my_stuff_v2_mutations where user_id=v_user and mutation_id=trim(p_mutation_id);
  if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return v_id; end if;
  perform 1 from public.my_stuff_items where id=p_item_id and user_id=v_user for update;
  if not found then raise exception 'My Stuff item not found'; end if;
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
    series=case
      when coalesce(p_patch->>'item_type',item_type) not in ('car','truck','motorcycle','atv','side_by_side','trailer','rv') then null
      when p_patch?'series' then nullif(trim(coalesce(p_patch->>'series','')),'')
      else series
    end,
    trim=case when p_patch?'trim' then nullif(trim(coalesce(p_patch->>'trim','')),'') else trim end,
    model_number=case when p_patch?'model_number' then nullif(trim(coalesce(p_patch->>'model_number','')),'') else model_number end,
    engine=case when p_patch?'engine' then nullif(trim(coalesce(p_patch->>'engine','')),'') else engine end,
    engine_model=case when p_patch?'engine_model' then nullif(trim(coalesce(p_patch->>'engine_model','')),'') else engine_model end,
    engine_displacement_liters=case when p_patch?'engine_displacement_liters' then nullif(p_patch->>'engine_displacement_liters','')::numeric else engine_displacement_liters end,
    engine_cylinders=case when p_patch?'engine_cylinders' then nullif(p_patch->>'engine_cylinders','')::integer else engine_cylinders end,
    transmission=case when p_patch?'transmission' then nullif(trim(coalesce(p_patch->>'transmission','')),'') else transmission end,
    drivetrain=case when p_patch?'drivetrain' then nullif(trim(coalesce(p_patch->>'drivetrain','')),'') else drivetrain end,
    fuel_power_type=case when p_patch?'fuel_power_type' then nullif(trim(coalesce(p_patch->>'fuel_power_type','')),'') else fuel_power_type end,
    vehicle_type=case when p_patch?'vehicle_type' then nullif(trim(coalesce(p_patch->>'vehicle_type','')),'') else vehicle_type end,
    body_style=case when p_patch?'body_style' then nullif(trim(coalesce(p_patch->>'body_style','')),'') else body_style end,
    plant_name=case when p_patch?'plant_name' then nullif(trim(coalesce(p_patch->>'plant_name','')),'') else plant_name end,
    plant_country=case when p_patch?'plant_country' then nullif(trim(coalesce(p_patch->>'plant_country','')),'') else plant_country end,
    vehicle_market=case when p_patch?'vehicle_market' then nullif(trim(coalesce(p_patch->>'vehicle_market','')),'') else vehicle_market end,
    serial_number=case when p_patch?'serial_number' then nullif(trim(coalesce(p_patch->>'serial_number','')),'') else serial_number end,
    engine_serial=case when p_patch?'engine_serial' then nullif(trim(coalesce(p_patch->>'engine_serial','')),'') else engine_serial end,
    vin=case
      when coalesce(p_patch->>'item_type',item_type) not in ('car','truck','motorcycle','atv','side_by_side','trailer','rv') then null
      when p_patch?'vin' then nullif(upper(regexp_replace(coalesce(p_patch->>'vin',''),'[ -]','','g')),'')
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
  insert into public.my_stuff_v2_mutations values(v_user,trim(p_mutation_id),'update_item_v2',v_hash,p_item_id,now());
  return p_item_id;
exception when check_violation or numeric_value_out_of_range or invalid_text_representation or datetime_field_overflow then raise exception 'Item contains an invalid or out-of-range value';
end $$;

create or replace function public.confirm_my_stuff_vehicle_identity_v3(p_item_id uuid,p_identity jsonb,p_mutation_id text) returns jsonb
language plpgsql security definer set search_path=public,extensions as $$
declare v_user uuid:=auth.uid(); v_hash text; v_old text; v_result jsonb; v_key text; v_vin text; v_existing_vin text; v_identity jsonb; v_item public.my_stuff_items%rowtype;
begin
 if v_user is null then raise exception 'Authentication required'; end if;
 if jsonb_typeof(p_identity)<>'object' or pg_column_size(p_identity)>32768 then raise exception 'Identity must be a bounded object'; end if;
 select key into v_key from jsonb_object_keys(p_identity) key where key not in
 ('vin','model_year','manufacturer','make','model','series','trim','engine','engine_model','engine_displacement_liters','engine_cylinders','transmission','drivetrain','fuel_power_type','vehicle_type','body_style','plant_name','plant_country','vehicle_market','vin_decoder_source','vin_decoder_version') limit 1;
 if v_key is not null then raise exception 'Unsupported identity field: %',v_key; end if;
 if nullif(trim(p_identity->>'make'),'') is null or nullif(trim(p_identity->>'model'),'') is null or nullif(p_identity->>'model_year','')::integer not between 1881 and 2200 then raise exception 'Confirmed identity requires bounded year, make, and model'; end if;
 if length(coalesce(p_identity->>'series',''))>200 or length(coalesce(p_identity->>'engine',''))>200 then raise exception 'Vehicle identity contains an invalid value'; end if;
 if nullif(trim(p_mutation_id),'') is null or length(p_mutation_id)>200 then raise exception 'Mutation ID required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_user::text||':item:'||p_item_id::text,0));
 select vin into v_existing_vin from public.my_stuff_items where id=p_item_id and user_id=v_user for update;
 if not found then raise exception 'My Stuff item not found'; end if;
 v_vin:=upper(regexp_replace(coalesce(nullif(p_identity->>'vin',''),v_existing_vin,''),'[ -]','','g'));
 if v_vin !~ '^[A-HJ-NPR-Z0-9]{17}$' then raise exception 'Confirmed identity requires a valid standard VIN'; end if;
 v_identity:=jsonb_set(p_identity,'{vin}',to_jsonb(v_vin),true);
 v_hash:=encode(digest(jsonb_build_object('item',p_item_id,'identity',v_identity)::text,'sha256'),'hex');
 select request_hash,result into v_old,v_result from public.my_stuff_v3_mutations where user_id=v_user and mutation_id=trim(p_mutation_id);
 if found then if v_old<>v_hash then raise exception 'Idempotency key reused with different request'; end if; return v_result; end if;
 update public.my_stuff_items set
  vin=v_vin,model_year=(v_identity->>'model_year')::integer,manufacturer=nullif(trim(coalesce(v_identity->>'manufacturer','')),''),make=trim(v_identity->>'make'),model=trim(v_identity->>'model'),
  series=nullif(trim(coalesce(v_identity->>'series','')),''),trim=nullif(trim(coalesce(v_identity->>'trim','')),''),engine=nullif(trim(coalesce(v_identity->>'engine','')),''),engine_model=nullif(trim(coalesce(v_identity->>'engine_model','')),''),
  engine_displacement_liters=nullif(v_identity->>'engine_displacement_liters','')::numeric,engine_cylinders=nullif(v_identity->>'engine_cylinders','')::integer,
  transmission=nullif(trim(coalesce(v_identity->>'transmission','')),''),drivetrain=nullif(trim(coalesce(v_identity->>'drivetrain','')),''),fuel_power_type=nullif(trim(coalesce(v_identity->>'fuel_power_type','')),''),
  vehicle_type=nullif(trim(coalesce(v_identity->>'vehicle_type','')),''),body_style=nullif(trim(coalesce(v_identity->>'body_style','')),''),
  plant_name=nullif(trim(coalesce(v_identity->>'plant_name','')),''),plant_country=nullif(trim(coalesce(v_identity->>'plant_country','')),''),
  vehicle_market=nullif(trim(coalesce(v_identity->>'vehicle_market','')),''),vin_decoder_source=nullif(trim(coalesce(v_identity->>'vin_decoder_source','')),''),
  vin_decoder_version=nullif(trim(coalesce(v_identity->>'vin_decoder_version','')),'') where id=p_item_id and user_id=v_user;
 if not found then raise exception 'My Stuff item not found'; end if;
 select * into v_item from public.my_stuff_items where id=p_item_id and user_id=v_user;
 update public.my_stuff_items set vin_confirmed_at=clock_timestamp(),vin_confirmation_fingerprint=private.my_stuff_vehicle_identity_fingerprint_v3(v_item) where id=p_item_id and user_id=v_user;
 select jsonb_build_object('item_id',id,'fingerprint',vin_confirmation_fingerprint,'confirmed_at',vin_confirmed_at) into v_result from public.my_stuff_items where id=p_item_id and user_id=v_user;
 insert into public.my_stuff_v3_mutations values(v_user,trim(p_mutation_id),'confirm_vehicle',v_hash,v_result,now());
 return v_result;
exception when check_violation or numeric_value_out_of_range or invalid_text_representation then raise exception 'Vehicle identity contains an invalid value';
end $$;

revoke all on function public.confirm_my_stuff_vehicle_identity_v3(uuid,jsonb,text) from public,anon;
grant execute on function public.confirm_my_stuff_vehicle_identity_v3(uuid,jsonb,text) to authenticated;

commit;
