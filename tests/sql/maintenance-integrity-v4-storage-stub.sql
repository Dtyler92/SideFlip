-- Minimal local Supabase Storage catalog needed to execute the real private-media
-- migration. The application migration itself is never copied or rewritten.
create schema storage;
create table storage.buckets(
 id text primary key,name text not null unique,public boolean not null default false,
 file_size_limit bigint,allowed_mime_types text[]
);
create table storage.objects(
 id uuid primary key default gen_random_uuid(),bucket_id text not null references storage.buckets(id),
 name text not null,metadata jsonb,unique(bucket_id,name)
);
create function storage.foldername(name text) returns text[] language sql immutable
set search_path=pg_catalog as $$select string_to_array(name,'/')$$;
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select,insert,update,delete on storage.objects to authenticated;
revoke all on storage.buckets from public,anon,authenticated;
