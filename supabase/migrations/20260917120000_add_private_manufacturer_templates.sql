-- LOCAL ONLY / UNAPPLIED. Reusable source templates, never owner schedules.
begin;

create table public.manufacturer_template_versions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  template_key text not null,
  version integer not null check (version > 0),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_document_id text not null,
  source_version text,
  schema_version text not null,
  applicability jsonb not null check (jsonb_typeof(applicability) = 'object'),
  status text not null check (status in ('needs_review','extraction_failed','reviewed')),
  record jsonb not null check (jsonb_typeof(record) = 'object'),
  created_at timestamptz not null default now(),
  unique (owner_id, template_key, version)
);
create index manufacturer_template_versions_lookup on public.manufacturer_template_versions
  (owner_id, source_document_id, source_sha256, source_version);
alter table public.manufacturer_template_versions enable row level security;
revoke all on public.manufacturer_template_versions from public, anon, authenticated, service_role;
grant select on public.manufacturer_template_versions to authenticated, service_role;
create policy manufacturer_template_owner_read on public.manufacturer_template_versions
  for select to authenticated using (owner_id = (select auth.uid()));

create function public.manufacturer_template_prevent_update() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'Manufacturer template versions are immutable; append a new version' using errcode='55000';
end $$;
revoke all on function public.manufacturer_template_prevent_update() from public,anon,authenticated,service_role;
create trigger manufacturer_template_immutable before update on public.manufacturer_template_versions
  for each row execute function public.manufacturer_template_prevent_update();

create function public.store_manufacturer_template_version(p_owner_id uuid, p_record jsonb)
returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_key text; v_version integer; v_existing public.manufacturer_template_versions%rowtype;
  v_id uuid; v_app jsonb; v_name text;
begin
  -- EXECUTE is granted only to the trusted backend. Browser ownership is never caller-supplied.
  if p_owner_id is null or not exists(select 1 from auth.users where id=p_owner_id) then
    raise exception 'Invalid template owner' using errcode='22023';
  end if;
  if p_record is null or jsonb_typeof(p_record) <> 'object' or octet_length(p_record::text)>2097152 then
    raise exception 'Invalid template record' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_object_keys(p_record) k where k not in
    ('template_key','version','source_sha256','source_document_id','source_version','source_url',
     'source_authenticity','source_authenticity_evidence','schema_version','validator_version',
     'applicability','applicability_reviewed','status','validation_report','payload')) then
    raise exception 'Unknown template metadata field' using errcode='22023';
  end if;
  foreach v_name in array array['template_key','source_document_id','schema_version','source_sha256','source_authenticity','status'] loop
    if jsonb_typeof(p_record->v_name) is distinct from 'string'
       or length(btrim(p_record->>v_name))=0 or length(p_record->>v_name)>512 then
      raise exception 'Missing or invalid template metadata: %', v_name using errcode='22023';
    end if;
  end loop;
  if (p_record->>'template_key') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     or (p_record->>'source_sha256') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_record->'version') is distinct from 'number'
     or (p_record->>'version') !~ '^[1-9][0-9]{0,8}$'
     or p_record->>'status' not in ('needs_review','extraction_failed','reviewed')
     or p_record->>'source_authenticity' not in ('user_uploaded_unverified','provider_citation_unconfirmed','publisher_verified') then
    raise exception 'Invalid source/version/status identity' using errcode='22023';
  end if;
  foreach v_name in array array['source_version','source_url','source_authenticity_evidence','validator_version'] loop
    if p_record ? v_name and p_record->v_name <> 'null'::jsonb and
       (jsonb_typeof(p_record->v_name)<>'string' or length(btrim(p_record->>v_name))=0 or length(p_record->>v_name)>4096) then
      raise exception 'Invalid optional metadata: %', v_name using errcode='22023';
    end if;
  end loop;
  if p_record->>'source_authenticity'='publisher_verified'
     and coalesce(length(btrim(p_record->>'source_authenticity_evidence')),0)=0 then
    raise exception 'Publisher verification requires independent evidence' using errcode='22023';
  end if;
  if jsonb_typeof(p_record->'payload') is distinct from 'object'
     or jsonb_typeof(p_record->'validation_report') is distinct from 'object'
     or jsonb_typeof(p_record->'applicability_reviewed') is distinct from 'boolean' then
    raise exception 'Payload and validation metadata required' using errcode='22023';
  end if;
  if (p_record->'payload') ?| array['owner_id','user_id','item_id','current_mileage','service_history','last_service','overdue'] then
    raise exception 'Template must not contain owner personalization' using errcode='22023';
  end if;
  v_app := p_record->'applicability';
  if jsonb_typeof(v_app) is distinct from 'object' then
    raise exception 'Applicability object required' using errcode='22023';
  end if;
  if not (v_app ?& array['year','make','model','engine','transmission','market'])
     or exists(select 1 from jsonb_object_keys(v_app) k where k not in ('year','make','model','engine','transmission','market')) then
    raise exception 'Applicability fields must be explicit; use null for unknown' using errcode='22023';
  end if;
  foreach v_name in array array['make','model','engine','transmission','market'] loop
    if v_app->v_name <> 'null'::jsonb and
       (jsonb_typeof(v_app->v_name)<>'string' or length(btrim(v_app->>v_name))=0 or length(v_app->>v_name)>256) then
      raise exception 'Invalid applicability field: %',v_name using errcode='22023';
    end if;
  end loop;
  if v_app->'year' <> 'null'::jsonb and
     (jsonb_typeof(v_app->'year')<>'number' or (v_app->>'year') !~ '^[0-9]{4}$') then
    raise exception 'Invalid applicability year' using errcode='22023';
  end if;
  -- Bind the v1 extraction envelope to its indexed metadata, never a different vehicle/source.
  if p_record->>'schema_version'='manufacturer-template-v1' and p_record->>'status'<>'extraction_failed' and (
       (p_record#>'{payload,schemaVersion}') is distinct from '1'::jsonb
       or (p_record#>'{payload,applicability}') is distinct from v_app
       or (p_record#>>'{payload,source,sha256}') is distinct from p_record->>'source_sha256'
       or (p_record#>>'{payload,source,id}') is distinct from p_record->>'source_document_id'
       or (p_record#>>'{payload,source,version}') is distinct from p_record->>'source_version') then
    raise exception 'Template payload source/schema/applicability identity mismatch' using errcode='22023';
  end if;
  if p_record->>'status'='reviewed' and (
       p_record->'applicability_reviewed' <> 'true'::jsonb
       or coalesce(length(btrim(p_record->>'validator_version')),0)=0
       or (p_record#>'{validation_report,passed}') is distinct from 'true'::jsonb
       or (p_record#>'{validation_report,source_support_checked}') is distinct from 'true'::jsonb
       or v_app->'year'='null'::jsonb or v_app->'make'='null'::jsonb or v_app->'model'='null'::jsonb) then
    raise exception 'Reviewed template requires validated source support and reviewed applicability' using errcode='22023';
  end if;
  v_key := p_record->>'template_key'; v_version := (p_record->>'version')::integer;
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || v_key, 0));
  select * into v_existing from public.manufacturer_template_versions
    where owner_id=p_owner_id and template_key=v_key and version=v_version;
  if found then
    if v_existing.record=p_record then return v_existing.id; end if;
    raise exception 'Template version identity conflicts with immutable record' using errcode='22023';
  end if;
  if v_version <> coalesce((select max(version) from public.manufacturer_template_versions
    where owner_id=p_owner_id and template_key=v_key),0)+1 then
    raise exception 'Append the next template version' using errcode='22023';
  end if;
  if exists(select 1 from public.manufacturer_template_versions where owner_id=p_owner_id
    and template_key=v_key and source_document_id<>p_record->>'source_document_id') then
    raise exception 'Template family source document identity changed' using errcode='22023';
  end if;
  insert into public.manufacturer_template_versions(owner_id,template_key,version,source_sha256,
    source_document_id,source_version,schema_version,applicability,status,record)
  values(p_owner_id,v_key,v_version,p_record->>'source_sha256',p_record->>'source_document_id',
    p_record->>'source_version',p_record->>'schema_version',v_app,p_record->>'status',p_record)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.store_manufacturer_template_version(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.store_manufacturer_template_version(uuid,jsonb) to service_role;

create function public.find_my_manufacturer_templates(p_applicability jsonb)
returns setof public.manufacturer_template_versions language sql stable security invoker
set search_path = pg_catalog, public as $$
  select t.* from public.manufacturer_template_versions t
  where auth.uid() is not null and t.owner_id=auth.uid() and t.status='reviewed'
    and jsonb_typeof(p_applicability)='object'
    and t.applicability->'year'=p_applicability->'year'
    and t.applicability->'make'=p_applicability->'make'
    and t.applicability->'model'=p_applicability->'model'
    -- A null source field is unspecified, not a guessed vehicle property.
    and not exists(select 1 from jsonb_each(t.applicability) a
      where a.value<>'null'::jsonb and a.value is distinct from p_applicability->a.key)
  order by t.template_key,t.version desc;
$$;
revoke all on function public.find_my_manufacturer_templates(jsonb) from public,anon,service_role;
grant execute on function public.find_my_manufacturer_templates(jsonb) to authenticated;
comment on table public.manufacturer_template_versions is
  'Private append-only reusable source templates. record.payload is schema-versioned, server-validated extraction, not owner maintenance. No automatic apply.';
commit;
