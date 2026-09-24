\set ON_ERROR_STOP on

insert into public.my_stuff_items(id,user_id,name,category,client_mutation_id)
values
  ('90000000-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222','Document queued fixture','car','shutdown-document-queued-item'),
  ('90000000-0000-4000-8000-000000000003','33333333-3333-4333-8333-333333333333','Document ready fixture','car','shutdown-document-ready-item')
on conflict do nothing;

insert into private.my_stuff_research_jobs(
  id,user_id,item_id,confirmed_fingerprint,status,request_snapshot,
  reserved_cents,client_mutation_id,request_hash,reservation_month,
  policy_version,execution_lane
) values (
  '90000000-0000-4000-8000-000000000012',
  '22222222-2222-4222-8222-222222222222',
  '90000000-0000-4000-8000-000000000002',
  repeat('c',64),'document_queued','{"make":"Fixture"}'::jsonb,
  1250,'shutdown-document-queued',repeat('d',64),date '2026-07-01',
  (select policy_version from private.my_stuff_research_runtime_config where singleton),
  'document_v2'
),(
  '90000000-0000-4000-8000-000000000013',
  '33333333-3333-4333-8333-333333333333',
  '90000000-0000-4000-8000-000000000003',
  repeat('e',64),'document_pending','{"make":"Fixture"}'::jsonb,
  1250,'shutdown-document-ready',repeat('f',64),date '2026-06-01',
  (select policy_version from private.my_stuff_research_runtime_config where singleton),
  'document_v2'
);

update private.my_stuff_research_jobs
set lease_owner='shutdown-fixture',
    lease_token='90000000-0000-4000-8000-000000000099',
    lease_expires_at=now()+interval '10 minutes',
    attempt_count=1,
    state_version=1
where id='90000000-0000-4000-8000-000000000013';

insert into private.my_stuff_research_budget_ledger(
  job_id,user_id,month_start,kind,cents,attempt_number
) values
  ('90000000-0000-4000-8000-000000000012','22222222-2222-4222-8222-222222222222',date '2026-07-01','reservation',1250,0),
  ('90000000-0000-4000-8000-000000000013','33333333-3333-4333-8333-333333333333',date '2026-06-01','reservation',1250,0);

update private.my_stuff_research_jobs
set queue_msg_id=pgmq.send(
  'my_stuff_research_v1',
  jsonb_build_object('job_id',id,'schema_version',1)
)
where id='90000000-0000-4000-8000-000000000012';

insert into private.my_stuff_research_attempts(
  id,job_id,attempt_number,provider,model,retention_policy,status
) values (
  '90000000-0000-4000-8000-000000000098',
  '90000000-0000-4000-8000-000000000013',
  1,'xai','grok-4.6','standard-30-days-store-false','running'
);

insert into private.my_stuff_document_executions(job_id,binding,state,attempt_id)
select j.id,private.document_binding_v1(j),'ready','90000000-0000-4000-8000-000000000098'
from private.my_stuff_research_jobs j
where j.id='90000000-0000-4000-8000-000000000013';

update private.my_stuff_research_runtime_config
set document_lane_enabled=true,
    updated_at=now()
where singleton;
