-- Helper consumed by the historical My Stuff migration stack. Its source table
-- was created by the real 20260806190000 freemium migration.
create function public.user_has_verified_pro_entitlement(p_user_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.user_entitlements e where e.user_id=p_user_id and e.source in('stripe','apple')
 and e.status in('active','grace_period') and e.last_verified_at is not null and e.expires_at>now())
$$;
revoke all on function public.user_has_verified_pro_entitlement(uuid) from public,anon,authenticated;
