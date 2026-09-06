begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$ begin
  if to_regprocedure('public.transfer_project_to_my_stuff_v3(uuid,jsonb,text)') is null then
    raise exception 'Required V3 transfer RPC is missing';
  end if;
end $$;

-- Projects stores vehicle_year as text while My Stuff stores model_year as
-- integer. Copy only a four-digit year; preserve missing/invalid values as NULL.
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
   if v_category not in ('car','truck','motorcycle','boat','atv','side_by_side','mower','tractor','trailer','generator','rv','equipment','bicycle','watch','electronics','gaming','tool','exercise','instrument','furniture','house','other') then v_category:='other'; end if;
   insert into public.my_stuff_items(user_id,name,category,acquired_on,notes,current_mileage,current_hours,current_cycles,client_mutation_id,item_type,model_year,manufacturer,make,model,model_number,engine_model,transmission,serial_number,engine_serial,vin,hull_number,purchase_price,purchase_currency,primary_photo_url,usage_dimensions,origin_mileage,origin_hours,origin_cycles,v2_request_hash)
   values(v_user,trim(v_project.title),v_category,null,nullif(trim(coalesce(v_project.notes,'')),''),nullif(p_options->>'current_mileage','')::numeric,nullif(p_options->>'current_hours','')::numeric,nullif(p_options->>'current_cycles','')::numeric,
     'transfer-v3:'||p_project_id::text,v_category,case when nullif(trim(v_project.vehicle_year::text),'') ~ '^[0-9]{4}$' then case when trim(v_project.vehicle_year::text)::integer between 1800 and 2200 then trim(v_project.vehicle_year::text)::integer else null end else null end,nullif(v_project.vehicle_make,''),nullif(v_project.vehicle_make,''),coalesce(nullif(v_project.vehicle_model,''),nullif(v_project.model_number,'')),nullif(v_project.model_number,''),nullif(v_project.engine_model,''),nullif(trim(coalesce(v_project.transmission,'')),''),nullif(v_project.serial_number,''),nullif(v_project.engine_serial,''),nullif(v_project.vin,''),nullif(v_project.hull_number,''),v_project.purchase_price,'USD',nullif(v_project.photo,''),v_dims,nullif(p_options->>'current_mileage','')::numeric,nullif(p_options->>'current_hours','')::numeric,nullif(p_options->>'current_cycles','')::numeric,v_transfer_hash) returning id into v_item;
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


revoke all on function public.transfer_project_to_my_stuff_v3(uuid,jsonb,text) from public,anon;
grant execute on function public.transfer_project_to_my_stuff_v3(uuid,jsonb,text) to authenticated;

commit;
