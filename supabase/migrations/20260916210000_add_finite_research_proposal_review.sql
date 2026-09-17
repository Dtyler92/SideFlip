-- LOCAL DRAFT, NOT PRODUCTION APPLIED. Finite proposal/review persistence only.
-- Application/scheduler integration is deliberately not enabled by this migration.
begin;
create table private.my_stuff_research_proposals (
 id uuid primary key default gen_random_uuid(), job_id uuid not null references private.my_stuff_research_jobs(id) on delete cascade,
 proposal jsonb not null, content_hash text not null, review_state text not null check(review_state in ('owner_verification_required','blocked')),
 created_at timestamptz not null default now(), unique(job_id,content_hash)
);
alter table private.my_stuff_research_proposals enable row level security;
revoke all on private.my_stuff_research_proposals from public,anon,authenticated,service_role;

create function private.validate_research_proposal_v1(p jsonb, evidence jsonb)
returns void language plpgsql immutable set search_path=pg_catalog as $$
declare k text; span jsonb; m jsonb; miles numeric:=0; months numeric:=0; e jsonb;
begin
 if p is null or p::text ~ ': null([,}])' or jsonb_typeof(p)<>'object' or p->'schemaVersion' is distinct from '1'::jsonb
 or (select count(*) from jsonb_object_keys(p))<>8
 or not(p ?& array['schemaVersion','id','name','action','evidenceIds','support','schedule','blockedReasons'])
 or coalesce(p->>'id','') !~ '^[a-zA-Z0-9_-]{1,100}$' or length(coalesce(p->>'name','')) not between 1 and 200
 or p->>'action' not in ('inspect','adjust','replace')
 or jsonb_typeof(p->'evidenceIds') is distinct from 'array' or jsonb_array_length(p->'evidenceIds') not between 1 and 30
 or jsonb_typeof(p->'blockedReasons') is distinct from 'array' or jsonb_array_length(p->'blockedReasons')>20
 then raise exception 'INVALID_PROPOSAL'; end if;
 if exists(select 1 from jsonb_array_elements_text(p->'evidenceIds') r where not exists(select 1 from jsonb_array_elements(evidence) source(value) where source.value->>'id'=r)) then raise exception 'INVALID_PROPOSAL_REFERENCE'; end if;
 if jsonb_typeof(p->'support') is distinct from 'object' or (select count(*) from jsonb_object_keys(p->'support'))<>8
 or p->'support'->>'origin' is distinct from 'provider_claim' or p->'support'->>'coverage' is distinct from 'finite_list_only' then raise exception 'INVALID_PROPOSAL_PROVENANCE'; end if;
 foreach k in array array['row','actionContext','headingContext','notesContext','timingContext','applicabilityContext'] loop
  if jsonb_typeof(p->'support'->k) is distinct from 'array' or jsonb_array_length(p->'support'->k) not between 1 and 30 then raise exception 'INVALID_PROPOSAL_CONTEXT'; end if;
  for span in select value from jsonb_array_elements(p->'support'->k) loop
   if jsonb_typeof(span)<>'object' or (select count(*) from jsonb_object_keys(span))<>2 or not(span ?& array['evidenceId','quote']) or not(p->'evidenceIds' ? (span->>'evidenceId')) or length(coalesce(span->>'quote','')) not between 1 and 2000 then raise exception 'INVALID_PROPOSAL_CONTEXT'; end if;
   select value into e from jsonb_array_elements(evidence) where value->>'id'=span->>'evidenceId';
   if position((span->>'quote') in (e->>'exactExcerpt'))=0 then raise exception 'INVALID_PROPOSAL_QUOTE'; end if;
  end loop;
 end loop;
 if p->'schedule'->>'kind'='milestones' then
  if (select count(*) from jsonb_object_keys(p->'schedule'))<>4 or not(p->'schedule' ?& array['kind','dueSemantics','milestones','end']) or p->'schedule'->>'dueSemantics' not in ('whichever_first','all') or jsonb_typeof(p->'schedule'->'milestones') is distinct from 'array' or jsonb_array_length(p->'schedule'->'milestones') not between 1 and 100 then raise exception 'INVALID_MILESTONES'; end if;
  for m in select value from jsonb_array_elements(p->'schedule'->'milestones') loop
   if (select count(*) from jsonb_object_keys(m))<>3 or not(m ?& array['miles','months','evidenceIds']) or jsonb_typeof(m->'miles') is distinct from 'number' or jsonb_typeof(m->'months') is distinct from 'number' or (m->>'miles') !~ '^[0-9]+$' or (m->>'months') !~ '^[0-9]+$' or (m->>'miles')::numeric not between miles+1 and 10000000 or (m->>'months')::numeric not between months+1 and 1200 or jsonb_typeof(m->'evidenceIds') is distinct from 'array' or jsonb_array_length(m->'evidenceIds') not between 1 and 30 then raise exception 'INVALID_MILESTONES'; end if;
   if exists(select 1 from jsonb_array_elements_text(m->'evidenceIds') r where not(p->'evidenceIds' ? r)) then raise exception 'INVALID_MILESTONE_REFERENCE'; end if;
   miles:=(m->>'miles')::numeric; months:=(m->>'months')::numeric;
  end loop;
  if p->'schedule'->'end' is distinct from jsonb_build_object('miles',miles,'months',months) then raise exception 'INVALID_FINITE_HORIZON'; end if;
 else
  if not(p->'schedule' ?& array['kind','details']) or coalesce(p->'schedule'->>'kind','') not in ('conditional','recurring','first_then_recurring') or (select count(*) from jsonb_object_keys(p->'schedule'))<>2 or length(coalesce(p->'schedule'->>'details','')) not between 1 and 10000 or jsonb_array_length(p->'blockedReasons')=0 then raise exception 'UNSUPPORTED_PROPOSAL'; end if;
 end if;
end $$;
revoke all on function private.validate_research_proposal_v1(jsonb,jsonb) from public,anon,authenticated,service_role;

create function public.settle_my_stuff_research_worker_v3(p_job_id uuid,p_lease_token text,p_cost_ticks bigint,p_evidence jsonb,p_candidates jsonb,p_unresolved jsonb,p_proposals jsonb)
returns uuid language plpgsql security definer set search_path=public,private,extensions as $$
declare p jsonb; result uuid;
begin
 if jsonb_typeof(p_proposals) is distinct from 'array' or octet_length(p_proposals::text)>100000 or jsonb_array_length(p_proposals)+jsonb_array_length(p_candidates)>100 then raise exception 'INVALID_PROPOSALS'; end if;
 if (select count(*) from jsonb_array_elements(p_proposals))<>(select count(distinct value->>'id') from jsonb_array_elements(p_proposals)) then raise exception 'DUPLICATE_PROPOSAL'; end if;
 for p in select value from jsonb_array_elements(p_proposals) loop perform private.validate_research_proposal_v1(p,p_evidence); end loop;
 -- Reuse actual authoritative lease, entitlement, identity/policy and exact tick settlement.
 result:=private.settle_my_stuff_research_job_v4(p_job_id,p_lease_token,p_cost_ticks,p_evidence,p_candidates,p_unresolved);
 if (select status from private.my_stuff_research_jobs where id=p_job_id)='awaiting_review' then
  for p in select value from jsonb_array_elements(p_proposals) loop
   insert into private.my_stuff_research_proposals(job_id,proposal,content_hash,review_state) values(p_job_id,p,encode(digest(p::text,'sha256'),'hex'),case when p->'schedule'->>'kind'='milestones' and jsonb_array_length(p->'blockedReasons')=0 then 'owner_verification_required' else 'blocked' end);
  end loop;
 end if;
 return result;
end $$;
revoke all on function public.settle_my_stuff_research_worker_v3(uuid,text,bigint,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.settle_my_stuff_research_worker_v3(uuid,text,bigint,jsonb,jsonb,jsonb,jsonb) to service_role;

create function public.get_my_stuff_research_review_v2(p_job_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,private as $$
declare r jsonb;
begin
 r:=public.get_my_stuff_research_review_v1(p_job_id);
 return r||jsonb_build_object('proposals',coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from private.my_stuff_research_proposals p where p.job_id=p_job_id),'[]'::jsonb),'capabilities',jsonb_build_object('proposalSchemaVersions',jsonb_build_array(1),'approvalSchemaVersions',jsonb_build_array(3),'applyScheduleKinds','[]'::jsonb));
end $$;
revoke all on function public.get_my_stuff_research_review_v2(uuid) from public,anon;
grant execute on function public.get_my_stuff_research_review_v2(uuid) to authenticated;

create function public.approve_my_stuff_research_v3(p_job_id uuid,p_reviews jsonb,p_mutation_id text)
returns uuid language plpgsql security definer set search_path=public,private,extensions as $$
declare u uuid:=auth.uid(); j private.my_stuff_research_jobs%rowtype; a private.my_stuff_research_approvals%rowtype; p private.my_stuff_research_proposals%rowtype; r jsonb; h text; snapshot jsonb; aid uuid;
begin
 if u is null then raise exception 'Authentication required'; end if;
 perform private.assert_my_stuff_research_user_v1(u);
 if exists(select 1 from public.account_deletion_tombstones where user_id=u) then raise exception 'ACCOUNT_DELETION_PENDING'; end if;
 if not public.user_has_verified_pro_entitlement(u) then raise exception 'PRO_REQUIRED'; end if;
 if length(trim(coalesce(p_mutation_id,''))) not between 1 and 200 or jsonb_typeof(p_reviews) is distinct from 'array' or jsonb_array_length(p_reviews) not between 1 and 100 then raise exception 'INVALID_REVIEW'; end if;
 if jsonb_array_length(p_reviews)<>(select count(distinct value->>'proposal_id') from jsonb_array_elements(p_reviews)) then raise exception 'INVALID_REVIEW'; end if;
 select jsonb_agg(value order by value->>'proposal_id') into p_reviews from jsonb_array_elements(p_reviews);
 h:=encode(digest(jsonb_build_object('job_id',p_job_id,'reviews',p_reviews)::text,'sha256'),'hex');
 -- Serialize both mutation identity and job selection. Replay precedes mutable identity checks.
 perform pg_advisory_xact_lock(hashtextextended('research-review-mutation:'||u::text||':'||trim(p_mutation_id),0));
 perform pg_advisory_xact_lock(hashtextextended('research-job:'||p_job_id::text,0));
 select * into j from private.my_stuff_research_jobs where id=p_job_id and user_id=u for update;
 if not found or not exists(select 1 from public.my_stuff_items where id=j.item_id and user_id=u) then raise exception 'Research job not found'; end if;
 select * into a from private.my_stuff_research_approvals where user_id=u and client_mutation_id=trim(p_mutation_id);
 if found then
  if a.job_id<>p_job_id or a.request_hash is distinct from h then raise exception 'MUTATION_ID_REUSED'; end if;
  return a.id;
 end if;
 if not exists(select 1 from public.my_stuff_items where id=j.item_id and user_id=u and vin_confirmation_fingerprint=j.confirmed_fingerprint) then raise exception 'IDENTITY_CHANGED'; end if;
 if not private.my_stuff_research_policy_is_current_v1(j.id) then raise exception 'POLICY_SUPERSEDED'; end if;
 if j.status<>'awaiting_review' then raise exception 'RESEARCH_NOT_AWAITING_REVIEW'; end if;
 for r in select value from jsonb_array_elements(p_reviews) loop
  if jsonb_typeof(r)<>'object' or (select count(*) from jsonb_object_keys(r))<>3 or not(r ?& array['proposal_id','content_hash','acknowledgements']) or r->'acknowledgements' is distinct from '{"sourceApplicability":true,"taskAction":true,"headingSchedule":true,"notesConditions":true,"finiteHorizon":true}'::jsonb then raise exception 'TASK_NOT_VERIFIED'; end if;
  select * into p from private.my_stuff_research_proposals where id=(r->>'proposal_id')::uuid and job_id=j.id;
  if not found or p.content_hash is distinct from r->>'content_hash' then raise exception 'STALE_PROPOSAL'; end if;
  if p.review_state<>'owner_verification_required' then raise exception 'PROPOSAL_BLOCKED'; end if;
 end loop;
 snapshot:=jsonb_build_object('schema_version',3,'job_id',j.id,'item_id',j.item_id,'confirmed_fingerprint',j.confirmed_fingerprint,'policy_version',j.policy_version,'reviews',p_reviews,'reviewed_by',u,'reviewed_at',now(),
 'proposals',(select jsonb_agg(to_jsonb(pr) order by pr.id) from private.my_stuff_research_proposals pr where pr.job_id=j.id and pr.id in(select (value->>'proposal_id')::uuid from jsonb_array_elements(p_reviews))),
 'evidence',(select jsonb_agg(to_jsonb(e) order by e.evidence_key) from private.my_stuff_research_evidence e where e.job_id=j.id));
 insert into private.my_stuff_research_approvals(job_id,user_id,item_id,snapshot,snapshot_hash,client_mutation_id,request_hash) values(j.id,u,j.item_id,snapshot,encode(digest(snapshot::text,'sha256'),'hex'),trim(p_mutation_id),h) returning id into aid;
 update private.my_stuff_research_jobs set status='approved',state_version=state_version+1,updated_at=now() where id=j.id;
 return aid;
end $$;
revoke all on function public.approve_my_stuff_research_v3(uuid,jsonb,text) from public,anon;
grant execute on function public.approve_my_stuff_research_v3(uuid,jsonb,text) to authenticated;

-- Preserve legacy implementation behind a version guard; no schema-3 downgrade.
alter function public.apply_my_stuff_research_v1(uuid,text) rename to apply_my_stuff_research_legacy_v1;
revoke all on function public.apply_my_stuff_research_legacy_v1(uuid,text) from public,anon,authenticated,service_role;
create function public.apply_my_stuff_research_v1(p_approval_id uuid,p_mutation_id text)
returns uuid[] language plpgsql security definer set search_path=public,private as $$
begin
 if not exists(select 1 from private.my_stuff_research_approvals where id=p_approval_id and user_id=auth.uid() and snapshot->>'schema_version' in ('1','2')) then raise exception 'UNSUPPORTED_APPROVAL_VERSION'; end if;
 return public.apply_my_stuff_research_legacy_v1(p_approval_id,p_mutation_id);
end $$;
revoke all on function public.apply_my_stuff_research_v1(uuid,text) from public,anon;
grant execute on function public.apply_my_stuff_research_v1(uuid,text) to authenticated;
commit;
