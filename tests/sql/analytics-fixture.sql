create schema auth;
create table auth.users (id uuid primary key);
create table public.profiles (
  id uuid primary key references auth.users(id),
  subscription_id text,
  stripe_customer_id text,
  subscription_status text,
  current_period_end timestamptz
);
insert into auth.users values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333');
insert into public.profiles(id) select id from auth.users;
