import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  captureEvent,
  extractAttribution,
  isAnalyticsRuntimeReady,
  reconcileAnalyticsPreference,
  sanitizeAnalyticsProperties,
} from '../src/analytics.js'
import {
  captureReferral,
  getStoredReferral,
  transitionReferralScope,
} from '../src/pwa.js'

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('analytics properties keep only bounded low-cardinality non-sensitive values', () => {
  assert.deepEqual(sanitizeAnalyticsProperties({
    plan: 'annual',
    status: 'active',
    amount: 5999,
    currency: 'usd',
    platform: 'web',
    project_category: 'mower',
    is_pro: true,
    email: 'person@example.com',
    project_title: 'Private project',
    description: 'Private notes',
    card_id: 'card_secret',
    billing_id: 'billing_secret',
    provider_id: 'provider_secret',
    signedTransaction: 'secret-payload',
    custom_unknown: 'drop me',
  }), {
    plan: 'annual',
    status: 'active',
    platform: 'web',
    project_category: 'mower',
    is_pro: true,
  })
})

test('attribution accepts only allowlisted bounded campaign fields', () => {
  assert.deepEqual(extractAttribution('https://sideflip.org/?utm_source=facebook&utm_medium=paid-social&utm_campaign=summer%20flips&ref=creator42&email=nope@example.com&utm_content=carousel%20one'), {
    utm_source: 'facebook',
    utm_medium: 'paid-social',
    utm_campaign: 'summer flips',
    referral_code: 'creator42',
    utm_content: 'carousel one',
  })
})

test('attribution rejects sensitive or unsafe values per field before capture or storage', () => {
  const unsafe = [
    'person@example.com',
    '+1 (555) 867-5309',
    'https://evil.example/path',
    'www.evil.example/path',
    'Bearer abcdefghijklmnopqrstuvwxyz',
    'sk_' + 'live_' + 'syntheticvalue',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature',
    'campaign<script>',
    'a'.repeat(100),
  ]
  for (const value of unsafe) {
    const url = new URL('https://sideflip.org/')
    url.searchParams.set('utm_campaign', value)
    url.searchParams.set('ref', value)
    assert.deepEqual(extractAttribution(url.href), {}, value)
    assert.deepEqual(sanitizeAnalyticsProperties({ utm_campaign: value, referral_code: value }), {}, value)
  }
})

test('referral capture preserves unrelated query parameters and scopes checkout referral across users', () => {
  const values = new Map()
  const previousWindow = globalThis.window
  const previousSessionStorage = globalThis.sessionStorage
  globalThis.sessionStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
  globalThis.window = {
    location: { href: 'https://sideflip.org/upgrade?ref=creator42&utm_source=facebook&canceled=1#plans' },
    history: { replaceState: (_state, _title, next) => { globalThis.window.replaced = next } },
    sessionStorage: globalThis.sessionStorage,
  }

  try {
    assert.equal(captureReferral(window.location.href, null), 'CREATOR42')
    assert.equal(window.replaced, '/upgrade?utm_source=facebook&canceled=1#plans')
    assert.equal(getStoredReferral(null), 'CREATOR42')
    transitionReferralScope(null, 'user-a')
    assert.equal(getStoredReferral('user-a'), 'CREATOR42')
    assert.equal(getStoredReferral('user-b'), null)
    transitionReferralScope('user-a', null)
    assert.equal(getStoredReferral('user-a'), null)
    transitionReferralScope(null, 'user-b')
    assert.equal(getStoredReferral('user-b'), null)
  } finally {
    globalThis.window = previousWindow
    globalThis.sessionStorage = previousSessionStorage
  }
})

test('web funnel instrumentation covers activation and Stripe conversion intent', () => {
  const auth = source('src/pages/AuthScreen.jsx')
  const app = source('src/App.jsx')
  const project = source('src/pages/NewProject.jsx')
  const detail = source('src/pages/ProjectDetail.jsx')
  const sale = source('src/pages/SellProject.jsx')
  const paywall = source('src/pages/Paywall.jsx')
  const settings = source('src/pages/Settings.jsx')
  assert.match(auth, /signup_started/)
  assert.match(auth, /signup_completed/)
  assert.match(app, /screen_viewed/)
  assert.match(project, /project_created/)
  assert.match(detail, /expense_added/)
  assert.match(detail, /expense_deleted/)
  assert.match(sale, /project_marked_sold/)
  assert.match(paywall, /paywall_viewed/)
  assert.match(paywall, /plan_selected/)
  assert.match(paywall, /stripe_checkout_started/)
  assert.match(settings, /Share usage analytics/)
  assert.match(settings, /setAnalyticsEnabled/)
})

test('signed-out reconciliation is ready but defaults capture off', async () => {
  assert.equal(await reconcileAnalyticsPreference(null), false)
  assert.equal(isAnalyticsRuntimeReady(null), true)
  assert.equal(captureEvent('app_opened'), false)
})

test('analytics lifecycle is reconciled before capture and scoped to the authenticated user', () => {
  const analyticsSource = source('src/analytics.js')
  const authSource = source('src/context/AuthContext.jsx')
  const appSource = source('src/App.jsx')

  assert.match(analyticsSource, /runtimeReady && analyticsEnabled/)
  assert.match(analyticsSource, /preferenceKey\(userId\)/)
  assert.doesNotMatch(analyticsSource, /await syncAnalyticsPreference\([^)]*\)[\s\S]{0,120}localChoice/)
  assert.match(analyticsSource, /method: 'GET'/)
  assert.match(analyticsSource, /posthog\.opt_out_capturing\(\)[\s\S]{0,120}purgePostHogQueues\(\)[\s\S]{0,120}posthog\.reset\(\)/)
  assert.match(analyticsSource, /queue\._queue = \[\]/)
  assert.match(analyticsSource, /request_batching: false/)
  assert.match(analyticsSource, /localStorage\.removeItem\(ATTRIBUTION_KEY\)/)
  assert.match(analyticsSource, /export async function setAnalyticsEnabled/)
  assert.match(analyticsSource, /if \(!normalized\) return completeReconciliation\(false\)/)
  assert.doesNotMatch(analyticsSource, /completeReconciliation\(true\)/)

  assert.match(authSource, /analyticsReady/)
  assert.match(authSource, /resetAnalytics\(\)[\s\S]*identifyAnalytics/)
  assert.match(authSource, /transitionReferralScope/)
  assert.match(authSource, /finally[\s\S]{0,200}resetAnalytics\(\)/)
  assert.match(appSource, /if \(!analyticsReady\) return/)
  assert.ok(appSource.indexOf('captureAttribution(initialUrlRef.current)') < appSource.indexOf('captureReferral(initialUrlRef.current'))
})

test('Settings waits for confirmed preference saves and reports failures', () => {
  const settings = source('src/pages/Settings.jsx')
  assert.match(settings, /async function handleAnalyticsPreference/)
  assert.match(settings, /await setAnalyticsEnabled/)
  assert.match(settings, /analyticsSaving/)
  assert.match(settings, /analyticsError/)
  assert.match(settings, /disabled=\{analyticsSaving\}/)
})

test('Settings accurately discloses the narrow analytics collection', () => {
  const settings = source('src/pages/Settings.jsx')
  assert.match(settings, /subscription plan, status, amount, and currency/i)
  assert.match(settings, /card, billing, or payment-provider identifiers/i)
  assert.match(settings, /project financials/i)
})
