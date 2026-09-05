create table if not exists public.account_deletion_tombstones(user_id uuid primary key references auth.users(id) on delete cascade,status text not null default 'requested');
