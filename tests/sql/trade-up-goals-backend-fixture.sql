create schema auth;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
grant usage on schema auth to anon,authenticated,service_role;
grant execute on function auth.uid() to anon,authenticated,service_role;

create table auth.users(id uuid primary key);
insert into auth.users(id) values
('11111111-1111-4111-8111-111111111111'),
('22222222-2222-4222-8222-222222222222'),
('33333333-3333-4333-8333-333333333333'),
('44444444-4444-4444-8444-444444444444'),
('55555555-5555-4555-8555-555555555555'),
('66666666-6666-4666-8666-666666666666'),
('77777777-7777-4777-8777-777777777777'),
('88888888-8888-4888-8888-888888888888');

create table public.user_entitlements(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null,
  status text not null,
  expires_at timestamptz,
  last_verified_at timestamptz
);

create table public.projects(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  category text not null default 'other',
  status text not null default 'active',
  purchase_price numeric(14,2),
  sale_price numeric(14,2),
  sold_at timestamptz,
  photo text,
  before_photo text,
  after_photo text,
  notes text,
  model_number text,
  serial_number text,
  engine_model text,
  engine_serial text,
  vin text,
  hull_number text,
  vehicle_year integer,
  vehicle_make text,
  vehicle_model text,
  created_at timestamptz not null default now()
);
create table public.expenses(
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  description text not null,
  amount numeric(14,2) not null,
  category text not null default 'other',
  created_at timestamptz not null default now()
);

alter table public.projects enable row level security;
alter table public.expenses enable row level security;
create policy projects_owner_all on public.projects for all to authenticated
using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create policy expenses_owner_all on public.expenses for all to authenticated
using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
grant select,insert,update,delete on public.projects,public.expenses to authenticated;

-- Deliberately retained legacy corruption: the authoritative migration must be
-- installable without validating old rows, while preventing every new write.
insert into public.projects(id,user_id,title,category,status,purchase_price)
values('51000000-0000-4000-8000-000000000005','55555555-5555-4555-8555-555555555555','Legacy NaN project','other','active',0);
insert into public.expenses(id,project_id,user_id,description,amount)
values('52000000-0000-4000-8000-000000000005','51000000-0000-4000-8000-000000000005','55555555-5555-4555-8555-555555555555','Legacy NaN','NaN'::numeric);
