\set ON_ERROR_STOP on
create function public._v4_assert(ok boolean,msg text) returns void language plpgsql as $$begin if ok is not true then raise exception 'assertion failed: %',msg; end if; end$$;
create function public._v4_raises(statement text,expected text) returns void language plpgsql as $$begin begin execute statement; exception when others then if sqlerrm not like '%'||expected||'%' then raise exception 'expected %, got %',expected,sqlerrm; end if; return; end; raise exception 'did not raise %',expected; end$$;

select id as archived_item from public.my_stuff_items where client_mutation_id='v2:v4-fixture-item' \gset
select id as historical_occurrence from public.my_stuff_service_occurrences where client_mutation_id='v4-historical-service' \gset
select id as transferred_item from public.my_stuff_items where client_mutation_id='v2:v4-transfer-item' \gset
select id as transfer_reason_item from public.my_stuff_items where client_mutation_id='v2:v4-transfer-reason-item' \gset
-- Phase 1 is state-preserving: no archive restoration or definition relabeling.
select public._v4_assert((select archived_at is not null and archive_reason='manual owner archive' from public.my_stuff_items where id=:'archived_item'),'manual archive preserved');
select public._v4_assert((select archived_at is not null from public.my_stuff_items where id=:'transferred_item'),'transferred item preserved');
select public._v4_assert((select archived_at is not null and archive_reason='Transferred to project' from public.my_stuff_items where id=:'transfer_reason_item'),'transfer reason preserved');
select public._v4_assert((select enabled and lifecycle_state is null from public.my_stuff_maintenance_definitions where client_mutation_id='v4-enabled-winner'),'enabled legacy definition unchanged');
select public._v4_assert((select not enabled and lifecycle_state is null and name='duplicate   task' from public.my_stuff_maintenance_definitions where client_mutation_id='v4-disabled-loser'),'disabled duplicate unchanged');
select public._v4_assert((select count(*)=2 from public.my_stuff_maintenance_definitions where client_mutation_id in ('v4-disabled-new','v4-disabled-old') and not enabled and lifecycle_state is null),'disabled definitions unchanged');
select public._v4_assert((select feature_enabled=false and legacy_retired=false from private.my_stuff_integrity_rollout_v4),'rollout defaults off');
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public._v4_raises(format('select public.record_my_stuff_current_mileage_v4(%L,10000,now(),%L)',:'archived_item','v4-disabled-probe'),'MAINTENANCE_V4_DISABLED');
reset role;
-- Disposable-owner test setup only. Production has no activation RPC; a future
-- exact-evidence, database-owner cutover migration must perform this write.
update private.my_stuff_integrity_rollout_v4 set feature_enabled=true where singleton;
-- Disposable-owner fixture setup after proving Phase 1 preserved the archive.
select :'archived_item'::uuid as v4_item \gset
update public.my_stuff_items set archived_at=null,archive_reason=null where id=:'v4_item';
update public.my_stuff_items set usage_dimensions=array['mileage','hours','cycles'] where id=:'v4_item';
select public._v4_assert(has_function_privilege('authenticated','public.record_my_stuff_service_with_expense_v3(uuid,uuid,uuid,jsonb,jsonb,text)','execute'),'legacy completion remains during phase 1');
select public._v4_assert(has_function_privilege('authenticated','public.set_my_stuff_item_archived_v2(uuid,boolean,text,text)','execute'),'legacy archive remains during phase 1');

insert into private.my_stuff_maintenance_test_clock_v4(singleton,server_now) values(true,'2026-09-24 12:00:00Z');
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.record_my_stuff_current_mileage_v4(:'v4_item',10000,'2026-09-24 12:05:00Z','v4-skew-exact') as exact_skew \gset
select public._v4_raises(format('select public.record_my_stuff_current_mileage_v4(%L,10000,%L,%L)',:'v4_item','2026-09-24 12:05:01Z','v4-skew-over'),'DEVICE_CLOCK_SKEW');
select public.record_my_stuff_current_reading_v4(:'v4_item','hours',100,'2026-09-24 12:00:00Z','v4-hours-1') as hours_first \gset
select public.record_my_stuff_current_reading_v4(:'v4_item','hours',100,'2026-10-24 12:00:00Z','v4-hours-1') as hours_replay \gset
select public._v4_assert(:'hours_first'::jsonb=:'hours_replay'::jsonb,'hours replay resolves before device clock validation');
select public._v4_raises(format('select public.record_my_stuff_current_reading_v4(%L,%L,99,%L,%L)',:'v4_item','hours','2026-09-24 12:00:00Z','v4-hours-lower'),'CURRENT_READING_CANNOT_DECREASE');
select public.setup_my_stuff_maintenance_preset_v4(:'v4_item','{"name":"Oil and filter change","service_action":"service","due_semantics":"whichever_first","active_profile":"normal","normal_interval_miles":5000,"normal_calendar_months":6,"severe_interval_miles":3000,"severe_calendar_months":3,"cadence_anchor":"last_completion"}','{"last_service_performed_on":"2026-05-01","last_service_mileage":10000,"current_mileage":11000}','2026-09-24 12:00:00Z','v4-oil-setup') as setup \gset
select (:'setup'::jsonb->>'definition_id')::uuid as oil_def \gset
select public.materialize_my_stuff_next_occurrence_v3(:'oil_def') as oil_plan \gset
select public.complete_my_stuff_maintenance_v4(:'oil_def','{"service_performed_on":"2026-09-22","service_timezone":"Pacific/Kiritimati","service_mileage":11000,"current_mileage":11200,"notes":"original"}'::jsonb||jsonb_build_object('planned_occurrence_id',:'oil_plan'),'2026-09-24 12:00:00Z','v4-complete') as completion \gset
select (:'completion'::jsonb->>'service_occurrence_id')::uuid as occurrence \gset
select :'completion'::jsonb->>'snapshot_sha256' as snapshot_hash \gset
select public._v4_assert(public.complete_my_stuff_maintenance_v4(:'oil_def','{"service_performed_on":"2026-09-22","service_timezone":"Pacific/Kiritimati","service_mileage":11000,"current_mileage":11200,"notes":"original"}'::jsonb||jsonb_build_object('planned_occurrence_id',:'oil_plan'),'2026-09-24 12:00:00Z','v4-complete')=:'completion'::jsonb,'canonical completion replay');
select public._v4_assert((select service_performed_on=date '2026-09-22' and service_timezone='Pacific/Kiritimati' from public.my_stuff_service_occurrences where id=:'occurrence'),'business date/timezone stable');
reset role;
set time zone 'America/Adak';
select public._v4_assert((private.my_stuff_original_snapshot_v4(:'occurrence')->>'service_performed_on')::date=date '2026-09-22','business date stable in negative extreme timezone');
set time zone 'Pacific/Kiritimati';
select public._v4_assert((private.my_stuff_original_snapshot_v4(:'occurrence')->>'service_performed_on')::date=date '2026-09-22','business date stable in positive extreme timezone');
set time zone 'UTC';
set role authenticated; select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public._v4_assert((select status='completed' and completed_service_occurrence_id=:'occurrence' from public.my_stuff_planned_occurrences where id=:'oil_plan'),'planned occurrence completed');
select public._v4_assert((select count(*)=1 from public.my_stuff_occurrence_status_events where planned_occurrence_id=:'oil_plan' and status='completed'),'one planned completion event');
select public._v4_assert((select count(*)>=1 from public.my_stuff_planned_occurrences where definition_id=:'oil_def' and id<>:'oil_plan'),'successor materialized');
select public.edit_my_stuff_completion_v4(:'occurrence','{"notes":"edited without reason","attachment_metadata":[{"storage_path":"private/secret.jpg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}',null,0,:'snapshot_hash','2026-09-24 12:00:00Z','v4-edit') as edit_result \gset
select :'edit_result'::jsonb->>'snapshot_sha256' as edit_hash \gset
select public._v4_raises(format('select public.edit_my_stuff_completion_v4(%L,%L,null,0,%L,%L,%L)',:'occurrence','{"notes":"stale"}',:'snapshot_hash','2026-09-24 12:00:00Z','v4-stale-edit'),'REVISION_CONFLICT');
select public._v4_assert((select reason is null from public.my_stuff_completion_corrections where client_mutation_id='v4-edit'),'edit reason optional');
select public._v4_raises(format('select public.correct_my_stuff_completion_v4(%L,%L,%L,1,%L,%L,%L)',:'occurrence','{"service_mileage":-1}','invalid negative',:'edit_hash','2026-09-24 12:00:00Z','v4-invalid-negative'),'INVALID_SERVICE_READING');
select public._v4_raises(format('select public.correct_my_stuff_completion_v4(%L,%L,%L,1,%L,%L,%L)',:'occurrence','{"parts":{}}','invalid details',:'edit_hash','2026-09-24 12:00:00Z','v4-invalid-parts'),'INVALID_COMPLETION_DETAILS');
reset role;
update private.my_stuff_maintenance_test_clock_v4 set server_now='2026-09-25 12:00:00Z';
set role authenticated; select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public._v4_assert(public.complete_my_stuff_maintenance_v4(:'oil_def','{"service_performed_on":"2026-09-22","service_timezone":"Pacific/Kiritimati","service_mileage":11000,"current_mileage":11200,"notes":"original"}'::jsonb||jsonb_build_object('planned_occurrence_id',:'oil_plan'),'2026-09-25 12:00:00Z','v4-complete')=:'completion'::jsonb,'far-later replay ignores fresh telemetry clock');
select public._v4_raises(format('select public.complete_my_stuff_maintenance_v4(%L,%L::jsonb,%L,%L)',:'oil_def','{"service_performed_on":"2026-09-22","service_timezone":"UTC"}','2026-09-25 12:00:00Z','v4-complete'),'Idempotency key reused');
select public._v4_raises(format('select public.edit_my_stuff_completion_v4(%L,%L,null,1,%L,%L,%L)',:'occurrence','{"notes":"boundary"}',:'edit_hash','2026-09-25 12:00:00Z','v4-boundary'),'COMPLETION_LOCKED');
select public._v4_raises(format('select public.correct_my_stuff_completion_v4(%L,%L,null,1,%L,%L,%L)',:'occurrence','{"notes":"no reason"}',:'edit_hash','2026-09-25 12:00:00Z','v4-no-reason'),'Correction reason required');
select public.correct_my_stuff_completion_v4(:'occurrence','{"service_mileage":10900}','receipt correction',1,:'edit_hash','2026-09-25 12:00:00Z','v4-correction') as corrected \gset
select :'corrected'::jsonb->>'snapshot_sha256' as corrected_hash \gset
select public._v4_raises(format('select public.correct_my_stuff_completion_v4(%L,%L,%L,2,%L,%L,%L)',:'occurrence','{"service_mileage":12001}','service exceeds snapshot current',:'corrected_hash','2026-09-25 12:00:00Z','v4-service-over-current'),'SERVICE_READING_EXCEEDS_CURRENT');
select public._v4_assert((public.get_my_stuff_maintenance_state_v4(:'oil_def')->>'next_due_mileage')::numeric=15900,'latest correction anchors due state');

select e->'effective' as historical_snapshot,e->>'effective_snapshot_sha256' as historical_hash from jsonb_array_elements(public.get_my_stuff_maintenance_report_v4(:'archived_item')->'completions') e where e->>'occurrence_id'=:'historical_occurrence' \gset
select public._v4_raises(format('select public.edit_my_stuff_completion_v4(%L,%L,null,0,%L,%L,%L)',:'historical_occurrence','{"notes":"window"}',:'historical_hash','2026-09-25 12:00:00Z','v4-historical-edit'),'COMPLETION_LOCKED');
select public.correct_my_stuff_completion_v4(:'historical_occurrence','{"notes":"historical corrected"}','owner correction',0,:'historical_hash','2026-09-25 12:00:00Z','v4-historical-correct');
select public._v4_assert((select completed_at::date=date '2026-01-01' from public.my_stuff_service_occurrences where id=:'historical_occurrence'),'historical original preserved');

select public.complete_my_stuff_maintenance_v4(:'oil_def','{"service_performed_on":"2026-09-24","service_mileage":12000,"current_mileage":12000}','2026-09-25 12:00:00Z','v4-newer-complete');
select public.correct_my_stuff_completion_v4(:'occurrence','{"notes":"older completion note after newer meter"}','notes-only historical correction',2,:'corrected_hash','2026-09-25 12:00:00Z','v4-notes-after-newer-meter');
select public._v4_assert((public.get_my_stuff_maintenance_state_v4(:'oil_def')->>'next_due_mileage')::numeric=17000,'newer completion overrides baseline and older correction');
select public.setup_my_stuff_maintenance_preset_v4(:'v4_item','{"name":"Hours and calendar","service_action":"service","due_semantics":"all","normal_interval_hours":50,"normal_calendar_months":12,"cadence_anchor":"last_completion"}','{"last_service_performed_on":"2025-09-25","last_service_hours":100}','2026-09-25 12:00:00Z','v4-hours-setup') as hours_setup \gset
select (:'hours_setup'::jsonb->>'definition_id')::uuid as hours_def \gset
select public.complete_my_stuff_maintenance_v4(:'hours_def','{"service_performed_on":"2026-09-25","service_hours":120,"current_hours":125,"expense":{"description":"Hour service","amount":25,"category":"maintenance","currency":"USD","incurred_on":"2026-09-25"}}','2026-09-25 12:00:00Z','v4-hours-complete') as hours_completion \gset
select public._v4_assert((:'hours_completion'::jsonb->>'expense_id') is not null and (:'hours_completion'::jsonb->'state'->>'next_due_hours')::numeric=170,'hours completion and expense atomic');
select public.setup_my_stuff_maintenance_preset_v4(:'v4_item','{"name":"Calendar only","service_action":"inspect","normal_calendar_months":12,"cadence_anchor":"last_completion"}','{}','2026-09-25 12:00:00Z','v4-calendar-setup') as calendar_setup \gset
select (:'calendar_setup'::jsonb->>'definition_id')::uuid as calendar_def \gset
select public.complete_my_stuff_maintenance_v4(:'calendar_def','{"service_performed_on":"2026-09-25"}','2026-09-25 12:00:00Z','v4-calendar-complete') as calendar_completion \gset
select (:'calendar_completion'::jsonb->>'service_occurrence_id')::uuid as calendar_occurrence \gset
select (:'calendar_completion'::jsonb->>'revision_id')::uuid as calendar_revision \gset

-- A completion missing an axis must not resurrect that axis from setup baseline.
select public.setup_my_stuff_maintenance_preset_v4(:'v4_item','{"name":"No stale baseline","service_action":"check","normal_interval_cycles":20,"cadence_anchor":"last_completion"}','{"last_service_cycles":7}','2026-09-25 12:00:00Z','v4-no-stale-setup') as no_stale_setup \gset
select (:'no_stale_setup'::jsonb->>'definition_id')::uuid as no_stale_def \gset
select public.complete_my_stuff_maintenance_v4(:'no_stale_def','{"service_performed_on":"2026-09-25"}','2026-09-25 12:00:00Z','v4-no-stale-complete');
select public._v4_assert(public.get_my_stuff_maintenance_state_v4(:'no_stale_def')->>'last_service_cycles' is null and public.get_my_stuff_maintenance_state_v4(:'no_stale_def')->>'next_due_cycles' is null and public.get_my_stuff_maintenance_state_v4(:'no_stale_def')->>'due_status'='needs_usage_update','new completion never falls back to stale baseline axis');

select public.get_my_stuff_maintenance_report_v4(:'v4_item',2,null,null) as report \gset
select public._v4_assert((:'report'::jsonb->>'owner_report_disclaimer') is not null and (:'report'::jsonb->'page'->>'truncated')::boolean,'report disclaimer and truncation');
select public._v4_assert((:'report'::jsonb-'snapshot_sha256'-'integrity_status'->>'generated_at') is not null,'report server generated');
select public._v4_assert(encode(digest((:'report'::jsonb-'snapshot_sha256'-'integrity_status')::text,'sha256'),'hex')=:'report'::jsonb->>'snapshot_sha256','report canonical hash');
select public._v4_assert(position('storage_path' in :'report')=0,'report omits attachment paths');
select public._v4_raises(format('update public.my_stuff_completion_corrections set reason=%L where occurrence_id=%L','tamper',:'occurrence'),'permission denied');
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public._v4_raises(format('select public.get_my_stuff_maintenance_report_v4(%L)',:'v4_item'),'not found');
select public._v4_raises(format('select public.correct_my_stuff_completion_v4(%L,%L,%L,2,%L,%L,%L)',:'occurrence','{"notes":"cross"}','cross',:'edit_hash','2026-09-25 12:00:00Z','cross-correction'),'not found');
reset role;

-- Definition and item deletion use bounded, fenced, expiring worker leases.
insert into public.my_stuff_service_history(user_id,item_id,definition_id)
values('11111111-1111-4111-8111-111111111111',:'v4_item',:'calendar_def') returning id as calendar_history \gset
insert into public.my_stuff_attachments(user_id,item_id,service_revision_id,storage_path,media_type,byte_size,sha256,state,finalized_at)
values('11111111-1111-4111-8111-111111111111',:'v4_item',:'calendar_revision','11111111-1111-4111-8111-111111111111/items/'||:'v4_item'||'/documents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf','application/pdf',10,repeat('a',64),'finalized',transaction_timestamp()) returning id as calendar_attachment \gset
set role authenticated; select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.request_my_stuff_deletion_v4('definition',:'calendar_def','delete-calendar') as delete_request \gset
select (:'delete_request'::jsonb->>'id')::uuid as delete_request_id \gset
select public._v4_assert(public.request_my_stuff_deletion_v4('definition',:'calendar_def','delete-calendar')=:'delete_request'::jsonb,'deletion replay stable');
reset role; set role service_role;
select public.claim_my_stuff_deletions_v4('worker-a',10,120) as def_claims \gset
select (:'def_claims'::jsonb->0->>'lease_token')::uuid as def_token \gset
select public._v4_raises(format('select public.ack_my_stuff_deletion_storage_v4(%L,%L,%L,0,0,0,null)',:'delete_request_id','worker-b',:'def_token'),'STALE_DELETION_LEASE');
select public.ack_my_stuff_deletion_storage_v4(:'delete_request_id','worker-a',:'def_token',0,0,0,null);
select public.finalize_my_stuff_deletion_v4(:'delete_request_id','worker-a',:'def_token') as processed_delete \gset
reset role;
select public._v4_assert(:'processed_delete'::jsonb->>'status'='complete' and not exists(select 1 from public.my_stuff_maintenance_definitions where id=:'calendar_def'),'definition deletion completes: '||:'processed_delete');
select public._v4_assert((select definition_id is null from public.my_stuff_service_history where id=:'calendar_history'),'definition history reference detached and row preserved');
select public._v4_assert((select definition_id is null and not scheduled from public.my_stuff_service_occurrences where id=:'calendar_occurrence'),'definition occurrence detached and row preserved');
select public._v4_assert(exists(select 1 from public.my_stuff_attachments where id=:'calendar_attachment'),'definition attachment graph preserved');
select public._v4_assert(exists(select 1 from public.my_stuff_deleted_definition_history_v4 where request_id=:'delete_request_id' and source_table='public.my_stuff_service_occurrence_bundle'),'definition occurrence graph preserved before cascade');
select public._v4_assert((select database_rows_expected=database_rows_deleted+database_rows_detached from public.my_stuff_deletion_requests_v4 where id=:'delete_request_id'),'definition deletion exact row accounting');

-- Failed work converges through a new token; stale acknowledgements stay fenced.
set role authenticated; select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
select public.create_my_stuff_item_v2('{"name":"Delete with storage","item_type":"tool"}','v4-delete-storage-item') as storage_item \gset
select public.request_my_stuff_deletion_v4('item',:'storage_item','delete-storage-item') as storage_delete_request \gset
select (:'storage_delete_request'::jsonb->>'id')::uuid as storage_delete_request_id \gset
reset role;
insert into storage.objects(bucket_id,name) values('my-stuff-media','33333333-3333-4333-8333-333333333333/items/'||:'storage_item'||'/photos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg');
set role service_role;
select public.claim_my_stuff_deletions_v4('worker-a',1,120) as first_claims \gset
select (:'first_claims'::jsonb->0->>'lease_token')::uuid as first_token \gset
select public.ack_my_stuff_deletion_storage_v4(:'storage_delete_request_id','worker-a',:'first_token',1,0,1,'mock failure');
select public.claim_my_stuff_deletions_v4('worker-b',1,120) as retry_claims \gset
select (:'retry_claims'::jsonb->0->>'lease_token')::uuid as retry_token \gset
select public._v4_raises(format('select public.ack_my_stuff_deletion_storage_v4(%L,%L,%L,1,1,0,null)',:'storage_delete_request_id','worker-a',:'first_token'),'STALE_DELETION_LEASE');
reset role;
-- Models successful exact-prefix Storage API removal plus readback.
delete from storage.objects where bucket_id='my-stuff-media' and name='33333333-3333-4333-8333-333333333333/items/'||:'storage_item'||'/photos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg';
set role service_role;
select public.ack_my_stuff_deletion_storage_v4(:'storage_delete_request_id','worker-b',:'retry_token',1,1,0,null);
select public.finalize_my_stuff_deletion_v4(:'storage_delete_request_id','worker-b',:'retry_token') as storage_database_done \gset
reset role;
select public._v4_assert(:'storage_database_done'::jsonb->>'status'='verifying_storage' and not exists(select 1 from public.my_stuff_items where id=:'storage_item'),'database deletion enters final storage verification');
set role authenticated; select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
select public._v4_raises(format('insert into storage.objects(bucket_id,name) values(%L,%L)','my-stuff-media','33333333-3333-4333-8333-333333333333/items/'||:'storage_item'||'/photos/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jpg'),'row-level security');
reset role;
-- Models an upload committed after the first empty readback but before item deletion.
insert into storage.objects(bucket_id,name) values('my-stuff-media','33333333-3333-4333-8333-333333333333/items/'||:'storage_item'||'/photos/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg');
delete from storage.objects where bucket_id='my-stuff-media' and name='33333333-3333-4333-8333-333333333333/items/'||:'storage_item'||'/photos/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg';
set role service_role;
select public.ack_my_stuff_deletion_storage_v4(:'storage_delete_request_id','worker-b',:'retry_token',1,1,0,null) as storage_complete \gset
reset role;
select public._v4_assert(:'storage_complete'::jsonb->>'status'='complete' and (select attempt_count=2 and storage_objects_expected=2 and storage_objects_deleted=2 from public.my_stuff_deletion_requests_v4 where id=:'storage_delete_request_id'),'late storage race is drained before completion');

-- Lost acknowledgement-to-finalize work is reclaimable after lease expiry.
set role authenticated; select set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555555',false);
select public.create_my_stuff_item_v2('{"name":"Recover database phase","item_type":"tool"}','v4-recover-db-item') as recover_item \gset
select public.request_my_stuff_deletion_v4('item',:'recover_item','delete-recover-item') as recover_request \gset
select (:'recover_request'::jsonb->>'id')::uuid as recover_request_id \gset
reset role; set role service_role;
select public.claim_my_stuff_deletions_v4('worker-c',1,120) as recover_claim_a \gset
select (:'recover_claim_a'::jsonb->0->>'lease_token')::uuid as recover_token_a \gset
select public.ack_my_stuff_deletion_storage_v4(:'recover_request_id','worker-c',:'recover_token_a',0,0,0,null);
reset role; update public.my_stuff_deletion_requests_v4 set lease_deadline=transaction_timestamp()-interval '1 second' where id=:'recover_request_id'; set role service_role;
select public.claim_my_stuff_deletions_v4('worker-d',1,120) as recover_claim_b \gset
select (:'recover_claim_b'::jsonb->0->>'lease_token')::uuid as recover_token_b \gset
select public._v4_assert(:'recover_claim_b'::jsonb->0->>'phase'='deleting_database' and :'recover_token_b'::uuid<>:'recover_token_a'::uuid,'expired deleting_database phase reclaimed with new token');
select public.finalize_my_stuff_deletion_v4(:'recover_request_id','worker-d',:'recover_token_b');
select public.ack_my_stuff_deletion_storage_v4(:'recover_request_id','worker-d',:'recover_token_b',0,0,0,null) as recover_complete \gset
reset role;
select public._v4_assert(:'recover_complete'::jsonb->>'status'='complete','reclaimed database phase converges');

select public._v4_raises($$insert into private.my_stuff_maintenance_test_clock_v4(singleton,server_now) values(false,now())$$,'violates check constraint');
delete from private.my_stuff_maintenance_test_clock_v4;
select private.assert_my_stuff_test_clock_empty_v4();
