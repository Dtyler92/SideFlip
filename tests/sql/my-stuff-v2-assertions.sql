create function public._test_assert_v2(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'assertion failed: %',p_message; end if; end $$;

-- Installed clients retain the exact V1 RPC implementations and signatures.
select public._test_assert_v2(not exists(
  select 1 from public._my_stuff_v1_rpc_snapshot s
  left join pg_proc p on p.oid=s.object_oid
  where p.oid is null
     or pg_get_function_identity_arguments(p.oid) is distinct from s.identity_arguments
     or pg_get_function_result(p.oid) is distinct from s.result_type
     or p.prosrc is distinct from s.prosrc
     or p.prosecdef is distinct from s.prosecdef
     or p.proconfig is distinct from s.proconfig
),'V1 My Stuff RPC signatures and implementations unchanged');
select public._test_assert_v2((select count(*) from public._my_stuff_v1_rpc_snapshot)=3,'all three V1 RPCs were snapshotted');
select public._test_assert_v2(not exists(
  select 1 from public._my_stuff_v1_column_snapshot s
  where s.columns is distinct from (
    select (array_agg(c.column_name::text order by c.ordinal_position))[1:cardinality(s.columns)]
    from information_schema.columns c where c.table_schema='public' and c.table_name=s.table_name
  )
),'V1 table column order remains a compatible prefix');
select public._test_assert_v2(not exists(
  select 1 from public._my_stuff_legacy_object_snapshot s
  join pg_class c on c.oid=s.object_oid
  where s.signature is distinct from jsonb_build_object(
    'columns',(select jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and not (c.relname='projects' and a.attname='my_stuff_archived_at')),
    'constraints',(select jsonb_agg(pg_get_constraintdef(con.oid,true) order by con.conname) from pg_constraint con where con.conrelid=c.oid),
    'indexes',(select jsonb_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid) from pg_index i where i.indrelid=c.oid),
    'triggers',(select jsonb_agg(pg_get_triggerdef(t.oid,true) order by t.tgname) from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal)
  )
),'existing projects, expenses, and Goal/accounting object contracts unchanged');
select public._test_assert_v2(
  (select count(*)=1 and bool_and(data_type='timestamp with time zone' and is_nullable='YES' and column_default is null)
   from information_schema.columns where table_schema='public' and table_name='projects' and column_name='my_stuff_archived_at'),
  'project archive marker is the only explicitly permitted additive project change');

select public._test_assert_v2(
  (select array_agg(c.column_name::text order by c.ordinal_position) @> array['item_type','custom_name','manufacturer','make','model','trim','model_number','engine','engine_model','transmission','drivetrain','fuel_power_type','serial_number','engine_serial','vin','hull_number','registration_number','model_year','purchase_price','purchase_currency','purchase_vendor','primary_photo_url','usage_dimensions','current_cycles','usage_profile','manufactured_on','in_service_on','origin_mileage','origin_hours','origin_cycles','archived_at','archive_reason','v2_request_hash'] from information_schema.columns c where c.table_schema='public' and c.table_name='my_stuff_items'),
  'V2 item fields installed');
select public._test_assert_v2(not exists(
  select 1 from (values
    ('my_stuff_v2_mutations'),('my_stuff_readings'),('my_stuff_maintenance_definitions'),('my_stuff_service_occurrences'),
    ('my_stuff_service_occurrence_revisions'),('my_stuff_service_audit'),('my_stuff_project_transfers')
  ) v(name) where to_regclass('public.'||v.name) is null
),'all V2 tables installed');
select public._test_assert_v2(not exists(
  select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in ('my_stuff_v2_mutations','my_stuff_readings','my_stuff_maintenance_definitions','my_stuff_service_occurrences','my_stuff_service_occurrence_revisions','my_stuff_service_audit','my_stuff_project_transfers') and not c.relrowsecurity
),'RLS enabled on every V2 table');
select public._test_assert_v2(not exists(
  select 1 from pg_class c, lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
  where c.oid in ('public.my_stuff_v2_mutations'::regclass,'public.my_stuff_readings'::regclass,'public.my_stuff_maintenance_definitions'::regclass,'public.my_stuff_service_occurrences'::regclass,'public.my_stuff_service_occurrence_revisions'::regclass,'public.my_stuff_service_audit'::regclass,'public.my_stuff_project_transfers'::regclass)
    and acl.grantee in (0,(select oid from pg_roles where rolname='anon'))
),'PUBLIC and anon have no V2 table privileges');
select public._test_assert_v2(
  not has_table_privilege('authenticated','public.my_stuff_v2_mutations','select,insert,update,delete')
  and not has_table_privilege('authenticated','public.my_stuff_readings','insert,update,delete')
  and not has_table_privilege('authenticated','public.my_stuff_service_occurrences','insert,update,delete')
  and not has_table_privilege('authenticated','public.my_stuff_service_occurrence_revisions','insert,update,delete')
  and not has_table_privilege('authenticated','public.my_stuff_service_audit','insert,update,delete')
  and not has_table_privilege('authenticated','public.my_stuff_project_transfers','insert,update,delete')
  and not has_table_privilege('authenticated','public.my_stuff_maintenance_definitions','insert,update,delete')
  and not has_column_privilege('authenticated','public.my_stuff_items','effective_current_mileage','update')
  and not has_column_privilege('authenticated','public.my_stuff_items','effective_current_hours','update')
  and not has_column_privilege('authenticated','public.my_stuff_items','effective_current_cycles','update')
  and not has_function_privilege('authenticated','public.sync_my_stuff_effective_readings_v2()','execute'),
  'V2 grants are read-only and effective readings are protected; all mutations use RPCs');
select public._test_assert_v2(not exists(
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('create_my_stuff_item_v2','update_my_stuff_item_v2','record_my_stuff_reading_v2','create_my_stuff_maintenance_definition_v2','update_my_stuff_maintenance_definition_v2','get_my_stuff_due_state_v2','record_my_stuff_service_occurrence_v2','revise_my_stuff_service_occurrence_v2','set_my_stuff_item_archived_v2','preview_project_to_my_stuff_v2','transfer_project_to_my_stuff_v2')
    and (not p.prosecdef or not (p.proconfig @> array['search_path=public']))
),'V2 RPCs are SECURITY DEFINER with fixed search_path');
select public._test_assert_v2(
  has_function_privilege('authenticated','public.create_my_stuff_item_v2(jsonb,text)','execute')
  and has_function_privilege('authenticated','public.update_my_stuff_item_v2(uuid,jsonb,text)','execute')
  and has_function_privilege('authenticated','public.record_my_stuff_reading_v2(uuid,text,numeric,timestamptz,uuid,text,jsonb,text)','execute')
  and has_function_privilege('authenticated','public.create_my_stuff_maintenance_definition_v2(uuid,jsonb,text)','execute')
  and has_function_privilege('authenticated','public.update_my_stuff_maintenance_definition_v2(uuid,jsonb,text)','execute')
  and has_function_privilege('authenticated','public.get_my_stuff_due_state_v2(uuid,timestamptz)','execute')
  and has_function_privilege('authenticated','public.record_my_stuff_service_occurrence_v2(uuid,uuid,jsonb,text)','execute')
  and has_function_privilege('authenticated','public.revise_my_stuff_service_occurrence_v2(uuid,jsonb,text,text)','execute')
  and has_function_privilege('authenticated','public.set_my_stuff_item_archived_v2(uuid,boolean,text,text)','execute')
  and has_function_privilege('authenticated','public.preview_project_to_my_stuff_v2(uuid)','execute')
  and has_function_privilege('authenticated','public.transfer_project_to_my_stuff_v2(uuid,jsonb,text)','execute')
  and not has_function_privilege('anon','public.transfer_project_to_my_stuff_v2(uuid,jsonb,text)','execute'),
  'V2 RPC grants are authenticated-only');
select public._test_assert_v2(
  to_regnamespace('private') is not null
  and not has_schema_privilege('authenticated','private','usage')
  and not has_schema_privilege('anon','private','usage')
  and has_schema_privilege('service_role','private','usage')
  and not has_function_privilege('authenticated','private.create_my_stuff_maintenance_definition_v2_trusted(uuid,uuid,jsonb,text)','execute')
  and not has_function_privilege('authenticated','private.record_my_stuff_service_occurrence_v2_trusted(uuid,uuid,uuid,jsonb,text)','execute')
  and has_function_privilege('service_role','private.create_my_stuff_maintenance_definition_v2_trusted(uuid,uuid,jsonb,text)','execute')
  and has_function_privilege('service_role','private.record_my_stuff_service_occurrence_v2_trusted(uuid,uuid,uuid,jsonb,text)','execute'),
  'trusted provenance writers are private and service-only');
select public._test_assert_v2(not exists(
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
       lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
  where n.nspname='public' and p.proname like '%my_stuff%' and acl.grantee=0 and acl.privilege_type='EXECUTE'
),'PUBLIC cannot execute My Stuff functions');
select public._test_assert_v2(not exists(
  select 1 from pg_constraint con join pg_class child on child.oid=con.conrelid join pg_class parent on parent.oid=con.confrelid
  where con.contype='f' and child.relname like 'my_stuff_%' and parent.relname in ('projects','expenses','trade_up_goals','goal_ledger')
),'V2 has no project, expense, or Goal/accounting foreign keys');

-- Atomic transfer copies approved descriptive fields without mutating accounting.
set role authenticated;
select set_config('request.jwt.claim.sub','88888888-8888-4888-8888-888888888888',false);
do $$
declare v_item uuid; v_retry uuid; v_reading uuid; v_correction uuid; v_definition uuid; v_occurrence uuid; v_revision uuid; v_all uuid; v_first uuid; v_last uuid; v_historical uuid;
begin
  v_item:=public.transfer_project_to_my_stuff_v2(
    '80000000-0000-4000-8000-000000000001',
    '{"current_mileage":100,"current_hours":5,"current_cycles":2,"usage_dimensions":["mileage","hours","cycles"],"selected_expense_ids":["e0000000-0000-4000-8000-000000000001"],"service_expense_ids":["e0000000-0000-4000-8000-000000000001"]}',
    'transfer-free-1');
  v_retry:=public.transfer_project_to_my_stuff_v2(
    '80000000-0000-4000-8000-000000000001',
    '{"current_mileage":100,"current_hours":5,"current_cycles":2,"usage_dimensions":["mileage","hours","cycles"],"selected_expense_ids":["e0000000-0000-4000-8000-000000000001"],"service_expense_ids":["e0000000-0000-4000-8000-000000000001"]}',
    'transfer-free-1');
  perform public._test_assert_v2(v_item=v_retry,'transfer retry returns the same item');
  perform public._test_assert_v2((select count(*)=1 from public.my_stuff_project_transfers where project_id='80000000-0000-4000-8000-000000000001'),'transfer creates one provenance link');
  perform public._test_assert_v2((select name='Project Truck' and category='truck' and purchase_price=1234.50 and model_number='M1' and vin='VIN1' and current_mileage=100 and current_hours=5 and current_cycles=2 from public.my_stuff_items where id=v_item),'transfer copies approved item fields');
  perform public._test_assert_v2((select status='sold' and sale_price=9999 and goal_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and goal_funding_amount=700 and out_of_pocket_amount=534.50 and trade_credit_amount=111 and my_stuff_archived_at is null from public.projects where id='80000000-0000-4000-8000-000000000001'),'transfer preserves project and Goal/accounting state');
  perform public._test_assert_v2((select not copied_fields && array['status','sale_price','sold_at','goal_id','goal_funding_amount','out_of_pocket_amount','trade_credit_amount']::text[] and jsonb_array_length(selected_expense_snapshot)=1 from public.my_stuff_project_transfers where item_id=v_item),'accounting fields are not copied into item and selected expenses are immutable provenance');
  perform public._test_assert_v2((select count(*)=1 from public.my_stuff_service_occurrences where item_id=v_item and provenance_type='project_expense_snapshot' and provenance->>'id'='e0000000-0000-4000-8000-000000000001'),'transfer preserves trusted expense provenance through the private writer');
  begin
    perform public.transfer_project_to_my_stuff_v2('80000000-0000-4000-8000-000000000001','{"current_mileage":999}','transfer-free-1');
    raise exception 'expected changed-payload idempotency failure';
  exception when others then
    if sqlerrm='expected changed-payload idempotency failure' then raise; end if;
    perform public._test_assert_v2(sqlerrm='Idempotency key reused with different request','changed transfer retry rejected');
  end;
  begin
    perform public.transfer_project_to_my_stuff_v2('80000000-0000-4000-8000-000000000002','{}','transfer-free-2');
    raise exception 'expected Free transfer quota failure';
  exception when others then
    if sqlerrm='expected Free transfer quota failure' then raise; end if;
    perform public._test_assert_v2(sqlerrm like 'Free accounts can have one My Stuff item%','Free transfer quota enforced');
  end;

  v_reading:=public.record_my_stuff_reading_v2(v_item,'cycles',3,'2026-09-03T12:00:00Z',null,null,'{"source_note":"meter"}','reading-1');
  perform public._test_assert_v2(v_reading=public.record_my_stuff_reading_v2(v_item,'cycles',3,'2026-09-03T12:00:00Z',null,null,'{"source_note":"meter"}','reading-1'),'reading retry is idempotent');
  v_correction:=public.record_my_stuff_reading_v2(v_item,'cycles',2.5,'2026-09-03T12:05:00Z',v_reading,'transcription error','{}','reading-correction');
  perform public._test_assert_v2((select corrects_reading_id=v_reading and source='correction' from public.my_stuff_readings where id=v_correction),'reading correction is appended with metadata');
  perform public._test_assert_v2((select current_cycles=3 and effective_current_cycles=2.5 from public.my_stuff_items where id=v_item),'correction changes only the protected effective reading');
  perform set_config('sideflip.allow_reading_correction','on',false);
  begin update public.my_stuff_items set current_mileage=99,current_hours=4 where id=v_item; raise exception 'expected spoofed GUC rewind failure';
  exception when others then if sqlerrm='expected spoofed GUC rewind failure' then raise; end if; perform public._test_assert_v2(sqlerrm in ('Mileage cannot move backwards','Operating hours cannot move backwards'),'caller-settable GUC cannot authorize V1 meter rewind'); end;
  begin update public.my_stuff_items set effective_current_mileage=1 where id=v_item; raise exception 'expected protected effective field failure';
  exception when others then if sqlerrm='expected protected effective field failure' then raise; end if; perform public._test_assert_v2(sqlstate='42501','authenticated cannot write protected effective meter columns'); end;
  begin update public.my_stuff_readings set reading_value=4 where id=v_reading; raise exception 'expected immutable reading failure';
  exception when others then if sqlerrm='expected immutable reading failure' then raise; end if; perform public._test_assert_v2(sqlstate='42501' or sqlerrm like '%immutable%','reading update rejected'); end;
  begin perform public.record_my_stuff_reading_v2(v_item,'cycles',4,'infinity',null,null,'{}','reading-infinity'); raise exception 'expected finite date failure';
  exception when others then if sqlerrm='expected finite date failure' then raise; end if; perform public._test_assert_v2(sqlerrm='Reading date is outside the supported range','infinite reading date rejected for intended reason'); end;

  perform public.update_my_stuff_item_v2(v_item,'{"model_number":"MODEL-2","engine_model":"ENG-2","serial_number":"SER-2","engine_serial":"ES-2","vin":"VIN-2","hull_number":"HULL-2","registration_number":"REG-2","usage_dimensions":["mileage","hours"],"manufactured_on":"2020-01-02","in_service_on":"2021-03-04"}','rich-item-update');
  perform public._test_assert_v2((select model_number='MODEL-2' and engine_model='ENG-2' and serial_number='SER-2' and engine_serial='ES-2' and vin='VIN-2' and hull_number='HULL-2' and registration_number='REG-2' and usage_dimensions=array['mileage','hours'] and manufactured_on='2020-01-02' and in_service_on='2021-03-04' from public.my_stuff_items where id=v_item),'all rich mutable item fields are updated');
  begin perform public.update_my_stuff_item_v2(v_item,'{"serial_nubmer":"typo"}','unknown-item-key'); raise exception 'expected unknown item key failure';
  exception when others then if sqlerrm='expected unknown item key failure' then raise; end if; perform public._test_assert_v2(sqlerrm='Unsupported item field: serial_nubmer','unknown item patch keys fail closed'); end;
  begin perform public.update_my_stuff_item_v2(v_item,'{"origin_mileage":0}','protected-item-key'); raise exception 'expected protected item key failure';
  exception when others then if sqlerrm='expected protected item key failure' then raise; end if; perform public._test_assert_v2(sqlerrm='Protected item field cannot be edited: origin_mileage','origin meter is explicitly protected'); end;
  begin perform public.set_my_stuff_item_archived_v2(v_item,true,null,' '); raise exception 'expected archive mutation validation failure';
  exception when others then if sqlerrm='expected archive mutation validation failure' then raise; end if; perform public._test_assert_v2(sqlerrm='Mutation ID required and must not exceed 200 characters','archive mutation ID is validated'); end;
  begin perform public.revise_my_stuff_service_occurrence_v2(gen_random_uuid(),'{}','reason',repeat('x',201)); raise exception 'expected revision mutation validation failure';
  exception when others then if sqlerrm='expected revision mutation validation failure' then raise; end if; perform public._test_assert_v2(sqlerrm='Mutation ID required and must not exceed 200 characters','revision mutation ID is validated before lookup'); end;

  perform public.record_my_stuff_reading_v2(v_item,'mileage',111,'2026-09-03T12:20:00Z',null,null,'{}','due-mileage');
  perform public.record_my_stuff_reading_v2(v_item,'hours',5,'2026-09-03T12:20:00Z',null,null,'{}','due-hours');
  v_all:=public.create_my_stuff_maintenance_definition_v2(v_item,'{"name":"All dimensions","due_semantics":"all","cadence_anchor":"asset_origin","normal_interval_miles":10,"normal_interval_hours":10,"due_soon_miles":0,"due_soon_hours":0}','due-all');
  v_first:=public.create_my_stuff_maintenance_definition_v2(v_item,'{"name":"First dimension","due_semantics":"whichever_first","cadence_anchor":"asset_origin","normal_interval_miles":10,"normal_interval_hours":10,"due_soon_miles":0,"due_soon_hours":0}','due-first');
  v_last:=public.create_my_stuff_maintenance_definition_v2(v_item,'{"name":"Last completion anchor","due_semantics":"whichever_first","cadence_anchor":"last_completion","normal_interval_miles":10,"first_interval_miles":5,"due_soon_miles":0}','due-last');
  perform public._test_assert_v2((select due_status='upcoming' and next_due_mileage=110 and next_due_hours=15 from public.get_my_stuff_due_state_v2(v_item,'2026-09-03T12:30:00Z') where definition_id=v_all),'all semantics wait for every configured dimension');
  perform public._test_assert_v2((select due_status='overdue' and next_due_mileage=110 from public.get_my_stuff_due_state_v2(v_item,'2026-09-03T12:30:00Z') where definition_id=v_first),'whichever-first semantics fire on one overdue dimension');
  perform public._test_assert_v2((select next_due_mileage=105 from public.get_my_stuff_due_state_v2(v_item,'2026-09-03T12:30:00Z') where definition_id=v_last),'as-of cutoff ignores later completion and keeps first cadence');

  v_definition:=public.create_my_stuff_maintenance_definition_v2(v_item,'{"name":"Full service","due_semantics":"whichever_first","active_profile":"severe","cadence_anchor":"asset_origin","normal_interval_miles":5000,"normal_interval_hours":100,"normal_interval_cycles":50,"normal_calendar_months":12,"first_interval_miles":1000,"first_interval_hours":20,"first_interval_cycles":10,"first_calendar_months":3,"due_soon_miles":500,"due_soon_hours":10,"due_soon_cycles":5,"due_soon_days":30,"enabled":true}','definition-1');
  perform public._test_assert_v2((select due_semantics='whichever_first' and active_profile='severe' and cadence_anchor='asset_origin' and normal_interval_miles=5000 and normal_interval_hours=100 and normal_interval_cycles=50 and normal_calendar_months=12 and first_interval_miles=1000 and due_soon_days=30 and enabled from public.my_stuff_maintenance_definitions where id=v_definition),'rich maintenance definition stored');
  perform public._test_assert_v2((select provenance_type='manual' and source_class='user' and citation_url is null from public.my_stuff_maintenance_definitions where id=v_definition),'public definition create forces manual user provenance');
  begin perform public.create_my_stuff_maintenance_definition_v2(v_item,'{"name":"Forged research","provenance_type":"ai_research","source_class":"manufacturer_manual"}','forge-definition-ai'); raise exception 'expected forged definition failure';
  exception when others then if sqlerrm='expected forged definition failure' then raise; end if; perform public._test_assert_v2(sqlerrm='Provenance fields cannot be supplied to public maintenance definition RPCs','public definition create rejects trusted provenance'); end;
  begin perform public.create_my_stuff_maintenance_definition_v2(v_item,'{"name":"Arbitrary provenance","provenance":{"authority":"dealer"}}','forge-definition-json'); raise exception 'expected arbitrary definition provenance failure';
  exception when others then if sqlerrm='expected arbitrary definition provenance failure' then raise; end if; perform public._test_assert_v2(sqlerrm='Provenance fields cannot be supplied to public maintenance definition RPCs','public definition create rejects arbitrary provenance JSON'); end;
  begin perform public.update_my_stuff_maintenance_definition_v2(v_definition,'{"source_class":"dealer"}','forge-definition-update'); raise exception 'expected forged definition update failure';
  exception when others then if sqlerrm='expected forged definition update failure' then raise; end if; perform public._test_assert_v2(sqlerrm='Provenance fields cannot be supplied to public maintenance definition RPCs','public definition update rejects trusted source classes'); end;
  begin
    perform public.update_my_stuff_maintenance_definition_v2(v_definition,'{"typo_unknown":123}','definition-unknown-key');
    raise exception 'expected unknown maintenance definition key failure';
  exception when others then
    if sqlerrm='expected unknown maintenance definition key failure' then raise; end if;
    perform public._test_assert_v2(sqlerrm='Unsupported maintenance definition field: typo_unknown','unknown maintenance definition patch keys fail closed');
  end;
  perform public.update_my_stuff_maintenance_definition_v2(v_definition,'{"enabled":false}','definition-disable');
  perform public._test_assert_v2((select not enabled from public.my_stuff_maintenance_definitions where id=v_definition),'definition can be disabled through narrow RPC');
  v_occurrence:=public.record_my_stuff_service_occurrence_v2(v_item,v_last,'{"completed_at":"2026-09-03T13:00:00Z","mileage":112,"hours":6,"cycles":3,"parts":[{"name":"filter","cost":12}],"labor":[{"hours":1}],"vendor":{"name":"Shop"},"warranty":{"months":12},"notes":"done","attachment_metadata":[{"name":"receipt.pdf","private":true}]}','service-1');
  perform public._test_assert_v2((select provenance_type='user_entered' and provenance='{}'::jsonb from public.my_stuff_service_occurrences where id=v_occurrence),'public service create forces user provenance');
  begin perform public.record_my_stuff_service_occurrence_v2(v_item,null,'{"service_name":"Forged import","provenance_type":"import","provenance":{"source":"dealer"}}','forge-service-import'); raise exception 'expected forged service failure';
  exception when others then if sqlerrm='expected forged service failure' then raise; end if; perform public._test_assert_v2(sqlerrm='Provenance fields cannot be supplied to public service RPCs','public service create rejects imported/arbitrary provenance'); end;
  begin perform public.revise_my_stuff_service_occurrence_v2(v_occurrence,'{"notes":"forged","provenance":{"source":"import"}}','bad provenance','forge-service-revision'); raise exception 'expected forged revision failure';
  exception when others then if sqlerrm='expected forged revision failure' then raise; end if; perform public._test_assert_v2(sqlerrm='Provenance fields cannot be supplied to public service RPCs','public service revision rejects arbitrary provenance'); end;
  v_revision:=public.revise_my_stuff_service_occurrence_v2(v_occurrence,'{"parts":[{"name":"filter","cost":10}],"labor":[{"hours":1}],"vendor":{"name":"Shop"},"warranty":{"months":12},"notes":"corrected","attachment_metadata":[{"name":"receipt.pdf","private":true}]}','corrected part cost','service-revision-2');
  perform public._test_assert_v2((select count(*)=2 and max(revision_number)=2 from public.my_stuff_service_occurrence_revisions where occurrence_id=v_occurrence),'service revisions append');
  perform public._test_assert_v2((select count(*)=2 from public.my_stuff_service_audit where occurrence_id=v_occurrence),'service audit records create and revise');
  perform public._test_assert_v2((select current_mileage=112 and current_hours=6 and current_cycles=3 and effective_current_mileage=112 from public.my_stuff_items where id=v_item),'service advances monotonic and effective item readings');
  perform public._test_assert_v2((select next_due_mileage=122 from public.get_my_stuff_due_state_v2(v_item,'2026-09-03T14:00:00Z') where definition_id=v_last),'last-completion cadence advances after an in-range completion');
  perform public._test_assert_v2((select next_due_mileage=105 and due_status='overdue' from public.get_my_stuff_due_state_v2(v_item,'2026-09-03T12:30:00Z') where definition_id=v_last),'historical as-of ignores persisted future completions and readings');
  perform public._test_assert_v2((select next_due_mileage=110 from public.get_my_stuff_due_state_v2(v_item,'2026-09-03T14:00:00Z') where definition_id=v_first),'asset-origin cadence does not reset after completion');

  -- No reading exists at or before 11:00. The origin is 100, so a 150-mile
  -- asset-origin due point remains upcoming even after a future 200 reading.
  v_historical:=public.create_my_stuff_maintenance_definition_v2(v_item,'{"name":"Historical future-reading guard","due_semantics":"whichever_first","cadence_anchor":"asset_origin","normal_interval_miles":50,"due_soon_miles":0}','due-historical');
  perform public.record_my_stuff_reading_v2(v_item,'mileage',200,'2026-09-03T15:00:00Z',null,null,'{}','future-mileage-200');
  perform public._test_assert_v2((select next_due_mileage=150 and due_status='upcoming' from public.get_my_stuff_due_state_v2(v_item,'2026-09-03T11:00:00Z') where definition_id=v_historical),'future reading cannot affect historical due state when no prior reading exists');
  perform public._test_assert_v2((select next_due_mileage=150 and due_status='overdue' from public.get_my_stuff_due_state_v2(v_item,'2026-09-03T16:00:00Z') where definition_id=v_historical),'current due state still uses the future reading once it is in range');
  begin perform public.get_my_stuff_due_state_v2(v_item,'infinity'); raise exception 'expected infinite due-state date failure';
  exception when others then if sqlerrm='expected infinite due-state date failure' then raise; end if; perform public._test_assert_v2(sqlerrm='Due-state as-of is outside the supported range [1900-01-01, 2200-01-01)','infinite due-state timestamp rejected'); end;
  begin perform public.get_my_stuff_due_state_v2(v_item,'1899-12-31T23:59:59Z'); raise exception 'expected old due-state date failure';
  exception when others then if sqlerrm='expected old due-state date failure' then raise; end if; perform public._test_assert_v2(sqlerrm='Due-state as-of is outside the supported range [1900-01-01, 2200-01-01)','too-old due-state timestamp rejected'); end;
  begin perform public.get_my_stuff_due_state_v2(v_item,'2200-01-01T00:00:00Z'); raise exception 'expected future due-state date failure';
  exception when others then if sqlerrm='expected future due-state date failure' then raise; end if; perform public._test_assert_v2(sqlerrm='Due-state as-of is outside the supported range [1900-01-01, 2200-01-01)','too-future due-state timestamp rejected'); end;
  begin
    perform public.record_my_stuff_service_occurrence_v2(v_item,null,'{"service_name":"Invalid rewind","completed_at":"2026-09-03T14:00:00Z","mileage":111}','service-rewind');
    raise exception 'expected service reading rewind failure';
  exception when others then
    if sqlerrm='expected service reading rewind failure' then raise; end if;
    perform public._test_assert_v2(sqlerrm='Service readings cannot move backwards','service cannot append a reading below the effective item reading');
  end;
  begin update public.my_stuff_service_occurrences set service_name='rewrite' where id=v_occurrence; raise exception 'expected immutable occurrence failure';
  exception when others then if sqlerrm='expected immutable occurrence failure' then raise; end if; perform public._test_assert_v2(sqlstate='42501' or sqlerrm like '%immutable%','occurrence update rejected'); end;
end $$;

-- Cross-account RLS hides every V2 relation and project transfer denies theft.
select set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',false);
select public._test_assert_v2((select count(*) from public.my_stuff_readings)=0,'cross-user readings hidden');
select public._test_assert_v2((select count(*) from public.my_stuff_maintenance_definitions)=0,'cross-user definitions hidden');
select public._test_assert_v2((select count(*) from public.my_stuff_service_occurrences)=0,'cross-user occurrences hidden');
select public._test_assert_v2((select count(*) from public.my_stuff_service_occurrence_revisions)=0,'cross-user revisions hidden');
select public._test_assert_v2((select count(*) from public.my_stuff_service_audit)=0,'cross-user audit hidden');
select public._test_assert_v2((select count(*) from public.my_stuff_project_transfers)=0,'cross-user transfers hidden');
do $$ begin
  begin perform public.transfer_project_to_my_stuff_v2('80000000-0000-4000-8000-000000000001','{}','steal-transfer'); raise exception 'expected ownership failure';
  exception when others then if sqlerrm='expected ownership failure' then raise; end if; perform public._test_assert_v2(sqlerrm='Project not found','cross-account transfer denied'); end;
end $$;
reset role;

-- Authoritative Pro may transfer multiple projects; downgrade retains and manages data.
insert into public.user_entitlements(user_id,source,status,expires_at,last_verified_at)
values('99999999-9999-4999-8999-999999999999','stripe','active',now()+interval '30 days',now());
set role authenticated;
select set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',false);
select public.transfer_project_to_my_stuff_v2('90000000-0000-4000-8000-000000000001','{}','pro-transfer-1');
select public.transfer_project_to_my_stuff_v2('90000000-0000-4000-8000-000000000002','{}','pro-transfer-2');
select public._test_assert_v2((select count(*) from public.my_stuff_items)=2,'authoritative Pro has unlimited transfer creation');
reset role;
delete from public.user_entitlements where user_id='99999999-9999-4999-8999-999999999999';
set role authenticated;
select set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',false);
select public.record_my_stuff_reading_v2((select id from public.my_stuff_items order by created_at limit 1),'hours',1,now(),null,null,'{}','downgrade-reading');
select public._test_assert_v2((select count(*) from public.my_stuff_items)=2,'downgrade retains and permits management of existing items');
reset role;

-- Direct auth-user ownership cascades all V2 descendants.
delete from auth.users where id='99999999-9999-4999-8999-999999999999';
select public._test_assert_v2(not exists(select 1 from public.my_stuff_items where user_id='99999999-9999-4999-8999-999999999999'),'account deletion cascades V2 items');
select public._test_assert_v2(not exists(select 1 from public.my_stuff_project_transfers where user_id='99999999-9999-4999-8999-999999999999'),'account deletion cascades transfer links');

drop function public._test_assert_v2(boolean,text);
