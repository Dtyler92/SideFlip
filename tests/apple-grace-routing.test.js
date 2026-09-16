import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { reconcileVerifiedAppleExpiration } from '../api/_lib/apple-entitlement-reconciliation.js'

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('both Apple writers persist the shared normalized effective expiration', () => {
  const purchase = source('api/verify-apple-purchase.js')
  const notifications = source('api/apple-server-notifications.js')
  assert.match(source('api/_lib/apple-current-subscription.js'), /normalizeAppleSubscriptionState/)
  assert.match(notifications, /normalizeAppleSubscriptionState/)
  assert.match(purchase, /new Date\(current\.effectiveExpiresDate\)\.toISOString\(\)/)
  assert.match(notifications, /const expiresAt = new Date\(effectiveExpiresDate\)\.toISOString\(\)/)
  assert.match(notifications, /p_expires_at:\s*expiresAt/)
  assert.doesNotMatch(purchase, /p_expires_at:\s*new Date\(currentTransaction\.expiresDate\)/)
  assert.doesNotMatch(notifications, /p_expires_at:\s*new Date\(transaction\.expiresDate\)/)
})

test('duplicate verified Apple state uses authoritative reconciliation RPC', async () => {
  const calls = []
  const repaired = await reconcileVerifiedAppleExpiration({
    supabase: { async rpc(name, args) { calls.push([name, args]); return { data: true, error: null } } },
    userId: 'user-id', originalTransactionId: 'original-id', transactionId: 'transaction-id',
    status: 'grace_period', expiresAt: '2026-09-17T00:00:00.000Z',
    providerSignedAt: '2026-09-16T11:59:00.000Z', verifiedAt: '2026-09-16T12:00:00.000Z',
  })

  assert.equal(repaired, true)
  assert.deepEqual(calls, [[
    'reconcile_verified_apple_entitlement',
    {
      p_user_id: 'user-id',
      p_original_transaction_id: 'original-id',
      p_transaction_id: 'transaction-id',
      p_provider_signed_at: '2026-09-16T11:59:00.000Z',
      p_status: 'grace_period',
      p_expires_at: '2026-09-17T00:00:00.000Z',
      p_verified_at: '2026-09-16T12:00:00.000Z',
    },
  ]])
})

test('authoritative expiration reconciliation propagates RPC errors and false results', async () => {
  const input = {
    userId: 'user-id', originalTransactionId: 'original-id', transactionId: 'transaction-id',
    status: 'grace_period', expiresAt: '2026-09-17T00:00:00.000Z',
    providerSignedAt: '2026-09-16T11:59:00.000Z', verifiedAt: '2026-09-16T12:00:00.000Z',
  }
  assert.equal(await reconcileVerifiedAppleExpiration({
    ...input, supabase: { async rpc() { return { data: false, error: null } } },
  }), false)
  await assert.rejects(reconcileVerifiedAppleExpiration({
    ...input, supabase: { async rpc() { return { data: null, error: new Error('database unavailable') } } },
  }), /database unavailable/)
})

test('expiration reconciliation rejects terminal status without touching state', async () => {
  let touched = false
  const repaired = await reconcileVerifiedAppleExpiration({
    supabase: { rpc() { touched = true } },
    userId: 'user-id', originalTransactionId: 'original-id', transactionId: 'transaction-id',
    status: 'expired', expiresAt: '2026-09-17T00:00:00.000Z',
    providerSignedAt: '2026-09-16T11:59:00.000Z',
  })
  assert.equal(repaired, false)
  assert.equal(touched, false)
})

test('Apple repair path contains no direct entitlement table update', () => {
  assert.doesNotMatch(source('api/_lib/apple-entitlement-reconciliation.js'), /\.from\(['"]user_entitlements['"]\)/)
})
