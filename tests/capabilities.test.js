import test from 'node:test'
import assert from 'node:assert/strict'
import { can, getPlan } from '../src/capabilities.js'

const LEGACY_STRIPE_PRO = {
  subscription_id: 'sub_legacy',
  subscription_status: 'active',
}

const TEST_NOW = Date.parse('2026-08-06T00:00:00.000Z')

const ACTIVE_APPLE_PRO = {
  source: 'apple',
  status: 'active',
  expires_at: '2030-01-01T00:00:00.000Z',
}

test('new accounts receive the useful Free core without a payment record', () => {
  assert.equal(getPlan({}, null), 'free')
  assert.equal(can({}, null, 'projects'), true)
  assert.equal(can({}, null, 'project_profit'), true)
  assert.equal(can({}, null, 'calculator'), true)
  assert.equal(can({}, null, 'one_goal'), true)
  assert.equal(can({}, null, 'portfolio_analytics'), false)
  assert.equal(can({}, null, 'ai_listings'), false)
  assert.equal(can({}, null, 'additional_goals'), false)
})

test('an active legacy Stripe subscription keeps Pro access', () => {
  assert.equal(getPlan(LEGACY_STRIPE_PRO, null), 'pro')
  assert.equal(can(LEGACY_STRIPE_PRO, null, 'portfolio_analytics'), true)
})

test('a verified active Apple entitlement grants Pro access', () => {
  assert.equal(getPlan({}, ACTIVE_APPLE_PRO, TEST_NOW), 'pro')
  assert.equal(can({}, ACTIVE_APPLE_PRO, 'ai_listings', TEST_NOW), true)
})

test('expired, revoked, or malformed Apple entitlements fall back to Free', () => {
  const expired = { ...ACTIVE_APPLE_PRO, expires_at: '2020-01-01T00:00:00.000Z' }
  const revoked = { ...ACTIVE_APPLE_PRO, status: 'revoked' }
  const malformed = { ...ACTIVE_APPLE_PRO, expires_at: '9999' }
  const missingExpiry = { ...ACTIVE_APPLE_PRO, expires_at: null }
  const wrongSource = { ...ACTIVE_APPLE_PRO, source: 'client' }

  assert.equal(getPlan({}, expired, TEST_NOW), 'free')
  assert.equal(getPlan({}, revoked, TEST_NOW), 'free')
  assert.equal(getPlan({}, malformed, TEST_NOW), 'free')
  assert.equal(getPlan({}, missingExpiry, TEST_NOW), 'free')
  assert.equal(getPlan({}, wrongSource, TEST_NOW), 'free')
  assert.equal(getPlan({ subscription_id: 'sub_stale', subscription_status: 'canceled' }, null, TEST_NOW), 'free')
})
