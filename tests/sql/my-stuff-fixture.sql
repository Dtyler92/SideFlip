create schema auth;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to anon,authenticated,service_role;
grant execute on function auth.uid() to anon,authenticated,service_role;
create table auth.users(id uuid primary key);
grant select on auth.users to authenticated;
insert into auth.users(id) values
('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222'),
('33333333-3333-4333-8333-333333333333'),('44444444-4444-4444-8444-444444444444'),
('55555555-5555-4555-8555-555555555555'),('66666666-6666-4666-8666-666666666666'),
('77777777-7777-4777-8777-777777777777'),('88888888-8888-4888-8888-888888888888'),
('99999999-9999-4999-8999-999999999999'),('aaaaaaaa-0000-4000-8000-000000000000'),
('bbbbbbbb-0000-4000-8000-000000000000'),('cccccccc-0000-4000-8000-000000000000');

create table public.user_entitlements(
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 source text not null,status text not null,expires_at timestamptz,last_verified_at timestamptz
);
create function public.user_has_verified_pro_entitlement(p_user_id uuid) returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.user_entitlements e where e.user_id=p_user_id and e.source in('stripe','apple')
 and e.status in('active','grace_period') and e.last_verified_at is not null and e.expires_at>now())$$;
revoke all on function public.user_has_verified_pro_entitlement(uuid) from public,anon,authenticated;

-- Realistic historical project/expense/Trade-Up Goal chain used by transfer tests.
create table public.trade_up_goals(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 name text not null,goal_type text not null default 'amount',target_item text,target_amount numeric(14,2) not null default 0,
 description text,status text not null default 'active',client_mutation_id text,created_at timestamptz not null default now(),completed_at timestamptz
);
create table public.projects(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 title text not null,category text not null default 'other',status text not null default 'active',purchase_price numeric(14,2),
 sale_price numeric(14,2),sold_at timestamptz,photo text,before_photo text,after_photo text,notes text,
 model_number text,serial_number text,engine_model text,engine_serial text,vin text,hull_number text,
 vehicle_year text,vehicle_make text,vehicle_model text,goal_id uuid references public.trade_up_goals(id) on delete set null,
 goal_funding_amount numeric(14,2) not null default 0,out_of_pocket_amount numeric(14,2) not null default 0,
 trade_credit_amount numeric(14,2) not null default 0,traded_from_project_id uuid references public.projects(id) on delete set null,
 trade_up_mutation_id text,created_at timestamptz not null default now()
);
create table public.expenses(
 id uuid primary key default gen_random_uuid(),project_id uuid not null references public.projects(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,description text not null,amount numeric(14,2) not null,
 category text not null default 'other',labor_hours numeric(10,2),created_at timestamptz not null default now()
);
create table public.goal_ledger(
 id uuid primary key default gen_random_uuid(),goal_id uuid not null references public.trade_up_goals(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,project_id uuid references public.projects(id) on delete set null,
 type text not null,amount numeric(14,2) not null,note text,client_mutation_id text,created_at timestamptz not null default now()
);
grant select on public.projects,public.expenses,public.trade_up_goals,public.goal_ledger to authenticated;

-- Store stable catalog signatures before V1; V1 must not touch these domains.
create table public._my_stuff_legacy_object_snapshot(object_oid oid primary key,schema_name name not null,object_name name not null,signature jsonb not null);
insert into public._my_stuff_legacy_object_snapshot
select c.oid,n.nspname,c.relname,jsonb_build_object(
 'columns',(select jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'constraints',(select jsonb_agg(pg_get_constraintdef(x.oid,true) order by x.conname) from pg_constraint x where x.conrelid=c.oid),
 'indexes',(select jsonb_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid) from pg_index i where i.indrelid=c.oid),
 'triggers',(select jsonb_agg(pg_get_triggerdef(t.oid,true) order by t.tgname) from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal))
from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in('projects','expenses','trade_up_goals','goal_ledger');
