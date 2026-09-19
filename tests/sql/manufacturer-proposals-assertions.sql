-- Synthetic source/owner-review scaffold; not real manufacturer proof or user consent.
update private.my_stuff_research_runtime_config set enabled=true where singleton;
delete from private.my_stuff_research_budget_ledger;
-- Isolate daily quota from the preceding legacy fixtures without changing limits.
update private.my_stuff_research_jobs set created_at=now()-interval '2 days' where user_id='22222222-2222-4222-8222-222222222222';
set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
select public.create_my_stuff_item_v2('{"name":"Finite proposal test","item_type":"car","usage_dimensions":["mileage"],"current_mileage":0,"origin_mileage":0,"purchase_price":1000,"purchase_currency":"USD"}','finite-item') as finite_item \gset
select public.confirm_my_stuff_vehicle_identity_v3(:'finite_item','{"model_year":2020,"make":"Honda","model":"Civic","engine_model":"L15B7","transmission":"CVT","drivetrain":"FWD","vehicle_market":"US"}','finite-confirm');
select vin_confirmation_fingerprint as finite_fp from public.my_stuff_items where id=:'finite_item' \gset
select public.enqueue_my_stuff_research_v3(:'finite_item',:'finite_fp','finite-enqueue') as finite_job \gset
reset role;
select jsonb_build_array(jsonb_build_object('id','e1','title','Synthetic local scope fixture','canonicalUrl','https://honda.com/guide','exactExcerpt','Replace air filter. 30000 miles or 36 months. Normal. Whichever first. No other notes.','page','42','accessedAt',now(),'applicability','2020 Honda Civic','sourceClass','manufacturer','sourceDomain','honda.com','locationVerified',false,'verificationStatus','provider_citation_unconfirmed'))::text as finite_evidence \gset
select jsonb_build_array(jsonb_build_object('schemaVersion',1,'id','air','name','Air filter','action','replace','evidenceIds',jsonb_build_array('e1'),'support',jsonb_build_object('origin','provider_claim','coverage','finite_list_only')||(select jsonb_object_agg(k,jsonb_build_array(jsonb_build_object('evidenceId','e1','quote','Replace air filter.'))) from unnest(array['row','actionContext','headingContext','notesContext','timingContext','applicabilityContext']) k),'schedule','{"kind":"milestones","dueSemantics":"whichever_first","milestones":[{"miles":30000,"months":36,"evidenceIds":["e1"]}],"end":{"miles":30000,"months":36}}'::jsonb,'blockedReasons','[]'::jsonb))::text as finite_proposals \gset
set role service_role;
select (public.lease_my_stuff_research_worker_v2('finite-worker')->'lease'->>'lease_token') as finite_token \gset
select public.settle_my_stuff_research_worker_v3(:'finite_job',:'finite_token',123456789,:'finite_evidence','[]','[]',:'finite_proposals');
reset role;
select public._research_assert((select actual_cost_ticks=123456789 and actual_cents=2 from private.my_stuff_research_jobs where id=:'finite_job'),'proposal settlement preserves ticks');
select jsonb_agg(jsonb_build_object('proposal_id',id,'content_hash',content_hash,'acknowledgements','{"sourceApplicability":true,"taskAction":true,"headingSchedule":true,"notesConditions":true,"finiteHorizon":true}'::jsonb))::text as finite_reviews from private.my_stuff_research_proposals where job_id=:'finite_job' \gset
set role authenticated;
select public._research_assert(jsonb_array_length(public.get_my_stuff_research_review_v2(:'finite_job')->'proposals')=1,'review reads settled proposal');
select public._research_raises(format('select public.approve_my_stuff_research_v3(%L,%L,%L)',:'finite_job',jsonb_set(:'finite_reviews'::jsonb,'{0,acknowledgements,taskAction}','false')::text,'finite-approve'),'TASK_NOT_VERIFIED');
select public.approve_my_stuff_research_v3(:'finite_job',:'finite_reviews','finite-approve') as finite_approval \gset
select public._research_assert(public.approve_my_stuff_research_v3(:'finite_job',:'finite_reviews','finite-approve')=:'finite_approval','approval replay exact');
select public._research_raises(format('select public.apply_my_stuff_research_v1(%L,%L)',:'finite_approval','finite-apply'),'UNSUPPORTED_APPROVAL_VERSION');
reset role;
select public._research_assert((select snapshot->>'schema_version'='3' and snapshot->'evidence'->0->>'verification_status'='provider_citation_unconfirmed' from private.my_stuff_research_approvals where id=:'finite_approval'),'snapshot seals review without authenticating provider');
select public._research_assert(not has_table_privilege('authenticated','private.my_stuff_research_proposals','INSERT'),'browser cannot inject proposals');
