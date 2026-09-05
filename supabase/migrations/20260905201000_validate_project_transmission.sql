begin;

-- Validate separately so the metadata-only ADD COLUMN / NOT VALID migration
-- does not hold its ACCESS EXCLUSIVE lock for the duration of this scan.
alter table public.projects validate constraint projects_transmission_length;

commit;
