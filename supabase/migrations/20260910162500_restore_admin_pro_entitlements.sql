-- Restore permanent and time-bounded owner/reviewer Pro grants through the
-- existing normalized admin entitlement source. Account-specific grants remain
-- separate Production data operations and are not embedded in this migration.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regclass('public.user_entitlements') is null
     or to_regprocedure('public.user_has_verified_pro_entitlement(uuid)') is null then
    raise exception 'Required entitlement objects are missing';
  end if;
end
$$;

create or replace function public.user_has_verified_pro_entitlement(p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.user_entitlements e
    where e.user_id = p_user_id
      and (
        (
          e.source = 'stripe'
          and e.status in ('active', 'trialing')
          and e.expires_at is not null
          and isfinite(e.expires_at)
          and e.expires_at > now()
        )
        or (
          e.source = 'apple'
          and e.status in ('active', 'grace_period')
          and e.expires_at is not null
          and isfinite(e.expires_at)
          and e.expires_at > now()
        )
        or (
          e.source = 'admin'
          and e.status = 'active'
          and (
            e.expires_at is null
            or (isfinite(e.expires_at) and e.expires_at > now())
          )
        )
      )
      and e.last_verified_at is not null
      and isfinite(e.last_verified_at)
      and e.last_verified_at <= now()
  )
$$;

revoke all on function public.user_has_verified_pro_entitlement(uuid) from public, anon, authenticated;

commit;
