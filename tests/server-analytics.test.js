import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildServerAnalyticsEvent, deterministicInsertId, normalizeBillingInterval } from '../api/_lib/analytics.js'
import { appleNotificationSemantics, appleNotificationStatus } from '../api/_lib/apple-notification-status.js'
import { stripeInvoicePaymentType } from '../api/_lib/stripe-analytics.js'

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('server purchase analytics is deterministic and strips provider identifiers', () => {
  const first = deterministicInsertId('stripe', 'evt_123', 'subscription_started')
  const second = deterministicInsertId('stripe', 'evt_123', 'subscription_started')
  assert.equal(first, second)
  assert.equal(first.length, 64)
  assert.doesNotMatch(first, /evt_123/)

  const payload = buildServerAnalyticsEvent({
    distinctId: '00000000-0000-4000-8000-000000000001',
    event: 'subscription_started',
    insertId: first,
    properties: {
      provider: 'stripe', plan: 'annual', status: 'active', amount: 9999,
      email: 'person@example.com', transaction_id: 'secret-provider-id',
    },
  })
  assert.equal(payload.event, 'subscription_started')
  assert.equal(payload.properties.provider, 'stripe')
  assert.equal(payload.properties.plan, 'annual')
  assert.equal(payload.properties.$insert_id, first)
  assert.equal(payload.properties.$geoip_disable, true)
  assert.equal(payload.properties.amount, undefined)
  assert.equal(payload.properties.email, undefined)
  assert.equal(payload.properties.transaction_id, undefined)
})

test('server analytics rejects unknown events and malformed user IDs', () => {
  assert.throws(() => buildServerAnalyticsEvent({ distinctId: 'not-a-user', event: 'subscription_started' }), /distinctId/)
  assert.throws(() => buildServerAnalyticsEvent({ distinctId: '00000000-0000-4000-8000-000000000001', event: 'made_up_event' }), /event/)
})

test('billing intervals are normalized and trial starts have their own event', () => {
  assert.equal(normalizeBillingInterval('month'), 'monthly')
  assert.equal(normalizeBillingInterval('year'), 'annual')
  assert.equal(normalizeBillingInterval('monthly'), 'monthly')
  assert.equal(normalizeBillingInterval('day'), undefined)
  assert.doesNotThrow(() => buildServerAnalyticsEvent({
    distinctId: '00000000-0000-4000-8000-000000000001',
    event: 'subscription_trial_started',
  }))
})

test('verified Apple notification evidence maps refund, revoke, and grace period', () => {
  const future = Date.now() + 60_000
  assert.equal(appleNotificationStatus({ notificationType: 'REFUND', transaction: { expiresDate: future } }), 'refunded')
  assert.equal(appleNotificationStatus({ notificationType: 'REVOKE', transaction: { revocationDate: Date.now(), expiresDate: future } }), 'revoked')
  assert.equal(appleNotificationStatus({
    notificationType: 'DID_FAIL_TO_RENEW', subtype: 'GRACE_PERIOD',
    transaction: { expiresDate: Date.now() - 1 }, renewalInfo: { gracePeriodExpiresDate: future, isInBillingRetryPeriod: true },
  }), 'grace_period')
  assert.equal(appleNotificationStatus({ notificationType: 'GRACE_PERIOD_EXPIRED', transaction: { expiresDate: Date.now() - 1 } }), 'expired')
})

test('verified Apple semantics classify cancellation and billing failure without ending access', () => {
  const future = Date.now() + 60_000
  assert.deepEqual(appleNotificationSemantics({ notificationType: 'DID_CHANGE_RENEWAL_STATUS', subtype: 'AUTO_RENEW_DISABLED' }), {
    cancellationScheduled: true, billingFailure: false,
  })
  assert.deepEqual(appleNotificationSemantics({ notificationType: 'DID_FAIL_TO_RENEW', subtype: 'BILLING_RETRY' }), {
    cancellationScheduled: false, billingFailure: true,
  })
  assert.equal(appleNotificationStatus({
    notificationType: 'DID_FAIL_TO_RENEW', subtype: 'BILLING_RETRY',
    transaction: { expiresDate: future }, renewalInfo: { isInBillingRetryPeriod: true },
  }), 'active')
})

test('Stripe paid invoice taxonomy includes only initial creation and renewal cycles', () => {
  assert.equal(stripeInvoicePaymentType('subscription_create'), 'initial')
  assert.equal(stripeInvoicePaymentType('subscription_cycle'), 'renewal')
  assert.equal(stripeInvoicePaymentType('subscription_update'), null)
  assert.equal(stripeInvoicePaymentType('manual'), null)
  assert.equal(stripeInvoicePaymentType(undefined), null)
})

test('provider handlers durably enqueue without PostHog request latency', () => {
  assert.match(source('api/create-checkout.js'), /stripe_checkout_created/)
  assert.match(source('api/create-checkout.js'), /enqueueServerEvent/)
  assert.doesNotMatch(source('api/create-checkout.js'), /captureServerEvent/)
  assert.match(source('api/stripe-webhook.js'), /checkout_completed/)
  assert.match(source('api/stripe-webhook.js'), /invoice\.paid/)
  assert.match(source('api/stripe-webhook.js'), /enqueueStripeProviderEvent/)
  assert.match(source('api/stripe-webhook.js'), /subscription_payment_succeeded/)
  assert.match(source('api/stripe-webhook.js'), /subscription_payment_failed/)
  assert.match(source('api/stripe-webhook.js'), /apply_stripe_subscription_event_v2/)
  assert.doesNotMatch(source('api/stripe-webhook.js'), /dispatchAnalyticsOutbox/)
  assert.doesNotMatch(source('api/verify-apple-purchase.js'), /dispatchAnalyticsOutbox/)
  assert.doesNotMatch(source('api/apple-server-notifications.js'), /dispatchAnalyticsOutbox/)

  const migration = source('supabase/migrations/20260809020000_add_product_analytics_outbox.sql')
  assert.match(migration, /create table public\.analytics_outbox/)
  assert.match(migration, /apple_entitlement_events_semantic_unique/)
  assert.match(migration, /apply_stripe_subscription_event_v2/)
  assert.match(migration, /apply_stripe_analytics_event/)
  assert.match(migration, /subscription_payment_succeeded/)
  assert.match(migration, /analytics_opt_out/)
  assert.match(migration, /analytics_deletion_queue/)
  assert.match(migration, /claim_token/)
  assert.match(migration, /subscription_trial_started/)
  assert.match(source('api/analytics-preference.js'), /supabase\.auth\.getUser\(token\)/)
  assert.match(source('api/analytics-preference.js'), /analytics_opt_out: !req\.body\.enabled/)
  assert.match(source('api/analytics-preference.js'), /update\([\s\S]*select\('analytics_opt_out'\)[\s\S]*maybeSingle\(\)/)
})

test('account deletion queues erasure before Auth deletion and worker fences asynchronous PostHog erasure', () => {
  const deletion = source('api/delete-account.js')
  assert.ok(deletion.indexOf("rpc('queue_analytics_deletion'") < deletion.indexOf('auth.admin.deleteUser'))
  const worker = source('api/_lib/analytics.js')
  assert.match(worker, /persons\/bulk_delete/)
  assert.match(worker, /distinct_ids: \[distinctId\]/)
  assert.match(worker, /delete_events: true/)
  assert.match(worker, /delete_recordings: true/)
  assert.match(worker, /POSTHOG_PERSONAL_API_KEY/)
  assert.match(worker, /process\.env\.POSTHOG_KEY/)
  assert.doesNotMatch(worker, /POSTHOG_PROJECT_KEY/)
  assert.match(worker, /AbortSignal\.timeout\(8000\)/)
  const dispatcher = source('api/analytics-dispatch.js')
  assert.match(dispatcher, /dispatchAnalyticsDeletionQueue/)
  assert.doesNotMatch(dispatcher, /Promise\.all/)
  assert.ok(dispatcher.indexOf('dispatchAnalyticsOutbox') < dispatcher.indexOf('dispatchAnalyticsDeletionQueue'))
  assert.match(dispatcher, /deadline/)
  assert.match(dispatcher, /backlog/)
  assert.match(dispatcher, /maxDuration: 60/)
  assert.match(worker, /submitted/)
  assert.doesNotMatch(worker, /p_deleted:/)
  assert.match(deletion, /reconciliationPending/)
})

test('migration-first release gate, readiness endpoint, and Vault-backed Supabase scheduler are present', () => {
  const scheduler = source('supabase/migrations/20260809030000_schedule_analytics_dispatch.sql')
  assert.match(source('api/analytics-readiness.js'), /analytics_backend_readiness/)
  assert.match(source('scripts/check-analytics-readiness.mjs'), /ANALYTICS_READINESS_URL/)
  assert.match(source('docs/analytics-deployment.md'), /migration-first/i)
  assert.match(source('docs/analytics-deployment.md'), /initial rollout/i)
  assert.match(source('docs/analytics-deployment.md'), /Supabase Vault/i)
  assert.doesNotMatch(source('vercel.json'), /"crons"/)
  assert.match(scheduler, /'\*\/5 \* \* \* \*'/)
  assert.match(scheduler, /vault\.decrypted_secrets/)
  assert.match(scheduler, /where name = 'sideflip_analytics_cron_secret'/)
  assert.doesNotMatch(scheduler, /Bearer [A-Za-z0-9_-]{16,}/)
})
