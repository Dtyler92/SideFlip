\set ON_ERROR_STOP on

insert into public.my_stuff_items(
  id,user_id,name,category,client_mutation_id
) values (
  '90000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'Shutdown fixture','car','shutdown-item'
) on conflict do nothing;

insert into private.my_stuff_research_jobs(
  id,user_id,item_id,confirmed_fingerprint,status,request_snapshot,
  reserved_cents,client_mutation_id,request_hash,reservation_month,
  policy_version
) values (
  '90000000-0000-4000-8000-000000000011',
  '11111111-1111-4111-8111-111111111111',
  '90000000-0000-4000-8000-000000000001',
  repeat('a',64),'queued','{"make":"Fixture"}'::jsonb,
  1250,'shutdown-queued',repeat('b',64),date '2026-08-01',
  (select policy_version from private.my_stuff_research_runtime_config where singleton)
);

insert into private.my_stuff_research_budget_ledger(
  job_id,user_id,month_start,kind,cents,attempt_number
) values (
  '90000000-0000-4000-8000-000000000011',
  '11111111-1111-4111-8111-111111111111',
  date '2026-08-01','reservation',1250,0
);

update private.my_stuff_research_jobs
set actual_cents=200
where id='90000000-0000-4000-8000-000000000011';

update private.my_stuff_research_jobs
set queue_msg_id=pgmq.send(
  'my_stuff_research_v1',
  jsonb_build_object('job_id',id,'schema_version',1)
)
where id='90000000-0000-4000-8000-000000000011';

insert into cron.job(jobname,schedule,command)
values(
  'sideflip-maintenance-research-worker',
  '*/5 * * * *',
  'select private.invoke_my_stuff_research_worker_v1()'
)
on conflict(jobname) do nothing;

update private.my_stuff_research_runtime_config
set enabled=true,
    updated_at=now()
where singleton;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='private'
      and table_name='my_stuff_research_runtime_config'
      and column_name='document_lane_enabled'
  ) then
    execute 'update private.my_stuff_research_runtime_config set document_lane_enabled=false where singleton';
  end if;
end
$$;
