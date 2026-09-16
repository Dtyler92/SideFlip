-- Correct SQLSTATE 42883 in unresolved validation; preserve all policy and billing gates.
-- JSON extraction and concatenation share precedence: extract both fields first.
begin;

create or replace function private.settle_my_stuff_research_job_v4(
  p_job_id uuid,p_worker text,p_cost_ticks bigint,p_evidence jsonb,p_candidates jsonb,p_unresolved jsonb)
returns uuid language plpgsql security definer set search_path=public,private,pgmq,extensions as $$
declare v_job private.my_stuff_research_jobs%rowtype; v_cfg private.my_stuff_research_runtime_config%rowtype; v_e jsonb; v_c jsonb;
  enabled_source_domains text[]; v_token uuid; v_total integer; v_cost_cents integer;
begin
  v_token:=p_worker::uuid;
  select * into v_cfg from private.my_stuff_research_runtime_config where singleton;
  if not found or not v_cfg.enabled or v_cfg.provider_name<>'xai' or v_cfg.provider_model<>'grok-4.6' then raise exception 'RESEARCH_DISABLED'; end if;
  select * into v_job from private.my_stuff_research_jobs where id=p_job_id and status='running' and lease_token=v_token and lease_expires_at>now() for update;
  if not found then raise exception 'STALE_RESEARCH_LEASE'; end if;
  if not private.my_stuff_research_policy_is_current_v1(v_job.id) then raise exception 'POLICY_SUPERSEDED'; end if;
  select coalesce(array_agg(domain),array[]::text[]) into enabled_source_domains from private.my_stuff_research_source_domains where enabled and terms_reviewed_on between current_date-365 and current_date and robots_reviewed_on between current_date-30 and current_date and lower(manufacturer)=lower(v_job.request_snapshot->>'make');
  if cardinality(enabled_source_domains)=0 then raise exception 'RESEARCH_DISABLED'; end if;
  perform private.assert_my_stuff_research_user_v1(v_job.user_id);
  if p_cost_ticks is null or p_cost_ticks<0 then raise exception 'INVALID_PROVIDER_RESPONSE'; end if;
  v_cost_cents:=ceil(p_cost_ticks::numeric/100000000)::integer;
  v_total:=coalesce(v_job.actual_cents,0)+v_cost_cents;
  if v_cost_cents<0 or v_total>v_job.reserved_cents then raise exception 'RESEARCH_BUDGET_EXCEEDED'; end if;
  if v_job.cancellation_requested_at is not null then
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values(p_job_id,v_job.user_id,v_job.reservation_month,'settlement',v_cost_cents,v_job.attempt_count) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values(p_job_id,v_job.user_id,v_job.reservation_month,'release',v_job.reserved_cents-v_total,0) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
    update private.my_stuff_research_attempts set status='cancelled',finished_at=now(),usage_cents=v_cost_cents,usage_ticks=p_cost_ticks where job_id=p_job_id and attempt_number=v_job.attempt_count;
    update private.my_stuff_research_jobs set status='cancelled',actual_cents=v_total,actual_cost_ticks=actual_cost_ticks+p_cost_ticks,lease_owner=null,lease_token=null,lease_expires_at=null,state_version=state_version+1,updated_at=now() where id=p_job_id;
    perform pgmq.delete('my_stuff_research_v1',v_job.queue_msg_id);
    return p_job_id;
  end if;
  if jsonb_typeof(p_evidence)<>'array' or jsonb_array_length(p_evidence)>30 or jsonb_typeof(p_candidates)<>'array' or jsonb_array_length(p_candidates)>100 or jsonb_typeof(p_unresolved)<>'array' or jsonb_array_length(p_unresolved)>50 then raise exception 'INVALID_RESEARCH_RESULT'; end if;
  if exists(select 1 from jsonb_array_elements(p_unresolved) value where jsonb_typeof(value)<>'object' or nullif(trim(value->>'name'),'') is null or length(value->>'name')>200 or nullif(trim(value->>'reason'),'') is null or length(value->>'reason')>1000 or ((value->>'name')||E'\n'||(value->>'reason')) ~* '(ignore|disregard).*(instruction|previous|system)|system\s*prompt|developer\s*message|jailbreak') then raise exception 'INVALID_RESEARCH_RESULT'; end if;
  delete from private.my_stuff_research_evidence where job_id=p_job_id;
  for v_e in select value from jsonb_array_elements(p_evidence) loop
    if nullif(v_e->>'id','') is null or nullif(v_e->>'canonicalUrl','') is null or nullif(v_e->>'exactExcerpt','') is null or (v_e->>'sourceDomain')<>all(enabled_source_domains) or coalesce((v_e->>'locationVerified')::boolean,true) is not false or v_e->>'verificationStatus'<>'provider_citation_unconfirmed' then raise exception 'INVALID_EVIDENCE'; end if;
    insert into private.my_stuff_research_evidence(job_id,evidence_key,title,canonical_url,exact_excerpt,page,section,accessed_on,accessed_at,applicability,source_class,source_domain,location_verified,verification_status,content_hash)
      values(p_job_id,v_e->>'id',v_e->>'title',v_e->>'canonicalUrl',v_e->>'exactExcerpt',nullif(v_e->>'page',''),nullif(v_e->>'section',''),(v_e->>'accessedAt')::timestamptz::date,(v_e->>'accessedAt')::timestamptz,v_e->>'applicability',v_e->>'sourceClass',v_e->>'sourceDomain',false,'provider_citation_unconfirmed',encode(digest(v_e::text,'sha256'),'hex'));
  end loop;
  delete from private.my_stuff_research_candidates where job_id=p_job_id;
  for v_c in select value from jsonb_array_elements(p_candidates) loop
    insert into private.my_stuff_research_candidates(job_id,candidate,content_hash) values(p_job_id,v_c,encode(digest(v_c::text,'sha256'),'hex'));
  end loop;
  insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values(p_job_id,v_job.user_id,v_job.reservation_month,'settlement',v_cost_cents,v_job.attempt_count) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
  insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values(p_job_id,v_job.user_id,v_job.reservation_month,'release',v_job.reserved_cents-v_total,0) on conflict (job_id,kind,attempt_number) where job_id is not null do nothing;
  update private.my_stuff_research_attempts set status='succeeded',finished_at=now(),usage_cents=v_cost_cents,usage_ticks=p_cost_ticks where job_id=p_job_id and attempt_number=v_job.attempt_count;
  update private.my_stuff_research_jobs set status='awaiting_review',actual_cents=v_total,actual_cost_ticks=actual_cost_ticks+p_cost_ticks,unresolved=p_unresolved,lease_owner=null,lease_token=null,lease_expires_at=null,state_version=state_version+1,updated_at=now() where id=p_job_id;
  perform pgmq.delete('my_stuff_research_v1',v_job.queue_msg_id);
  return p_job_id;
end $$;

commit;
