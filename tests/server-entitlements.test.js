import test from 'node:test'
import assert from 'node:assert/strict'
import { loadServerEntitlementState, resolveServerEntitlement } from '../api/_lib/entitlements.js'

const now = Date.parse('2026-08-06T00:00:00.000Z')
const verifiedAt = '2026-08-05T00:00:00+00:00'
const future = '2030-01-01T00:00:00+00:00'

function entitlement(source, status, overrides = {}) {
  return { source, status, expires_at: future, last_verified_at: verifiedAt, ...overrides }
}

function loaderClient({
  modeResult = { data: 'compatibility', error: null },
  profileResult = { data: { subscription_id: 'sub_legacy', subscription_status: 'active' }, error: null },
  entitlementResult = { data: [], error: null },
} = {}) {
  const query = result => {
    const chain = {
      select() { return chain },
      eq() { return chain },
      maybeSingle() { return Promise.resolve(result) },
      then(resolve, reject) { return Promise.resolve(result).then(resolve, reject) },
    }
    return chain
  }
  return {
    rpc: async () => modeResult,
    from(table) {
      if (table === 'profiles') return query(profileResult)
      if (table === 'user_entitlements') return query(entitlementResult)
      throw new Error(`Unexpected table: ${table}`)
    },
  }
}

test('normalized active and trialing Stripe entitlements grant Pro without trusting profile fields', () => {
  for (const status of ['active', 'trialing']) {
    const result = resolveServerEntitlement(
      { subscription_id: null, subscription_status: 'free' },
      [entitlement('stripe', status)],
      now,
    )
    assert.deepEqual(result, {
      plan: 'pro',
      entitlement: { source: 'stripe', status, expires_at: future },
    })
  }
})

test('legacy profile-only Stripe users retain compatibility access until verified cutover', () => {
  for (const subscription_status of ['active', 'trialing']) {
    const result = resolveServerEntitlement(
      { subscription_id: 'sub_legacy', subscription_status },
      [],
      now,
    )
    assert.equal(result.plan, 'pro')
    assert.equal(result.entitlement, null)
  }
})

test('canonical Stripe cutover disables profile compatibility and canonical terminal state always wins', () => {
  const profile = { subscription_id: 'sub_legacy', subscription_status: 'active' }
  assert.equal(resolveServerEntitlement(profile, [], now, { stripeCanonicalCutoverComplete: true }).plan, 'free')
  assert.equal(resolveServerEntitlement(profile, [entitlement('stripe', 'canceled')], now).plan, 'free')
  assert.equal(resolveServerEntitlement(profile, [entitlement('stripe', 'past_due')], now).plan, 'free')
})

test('Stripe expiry, cancellation, and revocation fail closed', () => {
  for (const row of [
    entitlement('stripe', 'active', { expires_at: '2020-01-01T00:00:00Z' }),
    entitlement('stripe', 'expired'),
    entitlement('stripe', 'canceled'),
    entitlement('stripe', 'revoked'),
  ]) {
    assert.equal(resolveServerEntitlement({}, [row], now).plan, 'free')
  }
})

test('Apple active and grace-period rows with verified future UTC expiration grant Pro', () => {
  for (const status of ['active', 'grace_period']) {
    const result = resolveServerEntitlement({}, [entitlement('apple', status)], now)
    assert.equal(result.plan, 'pro')
    assert.deepEqual(result.entitlement, { source: 'apple', status, expires_at: future })
  }
})

test('Apple expired and revoked rows fail closed', () => {
  for (const status of ['expired', 'revoked', 'refunded', 'canceled']) {
    assert.equal(resolveServerEntitlement({}, [entitlement('apple', status)], now).plan, 'free')
  }
})

test('malformed, non-UTC, infinite, and unverified timestamps fail closed', () => {
  for (const overrides of [
    { expires_at: '2030-01-01 00:00:00' },
    { expires_at: '2030-01-01T00:00:00-05:00' },
    { expires_at: '2030-02-30T00:00:00Z' },
    { expires_at: '2030-01-01T00:00:00.1234567Z' },
    { expires_at: 'infinity' },
    { expires_at: null },
    { last_verified_at: 'not-a-timestamp' },
    { last_verified_at: null },
  ]) {
    assert.equal(resolveServerEntitlement({}, [entitlement('apple', 'active', overrides)], now).plan, 'free')
  }
})

test('PostgREST UTC timestamps with up to six fractional digits are accepted', () => {
  for (const expires_at of [
    '2030-01-01T00:00:00Z',
    '2030-01-01T00:00:00.1Z',
    '2030-01-01T00:00:00.123456Z',
    '2030-01-01T00:00:00.123456+00:00',
  ]) {
    assert.equal(resolveServerEntitlement({}, [entitlement('apple', 'active', { expires_at })], now).plan, 'pro')
  }
})

test('loader rejects null and non-array entitlement table data instead of authorizing profile fallback', async () => {
  for (const data of [null, {}, 'rows', entitlement('stripe', 'active')]) {
    const state = await loadServerEntitlementState(loaderClient({ entitlementResult: { data, error: null } }), 'user-1', now)
    assert.deepEqual(state, { error: true })
  }
})

test('loader rejects malformed entitlement rows and fields', async () => {
  for (const row of [
    null,
    [],
    { source: 'stripe', status: 'active', expires_at: future },
    entitlement('unknown', 'active'),
    entitlement('stripe', 'unknown'),
    entitlement('stripe', 'active', { expires_at: 123 }),
    entitlement('stripe', 'active', { expires_at: 'not-a-timestamp' }),
    entitlement('stripe', 'active', { last_verified_at: null }),
    entitlement('stripe', 'active', { last_verified_at: 'not-a-timestamp' }),
  ]) {
    const state = await loadServerEntitlementState(loaderClient({ entitlementResult: { data: [row], error: null } }), 'user-1', now)
    assert.deepEqual(state, { error: true })
  }
})

test('loader rejects missing or malformed profile table data', async () => {
  for (const data of [
    null,
    [],
    {},
    { subscription_id: 'sub_legacy' },
    { subscription_id: 123, subscription_status: 'active' },
    { subscription_id: 'sub_legacy', subscription_status: true },
  ]) {
    const state = await loadServerEntitlementState(loaderClient({ profileResult: { data, error: null } }), 'user-1', now)
    assert.deepEqual(state, { error: true })
  }
})

test('loader requires complete successful PostgREST and RPC envelopes', async () => {
  for (const [field, malformed] of [
    ['modeResult', null],
    ['modeResult', { data: 'compatibility' }],
    ['modeResult', { error: null }],
    ['profileResult', null],
    ['profileResult', { data: { subscription_id: null, subscription_status: null } }],
    ['entitlementResult', null],
    ['entitlementResult', { data: [] }],
  ]) {
    const state = await loadServerEntitlementState(loaderClient({ [field]: malformed }), 'user-1', now)
    assert.deepEqual(state, { error: true }, `${field}: ${JSON.stringify(malformed)}`)
  }
})

test('loader grants only the exact compatibility profile fallback and denies it in canonical mode', async () => {
  for (const profile of [
    { subscription_id: '', subscription_status: 'active' },
    { subscription_id: 'sub_legacy', subscription_status: 'ACTIVE' },
    { subscription_id: 'sub_legacy', subscription_status: 'canceled' },
    { subscription_id: null, subscription_status: 'trialing' },
  ]) {
    const state = await loadServerEntitlementState(loaderClient({ profileResult: { data: profile, error: null } }), 'user-1', now)
    assert.equal(state.entitlement.plan, 'free')
  }

  const compatibility = await loadServerEntitlementState(loaderClient(), 'user-1', now)
  assert.deepEqual(compatibility, { entitlement: { plan: 'pro', entitlement: null } })

  const canonical = await loadServerEntitlementState(loaderClient({ modeResult: { data: 'canonical', error: null } }), 'user-1', now)
  assert.deepEqual(canonical, { entitlement: { plan: 'free', entitlement: null } })
})
