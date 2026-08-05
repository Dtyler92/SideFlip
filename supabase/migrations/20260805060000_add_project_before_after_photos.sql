-- Add explicit before/after project photos without changing the legacy main photo.
-- REVIEW ONLY: do not apply without separate Supabase migration approval.

begin;

alter table public.projects
  add column if not exists before_photo text,
  add column if not exists after_photo text;

-- Existing main images become the initial before image. This is idempotent and
-- keeps `photo` populated for the submitted native build and older web clients.
update public.projects
  set before_photo = photo
  where before_photo is null
    and after_photo is null
    and photo is not null;

commit;
