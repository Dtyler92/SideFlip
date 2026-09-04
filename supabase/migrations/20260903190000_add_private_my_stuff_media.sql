-- SideFlip My Stuff private media storage.
-- REVIEW ONLY: do not apply without separate Supabase migration approval.
-- Additive and independent of My Stuff attachment metadata and existing project photos.
--
-- Object names use the enforced, bounded shapes below. Both item-id and object-id are
-- UUIDs, so every object is record-scoped and arbitrary owner-prefix subtrees are denied:
--   <auth.uid()>/items/<item-id>/photos/<object-id>.<image-ext>
--   <auth.uid()>/items/<item-id>/before-after/<before|after>/<object-id>.<image-ext>
--   <auth.uid()>/items/<item-id>/<receipts|invoices|documents>/<object-id>.<allowed-ext>
-- Store the bucket ID and object name in future attachment metadata; never persist a
-- public URL. Read private objects through short-lived signed URLs created only after
-- authorization. The owner SELECT policy is compatible with Supabase createSignedUrl.

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'my-stuff-media',
  'my-stuff-media',
  false,
  15728640, -- 15 MiB per object
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- The full-name predicate is intentionally repeated in USING and WITH CHECK so Storage
-- API upload, upsert, copy, and move/rename paths cannot escape the bounded grammar.
drop policy if exists "my_stuff_media_owner_select" on storage.objects;
create policy "my_stuff_media_owner_select"
on storage.objects
for SELECT
to authenticated
using (
  bucket_id = 'my-stuff-media'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and exists (
    select 1
    from public.my_stuff_items
    where my_stuff_items.id::text = (storage.foldername(name))[3]
      and my_stuff_items.user_id = (select auth.uid())
  )
  and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/items/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(photos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)|before-after/(before|after)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)|(receipts|invoices|documents)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif|pdf|doc|docx))$'
);

drop policy if exists "my_stuff_media_owner_insert" on storage.objects;
create policy "my_stuff_media_owner_insert"
on storage.objects
for INSERT
to authenticated
with check (
  bucket_id = 'my-stuff-media'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and exists (
    select 1
    from public.my_stuff_items
    where my_stuff_items.id::text = (storage.foldername(name))[3]
      and my_stuff_items.user_id = (select auth.uid())
  )
  and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/items/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(photos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)|before-after/(before|after)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)|(receipts|invoices|documents)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif|pdf|doc|docx))$'
);

drop policy if exists "my_stuff_media_owner_update" on storage.objects;
create policy "my_stuff_media_owner_update"
on storage.objects
for UPDATE
to authenticated
using (
  bucket_id = 'my-stuff-media'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and exists (
    select 1
    from public.my_stuff_items
    where my_stuff_items.id::text = (storage.foldername(name))[3]
      and my_stuff_items.user_id = (select auth.uid())
  )
  and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/items/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(photos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)|before-after/(before|after)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)|(receipts|invoices|documents)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif|pdf|doc|docx))$'
)
with check (
  bucket_id = 'my-stuff-media'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and exists (
    select 1
    from public.my_stuff_items
    where my_stuff_items.id::text = (storage.foldername(name))[3]
      and my_stuff_items.user_id = (select auth.uid())
  )
  and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/items/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(photos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)|before-after/(before|after)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)|(receipts|invoices|documents)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif|pdf|doc|docx))$'
);

drop policy if exists "my_stuff_media_owner_delete" on storage.objects;
create policy "my_stuff_media_owner_delete"
on storage.objects
for DELETE
to authenticated
using (
  bucket_id = 'my-stuff-media'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and exists (
    select 1
    from public.my_stuff_items
    where my_stuff_items.id::text = (storage.foldername(name))[3]
      and my_stuff_items.user_id = (select auth.uid())
  )
  and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/items/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(photos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)|before-after/(before|after)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)|(receipts|invoices|documents)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif|pdf|doc|docx))$'
);

commit;
