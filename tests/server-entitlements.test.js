import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveServerEntitlement } from '../api/_lib/entitlements.js'

const entitlementEndpointSource = readFileSync(new URL('../api/entitlement.js', import.meta.url), 'utf8')

const now = Date.parse('2026-08-06T00:00:00.000Z')

test('authenticated entitlement responses are private, non-cacheable, and uniquely resolved', () => {
  assert.match(entitlementEndpointSource, /Cache-Control', 'private, no-store, no-cache, max-age=0, must-revalidate'/)
  assert.match(entitlementEndpointSource, /CDN-Cache-Control', 'no-store'/)
  assert.match(entitlementEndpointSource, /Vary', 'Authorization'/)
  assert.match(entitlementEndpointSource, /resolved_at: new Date\(\)\.toISOString\(\)/)
})

test('server entitlement resolver grants Pro for a currently verified Apple entitlement', () => {
  const result = resolveServerEntitlement({}, [{
    source: 'apple', status: 'active', expires_at: '2030-01-01T00:00:00.000Z',
    last_verified_at: '2026-08-05T00:00:00.000Z',
  }], now)
  assert.equal(result.plan, 'pro')
  assert.equal(result.entitlement.source, 'apple')
})

test('server entitlement resolver accepts Supabase PostgreSQL UTC timestamptz serialization', () => {
  for (const expires_at of [
    '2026-08-07T00:00:00+00:00',
    '2026-08-07T00:00:00.123456+00:00',
    '2026-08-07T00:00:00Z',
  ]) {
    const result = resolveServerEntitlement({}, [{
      source: 'apple', status: 'active', expires_at,
      last_verified_at: '2026-08-05T00:00:00+00:00',
    }], now)
    assert.equal(result.plan, 'pro')
  }
})

test('server entitlement resolver grants Pro during a verified Apple billing grace period', () => {
  const result = resolveServerEntitlement({}, [{
    source: 'apple', status: 'grace_period', expires_at: '2026-08-07T00:00:00.000Z',
    last_verified_at: '2026-08-05T00:00:00.000Z',
  }], now)
  assert.equal(result.plan, 'pro')
  assert.equal(result.entitlement.status, 'grace_period')
})

test('server entitlement resolver preserves Pro for active legacy Stripe subscribers', () => {
  const result = resolveServerEntitlement({ subscription_id: 'sub_legacy', subscription_status: 'trialing' }, [], now)
  assert.equal(result.plan, 'pro')
})

test('server entitlement resolver rejects unverified, expired, and revoked Apple rows', () => {
  for (const entitlement of [
    { source: 'apple', status: 'active', expires_at: '2030-01-01T00:00:00.000Z', last_verified_at: null },
    { source: 'apple', status: 'active', expires_at: '2020-01-01T00:00:00.000Z', last_verified_at: '2026-08-05T00:00:00.000Z' },
    { source: 'apple', status: 'grace_period', expires_at: '2020-01-01T00:00:00.000Z', last_verified_at: '2026-08-05T00:00:00.000Z' },
    { source: 'apple', status: 'revoked', expires_at: '2030-01-01T00:00:00.000Z', last_verified_at: '2026-08-05T00:00:00.000Z' },
    { source: 'apple', status: 'active', expires_at: '2030-01-01T00:00:00-04:00', last_verified_at: '2026-08-05T00:00:00.000Z' },
    { source: 'apple', status: 'active', expires_at: '2030-01-01T00:00:00.1234567+00:00', last_verified_at: '2026-08-05T00:00:00.000Z' },
    { source: 'apple', status: 'active', expires_at: '2030-01-01T00:00:00', last_verified_at: '2026-08-05T00:00:00.000Z' },
  ]) assert.equal(resolveServerEntitlement({}, [entitlement], now).plan, 'free')
})
