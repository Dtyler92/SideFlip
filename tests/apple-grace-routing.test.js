import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { reconcileVerifiedAppleExpiration } from '../api/_lib/apple-entitlement-reconciliation.js'

const notificationSource = readFileSync(new URL('../api/apple-server-notifications.js', import.meta.url), 'utf8')

test('Apple notifications persist the validated effective expiration', () => {
  assert.match(notificationSource, /appleEffectiveExpiration/)
  assert.match(notificationSource, /p_expires_at:\s*new Date\(effectiveExpiresDate\)\.toISOString\(\)/)
  assert.doesNotMatch(notificationSource, /p_expires_at:\s*new Date\(transaction\.expiresDate\)/)
})

test('duplicate verified state repairs only its matching shorter Apple expiration', async () => {
  const calls = []
  const builder = {
    update(value) { calls.push(['update', value]); return this },
    eq(column, value) { calls.push(['eq', column, value]); return this },
    lt(column, value) { calls.push(['lt', column, value]); return this },
    async select(column) { calls.push(['select', column]); return { data: [{ id: 'row' }], error: null } },
  }
  const supabase = { from(table) { calls.push(['from', table]); return builder } }
  const repaired = await reconcileVerifiedAppleExpiration({
    supabase,
    userId: 'user-id',
    originalTransactionId: 'original-id',
    transactionId: 'transaction-id',
    status: 'grace_period',
    expiresAt: '2026-08-24T00:00:00.000Z',
    providerSignedAt: '2026-08-23T21:59:00.000Z',
    verifiedAt: '2026-08-23T22:00:00.000Z',
  })

  assert.equal(repaired, true)
  assert.deepEqual(calls, [
    ['from', 'user_entitlements'],
    ['update', { expires_at: '2026-08-24T00:00:00.000Z', last_verified_at: '2026-08-23T22:00:00.000Z' }],
    ['eq', 'source', 'apple'],
    ['eq', 'user_id', 'user-id'],
    ['eq', 'original_transaction_id', 'original-id'],
    ['eq', 'apple_latest_transaction_id', 'transaction-id'],
    ['eq', 'apple_latest_signed_at', '2026-08-23T21:59:00.000Z'],
    ['eq', 'status', 'grace_period'],
    ['lt', 'expires_at', '2026-08-24T00:00:00.000Z'],
    ['select', 'id'],
  ])
})

test('stale verification cannot reconcile over a newer Apple-signed state', async () => {
  const latestSignedAt = '2026-08-23T22:05:00.000Z'
  let requestedSignedAt = null
  const builder = {
    update() { return this },
    eq(column, value) { if (column === 'apple_latest_signed_at') requestedSignedAt = value; return this },
    lt() { return this },
    async select() { return { data: requestedSignedAt === latestSignedAt ? [{ id: 'row' }] : [], error: null } },
  }
  const repaired = await reconcileVerifiedAppleExpiration({
    supabase: { from() { return builder } },
    userId: 'user-id', originalTransactionId: 'original-id', transactionId: 'transaction-id',
    status: 'grace_period',
    expiresAt: '2026-08-24T00:00:00.000Z',
    providerSignedAt: '2026-08-23T21:59:00.000Z',
    verifiedAt: '2026-08-23T22:00:00.000Z',
  })
  assert.equal(repaired, false)
})

test('expiration reconciliation refuses non-access statuses without touching the database', async () => {
  let touched = false
  const supabase = { from() { touched = true } }
  const repaired = await reconcileVerifiedAppleExpiration({
    supabase,
    userId: 'user-id', originalTransactionId: 'original-id', transactionId: 'transaction-id',
    status: 'expired', expiresAt: '2026-08-24T00:00:00.000Z',
  })
  assert.equal(repaired, false)
  assert.equal(touched, false)
})
