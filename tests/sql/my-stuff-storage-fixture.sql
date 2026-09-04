create schema auth;
create schema storage;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'storage_service_test') then
    create role storage_service_test nologin bypassrls;
  end if;
end;
$$;

create function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
  select case
    when strpos(name, '/') = 0 then array[]::text[]
    else string_to_array(regexp_replace(name, '/[^/]+$', ''), '/')
  end;
$$;

create table storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table storage.objects (
  id uuid primary key,
  bucket_id text not null references storage.buckets(id),
  name text not null,
  metadata jsonb not null default '{}'::jsonb,
  unique (bucket_id, name)
);

alter table storage.objects enable row level security;

-- Mirrors supabase/storage tenant migration 0055-prevent-direct-deletes.sql.
-- Storage API database sessions opt in to metadata deletion with this GUC only after
-- the service has authorized and removed the backing object.
create or replace function storage.protect_delete()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('storage.allow_delete_query', true), 'false') != 'true' then
    raise exception 'Direct deletion from storage tables is not allowed. Use the Storage API instead.'
      using hint = 'This prevents accidental data loss from orphaned objects.',
            errcode = '42501';
  end if;
  return null;
end;
$$;

create trigger protect_buckets_delete
  before delete on storage.buckets
  for each statement
  execute function storage.protect_delete();

create trigger protect_objects_delete
  before delete on storage.objects
  for each statement
  execute function storage.protect_delete();

grant usage on schema auth, storage to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant execute on function storage.foldername(text) to anon, authenticated;
grant select, insert, update, delete on storage.objects to anon, authenticated;
grant select on storage.buckets to anon, authenticated;
grant usage on schema storage to storage_service_test;
grant select, delete on storage.objects to storage_service_test;

create table public.my_stuff_items (
  id uuid primary key,
  user_id uuid not null
);

grant select on public.my_stuff_items to authenticated;

insert into public.my_stuff_items (id, user_id) values
  ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111'),
  ('55555555-5555-4555-8555-555555555555', '22222222-2222-4222-8222-222222222222');

insert into storage.buckets (id, name, public)
values ('other-private', 'other-private', false);
