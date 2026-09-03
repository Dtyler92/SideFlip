\set ON_ERROR_STOP on

create function public._storage_test_assert(ok boolean, message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(ok, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;

select public._storage_test_assert(
  (select not public and file_size_limit = 15728640
     and cardinality(allowed_mime_types) = 8
     and allowed_mime_types @> array[
       'image/jpeg',
       'image/png',
       'image/webp',
       'image/heic',
       'image/heif',
       'application/pdf',
       'application/msword',
       'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
     ]::text[]
   from storage.buckets where id = 'my-stuff-media'),
  'private bucket has the exact bounded declared-type contract'
);

select public._storage_test_assert(
  (select count(*) = 4
   from pg_policies
   where schemaname = 'storage'
     and tablename = 'objects'
     and policyname in (
       'my_stuff_media_owner_select',
       'my_stuff_media_owner_insert',
       'my_stuff_media_owner_update',
       'my_stuff_media_owner_delete'
     )
     and roles = array['authenticated']::name[]),
  'all four policies are authenticated-only after double application'
);

select public._storage_test_assert(
  (select count(*) = 4
   from pg_policies
   where schemaname = 'storage'
     and tablename = 'objects'
     and concat(coalesce(qual, ''), coalesce(with_check, '')) like '%foldername(name)%'
     and concat(coalesce(qual, ''), coalesce(with_check, '')) like '%auth.uid()%'
     and concat(coalesce(qual, ''), coalesce(with_check, '')) like '%/items/%'
     and concat(coalesce(qual, ''), coalesce(with_check, '')) like '%before-after%'
     and concat(coalesce(qual, ''), coalesce(with_check, '')) like '%name ~%'),
  'every policy enforces owner and bounded item/object path grammar'
);

select public._storage_test_assert(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'storage.objects'::regclass
      and tgname = 'protect_objects_delete'
      and not tgisinternal
  ) and pg_get_functiondef('storage.protect_delete()'::regprocedure)
        like '%storage.allow_delete_query%',
  'fixture mirrors current Supabase protect_delete trigger and GUC'
);

-- Seed a cross-owner object as the database owner, as the Storage service would have.
insert into storage.objects(id, bucket_id, name) values
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'my-stuff-media',
    '22222222-2222-4222-8222-222222222222/items/55555555-5555-4555-8555-555555555555/photos/66666666-6666-4666-8666-666666666666.jpg'
  );

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);

insert into storage.objects(id, bucket_id, name) values
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    'my-stuff-media',
    '11111111-1111-4111-8111-111111111111/items/33333333-3333-4333-8333-333333333333/receipts/44444444-4444-4444-8444-444444444444.pdf'
  );

select public._storage_test_assert(
  (select count(*) = 1 from storage.objects),
  'owner SELECT sees only its own prefix'
);

-- Storage API upsert uses INSERT ... ON CONFLICT DO UPDATE and needs INSERT/UPDATE.
insert into storage.objects(id, bucket_id, name, metadata) values
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    'my-stuff-media',
    '11111111-1111-4111-8111-111111111111/items/33333333-3333-4333-8333-333333333333/receipts/44444444-4444-4444-8444-444444444444.pdf',
    '{"upserted":true}'::jsonb
  )
on conflict (bucket_id, name) do update set metadata = excluded.metadata;
select public._storage_test_assert(
  (select metadata = '{"upserted":true}'::jsonb
   from storage.objects
   where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'),
  'owner same-path upsert succeeds'
);

-- Storage API copy requires SELECT on the source and INSERT on the destination.
insert into storage.objects(id, bucket_id, name, metadata)
select
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
  bucket_id,
  '11111111-1111-4111-8111-111111111111/items/33333333-3333-4333-8333-333333333333/documents/77777777-7777-4777-8777-777777777777.docx',
  metadata
from storage.objects
where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
select public._storage_test_assert(
  (select count(*) = 2 from storage.objects),
  'same-owner copy succeeds'
);

-- A same-owner, same-bucket move/rename must satisfy both UPDATE predicates.
update storage.objects
set name = '11111111-1111-4111-8111-111111111111/items/33333333-3333-4333-8333-333333333333/documents/88888888-8888-4888-8888-888888888888.docx'
where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
select public._storage_test_assert(
  exists (
    select 1 from storage.objects
    where name like '%/documents/88888888-8888-4888-8888-888888888888.docx'
  ),
  'same-owner same-prefix rename succeeds'
);

-- Current Supabase protects direct table deletes to avoid orphaning backing objects.
do $$
begin
  begin
    delete from storage.objects where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
    raise exception 'direct storage.objects DELETE unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
select public._storage_test_assert(
  exists (select 1 from storage.objects where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'),
  'protect_delete blocks direct deletion when Storage API GUC is absent'
);

-- Model only the Storage API database session after it has authorized/backing-store work.
-- This enables metadata DELETE so the remaining assertions exercise RLS, not the guard.
select set_config('storage.allow_delete_query', 'true', false);

do $$
begin
  begin
    insert into storage.objects(id, bucket_id, name) values
      (
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
        'my-stuff-media',
        '22222222-2222-4222-8222-222222222222/items/55555555-5555-4555-8555-555555555555/documents/99999999-9999-4999-8999-999999999999.pdf'
      );
    raise exception 'cross-owner INSERT unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into storage.objects(id, bucket_id, name, metadata) values
      (
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6',
        'my-stuff-media',
        '22222222-2222-4222-8222-222222222222/items/55555555-5555-4555-8555-555555555555/photos/66666666-6666-4666-8666-666666666666.jpg',
        '{"tampered":true}'::jsonb
      )
    on conflict (bucket_id, name) do update set metadata = excluded.metadata;
    raise exception 'cross-owner UPSERT unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into storage.objects(id, bucket_id, name, metadata)
    select
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12',
      bucket_id,
      '22222222-2222-4222-8222-222222222222/items/55555555-5555-4555-8555-555555555555/documents/14141414-1414-4414-8414-141414141414.pdf',
      metadata
    from storage.objects
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
    raise exception 'cross-owner copy destination unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update storage.objects
    set name = '22222222-2222-4222-8222-222222222222/items/55555555-5555-4555-8555-555555555555/photos/99999999-9999-4999-8999-999999999999.jpg'
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
    raise exception 'cross-owner rename unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update storage.objects
    set bucket_id = 'other-private'
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
    raise exception 'cross-bucket move unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into storage.objects(id, bucket_id, name, metadata)
    select
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7',
      'other-private',
      '11111111-1111-4111-8111-111111111111/items/33333333-3333-4333-8333-333333333333/photos/99999999-9999-4999-8999-999999999999.jpg',
      metadata
    from storage.objects
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
    raise exception 'cross-bucket copy unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into storage.objects(id, bucket_id, name) values
      (
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8',
        'my-stuff-media',
        '11111111-1111-4111-8111-111111111111/items/not-a-uuid/photos/99999999-9999-4999-8999-999999999999.jpg'
      );
    raise exception 'unbounded non-UUID item path unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into storage.objects(id, bucket_id, name) values
      (
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9',
        'my-stuff-media',
        '11111111-1111-4111-8111-111111111111/arbitrary/nested/path/file.exe'
      );
    raise exception 'arbitrary owner-prefix path unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;

do $$
declare
  affected integer;
begin
  insert into storage.objects(id, bucket_id, name, metadata)
  select
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10',
    bucket_id,
    '11111111-1111-4111-8111-111111111111/items/33333333-3333-4333-8333-333333333333/photos/12121212-1212-4212-8212-121212121212.jpg',
    metadata
  from storage.objects
  where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  get diagnostics affected = row_count;
  perform public._storage_test_assert(affected = 0, 'cross-owner source cannot be copied');

  update storage.objects set metadata = '{"tampered":true}'::jsonb
  where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  get diagnostics affected = row_count;
  perform public._storage_test_assert(affected = 0, 'cross-owner UPDATE sees no row');

  delete from storage.objects
  where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  get diagnostics affected = row_count;
  perform public._storage_test_assert(affected = 0, 'Storage API-authorized cross-owner DELETE sees no row');
end;
$$;

reset role;
set role anon;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);

select public._storage_test_assert(
  (select count(*) = 0 from storage.objects),
  'anonymous callers receive no rows even with a forged claim setting'
);

do $$
declare
  affected integer;
begin
  begin
    insert into storage.objects(id, bucket_id, name) values
      (
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11',
        'my-stuff-media',
        '11111111-1111-4111-8111-111111111111/items/33333333-3333-4333-8333-333333333333/photos/13131313-1313-4313-8313-131313131313.jpg'
      );
    raise exception 'anonymous INSERT unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  update storage.objects set metadata = '{"anonymous":true}'::jsonb;
  get diagnostics affected = row_count;
  perform public._storage_test_assert(affected = 0, 'anonymous UPDATE affects no rows');

  delete from storage.objects;
  get diagnostics affected = row_count;
  perform public._storage_test_assert(affected = 0, 'anonymous Storage API DELETE affects no rows');
end;
$$;

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select set_config('storage.allow_delete_query', 'true', false);
delete from storage.objects;
select public._storage_test_assert(
  (select count(*) = 0 from storage.objects),
  'owner Storage API-authorized DELETE removes all visible owned objects'
);

reset role;
select public._storage_test_assert(
  (select count(*) = 1 from storage.objects),
  'cross-owner sentinel was not changed, copied, moved, or deleted'
);
select public._storage_test_assert(
  (select metadata = '{}'::jsonb
   from storage.objects
   where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),
  'cross-owner upsert did not alter sentinel metadata'
);
