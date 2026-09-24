import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sql = readFileSync(new URL('../supabase/migrations/20260910162500_restore_admin_pro_entitlements.sql', import.meta.url), 'utf8')

test('admin entitlement migration aligns permanent and expiring server-side Pro access', () => {
  assert.match(sql, /create or replace function public\.user_has_verified_pro_entitlement\(p_user_id uuid\)/i)
  assert.match(sql, /e\.source = 'admin'/i)
  assert.match(sql, /e\.status = 'active'/i)
  assert.match(sql, /e\.expires_at is null\s+or \(isfinite\(e\.expires_at\) and e\.expires_at > now\(\)\)/i)
  assert.match(sql, /e\.last_verified_at is not null\s+and isfinite\(e\.last_verified_at\)\s+and e\.last_verified_at <= now\(\)/i)
  assert.match(sql, /revoke all on function public\.user_has_verified_pro_entitlement\(uuid\) from public, anon, authenticated/i)
  assert.doesNotMatch(sql, /insert\s+into\s+public\.user_entitlements/i)
})