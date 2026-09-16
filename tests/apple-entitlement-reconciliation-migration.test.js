import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const migrationUrl = new URL('../supabase/migrations/20260916170000_add_apple_entitlement_reconciliation.sql', import.meta.url)

function migrationSource() {
  assert.equal(existsSync(migrationUrl), true, 'add the review-only reconciliation migration')
  return readFileSync(migrationUrl, 'utf8')
}

test('Apple duplicate reconciliation is service-only, locked, fenced, and versioned', () => {
  const sql = migrationSource()
  assert.match(sql, /REVIEW ONLY/i)
  assert.match(sql, /create table public\.apple_entitlement_reconciliation_versions/i)
  assert.match(sql, /create function public\.reconcile_verified_apple_entitlement/i)
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(p_original_transaction_id,\s*0\)\)/i)
  assert.match(sql, /account_deletion_tombstones/i)
  assert.match(sql, /for update/i)
  assert.match(sql, /APPLE_TRANSACTION_ALREADY_BOUND/i)
  assert.match(sql, /insert into public\.apple_entitlement_reconciliation_versions/i)
  assert.match(sql, /update public\.apple_entitlement_events/i)
  assert.match(sql, /update public\.user_entitlements/i)
  assert.match(sql, /revoke all on function public\.reconcile_verified_apple_entitlement[^;]+from public, anon, authenticated/is)
  assert.match(sql, /grant execute on function public\.reconcile_verified_apple_entitlement[^;]+to service_role/is)
  assert.doesNotMatch(sql, /grant execute on function public\.reconcile_verified_apple_entitlement[^;]+to (?:anon|authenticated)/is)
})

test('reconciliation scopes repair to the exact latest nonterminal event', () => {
  const sql = migrationSource()
  assert.match(sql, /p_status not in \('active',\s*'grace_period'\)/i)
  assert.match(sql, /apple_latest_transaction_id\s*=\s*p_transaction_id/i)
  assert.match(sql, /apple_latest_signed_at\s*=\s*p_provider_signed_at/i)
  assert.match(sql, /status\s*=\s*p_status/i)
  assert.match(sql, /provider_signed_at\s*=\s*p_provider_signed_at/i)
  assert.match(sql, /get diagnostics v_updated_count = row_count/i)
})
