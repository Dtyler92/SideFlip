import test from 'node:test'
import assert from 'node:assert/strict'

process.env.STRIPE_SECRET_KEY ||= 'sk_test_synthetic'
process.env.VITE_SUPABASE_URL ||= 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'synthetic-service-role-key'

const { resolveCustomerId } = await import('../api/create-portal-session.js')

function mockStripe({ customers = [], subscriptionsByCustomer = {}, retrievedSubscription = null } = {}) {
  return {
    customers: {
      async list() { return { data: customers } },
    },
    subscriptions: {
      async retrieve() {
        if (retrievedSubscription instanceof Error) throw retrievedSubscription
        return retrievedSubscription
      },
      async list({ customer }) { return { data: subscriptionsByCustomer[customer] || [] } },
    },
  }
}

test('portal recovery immediately uses a stored Stripe customer ID', async () => {
  const stripe = mockStripe()
  assert.equal(
    await resolveCustomerId({ id: 'user-1', email: 'owner@example.com' }, { stripe_customer_id: 'cus_stored' }, stripe),
    'cus_stored'
  )
})

test('portal recovery resolves a subscription-only legacy profile', async () => {
  const stripe = mockStripe({ retrievedSubscription: { customer: 'cus_from_subscription' } })
  assert.equal(
    await resolveCustomerId({ id: 'user-2', email: 'owner@example.com' }, { subscription_id: 'sub_legacy' }, stripe),
    'cus_from_subscription'
  )
})

test('portal recovery prefers exact user metadata when an email has multiple Stripe customers', async () => {
  const stripe = mockStripe({
    customers: [{ id: 'cus_wrong' }, { id: 'cus_right' }],
    subscriptionsByCustomer: {
      cus_wrong: [{ metadata: { userId: 'another-user' } }],
      cus_right: [{ metadata: { userId: 'user-3' } }],
    },
  })
  assert.equal(
    await resolveCustomerId({ id: 'user-3', email: 'owner@example.com' }, {}, stripe),
    'cus_right'
  )
})

test('portal recovery accepts the only exact-email customer for old records', async () => {
  const stripe = mockStripe({ customers: [{ id: 'cus_only' }] })
  assert.equal(
    await resolveCustomerId({ id: 'user-4', email: 'owner@example.com' }, {}, stripe),
    'cus_only'
  )
})

test('portal recovery returns null for a login with no Stripe billing record', async () => {
  const stripe = mockStripe()
  assert.equal(
    await resolveCustomerId({ id: 'reviewer', email: 'reviewer@example.com' }, {}, stripe),
    null
  )
})
