-- Enforce SideFlip Free/Pro project photo quotas across every project photo field.
-- Depends on 20260807210000_enforce_freemium_goal_limit.sql for verified entitlement truth.

begin;

create or replace function public.enforce_project_photo_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
  v_count integer;
begin
  if tg_op = 'UPDATE'
     and new.user_id is not distinct from old.user_id
     and new.photos is not distinct from old.photos
     and new.photo is not distinct from old.photo
     and new.before_photo is not distinct from old.before_photo
     and new.after_photo is not distinct from old.after_photo then
    return new;
  end if;

  if new.user_id is null then
    raise exception 'Project owner is required';
  end if;

  v_limit := case
    when public.user_has_verified_pro_entitlement(new.user_id) then 25
    else 5
  end;

  select count(distinct trim(photo_url))
    into v_count
    from unnest(
      coalesce(new.photos, array[]::text[])
      || array_remove(array[new.photo, new.before_photo, new.after_photo]::text[], null)
    ) as photo_url
   where nullif(trim(photo_url), '') is not null;

  if v_count > v_limit then
    raise exception 'Project photo limit exceeded. This account allows % total photos per project.', v_limit;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_project_photo_quota() from public;
revoke all on function public.enforce_project_photo_quota() from anon;
revoke all on function public.enforce_project_photo_quota() from authenticated;

drop trigger if exists projects_photo_quota on public.projects;
create trigger projects_photo_quota
before insert or update of photos, photo, before_photo, after_photo, user_id
on public.projects
for each row execute function public.enforce_project_photo_quota();

commit;
