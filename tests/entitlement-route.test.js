import test from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL ||= 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= ['synthetic', 'service', 'key'].join('-')

const { createEntitlementHandler } = await import('../api/entitlement.js')

function query(result) {
  const chain = {
    select() { return chain },
    eq() { return chain },
    maybeSingle() { return Promise.resolve(result) },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject) },
  }
  return chain
}

function clientFor({ stripeMode = 'compatibility', stripeModeError = null, entitlements = [], tombstone = null, tombstoneError = null, onRead = () => {} } = {}) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    rpc(name) {
      assert.equal(name, 'stripe_entitlement_read_mode')
      return Promise.resolve({ data: stripeMode, error: stripeModeError })
    },
    from(table) {
      onRead(table)
      if (table === 'account_deletion_tombstones') return query({ data: tombstone, error: tombstoneError })
      if (table === 'profiles') return query({ data: { subscription_id: 'sub_synthetic', subscription_status: 'active' }, error: null })
      if (table === 'user_entitlements') return query({ data: entitlements, error: null })
      throw new Error(`Unexpected table: ${table}`)
    },
  }
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    end() { return this },
  }
}

function request() {
  return { method: 'GET', headers: { authorization: 'Bearer synthetic-token' } }
}

test('entitlement route fails closed when canonical read mode is unavailable or invalid', async () => {
  for (const [label, stripeMode, stripeModeError] of [
    ['rpc error', null, { message: 'synthetic mode failure' }],
    ['missing row', null, null],
    ['invalid mode', 'legacy', null],
  ]) {
    const res = responseRecorder()
    await createEntitlementHandler({ client: clientFor({ stripeMode, stripeModeError }) })(request(), res)
    assert.equal(res.statusCode, 503, label)
    assert.deepEqual(res.body, { error: 'Could not resolve your plan.' }, label)
  }
})

test('entitlement route preserves compatibility mode legacy profile Pro fallback', async () => {
  const res = responseRecorder()
  await createEntitlementHandler({ client: clientFor() })(request(), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { plan: 'pro', entitlement: null })
})

test('entitlement route checks deletion tombstone before entitlement reads and fails closed on lookup errors', async () => {
  for (const [label, options, expectedStatus] of [
    ['tombstoned', { tombstone: { status: 'processing' } }, 410],
    ['lookup error', { tombstoneError: { message: 'synthetic lookup failure' } }, 503],
  ]) {
    const reads = []
    const res = responseRecorder()
    await createEntitlementHandler({ client: clientFor({ ...options, onRead: table => reads.push(table) }) })(request(), res)
    assert.equal(res.statusCode, expectedStatus, label)
    assert.deepEqual(reads, ['account_deletion_tombstones'], label)
  }
})