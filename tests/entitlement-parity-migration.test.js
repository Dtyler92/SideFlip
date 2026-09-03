import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const migrationUrl = new URL('../supabase/migrations/20260904120000_normalize_stripe_entitlement_authority.sql', import.meta.url)
const source = relativePath => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')

function migrationSource() {
  assert.equal(existsSync(migrationUrl), true, 'add one future-dated review-only migration')
  return readFileSync(migrationUrl, 'utf8')
}

test('review-only migration atomically normalizes both installed Stripe RPC signatures', () => {
  const sql = migrationSource()
  assert.match(sql, /REVIEW ONLY/i)
  assert.match(sql, /begin\s*;/i)
  assert.match(sql, /commit\s*;/i)
  assert.match(sql, /create or replace function public\.apply_stripe_subscription_event\(\s*p_event_id text,\s*p_event_type text,\s*p_provider_created_at timestamptz,\s*p_user_id uuid,\s*p_subscription_id text,\s*p_customer_id text,\s*p_status text,\s*p_current_period_end timestamptz\s*\)/is)
  assert.match(sql, /create or replace function public\.apply_stripe_subscription_event_v2\(\s*p_event_id text,\s*p_event_type text,\s*p_provider_created_at timestamptz,\s*p_user_id uuid,\s*p_subscription_id text,\s*p_customer_id text,\s*p_status text,\s*p_current_period_end timestamptz,\s*p_cancel_at_period_end boolean,\s*p_cancellation_just_scheduled boolean,\s*p_was_trial boolean,\s*p_churn_type text,\s*p_plan text,\s*p_billing_interval text\s*\)/is)
  assert.ok((sql.match(/insert into public\.user_entitlements/gi) || []).length >= 1)
  assert.match(sql, /p_status in \('active','trialing'\)/i)
  assert.match(sql, /on conflict\s*\(source,\s*provider_subscription_id\)/i)
})

test('migration aligns the SQL resolver and fails closed on terminal or non-finite state', () => {
  const sql = migrationSource()
  assert.match(sql, /create or replace function public\.user_has_verified_pro_entitlement\(p_user_id uuid\)/i)
  assert.match(sql, /e\.source = 'stripe' and e\.status in \('active', 'trialing'\)/i)
  assert.match(sql, /e\.source = 'apple' and e\.status in \('active', 'grace_period'\)/i)
  assert.match(sql, /isfinite\(e\.expires_at\)/i)
  assert.match(sql, /isfinite\(e\.last_verified_at\)/i)
})

test('server entitlement consumers retain explicitly gated profile compatibility until cutover', () => {
  for (const path of ['api/entitlement.js', 'api/generate-listing.js']) {
    assert.match(source(path), /from\(['"]profiles['"]\)/)
    assert.match(source(path), /from\(['"]user_entitlements['"]\)/)
    assert.match(source(path), /stripe_entitlement_read_mode/)
  }
})

test('migration fences tombstones, avoids profile backfill, and hardens authority objects', () => {
  const sql = migrationSource()
  assert.match(sql, /account_deletion_tombstones/i)
  assert.doesNotMatch(sql, /insert into public\.user_entitlements[\s\S]{0,500}select[\s\S]{0,200}from public\.profiles/i)
  assert.match(sql, /enable row level security/i)
  assert.match(sql, /revoke all on table public\.user_entitlements from public, anon, authenticated/i)
  assert.match(sql, /revoke all on function public\.apply_stripe_subscription_event\([^)]+\) from public, anon, authenticated/is)
  assert.match(sql, /revoke all on function public\.apply_stripe_subscription_event_v2\([^)]+\) from public, anon, authenticated/is)
  assert.match(sql, /grant execute on function public\.apply_stripe_subscription_event\([^)]+\) to service_role/is)
  assert.match(sql, /grant execute on function public\.apply_stripe_subscription_event_v2\([^)]+\) to service_role/is)
  assert.ok((sql.match(/security definer(?:\s+set search_path = pg_catalog, public|[\s\S]{0,40}set search_path = pg_catalog, public)/gi) || []).length >= 3)
  assert.doesNotMatch(sql, /grant\s+(select|insert|update|delete|execute)[^;]+to\s+(anon|authenticated)/i)
  assert.doesNotMatch(sql, /from\s+public\.profiles[\s\S]{0,200}insert into public\.user_entitlements/i)
})

test('provider ordering and ownership use service-only canonical state, not profiles', () => {
  const sql = migrationSource()
  assert.match(sql, /create table public\.stripe_subscription_ownership/i)
  assert.match(sql, /create table public\.stripe_subscription_state/i)
  assert.ok((sql.match(/revoke all on table public\.stripe_subscription_(?:ownership|state) from public, anon, authenticated/gi) || []).length >= 2)
  assert.match(sql, /create trigger profiles_protect_stripe_provider_columns/i)
  assert.match(sql, /subscription_status is distinct from old\.subscription_status/i)
  assert.match(sql, /public\.stripe_event_precedence\(p_event_type,\s*p_status\)/i)
})

test('migration exposes an explicit service-only verified reconciliation and cutover contract', () => {
  const sql = migrationSource()
  assert.match(sql, /create (?:or replace )?function public\.reconcile_verified_stripe_subscription/i)
  assert.match(sql, /p_provider_verified boolean/i)
  assert.match(sql, /create table public\.stripe_entitlement_rollout_state/i)
  assert.match(sql, /stripe_entitlement_read_mode/i)
  assert.match(sql, /grant execute on function public\.reconcile_verified_stripe_subscription[^;]+to service_role/is)
  assert.doesNotMatch(sql, /grant execute on function public\.reconcile_verified_stripe_subscription[^;]+to (?:anon|authenticated)/is)
})

test('trusted Stripe inputs are validated before event consumption', () => {
  const sql = migrationSource()
  assert.match(sql, /p_event_type not in \('customer\.subscription\.created','customer\.subscription\.updated','customer\.subscription\.deleted'\)/i)
  assert.match(sql, /p_status not in \('active','trialing','past_due','unpaid','canceled','incomplete','incomplete_expired','paused'\)/i)
  assert.match(sql, /not isfinite\(p_current_period_end\)/i)
  assert.match(sql, /nullif\(btrim\(p_event_id\), ''\)/i)
  assert.match(sql, /nullif\(btrim\(p_customer_id\), ''\)/i)
})
