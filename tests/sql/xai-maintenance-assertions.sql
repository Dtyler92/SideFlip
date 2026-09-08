select public._research_assert((select enabled is false and provider_name='xai' and provider_model='grok-4.6' and retention_policy='standard-30-days-store-false' and policy_version='research-v2-xai-citations' and per_job_budget_cents=2500 and monthly_user_budget_cents=2500 from private.my_stuff_research_runtime_config where singleton),'xAI conversion installs disabled with exact provider policy');
select public._research_assert(not exists(select 1 from cron.job where jobname='sideflip-maintenance-research-worker'),'xAI conversion leaves cron absent');
select public._research_assert(exists(select 1 from information_schema.columns where table_schema='private' and table_name='my_stuff_research_evidence' and column_name='verification_status'),'evidence verification state is durable');
select public._research_assert(has_function_privilege('authenticated','public.approve_my_stuff_research_v2(uuid,uuid[],boolean,text)','execute') and not has_function_privilege('anon','public.approve_my_stuff_research_v2(uuid,uuid[],boolean,text)','execute'),'explicit source approval is authenticated only');
select public._research_assert(not has_function_privilege('anon','public.approve_my_stuff_research_v1(uuid,uuid[],text)','execute'),'legacy approval remains anonymous-denied');

insert into public.user_entitlements(user_id,source,status,expires_at,last_verified_at)
values('22222222-2222-4222-8222-222222222222','apple','active',now()+interval '30 days',now());

set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.create_my_stuff_item_v2('{"name":"xAI research car","item_type":"car","usage_dimensions":["mileage"],"current_mileage":0,"origin_mileage":0,"purchase_price":1000,"purchase_currency":"USD"}','xai-research-item') as xai_item \gset
select public.confirm_my_stuff_vehicle_identity_v3(:'xai_item','{"model_year":2020,"make":"Honda","model":"Civic","engine_model":"L15B7","transmission":"CVT","drivetrain":"FWD","vehicle_market":"US"}','xai-research-confirm');
select vin_confirmation_fingerprint as xai_fingerprint from public.my_stuff_items where id=:'xai_item' \gset
reset role;

update private.my_stuff_research_runtime_config set enabled=true where singleton;
-- Isolate the xAI budget assertions from the preceding foundation harness.
delete from private.my_stuff_research_budget_ledger;
set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.enqueue_my_stuff_research_v3(:'xai_item',:'xai_fingerprint','xai-cost-enqueue') as xai_cost_job \gset
reset role;
set role service_role;
select (public.lease_my_stuff_research_worker_v2('xai-cost-worker')->'lease'->>'lease_token')::uuid as xai_cost_token \gset
select public.fail_my_stuff_research_worker_v2(:'xai_cost_job',:'xai_cost_token',150000000,'PROVIDER_REJECTED','PROVIDER_REJECTED');
reset role;
select public._research_assert((select status='failed' and actual_cents=2 and actual_cost_ticks=150000000 from private.my_stuff_research_jobs where id=:'xai_cost_job'),'known failed provider spend is persisted in exact ticks and rounded-up cents');
select public._research_assert((select usage_ticks=150000000 and usage_cents=2 from private.my_stuff_research_attempts where job_id=:'xai_cost_job' and attempt_number=1),'attempt stores authoritative xAI cost ticks');
delete from private.my_stuff_research_budget_ledger where job_id=:'xai_cost_job';

set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.enqueue_my_stuff_research_v3(:'xai_item',:'xai_fingerprint','xai-research-enqueue') as xai_job \gset
reset role;

insert into private.my_stuff_research_evidence(id,job_id,evidence_key,title,canonical_url,exact_excerpt,page,accessed_on,accessed_at,applicability,source_class,source_domain,location_verified,verification_status,content_hash)
values('30000000-0000-4000-8000-000000000011',:'xai_job','x1','Honda maintenance guide','https://honda.com/guide','Replace engine oil every 7,500 miles.','42',current_date,now(),'2020 Honda Civic','manufacturer','honda.com',false,'provider_citation_unconfirmed',repeat('e',64));
insert into private.my_stuff_research_candidates(id,job_id,candidate,content_hash)
values('40000000-0000-4000-8000-000000000011',:'xai_job','{"name":"Engine oil","action":"replace","profile":"normal","dueSemantics":"whichever_first","intervalMiles":7500,"evidenceIds":["x1"],"uncertainty":"low","conflict":false}',repeat('f',64));
update private.my_stuff_research_jobs set status='awaiting_review' where id=:'xai_job';
select pgmq.delete('my_stuff_research_v1',(select queue_msg_id from private.my_stuff_research_jobs where id=:'xai_job'));
insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number)
values(:'xai_job','22222222-2222-4222-8222-222222222222',date_trunc('month',current_date)::date,'release',2500,0);

set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public._research_assert((public.get_my_stuff_research_review_v1(:'xai_job')->'evidence'->0->>'verification_status')='provider_citation_unconfirmed','review exposes provider citation as unconfirmed');
select public._research_raises(format('select public.approve_my_stuff_research_v1(%L,array[%L::uuid],%L)',:'xai_job','40000000-0000-4000-8000-000000000011','xai-old-approve'),'UNCONFIRMED_EVIDENCE_REQUIRES_V2_APPROVAL');
select public._research_raises(format('select public.approve_my_stuff_research_v2(%L,array[%L::uuid],false,%L)',:'xai_job','40000000-0000-4000-8000-000000000011','xai-false-approve'),'SOURCES_NOT_VERIFIED');
select public.approve_my_stuff_research_v2(:'xai_job',array['40000000-0000-4000-8000-000000000011'::uuid],true,'xai-verified-approve') as xai_approval \gset
reset role;
select public._research_assert((select snapshot->>'sources_verified'='true' and (snapshot->>'schema_version')::integer=2 from private.my_stuff_research_approvals where id=:'xai_approval'),'approval snapshot seals explicit source verification');
set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.apply_my_stuff_research_v1(:'xai_approval','xai-apply');
select public.apply_my_stuff_research_v1(:'xai_approval','xai-apply');
select public._research_assert((select count(*)=1 from public.my_stuff_maintenance_definitions where item_id=:'xai_item' and provenance_type='ai_research' and normal_interval_miles=7500),'verified selection applies once to the correct item schedule');
reset role;
update public.my_stuff_items set item_type='truck' where id=:'xai_item';
set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public._research_assert(public.approve_my_stuff_research_v2(:'xai_job',array['40000000-0000-4000-8000-000000000011'::uuid],true,'xai-verified-approve')=:'xai_approval','successful approval replay remains stable after identity changes');
reset role;
update private.my_stuff_research_runtime_config set enabled=false where singleton;
