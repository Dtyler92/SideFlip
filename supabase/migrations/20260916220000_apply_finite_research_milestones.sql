-- LOCAL ONLY additive draft. Never applied to production.
begin;
alter table public.my_stuff_maintenance_definitions add column schedule_spec jsonb;
alter table public.my_stuff_planned_occurrences add column milestone_index integer check(milestone_index>=0);
create unique index my_stuff_finite_milestone_unique on public.my_stuff_planned_occurrences(definition_id,milestone_index) where milestone_index is not null;

alter function private.validate_research_proposal_v1(jsonb,jsonb) rename to validate_research_proposal_base_v1;
create function private.validate_research_proposal_v1(p jsonb,evidence jsonb) returns void language plpgsql immutable set search_path=pg_catalog,private as $$
declare a jsonb; s jsonb; k text; m jsonb;

begin
 perform private.validate_research_proposal_base_v1(p,evidence);
 if jsonb_typeof(p->'name')<>'string' or (p->>'name') !~ '[^[:space:]]' or jsonb_typeof(p->'action')<>'string' or jsonb_typeof(p->'id')<>'string' then raise exception 'INVALID_PROPOSAL'; end if;
 for a in select value from jsonb_array_elements(p->'blockedReasons') loop
 if jsonb_typeof(a)<>'string' or (a#>>'{}') !~ '[^[:space:]]' or length(a#>>'{}')>1000 then raise exception 'INVALID_PROPOSAL'; end if;
 end loop;
 for a in select p->'evidenceIds' union all select value->'evidenceIds' from jsonb_array_elements(coalesce(p->'schedule'->'milestones','[]')) loop
 if jsonb_array_length(a)<>(select count(distinct value) from jsonb_array_elements(a)) or exists(select 1 from jsonb_array_elements(a) where jsonb_typeof(value)<>'string') then raise exception 'INVALID_PROPOSAL_REFERENCE'; end if;
 end loop;
 foreach k in array array['row','actionContext','headingContext','notesContext','timingContext','applicabilityContext'] loop
 for s in select value from jsonb_array_elements(p->'support'->k) loop
 if jsonb_typeof(s->'quote')<>'string' or (s->>'quote') !~ '[^[:space:]]' or jsonb_typeof(s->'evidenceId')<>'string' then raise exception 'INVALID_PROPOSAL_CONTEXT'; end if;
 end loop; end loop;
 for m in select value from jsonb_array_elements(coalesce(p->'schedule'->'milestones','[]')) loop
  foreach k in array array['row','actionContext','headingContext'] loop
   if not exists(select 1 from jsonb_array_elements(p->'support'->k) x where m->'evidenceIds' ? (x->>'evidenceId')) then raise exception 'INVALID_MILESTONE_CONTEXT'; end if;
  end loop;
  if not exists(select 1 from jsonb_array_elements(p->'support'->'headingContext') x cross join lateral regexp_matches(x->>'quote','\m([0-9][0-9,]*)\s+miles\s+(?:or|and|/)\s+([0-9]+)\s+months\M','gi') h where m->'evidenceIds' ? (x->>'evidenceId') and replace(h[1],',','')::numeric=(m->>'miles')::numeric and h[2]::numeric=(m->>'months')::numeric) then raise exception 'INVALID_MILESTONE_HEADING'; end if;
 end loop;
 if p->'schedule'->>'kind'<>'milestones' and (jsonb_typeof(p->'schedule'->'details')<>'string' or (p->'schedule'->>'details') !~ '[^[:space:]]') then raise exception 'INVALID_PROPOSAL'; end if;
end $$;
revoke all on function private.validate_research_proposal_v1(jsonb,jsonb) from public,anon,authenticated,service_role;

create function private.research_task_key_v1(name text) returns text language sql immutable set search_path=pg_catalog as $$
 select regexp_replace(regexp_replace(lower(regexp_replace(normalize(name,NFKC),'^[[:space:]]+|[[:space:]]+$','','g')),'^(inspect|adjust|replace)\s+','','i'),'\s+',' ','g')
$$;
revoke all on function private.research_task_key_v1(text) from public,anon,authenticated,service_role;
alter function public.settle_my_stuff_research_worker_v3(uuid,text,bigint,jsonb,jsonb,jsonb,jsonb) rename to settle_my_stuff_research_worker_base_v3;
revoke all on function public.settle_my_stuff_research_worker_base_v3(uuid,text,bigint,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;
create function public.settle_my_stuff_research_worker_v3(p_job_id uuid,p_lease_token text,p_cost_ticks bigint,p_evidence jsonb,p_candidates jsonb,p_unresolved jsonb,p_proposals jsonb)
returns uuid language plpgsql security definer set search_path=public,private,extensions as $$
declare p jsonb; u jsonb;
begin
 if jsonb_typeof(p_candidates) is distinct from 'array' or jsonb_typeof(p_unresolved) is distinct from 'array' or jsonb_typeof(p_proposals) is distinct from 'array' then raise exception 'INVALID_PROPOSALS'; end if;
 if (select count(*) from jsonb_array_elements(p_proposals))<>(select count(distinct private.research_task_key_v1(value->>'name')) from jsonb_array_elements(p_proposals)) then raise exception 'DUPLICATE_PROPOSAL_TASK'; end if;
 for p in select value from jsonb_array_elements(p_proposals) loop
  if exists(select 1 from jsonb_array_elements(p_candidates) c where private.research_task_key_v1(c->>'name')=private.research_task_key_v1(p->>'name')) then raise exception 'CROSS_LANE_TASK_CONFLICT'; end if;
  for u in select value from jsonb_array_elements(p_unresolved) loop
   if private.research_task_key_v1(u->>'name')=private.research_task_key_v1(p->>'name') and not coalesce(p->'blockedReasons' ? (u->>'reason'),false) then raise exception 'UNRESOLVED_TASK_CONFLICT'; end if;
  end loop;
 end loop;
 if exists(select 1 from jsonb_array_elements(p_candidates) c cross join jsonb_array_elements(p_unresolved) unresolved_row where private.research_task_key_v1(c->>'name')=private.research_task_key_v1(unresolved_row->>'name')) then raise exception 'UNRESOLVED_TASK_CONFLICT'; end if;
 return public.settle_my_stuff_research_worker_base_v3(p_job_id,p_lease_token,p_cost_ticks,p_evidence,p_candidates,p_unresolved,p_proposals);
end $$;
revoke all on function public.settle_my_stuff_research_worker_v3(uuid,text,bigint,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.settle_my_stuff_research_worker_v3(uuid,text,bigint,jsonb,jsonb,jsonb,jsonb) to service_role;

create function private.finite_occurrence_due_v1(p_id uuid,p_as_of timestamptz) returns text language plpgsql stable security definer set search_path=public,private as $$
declare p public.my_stuff_planned_occurrences%rowtype; d public.my_stuff_maintenance_definitions%rowtype; i public.my_stuff_items%rowtype; at_due timestamptz; miles numeric; yes boolean;
begin
 select * into p from public.my_stuff_planned_occurrences where id=p_id and user_id=auth.uid();
 if not found then raise exception 'Occurrence not found'; end if;
 select * into d from public.my_stuff_maintenance_definitions where id=p.definition_id;
 select * into i from public.my_stuff_items where id=p.item_id;
 -- Completion has an explicit business timestamp. Manual resolutions use append-only event time.
 if p.status='completed' and exists(select 1 from public.my_stuff_service_occurrences s where s.id=p.completed_service_occurrence_id and s.completed_at<=p_as_of) then return 'completed'; end if;
 -- Equal transaction timestamps cannot establish order; report honest unknown rather than guess.
 select case when count(distinct e.status)=1 then min(e.status) else 'history_unknown' end into p.status
 from public.my_stuff_occurrence_status_events e
 where e.planned_occurrence_id=p.id and e.source='manual' and e.created_at=(
 select max(ev.created_at) from public.my_stuff_occurrence_status_events ev
 where ev.planned_occurrence_id=p.id and ev.source='manual' and ev.created_at<=p_as_of);
 p.status:=coalesce(p.status,'history_unknown');
 if p.status<>'not_completed' then return p.status; end if;
 if i.in_service_on is null then return 'in_service_unknown'; end if;
 select r.reading_value into miles from public.my_stuff_readings r where r.item_id=i.id and r.reading_type='mileage' and r.recorded_at<=p_as_of order by r.recorded_at desc,r.created_at desc,r.id desc limit 1;
 miles:=coalesce(miles,i.origin_mileage);
 if miles is null then return 'meter_unknown'; end if;
 at_due:=i.in_service_on::timestamptz+make_interval(months=>(d.schedule_spec->'milestones'->p.milestone_index->>'months')::integer);
 if d.schedule_spec->>'dueSemantics'='all' then yes:=miles>=p.due_mileage and p_as_of>=at_due; else yes:=miles>=p.due_mileage or p_as_of>=at_due; end if;
 return case when yes then 'due_now' else 'upcoming' end;
end $$;
revoke all on function private.finite_occurrence_due_v1(uuid,timestamptz) from public,anon,authenticated,service_role;

alter function public.get_my_stuff_due_state_v2(uuid,timestamptz) rename to get_my_stuff_due_state_legacy_v2;
revoke all on function public.get_my_stuff_due_state_legacy_v2(uuid,timestamptz) from public,anon,authenticated,service_role;
create function public.get_my_stuff_due_state_v2(p_item_id uuid,p_as_of timestamptz default now())
returns table(definition_id uuid,next_due_at timestamptz,next_due_mileage numeric,next_due_hours numeric,next_due_cycles numeric,due_status text)
language plpgsql stable security definer set search_path=public,private as $$
begin
 if p_as_of is null or not isfinite(p_as_of) or p_as_of<'1900-01-01Z' or p_as_of>='2200-01-01Z' then raise exception 'As-of date outside supported range'; end if;
 return query select l.* from public.get_my_stuff_due_state_legacy_v2(p_item_id,p_as_of) l join public.my_stuff_maintenance_definitions d on d.id=l.definition_id where d.schedule_spec is null;
 return query select d.id,case when i.in_service_on is null or p.id is null then null else i.in_service_on::timestamptz+make_interval(months=>(d.schedule_spec->'milestones'->p.milestone_index->>'months')::integer) end,p.due_mileage,null::numeric,null::numeric,
 case when p.id is null then 'source_coverage_exhausted' else private.finite_occurrence_due_v1(p.id,p_as_of) end
 from public.my_stuff_maintenance_definitions d join public.my_stuff_items i on i.id=d.item_id left join lateral(select o.* from public.my_stuff_planned_occurrences o where o.definition_id=d.id and o.milestone_index is not null and private.finite_occurrence_due_v1(o.id,p_as_of) not in ('completed','skipped','not_applicable') order by o.milestone_index limit 1) p on true
 where d.item_id=p_item_id and d.user_id=auth.uid() and d.enabled and d.schedule_spec is not null;
end $$;
revoke all on function public.get_my_stuff_due_state_v2(uuid,timestamptz) from public,anon;
grant execute on function public.get_my_stuff_due_state_v2(uuid,timestamptz) to authenticated;

alter function public.materialize_my_stuff_next_occurrence_v3(uuid) rename to materialize_my_stuff_next_occurrence_legacy_v3;
revoke all on function public.materialize_my_stuff_next_occurrence_legacy_v3(uuid) from public,anon,authenticated,service_role;
create function public.materialize_my_stuff_next_occurrence_v3(p_definition_id uuid) returns uuid language plpgsql security definer set search_path=public,private as $$
declare d public.my_stuff_maintenance_definitions%rowtype; m jsonb; n integer:=0; v uuid; result uuid; anchor date;
begin
 select * into d from public.my_stuff_maintenance_definitions where id=p_definition_id and user_id=auth.uid() and enabled for update;
 if not found then raise exception 'Maintenance definition not found'; end if;
 if d.schedule_spec is null then return public.materialize_my_stuff_next_occurrence_legacy_v3(p_definition_id); end if;
 select id into v from public.my_stuff_definition_versions where definition_id=d.id order by version_number limit 1;
 select in_service_on into anchor from public.my_stuff_items where id=d.item_id;
 for m in select value from jsonb_array_elements(d.schedule_spec->'milestones') loop
 insert into public.my_stuff_planned_occurrences(user_id,item_id,definition_id,definition_version_id,occurrence_key,status,due_at,due_mileage,milestone_index)
 values(d.user_id,d.item_id,d.id,v,'finite:'||v::text||':'||n,'history_unknown',anchor::timestamptz+make_interval(months=>(m->>'months')::integer),(m->>'miles')::numeric,n)
 on conflict(definition_id,milestone_index) where milestone_index is not null do nothing;
 n:=n+1;
 end loop;
 select id into result from public.my_stuff_planned_occurrences where definition_id=d.id and status not in ('completed','skipped','not_applicable') order by milestone_index limit 1;
 return result;
end $$;
revoke all on function public.materialize_my_stuff_next_occurrence_v3(uuid) from public,anon;
grant execute on function public.materialize_my_stuff_next_occurrence_v3(uuid) to authenticated;

create function public.apply_my_stuff_research_v2(p_approval_id uuid,p_mutation_id text) returns uuid[] language plpgsql security definer set search_path=public,private,extensions as $$
declare u uuid:=auth.uid(); a private.my_stuff_research_approvals%rowtype; j private.my_stuff_research_jobs%rowtype; ids uuid[]:=array[]::uuid[]; old_mut text; p jsonb; spec jsonb; def jsonb; v_def uuid; e jsonb; key text;
begin
 if u is null then raise exception 'Authentication required'; end if;
 perform private.assert_my_stuff_research_user_v1(u);
 if exists(select 1 from public.account_deletion_tombstones where user_id=u) then raise exception 'ACCOUNT_DELETION_PENDING'; end if;
 if not public.user_has_verified_pro_entitlement(u) then raise exception 'PRO_REQUIRED'; end if;
 if length(trim(coalesce(p_mutation_id,''))) not between 1 and 200 then raise exception 'Mutation ID required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('research-approval:'||p_approval_id::text,0));
 select * into a from private.my_stuff_research_approvals where id=p_approval_id and user_id=u;
 if not found then raise exception 'Research approval not found'; end if;
 if a.snapshot->>'schema_version' in ('1','2') then return public.apply_my_stuff_research_v1(p_approval_id,p_mutation_id); end if;
 if a.snapshot->>'schema_version' is distinct from '3' then raise exception 'UNSUPPORTED_APPROVAL_VERSION'; end if;
 select * into j from private.my_stuff_research_jobs where id=a.job_id and user_id=u for update;
 perform 1 from public.my_stuff_items where id=a.item_id and user_id=u for update;
 if not found then raise exception 'Research item not found'; end if;
 select definition_ids,client_mutation_id into ids,old_mut from private.my_stuff_research_apply_records where approval_id=a.id;
 if found then if old_mut<>trim(p_mutation_id) then raise exception 'MUTATION_ID_REUSED'; end if; return ids; end if;
 ids:=array[]::uuid[];
 if not exists(select 1 from public.my_stuff_items where id=a.item_id and user_id=u and vin_confirmation_fingerprint=j.confirmed_fingerprint) then raise exception 'IDENTITY_CHANGED'; end if;
 if j.status<>'approved' then raise exception 'Research job is not approved'; end if;
 if not private.my_stuff_research_policy_is_current_v1(j.id) then raise exception 'POLICY_SUPERSEDED'; end if;
 if a.snapshot->>'reviewed_by' is distinct from u::text or a.snapshot_hash<>encode(digest(a.snapshot::text,'sha256'),'hex') then raise exception 'INVALID_APPROVAL'; end if;
 for p in select value from jsonb_array_elements(a.snapshot->'proposals') loop
 if p->'proposal'->'schedule'->>'kind' is distinct from 'milestones' or p->'proposal'->'blockedReasons'<>'[]'::jsonb or p->>'job_id' is distinct from j.id::text then raise exception 'PROPOSAL_BLOCKED'; end if;
 spec:=p->'proposal'->'schedule'||jsonb_build_object('schemaVersion',1,'approvalId',a.id,'proposalId',p->>'id','contentHash',p->>'content_hash');
 select value into e from jsonb_array_elements(a.snapshot->'evidence') where value->>'evidence_key'=p->'proposal'->'evidenceIds'->>0;
 if e is null then raise exception 'MISSING_EVIDENCE'; end if;
 def:=jsonb_build_object('name',p->'proposal'->>'name','service_action',p->'proposal'->>'action','due_semantics',spec->>'dueSemantics','cadence_anchor','asset_origin','normal_interval_miles',(spec->'milestones'->0->>'miles')::numeric,'normal_calendar_months',(spec->'milestones'->0->>'months')::integer,'provenance_type','ai_research','source_class',case when e->>'source_class'='authorized_dealer' then 'dealer' else 'manufacturer_guide' end,'citation_url',e->>'canonical_url','citation_title',e->>'title','uncertain',true,'uncertainty_reason','Provider citation unconfirmed; separate owner review sealed in approval','enabled',true);
 v_def:=private.create_my_stuff_maintenance_definition_v2_trusted(u,a.item_id,def,'finite:'||a.id::text||':'||(p->>'id'));
 update public.my_stuff_maintenance_definitions set schedule_spec=spec where my_stuff_maintenance_definitions.id=v_def;
 insert into public.my_stuff_definition_versions(user_id,item_id,definition_id,version_number,definition,provenance_type,client_mutation_id,request_hash) values(u,a.item_id,v_def,1,def||jsonb_build_object('schedule_spec',spec),'ai_research','finite-version:'||a.id::text||':'||(p->>'id'),p->>'content_hash');
 for key in select value from jsonb_array_elements_text(p->'proposal'->'evidenceIds') loop
 insert into private.my_stuff_research_definition_evidence(definition_id,evidence_id,approval_id,due_semantics,profile) select v_def,ev.id,a.id,spec->>'dueSemantics','normal' from private.my_stuff_research_evidence ev where ev.job_id=j.id and ev.evidence_key=key and exists(select 1 from jsonb_array_elements(a.snapshot->'evidence') se where se->>'id'=ev.id::text);
 if not found then raise exception 'MISSING_SEALED_EVIDENCE'; end if;
 end loop;
 perform public.materialize_my_stuff_next_occurrence_v3(v_def);
 ids:=array_append(ids,v_def);
 end loop;
 if cardinality(ids)=0 then raise exception 'EMPTY_APPROVAL'; end if;
 insert into private.my_stuff_research_apply_records(approval_id,user_id,definition_ids,client_mutation_id) values(a.id,u,ids,trim(p_mutation_id));
 update private.my_stuff_research_jobs set status='applied',state_version=state_version+1,updated_at=now() where my_stuff_research_jobs.id=j.id;
 return ids;
end $$;
revoke all on function public.apply_my_stuff_research_v2(uuid,text) from public,anon;
grant execute on function public.apply_my_stuff_research_v2(uuid,text) to authenticated;

create or replace function public.get_my_stuff_research_review_v2(p_job_id uuid) returns jsonb language plpgsql stable security definer set search_path=public,private as $$
declare r jsonb;
begin r:=public.get_my_stuff_research_review_v1(p_job_id);
 return r||jsonb_build_object('approval',(select jsonb_build_object('id',a.id,'snapshot',a.snapshot) from private.my_stuff_research_approvals a where a.id=(r->>'approval_id')::uuid and a.job_id=p_job_id and a.user_id=auth.uid()),'proposals',coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from private.my_stuff_research_proposals p where p.job_id=p_job_id),'[]'::jsonb),'capabilities',jsonb_build_object('proposalSchemaVersions',jsonb_build_array(1),'approvalSchemaVersions',jsonb_build_array(3),'applyScheduleKinds',jsonb_build_array('milestones')));
end $$;

alter function public.get_my_stuff_due_views_v3(uuid,timestamptz) rename to get_my_stuff_due_views_legacy_v3;
revoke all on function public.get_my_stuff_due_views_legacy_v3(uuid,timestamptz) from public,anon,authenticated,service_role;
create function public.get_my_stuff_due_views_v3(p_item_id uuid,p_as_of timestamptz default now()) returns jsonb language plpgsql stable security definer set search_path=public,private as $$
declare r jsonb;
begin
 r:=public.get_my_stuff_due_views_legacy_v3(p_item_id,p_as_of);
 return coalesce((select jsonb_agg(case when (x->'occurrence'->>'milestone_index') is not null then jsonb_set(x,'{view}',to_jsonb(private.finite_occurrence_due_v1((x->'occurrence'->>'id')::uuid,p_as_of))) else x end) from jsonb_array_elements(r) x),'[]'::jsonb);
end $$;
revoke all on function public.get_my_stuff_due_views_v3(uuid,timestamptz) from public,anon;
grant execute on function public.get_my_stuff_due_views_v3(uuid,timestamptz) to authenticated;

create function private.guard_finite_definition_v1() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if old.schedule_spec is not null and (new.schedule_spec is distinct from old.schedule_spec or new.cadence_anchor<>old.cadence_anchor or new.due_semantics<>old.due_semantics or new.service_action<>old.service_action or new.active_profile<>old.active_profile or row(new.normal_interval_miles,new.normal_calendar_months,new.first_interval_miles,new.first_calendar_months,new.severe_interval_miles,new.severe_calendar_months,new.normal_interval_hours,new.normal_interval_cycles,new.first_interval_hours,new.first_interval_cycles,new.severe_interval_hours,new.severe_interval_cycles) is distinct from row(old.normal_interval_miles,old.normal_calendar_months,old.first_interval_miles,old.first_calendar_months,old.severe_interval_miles,old.severe_calendar_months,old.normal_interval_hours,old.normal_interval_cycles,old.first_interval_hours,old.first_interval_cycles,old.severe_interval_hours,old.severe_interval_cycles)) then raise exception 'FINITE_SCHEDULE_IMMUTABLE'; end if;
 return new;
end $$;
revoke all on function private.guard_finite_definition_v1() from public,anon,authenticated,service_role;
create trigger guard_finite_definition before update on public.my_stuff_maintenance_definitions for each row execute function private.guard_finite_definition_v1();
create function private.refresh_finite_calendar_anchors_v1() returns trigger language plpgsql security definer set search_path=public,private as $$
begin
 update public.my_stuff_planned_occurrences p set due_at=new.in_service_on::timestamptz+make_interval(months=>(d.schedule_spec->'milestones'->p.milestone_index->>'months')::integer)
 from public.my_stuff_maintenance_definitions d where d.id=p.definition_id and d.item_id=new.id and d.schedule_spec is not null and p.milestone_index is not null and p.status<>'completed';
 return new;
end $$;
revoke all on function private.refresh_finite_calendar_anchors_v1() from public,anon,authenticated,service_role;
create trigger refresh_finite_calendar_anchors after update of in_service_on on public.my_stuff_items for each row when(old.in_service_on is distinct from new.in_service_on) execute function private.refresh_finite_calendar_anchors_v1();
commit;
