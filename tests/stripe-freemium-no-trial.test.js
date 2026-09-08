import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('new web Pro subscriptions have no free trial or negative-option conversion', () => {
  const checkout = source('api/create-checkout.js')
  const webhook = source('api/stripe-webhook.js')
  const paywall = source('src/pages/Paywall.jsx')
  const terms = source('src/pages/TermsOfService.jsx')
  const publicTerms = source('public/terms/index.html')

  assert.doesNotMatch(checkout, /trial_period_days|trial_end|Cancel before the trial ends/i)
  assert.doesNotMatch(checkout, /allow_promotion_codes|stripe\.coupons\.list|discounts/)
  assert.match(webhook, /event\.type === 'customer\.subscription\.created'[\s\S]*subscription\.status === 'trialing'[\s\S]*subscription\.trial_end[\s\S]*email/)
  assert.doesNotMatch(paywall, /free trial|trial ends|Cancel before day/i)
  assert.match(paywall, /Free plan remains available/i)
  assert.match(paywall, /charged immediately/i)
  assert.match(checkout, /charge .* immediately/i)
  assert.doesNotMatch(terms, /any web trial/i)
  assert.match(terms, /Last updated: September 8, 2026/)
  assert.doesNotMatch(publicTerms, /any web trial/i)
  assert.match(publicTerms, /does not offer a free trial for web subscriptions/i)
  assert.match(publicTerms, /charged immediately after checkout confirmation/i)
  assert.match(publicTerms, /Last updated: September 8, 2026/)
})

test('legacy Stripe trials remain recognized until their provider lifecycle ends', () => {
  const capabilities = source('src/capabilities.js')
  const entitlementResolver = source('api/_lib/entitlements.js')

  assert.match(capabilities, /subscription_status === 'trialing'/)
  assert.match(entitlementResolver, /\['active', 'trialing'\]\.includes\(profile\.subscription_status\)/)
})
