-- LOCAL ONLY / UNAPPLIED. Separate review/approval required before deployment.
-- Adopt ONE existing first-attempt leased/reserved job; no new queue or budget.
begin;
alter table private.my_stuff_research_runtime_config add column document_lane_enabled boolean not null default false;
alter table private.my_stuff_research_jobs drop constraint my_stuff_research_jobs_status_check;
alter table private.my_stuff_research_jobs add constraint my_stuff_research_jobs_status_check check(status in
 ('queued','running','awaiting_review','approved','applied','failed','cancelled','superseded','deleted','document_pending','document_complete','document_failed'));
create table private.my_stuff_document_executions (
 job_id uuid primary key references private.my_stuff_research_jobs(id) on delete cascade,
 binding jsonb not null,
 state text not null default 'ready' check(state in ('ready','attempted','completed','failed')),
 source jsonb,
 attempt_id uuid not null references private.my_stuff_research_attempts(id),
 template_id uuid unique references public.manufacturer_template_versions(id),
 cost_ticks bigint check(cost_ticks>=0),
 error_code text,
 check((state='completed')=(template_id is not null)),
 check(state not in ('attempted','completed') or source is not null)
);
alter table private.my_stuff_document_executions enable row level security;
revoke all on private.my_stuff_document_executions from public,anon,authenticated,service_role;
-- Existing worker RPCs are SECURITY DEFINER; direct service table writes are
-- unnecessary and bypass accounting. Browser roles were already denied.
revoke insert,update,delete on private.my_stuff_research_jobs,private.my_stuff_research_attempts,
 private.my_stuff_research_budget_ledger from service_role;
-- New state cannot be changed through direct trusted-service DML either. Existing
-- legacy RPCs remain unchanged and never select the new non-queued/running states.
create function private.guard_document_job_dml_v1() returns trigger language plpgsql set search_path=pg_catalog,private as $$
begin
 if current_user <> pg_get_userbyid((select relowner from pg_class where oid=TG_RELID)) and
   exists(select 1 from private.my_stuff_document_executions where job_id=old.id) then
   raise exception 'DOCUMENT_RPC_REQUIRED';
 end if;
 return new;
end $$;
revoke all on function private.guard_document_job_dml_v1() from public,anon,authenticated,service_role;
-- Trigger uses invoker rights; service has no execution-table visibility, so any
-- direct UPDATE fails closed. Legacy definer RPCs run as the table owner.
create trigger document_job_direct_update before update on private.my_stuff_research_jobs
 for each row execute function private.guard_document_job_dml_v1();

create function private.document_binding_v1(j private.my_stuff_research_jobs) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('jobId',j.id,'ownerId',j.user_id,'itemId',j.item_id,'leaseToken',j.lease_token,
 'confirmedFingerprint',j.confirmed_fingerprint,'jobRevision',j.state_version,'policyVersion',j.policy_version,
 'reservationMonth',j.reservation_month,'reservedCents',j.reserved_cents,'requestSnapshot',j.request_snapshot)
$$;

-- Lock order: job then execution then item/config. Item identity changes wait for
-- finalize and vice versa; no read-check/write gap. Failure accounting deliberately
-- does NOT require current identity/entitlement/lease (a paid result still costs).
create function private.assert_document_job_v1(p_binding jsonb,p_current boolean default true)
returns private.my_stuff_document_executions language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare j private.my_stuff_research_jobs; d private.my_stuff_document_executions; i public.my_stuff_items; c private.my_stuff_research_runtime_config;
begin
 select * into j from private.my_stuff_research_jobs where id=(p_binding->>'jobId')::uuid for update;
 select * into d from private.my_stuff_document_executions where job_id=j.id for update;
 if d.job_id is null or d.binding is distinct from p_binding or
   j.user_id::text is distinct from p_binding->>'ownerId' or j.item_id::text is distinct from p_binding->>'itemId' or
   j.confirmed_fingerprint is distinct from p_binding->>'confirmedFingerprint' or
   j.request_snapshot is distinct from p_binding->'requestSnapshot' or
   j.reservation_month::text is distinct from p_binding->>'reservationMonth' or
   j.reserved_cents is distinct from (p_binding->>'reservedCents')::integer or
   j.policy_version is distinct from p_binding->>'policyVersion' then raise exception 'DOCUMENT_BINDING_MISMATCH'; end if;
 if not exists(select 1 from private.my_stuff_research_budget_ledger where job_id=j.id and user_id=j.user_id
    and kind='reservation' and attempt_number=0 and cents=j.reserved_cents and month_start=j.reservation_month)
 then raise exception 'DOCUMENT_RESERVATION_MISSING'; end if;
 if p_current then
   select * into c from private.my_stuff_research_runtime_config where singleton for share;
   select * into i from public.my_stuff_items where id=j.item_id and user_id=j.user_id for share;
   if i.id is null or i.vin_confirmation_fingerprint is distinct from j.confirmed_fingerprint or
      i.vin_confirmation_fingerprint is distinct from private.my_stuff_vehicle_identity_fingerprint_v3(i)
   then raise exception 'IDENTITY_UNCONFIRMED'; end if;
   if c.singleton is null or not c.enabled or not c.document_lane_enabled or j.policy_version is distinct from c.policy_version then raise exception 'DOCUMENT_DISABLED'; end if;
   perform private.assert_my_stuff_research_user_v1(j.user_id);
   if j.cancellation_requested_at is not null then raise exception 'DOCUMENT_CANCELLED'; end if;
   if d.state not in ('completed','failed') and (j.status<>'document_pending' or j.lease_token::text is distinct from p_binding->>'leaseToken'
       or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp()) then raise exception 'STALE_DOCUMENT_LEASE'; end if;
 end if;
 return d;
end $$;

create function public.prepare_document_job_v1(p_job_id uuid,p_lease_token uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare j private.my_stuff_research_jobs; d private.my_stuff_document_executions; a uuid; b jsonb;
begin
 select * into j from private.my_stuff_research_jobs where id=p_job_id for update;
 select * into d from private.my_stuff_document_executions where job_id=j.id;
 if d.job_id is not null then
   if d.binding->>'leaseToken' is distinct from p_lease_token::text then raise exception 'STALE_DOCUMENT_LEASE'; end if;
   perform private.assert_document_job_v1(d.binding);
   return d.binding;
 end if;
 if j.id is null or p_lease_token is null or j.state_version<1 or j.reserved_cents not between 1 and 100000 or
    j.policy_version is null or j.policy_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' or
    j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp()
    or j.attempt_count<>1 or coalesce(j.actual_cents,0)<>0 or j.actual_cost_ticks<>0
    or exists(select 1 from private.my_stuff_research_budget_ledger where job_id=j.id and kind<>'reservation')
 then raise exception 'DOCUMENT_FIRST_LEASE_REQUIRED'; end if;
 select id into a from private.my_stuff_research_attempts where job_id=j.id and attempt_number=1 and status='running';
 if a is null then raise exception 'DOCUMENT_ATTEMPT_MISSING'; end if;
 b:=private.document_binding_v1(j);
 insert into private.my_stuff_document_executions(job_id,binding,attempt_id) values(j.id,b,a);
 update private.my_stuff_research_jobs set status='document_pending' where id=j.id;
 perform private.assert_document_job_v1(b);
 -- Remove old queue delivery in the same transaction; lease expiry cannot reach
 -- legacy running-job retry. Unknown attempts retain their reservation indefinitely.
 if j.queue_msg_id is not null then perform pgmq.delete('my_stuff_research_v1',j.queue_msg_id); end if;
 return b;
end $$;

create function public.read_document_job_v1(p_binding jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare d private.my_stuff_document_executions; r jsonb;
begin
 d:=private.assert_document_job_v1(p_binding);
 if d.template_id is not null then
   select record into r from public.manufacturer_template_versions where id=d.template_id and owner_id=(p_binding->>'ownerId')::uuid;
   if r is null then raise exception 'DOCUMENT_LINK_MISSING'; end if;
 end if;
 return jsonb_build_object('binding',d.binding,'state',d.state,'source',d.source,'attemptId',d.attempt_id,'templateId',d.template_id,
   'record',r,'costInUsdTicks',d.cost_ticks,'authorized',true,'identityConfirmed',true,'policyCurrent',true,
   'entitlementCurrent',true,'reservationPersisted',true,'cancelled',false,'leaseCurrent',true);
end $$;

create function public.claim_document_job_v1(p_binding jsonb,p_source jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare d private.my_stuff_document_executions;
begin
 d:=private.assert_document_job_v1(p_binding);
 if d.state<>'ready' then return jsonb_build_object('claimed',false); end if;
 if p_source is null or jsonb_typeof(p_source)<>'object' or
    (select count(*) from jsonb_object_keys(p_source))<>2 or
    jsonb_typeof(p_source->'sourceSha256') is distinct from 'string' or (p_source->>'sourceSha256') !~ '^[0-9a-f]{64}$' or
    jsonb_typeof(p_source->'selectedPages') is distinct from 'array' or jsonb_array_length(p_source->'selectedPages') not between 1 and 1000 or
    exists(select 1 from jsonb_array_elements(p_source->'selectedPages') v where jsonb_typeof(v)<>'number' or v::text !~ '^[1-9][0-9]{0,5}$')
 then raise exception 'DOCUMENT_SOURCE_INVALID'; end if;
 update private.my_stuff_document_executions set state='attempted',source=p_source where job_id=d.job_id;
 return jsonb_build_object('claimed',true,'attemptId',d.attempt_id);
end $$;

create function private.settle_document_accounting_v1(d private.my_stuff_document_executions,p_ticks bigint,p_success boolean,p_code text)
returns void language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare j private.my_stuff_research_jobs; charge integer;
begin
 select * into j from private.my_stuff_research_jobs where id=d.job_id for update;
 if p_ticks<0 or p_ticks>9007199254740991 then raise exception 'DOCUMENT_COST_INVALID'; end if;
 -- Null is unknown: retain the whole reservation, not an invented known cost.
 charge:=case when p_ticks is null then j.reserved_cents else ceil(p_ticks::numeric/100000000)::integer end;
 -- Existing enqueue totals reservation minus release (not settlement). Account
 -- for an unexpected known overrun as an additional consumed reservation so the
 -- global ceiling cannot silently undercount spend. Never erase older entries.
 if charge>j.reserved_cents then
   insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number)
   values(j.id,j.user_id,j.reservation_month,'reservation',charge-j.reserved_cents,1);
 end if;
 insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number)
 values(j.id,j.user_id,j.reservation_month,'settlement',charge,1),
       (j.id,j.user_id,j.reservation_month,'release',greatest(j.reserved_cents-charge,0),0);
 update private.my_stuff_research_attempts set status=case when p_success then 'succeeded' else 'failed' end,
   finished_at=now(),usage_ticks=p_ticks,usage_cents=charge,error_code=p_code where id=d.attempt_id;
 update private.my_stuff_research_jobs set status=case when p_success then 'document_complete' else 'document_failed' end,
   actual_cents=coalesce(actual_cents,0)+charge,actual_cost_ticks=actual_cost_ticks+coalesce(p_ticks,0),
   last_error_code=p_code,lease_owner=null,lease_token=null,lease_expires_at=null,queue_msg_id=null,
   state_version=state_version+1,updated_at=now() where id=j.id;
end $$;

create function public.finalize_document_job_v1(p_binding jsonb,p_attempt_id uuid,p_record jsonb,p_cost_ticks bigint) returns uuid
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare d private.my_stuff_document_executions; t uuid; r jsonb;
begin
 d:=private.assert_document_job_v1(p_binding);
 if d.attempt_id is distinct from p_attempt_id then raise exception 'DOCUMENT_ATTEMPT_MISMATCH'; end if;
 if d.state='completed' then
   select record into r from public.manufacturer_template_versions where id=d.template_id;
   if r is distinct from p_record or d.cost_ticks is distinct from p_cost_ticks then raise exception 'DOCUMENT_FINALIZE_CONFLICT'; end if;
   return d.template_id;
 end if;
 if d.state<>'attempted' then raise exception 'DOCUMENT_ATTEMPT_REQUIRED'; end if;
 if p_cost_ticks is null or p_cost_ticks<0 or p_cost_ticks>9007199254740991 or
    ceil(p_cost_ticks::numeric/100000000)>(p_binding->>'reservedCents')::integer then raise exception 'DOCUMENT_COST_INVALID'; end if;
 if p_record->>'template_key' is distinct from 'document-job:'||d.job_id::text or p_record->'version' is distinct from '1'::jsonb or
    p_record->>'schema_version' is distinct from 'manufacturer-template-v2' or p_record->>'status' is distinct from 'needs_review' or
    p_record->'applicability_reviewed' is distinct from 'false'::jsonb or
    p_record#>'{validation_report,document_job}' is distinct from (d.binding-'leaseToken')||jsonb_build_object('source',d.source) or
    p_record->>'source_sha256' is distinct from d.source->>'sourceSha256' or
    (select jsonb_agg(v->'pdfPage' order by n) from jsonb_array_elements(p_record#>'{payload,documentBundle,pages}') with ordinality a(v,n)) is distinct from d.source->'selectedPages' or
    exists(select 1 from unnest(array['auto_apply_allowed','semanticVerified','sourceAuthenticated','applicable']) k
      where p_record->'validation_report'->k is distinct from 'false'::jsonb)
 then raise exception 'DOCUMENT_RECORD_MISMATCH'; end if;
 -- Existing schema-v2 SQL insert trigger independently validates evidence/rules.
 t:=public.store_manufacturer_template_version((p_binding->>'ownerId')::uuid,p_record);
 update private.my_stuff_document_executions set state='completed',template_id=t,cost_ticks=p_cost_ticks where job_id=d.job_id;
 perform private.settle_document_accounting_v1(d,p_cost_ticks,true,null);
 return t;
end $$;

create function public.fail_document_job_v1(p_binding jsonb,p_attempt_id uuid,p_cost_ticks bigint,p_code text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare d private.my_stuff_document_executions;
begin
 d:=private.assert_document_job_v1(p_binding,false);
 if d.attempt_id is distinct from p_attempt_id then raise exception 'DOCUMENT_ATTEMPT_MISMATCH'; end if;
 if d.state='completed' then return false; end if;
 if d.state='failed' then
   if d.cost_ticks is distinct from p_cost_ticks or d.error_code is distinct from p_code then raise exception 'DOCUMENT_FAILURE_CONFLICT'; end if;
   return true;
 end if;
 if p_code is null or p_code !~ '^DOCUMENT_[A-Z_]{1,80}$' then raise exception 'DOCUMENT_ERROR_INVALID'; end if;
 -- Explicit source-preflight failure is nonbillable only before claim.
 if d.state='ready' and p_cost_ticks is distinct from 0::bigint then raise exception 'DOCUMENT_PREFLIGHT_COST_INVALID'; end if;
 update private.my_stuff_document_executions set state='failed',cost_ticks=p_cost_ticks,error_code=p_code where job_id=d.job_id;
 perform private.settle_document_accounting_v1(d,p_cost_ticks,false,p_code);
 return true;
end $$;

create function private.require_document_template_link_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 if new.template_key like 'document-job:%' and not exists(
   select 1 from private.my_stuff_document_executions d
   join public.manufacturer_template_versions raw on raw.id=d.template_id
   where d.state='completed' and new.template_key='document-job:'||d.job_id::text
     and new.owner_id::text=d.binding->>'ownerId' and
     (d.template_id=new.id or (new.version>raw.version and new.source_sha256=raw.source_sha256
       and new.record#>'{validation_report,document_job}'=raw.record#>'{validation_report,document_job}')))
 then raise exception 'DOCUMENT_ATOMIC_LINK_REQUIRED'; end if;
 return null;
end $$;
revoke all on function private.require_document_template_link_v1() from public,anon,authenticated,service_role;
create constraint trigger document_template_atomic_link after insert on public.manufacturer_template_versions
 deferrable initially deferred for each row execute function private.require_document_template_link_v1();

-- Owner result API has no caller-supplied owner and exposes no lease credential.
create function public.get_my_document_job_result_v1(p_job_id uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,public,private as $$
 select jsonb_build_object('jobId',j.id,'state',d.state,'templateId',d.template_id,'record',t.record,
   'costInUsdTicks',d.cost_ticks,'costUnknown',d.state='failed' and d.cost_ticks is null)
 from private.my_stuff_research_jobs j join private.my_stuff_document_executions d on d.job_id=j.id
 left join public.manufacturer_template_versions t on t.id=d.template_id and t.owner_id=j.user_id
 where j.id=p_job_id and j.user_id=auth.uid()
$$;
revoke all on function private.document_binding_v1(private.my_stuff_research_jobs),
 private.assert_document_job_v1(jsonb,boolean),
 private.settle_document_accounting_v1(private.my_stuff_document_executions,bigint,boolean,text)
 from public,anon,authenticated,service_role;
revoke all on function public.prepare_document_job_v1(uuid,uuid),public.read_document_job_v1(jsonb),
 public.claim_document_job_v1(jsonb,jsonb),public.finalize_document_job_v1(jsonb,uuid,jsonb,bigint),
 public.fail_document_job_v1(jsonb,uuid,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.prepare_document_job_v1(uuid,uuid),public.read_document_job_v1(jsonb),
 public.claim_document_job_v1(jsonb,jsonb),public.finalize_document_job_v1(jsonb,uuid,jsonb,bigint),
 public.fail_document_job_v1(jsonb,uuid,bigint,text) to service_role;
revoke all on function public.get_my_document_job_result_v1(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_my_document_job_result_v1(uuid) to authenticated;
commit;
