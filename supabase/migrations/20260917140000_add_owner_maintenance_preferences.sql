-- LOCAL/UNAPPLIED: additive owner facts; no backfill or inferred reading dates.
begin;
create table public.my_stuff_owner_preference_revisions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 item_id uuid not null references public.my_stuff_items(id) on delete cascade,
 revision_number integer not null, annual_mileage_estimate numeric,
 condition_answers jsonb not null default '{}', reason text not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(item_id,revision_number), check(annual_mileage_estimate >= 0 and annual_mileage_estimate <= 1000000),
 check(jsonb_typeof(condition_answers)='object')
);
create table public.my_stuff_service_detail_revisions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 item_id uuid not null references public.my_stuff_items(id) on delete cascade,
 occurrence_id uuid not null references public.my_stuff_service_occurrences(id) on delete cascade,
 revision_number integer not null, details jsonb not null, reason text not null,
 created_at timestamptz not null default clock_timestamp(), unique(occurrence_id,revision_number)
);
alter table public.my_stuff_owner_preference_revisions enable row level security;
alter table public.my_stuff_service_detail_revisions enable row level security;
revoke all on public.my_stuff_owner_preference_revisions,public.my_stuff_service_detail_revisions from public,anon,authenticated;
grant select on public.my_stuff_owner_preference_revisions,public.my_stuff_service_detail_revisions to authenticated;
create policy owner_read on public.my_stuff_owner_preference_revisions for select to authenticated using(user_id=(select auth.uid()));
create policy owner_read on public.my_stuff_service_detail_revisions for select to authenticated using(user_id=(select auth.uid()));
create trigger owner_preferences_immutable before update or delete on public.my_stuff_owner_preference_revisions for each row execute function public.prevent_my_stuff_v2_immutable_update();
create trigger service_details_immutable before update or delete on public.my_stuff_service_detail_revisions for each row execute function public.prevent_my_stuff_v2_immutable_update();

create function public.get_my_stuff_owner_preferences_v1(p_item_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public,extensions as $$
declare r jsonb;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if not exists(select 1 from public.my_stuff_items where id=p_item_id and user_id=auth.uid()) then raise exception 'My Stuff item not found'; end if;
 select to_jsonb(x) into r from public.my_stuff_owner_preference_revisions x where item_id=p_item_id and user_id=auth.uid() order by revision_number desc limit 1;
 return coalesce(r,jsonb_build_object('annual_mileage_estimate',null,'condition_answers','{}'::jsonb));
end $$;

create function public.save_my_stuff_owner_preferences_v1(p_item_id uuid,p_preferences jsonb,p_reason text,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public,extensions as $$
declare u uuid:=auth.uid(); h text; old text; result jsonb; rid uuid; n integer; answers jsonb;
begin
 if u is null then raise exception 'Authentication required'; end if;
 if nullif(trim(p_mutation_id),'') is null or length(p_mutation_id)>160 then raise exception 'Mutation ID required (max 160)'; end if;
 if nullif(trim(p_reason),'') is null or length(p_reason)>1000 then raise exception 'Reason required (max 1000)'; end if;
 if p_preferences is null or jsonb_typeof(p_preferences)<>'object' or pg_column_size(p_preferences)>32768 or exists(select 1 from jsonb_object_keys(p_preferences) k where k not in ('annual_mileage_estimate','condition_answers')) then raise exception 'Invalid preferences'; end if;
 if p_preferences ? 'annual_mileage_estimate' and jsonb_typeof(p_preferences->'annual_mileage_estimate') not in ('number','null') then raise exception 'Invalid annual mileage estimate'; end if;
 answers:=coalesce(p_preferences->'condition_answers','{}');
 if jsonb_typeof(answers)<>'object' then raise exception 'Condition answers must be an object'; end if;
 if exists(select 1 from jsonb_each(answers) e where length(e.key)>200 or length(e.key)=0 or jsonb_typeof(e.value) not in ('boolean','number','string','null')) then raise exception 'Condition answers must be scalar facts or null'; end if;
 perform 1 from public.my_stuff_items where id=p_item_id and user_id=u for update;
 if not found then raise exception 'My Stuff item not found'; end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text||':owner-facts:'||trim(p_mutation_id),0));
 h:=encode(digest(jsonb_build_object('kind','owner_preferences','item',p_item_id,'preferences',p_preferences,'reason',p_reason)::text,'sha256'),'hex');
 select request_hash,m.result into old,result from public.my_stuff_v3_mutations m where user_id=u and mutation_id=trim(p_mutation_id);
 if found then if old<>h then raise exception 'Idempotency key reused with different request'; end if; return (result->>'revision_id')::uuid; end if;
 select coalesce(max(revision_number),0)+1 into n from public.my_stuff_owner_preference_revisions where item_id=p_item_id;
 insert into public.my_stuff_owner_preference_revisions(user_id,item_id,revision_number,annual_mileage_estimate,condition_answers,reason)
 values(u,p_item_id,n,(p_preferences->>'annual_mileage_estimate')::numeric,answers,trim(p_reason)) returning id into rid;
 insert into public.my_stuff_v3_mutations values(u,trim(p_mutation_id),'owner_preferences',h,jsonb_build_object('revision_id',rid),now());
 return rid;
end $$;

create function public.save_my_stuff_service_details_v1(p_occurrence_id uuid,p_details jsonb,p_reason text,p_mutation_id text) returns uuid
language plpgsql security definer set search_path=public,extensions as $$
declare u uuid:=auth.uid(); item uuid; h text; old text; result jsonb; rid uuid; n integer;
begin
 if u is null then raise exception 'Authentication required'; end if;
 if nullif(trim(p_mutation_id),'') is null or length(p_mutation_id)>180 then raise exception 'Mutation ID required (max 180)'; end if;
 if nullif(trim(p_reason),'') is null or length(p_reason)>1000 then raise exception 'Reason required (max 1000)'; end if;
 if p_details is null or jsonb_typeof(p_details)<>'object' or pg_column_size(p_details)>8192 then raise exception 'Invalid service details'; end if;
 if exists(select 1 from jsonb_each(p_details) e where e.key not in ('oil_specification','oil_viscosity','oil_product') or jsonb_typeof(e.value) not in ('string','null') or length(e.value#>>'{}')>1000) then raise exception 'Unsupported service detail'; end if;
 select item_id into item from public.my_stuff_service_occurrences where id=p_occurrence_id and user_id=u for update;
 if not found then raise exception 'Service occurrence not found'; end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text||':owner-facts:'||trim(p_mutation_id),0));
 h:=encode(digest(jsonb_build_object('kind','service_details','occurrence',p_occurrence_id,'details',p_details,'reason',p_reason)::text,'sha256'),'hex');
 select request_hash,m.result into old,result from public.my_stuff_v3_mutations m where user_id=u and mutation_id=trim(p_mutation_id);
 if found then if old<>h then raise exception 'Idempotency key reused with different request'; end if; return (result->>'revision_id')::uuid; end if;
 select coalesce(max(revision_number),0)+1 into n from public.my_stuff_service_detail_revisions where occurrence_id=p_occurrence_id;
 insert into public.my_stuff_service_detail_revisions(user_id,item_id,occurrence_id,revision_number,details,reason) values(u,item,p_occurrence_id,n,p_details,trim(p_reason)) returning id into rid;
 insert into public.my_stuff_v3_mutations values(u,trim(p_mutation_id),'service_details',h,jsonb_build_object('revision_id',rid),now());
 return rid;
end $$;

create function public.record_my_stuff_service_with_details_v1(p_item_id uuid,p_planned_occurrence_id uuid,p_definition_id uuid,p_service jsonb,p_expense jsonb,p_details jsonb,p_mutation_id text) returns jsonb
language plpgsql security definer set search_path=public,extensions as $$
declare r jsonb; d uuid; completed timestamptz;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if nullif(trim(p_mutation_id),'') is null or length(p_mutation_id)>140 then raise exception 'Mutation ID required (max 140)'; end if;
 -- The legacy writer defaults missing dates to now: never pass unknown dates.
 if nullif(p_service->>'completed_at','') is null then raise exception 'Confirm completion date; unknown historical dates are not supported'; end if;
 completed:=(p_service->>'completed_at')::timestamptz;
 if not isfinite(completed) or completed<'1900-01-01Z' or completed>now() then raise exception 'Completion date outside supported range'; end if;
 if exists(select 1 from jsonb_each(p_service) e where e.key in ('mileage','hours','cycles') and jsonb_typeof(e.value)='null') then raise exception 'Omit unknown service reading fields'; end if;
 r:=public.record_my_stuff_service_with_expense_v3(p_item_id,p_planned_occurrence_id,p_definition_id,p_service,p_expense,'details-service:'||trim(p_mutation_id));
 d:=public.save_my_stuff_service_details_v1((r->>'service_occurrence_id')::uuid,p_details,'Recorded service','details-facts:'||trim(p_mutation_id));
 return r||jsonb_build_object('details_revision_id',d);
end $$;
revoke all on function public.get_my_stuff_owner_preferences_v1(uuid),public.save_my_stuff_owner_preferences_v1(uuid,jsonb,text,text),public.save_my_stuff_service_details_v1(uuid,jsonb,text,text),public.record_my_stuff_service_with_details_v1(uuid,uuid,uuid,jsonb,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.get_my_stuff_owner_preferences_v1(uuid),public.save_my_stuff_owner_preferences_v1(uuid,jsonb,text,text),public.save_my_stuff_service_details_v1(uuid,jsonb,text,text),public.record_my_stuff_service_with_details_v1(uuid,uuid,uuid,jsonb,jsonb,jsonb,text) to authenticated;
commit;
