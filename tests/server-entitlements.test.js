import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveServerEntitlement } from '../api/_lib/entitlements.js'

const now = Date.parse('2026-08-06T00:00:00.000Z')

test('server entitlement resolver grants Pro for a currently verified Apple entitlement', () => {
  const result = resolveServerEntitlement({}, [{
    source: 'apple', status: 'active', expires_at: '2030-01-01T00:00:00.000Z',
    last_verified_at: '2026-08-05T00:00:00.000Z',
  }], now)
  assert.equal(result.plan, 'pro')
  assert.equal(result.entitlement.source, 'apple')
})

test('server entitlement resolver preserves Pro for active legacy Stripe subscribers', () => {
  const result = resolveServerEntitlement({ subscription_id: 'sub_legacy', subscription_status: 'trialing' }, [], now)
  assert.equal(result.plan, 'pro')
})

test('server entitlement resolver rejects unverified, expired, and revoked Apple rows', () => {
  for (const entitlement of [
    { source: 'apple', status: 'active', expires_at: '2030-01-01T00:00:00.000Z', last_verified_at: null },
    { source: 'apple', status: 'active', expires_at: '2020-01-01T00:00:00.000Z', last_verified_at: '2026-08-05T00:00:00.000Z' },
    { source: 'apple', status: 'revoked', expires_at: '2030-01-01T00:00:00.000Z', last_verified_at: '2026-08-05T00:00:00.000Z' },
  ]) assert.equal(resolveServerEntitlement({}, [entitlement], now).plan, 'free')
})
