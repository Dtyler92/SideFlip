\set ON_ERROR_STOP on

create role anon;
create role authenticated;
create role service_role;

create table public.user_entitlements(
  user_id uuid not null,
  source text not null,
  status text not null,
  expires_at timestamptz,
  last_verified_at timestamptz not null
);

create function public.user_has_verified_pro_entitlement(uuid)
returns boolean language sql as $$ select false $$;
grant execute on function public.user_has_verified_pro_entitlement(uuid) to public;

\ir ../../supabase/migrations/20260910162500_restore_admin_pro_entitlements.sql

insert into public.user_entitlements(user_id,source,status,expires_at,last_verified_at) values
('00000000-0000-0000-0000-000000000001','admin','active',null,now()),
('00000000-0000-0000-0000-000000000002','admin','active',now()+interval '30 days',now()),
('00000000-0000-0000-0000-000000000003','admin','active',now()-interval '1 day',now()),
('00000000-0000-0000-0000-000000000004','admin','revoked',null,now()),
('00000000-0000-0000-0000-000000000005','stripe','active',now()+interval '30 days',now()),
('00000000-0000-0000-0000-000000000006','apple','grace_period',now()+interval '1 day',now()),
('00000000-0000-0000-0000-000000000007','admin','active',null,now()+interval '1 day');

do $$
begin
  if not public.user_has_verified_pro_entitlement('00000000-0000-0000-0000-000000000001') then raise exception 'permanent admin denied'; end if;
  if not public.user_has_verified_pro_entitlement('00000000-0000-0000-0000-000000000002') then raise exception 'bounded admin denied'; end if;
  if public.user_has_verified_pro_entitlement('00000000-0000-0000-0000-000000000003') then raise exception 'expired admin granted'; end if;
  if public.user_has_verified_pro_entitlement('00000000-0000-0000-0000-000000000004') then raise exception 'revoked admin granted'; end if;
  if not public.user_has_verified_pro_entitlement('00000000-0000-0000-0000-000000000005') then raise exception 'stripe regression'; end if;
  if not public.user_has_verified_pro_entitlement('00000000-0000-0000-0000-000000000006') then raise exception 'apple regression'; end if;
  if public.user_has_verified_pro_entitlement('00000000-0000-0000-0000-000000000007') then raise exception 'future verification granted'; end if;
end
$$;

set role authenticated;
do $$
begin
  perform public.user_has_verified_pro_entitlement('00000000-0000-0000-0000-000000000001');
  raise exception 'authenticated execution unexpectedly allowed';
exception when insufficient_privilege then null;
end
$$;
reset role;

select 'admin_entitlement_harness_passed' as result;
