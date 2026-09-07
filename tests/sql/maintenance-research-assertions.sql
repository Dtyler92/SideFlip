create function public._research_assert(ok boolean,msg text) returns void language plpgsql as $$begin if ok is not true then raise exception 'assertion failed: %',msg; end if; end$$;
create function public._research_raises(statement text,expected text) returns void language plpgsql as $$begin begin execute statement; exception when others then if sqlerrm not like '%'||expected||'%' then raise exception 'assertion failed: expected %, got %',expected,sqlerrm; end if; return; end; raise exception 'assertion failed: statement did not raise expected error: %',expected; end$$;

select public._research_assert((select enabled is false and global_monthly_budget_cents=2500 and max_searches=3 and max_fetches=2 and max_attempts=2 and daily_user_job_cap=2 and monthly_user_job_cap=10 from private.my_stuff_research_runtime_config where singleton),'research installs disabled with owner-approved limits');
select public._research_assert((select active is false from cron.job where jobname='sideflip-maintenance-research-worker'),'research cron installs inactive');
select public._research_assert(not has_table_privilege('authenticated','private.my_stuff_research_jobs','select,insert,update,delete'),'research jobs are private');
select public._research_assert(not has_table_privilege('authenticated','private.my_stuff_research_approvals','select,insert,update,delete'),'research approvals are private');
select public._research_assert(has_function_privilege('authenticated','public.enqueue_my_stuff_research_v3(uuid,text,text)','execute'),'enqueue is authenticated');
select public._research_assert(has_function_privilege('authenticated','public.approve_my_stuff_research_v1(uuid,uuid[],text)','execute'),'selective approve is authenticated');
select public._research_assert(not has_function_privilege('anon','public.enqueue_my_stuff_research_v3(uuid,text,text)','execute'),'anonymous enqueue denied');
select public._research_assert(has_function_privilege('service_role','private.lease_my_stuff_research_job_v3(text,integer)','execute'),'worker lease granted only to trusted role');
select public._research_assert(has_function_privilege('service_role','public.lease_my_stuff_research_worker_v1(text)','execute') and not has_function_privilege('authenticated','public.lease_my_stuff_research_worker_v1(text)','execute') and not has_function_privilege('anon','public.lease_my_stuff_research_worker_v1(text)','execute'),'public worker wrapper is service-only');
select public._research_assert(not has_schema_privilege('authenticated','pgmq','usage') and not has_function_privilege('authenticated','pgmq.send(text,jsonb)','execute'),'browser roles cannot access PGMQ');

set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public._research_raises($q$select public.get_my_stuff_research_status_v1('00000000-0000-4000-8000-000000000000')$q$,'PRO_REQUIRED');
reset role;

insert into public.user_entitlements(user_id,source,status,expires_at,last_verified_at)
values('11111111-1111-4111-8111-111111111111','apple','active',now()+interval '30 days',now());
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.create_my_stuff_item_v2('{"name":"Research car","item_type":"car","usage_dimensions":["mileage"],"current_mileage":0,"origin_mileage":0,"purchase_price":1000,"purchase_currency":"USD"}','research-item') as research_item \gset
select public.confirm_my_stuff_vehicle_identity_v3(:'research_item','{"model_year":2020,"make":"Honda","model":"Civic","engine_model":"L15B7","transmission":"CVT","drivetrain":"FWD","vehicle_market":"US"}','research-confirm');
select vin_confirmation_fingerprint as research_fingerprint from public.my_stuff_items where id=:'research_item' \gset
select public._research_raises(format('select public.enqueue_my_stuff_research_v3(%L,%L,%L)',:'research_item',:'research_fingerprint','disabled-enqueue'),'RESEARCH_DISABLED');
reset role;

insert into private.my_stuff_research_source_domains(domain,source_class,include_subdomains,enabled,manufacturer,terms_reviewed_on,robots_reviewed_on,licensing_disposition,reviewed_by)
values('honda.com','manufacturer',true,true,'Honda',current_date,current_date,'test fixture only','test harness');
update private.my_stuff_research_runtime_config set enabled=true,provider_name='anthropic',provider_model='claude-sonnet-4-5-20250929',retention_policy='test-no-provider-call',monthly_user_budget_cents=2500 where singleton;

set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.enqueue_my_stuff_research_v3(:'research_item',:'research_fingerprint','research-enqueue') as research_job \gset
select public._research_assert((public.get_my_stuff_research_status_v1(:'research_item')->>'id')::uuid=:'research_job','status resolves latest job by item');
reset role;

insert into private.my_stuff_research_evidence(id,job_id,evidence_key,title,canonical_url,exact_excerpt,page,accessed_on,accessed_at,applicability,source_class,source_domain,location_verified,content_hash)
values('30000000-0000-4000-8000-000000000001',:'research_job','e1','Honda maintenance guide','https://honda.com/guide','Replace engine oil every 7,500 miles.','42',current_date,now(),'2020 Honda Civic','manufacturer','honda.com',true,repeat('a',64));
insert into private.my_stuff_research_candidates(id,job_id,candidate,content_hash) values
('40000000-0000-4000-8000-000000000001',:'research_job','{"name":"Engine oil","action":"replace","profile":"normal","dueSemantics":"whichever_first","intervalMiles":7500,"evidenceIds":["e1"],"uncertainty":"low","conflict":false}',repeat('b',64)),
('40000000-0000-4000-8000-000000000002',:'research_job','{"name":"Engine oil","action":"replace","profile":"severe","dueSemantics":"whichever_first","intervalMiles":3750,"evidenceIds":["e1"],"uncertainty":"medium","conflict":false}',repeat('c',64)),
('40000000-0000-4000-8000-000000000003',:'research_job','{"name":"General inspection","action":"inspect","profile":"normal","dueSemantics":"whichever_first","intervalMonths":12,"evidenceIds":["e1"],"uncertainty":"medium","conflict":false}',repeat('d',64));
update private.my_stuff_research_jobs set status='awaiting_review' where id=:'research_job';
select pgmq.delete('my_stuff_research_v1',(select queue_msg_id from private.my_stuff_research_jobs where id=:'research_job'));

set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public._research_assert(jsonb_array_length(public.get_my_stuff_research_review_v1(:'research_job')->'candidates')=3,'review returns candidates');
reset role;
update private.my_stuff_research_runtime_config set policy_version='research-v2' where singleton;
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public._research_assert(public.get_my_stuff_research_status_v1(:'research_item')->>'status'='superseded','status exposes stale policy as superseded');
select public._research_raises(format('select public.get_my_stuff_research_review_v1(%L)',:'research_job'),'Research review not found');
reset role;
update private.my_stuff_research_runtime_config set policy_version='research-v1' where singleton;
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.approve_my_stuff_research_v1(:'research_job',array['40000000-0000-4000-8000-000000000001'::uuid,'40000000-0000-4000-8000-000000000002'::uuid],'research-approve') as research_approval \gset
select public._research_assert((public.get_my_stuff_research_status_v1(:'research_item')->>'approval_id')::uuid=:'research_approval','status exposes exact approval handle');
select public._research_raises(format('select public.approve_my_stuff_research_v1(%L,array[%L::uuid],%L)',:'research_job','40000000-0000-4000-8000-000000000002','research-approve'),'MUTATION_ID_REUSED');
reset role;
update private.my_stuff_research_jobs set status='cancelled' where id=:'research_job';
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public._research_raises(format('select public.apply_my_stuff_research_v1(%L,%L)',:'research_approval','research-apply-cancelled'),'Research job is not approved');
reset role;
update private.my_stuff_research_jobs set status='approved' where id=:'research_job';
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.apply_my_stuff_research_v1(:'research_approval','research-apply');
select public.apply_my_stuff_research_v1(:'research_approval','research-apply');
select public._research_assert(public.approve_my_stuff_research_v1(:'research_job',array['40000000-0000-4000-8000-000000000001'::uuid,'40000000-0000-4000-8000-000000000002'::uuid],'research-approve')=:'research_approval','approval retry remains stable after apply');
select public._research_raises(format('select public.apply_my_stuff_research_v1(%L,%L)',:'research_approval','research-apply-different'),'MUTATION_ID_REUSED');
select public._research_assert((select count(*)=2 and bool_and(name='Engine oil') and count(*) filter(where normal_interval_miles=7500)=1 and count(*) filter(where severe_interval_miles=3750)=1 from public.my_stuff_maintenance_definitions where item_id=:'research_item' and provenance_type='ai_research'),'apply keeps duplicate task names distinct and maps normal/severe intervals');
select public._research_assert((select count(*)=2 from public.my_stuff_definition_versions where item_id=:'research_item' and provenance_type='ai_research'),'apply creates immutable definition versions');
select public._research_assert((select count(*)=2 from public.my_stuff_planned_occurrences where item_id=:'research_item' and status='not_completed'),'apply materializes planned occurrences');

reset role;
update public.my_stuff_items set item_type='truck' where id=:'research_item';
select public._research_assert((select vin_confirmation_fingerprint is null and vin_confirmed_at is null from public.my_stuff_items where id=:'research_item'),'changing supported item type persistently invalidates confirmed identity');
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public._research_assert(cardinality(public.apply_my_stuff_research_v1(:'research_approval','research-apply'))=2,'successful apply replay is stable after identity changes');
select public.confirm_my_stuff_vehicle_identity_v3(:'research_item','{"model_year":2020,"make":"Honda","model":"Civic","engine_model":"L15B7","transmission":"CVT","drivetrain":"FWD","vehicle_market":"US"}','research-reconfirm');
select vin_confirmation_fingerprint as research_fingerprint from public.my_stuff_items where id=:'research_item' \gset
reset role;
insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number)
values(:'research_job','11111111-1111-4111-8111-111111111111',date_trunc('month',current_date)::date,'release',306,0);
update private.my_stuff_research_jobs set created_at=now()-interval '1 day' where id=:'research_job';
select pgmq.send('my_stuff_research_v1','{"schema_version":99,"job_id":"not-a-uuid"}'::jsonb) as malformed_msg \gset
set role service_role;
select public._research_assert(private.lease_my_stuff_research_job_v3('malformed-worker',300) is null,'malformed queue payload is not leased');
reset role;
select public._research_assert(not exists(select 1 from pgmq.messages where msg_id=:'malformed_msg'),'malformed queue payload is durably removed');
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.enqueue_my_stuff_research_v3(:'research_item',:'research_fingerprint','research-crash-recovery') as crash_job \gset
reset role;
select pgmq.delete('my_stuff_research_v1',(select queue_msg_id from private.my_stuff_research_jobs where id=:'crash_job'));
select pgmq.send('my_stuff_research_v1',jsonb_build_object('job_id',:'crash_job'::uuid)) as missing_schema_msg \gset
update private.my_stuff_research_jobs set queue_msg_id=:'missing_schema_msg' where id=:'crash_job';
set role service_role;
select public._research_assert(private.lease_my_stuff_research_job_v3('missing-schema-worker',300) is null,'missing schema version cannot lease a valid queued job');
reset role;
select public._research_assert((select status='queued' and attempt_count=0 from private.my_stuff_research_jobs where id=:'crash_job') and not exists(select 1 from pgmq.messages where msg_id=:'missing_schema_msg'),'missing schema message is deleted without mutating its job');
select pgmq.send('my_stuff_research_v1',jsonb_build_object('job_id',:'crash_job'::uuid,'schema_version','1')) as string_schema_msg \gset
update private.my_stuff_research_jobs set queue_msg_id=:'string_schema_msg' where id=:'crash_job';
set role service_role;
select public._research_assert(private.lease_my_stuff_research_job_v3('string-schema-worker',300) is null,'string schema version cannot lease a valid queued job');
reset role;
select public._research_assert((select status='queued' and attempt_count=0 from private.my_stuff_research_jobs where id=:'crash_job') and not exists(select 1 from pgmq.messages where msg_id=:'string_schema_msg'),'string schema message is deleted without mutating its job');
select pgmq.send('my_stuff_research_v1',jsonb_build_object('job_id',:'crash_job'::uuid,'schema_version',1)) as restored_msg \gset
update private.my_stuff_research_jobs set queue_msg_id=:'restored_msg' where id=:'crash_job';
update private.my_stuff_research_jobs set not_before=now()+interval '1 minute' where id=:'crash_job';
update pgmq.messages set visible_at=now() where msg_id=(select queue_msg_id from private.my_stuff_research_jobs where id=:'crash_job');
set role service_role;
select public._research_assert(private.lease_my_stuff_research_job_v3('early-worker',300) is null,'early queue read does not lease a not-before job');
reset role;
select public._research_assert(exists(select 1 from pgmq.messages where msg_id=(select queue_msg_id from private.my_stuff_research_jobs where id=:'crash_job')),'early queue read preserves the job message');
update private.my_stuff_research_jobs set not_before=now() where id=:'crash_job';
update pgmq.messages set visible_at=now() where msg_id=(select queue_msg_id from private.my_stuff_research_jobs where id=:'crash_job');
set role service_role;
select (private.lease_my_stuff_research_job_v3('crash-worker-1',300)).lease_token as stale_token \gset
reset role;
update private.my_stuff_research_jobs set lease_expires_at=now()-interval '1 second' where id=:'crash_job';
update pgmq.messages set visible_at=now() where msg_id=(select queue_msg_id from private.my_stuff_research_jobs where id=:'crash_job');
set role service_role;
select (private.lease_my_stuff_research_job_v3('crash-worker-2',300)).lease_token as current_token \gset
select public._research_assert(:'stale_token'::uuid<>:'current_token'::uuid and (select attempt_count=2 and status='running' from private.my_stuff_research_jobs where id=:'crash_job'),'expired lease is reclaimed with a new fencing token');
select public._research_assert(private.fail_my_stuff_research_job_v1(:'crash_job',:'stale_token','INVALID_EVIDENCE','stale') is false,'stale worker cannot fail reclaimed job');
select public._research_assert(private.fail_my_stuff_research_job_v1(:'crash_job',:'current_token','INVALID_EVIDENCE','bounded') is true,'current worker can terminally fail reclaimed job');
reset role;
select public._research_assert((select count(*)=2 and sum(cents)=306 from private.my_stuff_research_budget_ledger where job_id=:'crash_job' and kind='settlement'),'expired and terminal attempts consume no more than the sealed reservation');
update private.my_stuff_research_jobs set created_at=now()-interval '1 day' where id=:'crash_job';
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.enqueue_my_stuff_research_v3(:'research_item',:'research_fingerprint','research-retry-cancel') as retry_job \gset
reset role;
set role service_role;
select (private.lease_my_stuff_research_job_v3('retry-worker',300)).lease_token as retry_token \gset
select public._research_assert(private.fail_my_stuff_research_job_v1(:'retry_job',:'retry_token','PROVIDER_TRANSIENT','bounded') is true,'first failed attempt is charged and requeued');
reset role;
update private.my_stuff_research_jobs set reservation_month=(date_trunc('month',current_date)-interval '1 month')::date,not_before=now() where id=:'retry_job';
update private.my_stuff_research_budget_ledger set month_start=(date_trunc('month',current_date)-interval '1 month')::date where job_id=:'retry_job';
update pgmq.messages set visible_at=now() where msg_id=(select queue_msg_id from private.my_stuff_research_jobs where id=:'retry_job');
set role service_role;
select public._research_assert(private.lease_my_stuff_research_job_v3('rollover-worker',300) is null,'prior-month retry is cancelled before more provider work');
reset role;
select public._research_assert((select actual_cents=153 and status='cancelled' from private.my_stuff_research_jobs where id=:'retry_job'),'cancel after first attempt preserves incurred provider cost');
select public._research_assert((select count(*)=1 and max(cents)=153 from private.my_stuff_research_budget_ledger where job_id=:'retry_job' and kind='release'),'cancel after first attempt releases only unused reservation');
select public._research_assert((select count(distinct month_start)=1 and min(month_start)=(date_trunc('month',current_date)-interval '1 month')::date from private.my_stuff_research_budget_ledger where job_id=:'retry_job'),'month rollover keeps settlement and release bound to original reservation month');
select public._research_assert((select sum(case when kind='reservation' then cents when kind='release' then -cents else 0 end)=153 from private.my_stuff_research_budget_ledger where job_id=:'retry_job'),'incurred first-attempt spend remains charged after cancellation');
update private.my_stuff_research_jobs set created_at=now()-interval '1 day' where id=:'retry_job';
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.enqueue_my_stuff_research_v3(:'research_item',:'research_fingerprint','research-cancel-enqueue') as cancel_job \gset
select public.cancel_my_stuff_research_v1(:'cancel_job','research-cancel');
reset role;
select public._research_assert((select status='cancelled' from private.my_stuff_research_jobs where id=:'cancel_job'),'queued research cancellation is terminal');
select public._research_assert((select count(*)=1 and max(cents)=306 from private.my_stuff_research_budget_ledger where job_id=:'cancel_job' and kind='release'),'queued cancellation releases its full reservation');

set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.enqueue_my_stuff_research_v3(:'research_item',:'research_fingerprint','research-entitlement-lapse') as lapse_job \gset
reset role;
update public.user_entitlements set expires_at=now()-interval '1 second' where user_id='11111111-1111-4111-8111-111111111111';
set role service_role;
select private.lease_my_stuff_research_job_v3('fixture-worker',300);
select public._research_assert((select status='cancelled' and last_error_code='PRO_REQUIRED' from private.my_stuff_research_jobs where id=:'lapse_job'),'worker cancels before provider work when Pro expires');
select public._research_assert((select count(*)=1 and max(cents)=306 from private.my_stuff_research_budget_ledger where job_id=:'lapse_job' and kind='release'),'preflight Pro lapse releases its full reservation');
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public._research_raises(format('select public.get_my_stuff_research_review_v1(%L)',:'research_job'),'PRO_REQUIRED');
select public._research_raises(format('select public.apply_my_stuff_research_v1(%L,%L)',:'research_approval','research-apply-after-expiry'),'PRO_REQUIRED');
reset role;

select count(*) as ledger_count_before,coalesce(sum(case when kind='reservation' then cents when kind='release' then -cents else 0 end),0) as ledger_net_before from private.my_stuff_research_budget_ledger \gset
delete from auth.users where id='11111111-1111-4111-8111-111111111111';
select public._research_assert((select count(*) from private.my_stuff_research_budget_ledger)=:'ledger_count_before'::bigint and (select coalesce(sum(case when kind='reservation' then cents when kind='release' then -cents else 0 end),0) from private.my_stuff_research_budget_ledger)=:'ledger_net_before'::numeric,'account deletion preserves anonymized global budget history');
select public._research_assert((select bool_and(user_id is null and job_id is null) from private.my_stuff_research_budget_ledger),'deleted account budget rows are anonymized');
