-- Replace the reduced My Stuff test entitlement fixture with the actual historical
-- freemium migration schema before privilege hardening is replayed.
drop function public.user_has_verified_pro_entitlement(uuid);
drop table public.user_entitlements;
