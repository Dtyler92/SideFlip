-- Harden the `profiles` table so signed-in clients cannot grant themselves
-- paid access. Subscription state (subscription_status, subscription_id,
-- stripe_customer_id, current_period_end, …) is authoritative billing data and
-- must only ever be written by the Stripe webhook, which uses the service-role
-- key and therefore bypasses these grants and RLS entirely.
--
-- The app decides access client-side from these columns (see billing.js /
-- App.jsx), and the browser uses the anon key with a permissive own-row UPDATE
-- policy (Settings.jsx writes `currency` directly). Without a column-level
-- restriction, any authenticated user could:
--   supabase.from('profiles')
--     .update({ subscription_status: 'active', subscription_id: 'x' })
--     .eq('id', auth.uid())
-- and unlock the entire paid app for free.
--
-- RLS policies gate *rows*, not *columns*. Column privileges are the correct
-- tool here: revoke blanket UPDATE from the client roles and grant UPDATE on
-- only the user-editable columns. Row scoping (auth.uid() = id) continues to be
-- enforced by the existing own-row UPDATE policy.

begin;

alter table public.profiles enable row level security;

-- Remove any blanket UPDATE privilege the client roles may hold, then grant
-- back only the columns a user is allowed to change themselves.
revoke update on public.profiles from authenticated, anon;
grant update (currency) on public.profiles to authenticated;

-- Clients must never INSERT/DELETE profile rows either; the service role and
-- the auth trigger own row lifecycle.
revoke insert, delete on public.profiles from authenticated, anon;

-- Guarantee an own-row UPDATE policy exists so the column-scoped currency
-- write keeps working. Creating it idempotently is safe: multiple permissive
-- policies simply OR together, and the column grant above is what actually
-- blocks writes to billing columns regardless of any policy.
drop policy if exists "Users update own profile currency" on public.profiles;
create policy "Users update own profile currency" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

commit;
