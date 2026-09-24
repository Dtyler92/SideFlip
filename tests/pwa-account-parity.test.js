import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { CURRENCIES, formatMoneyForCurrency } from '../src/currencyModel.js'
import { clearSideFlipBrowserData } from '../src/accountCleanup.js'

const source = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('PWA bottom navigation exposes the Android product-tab contract without Settings', () => {
  const nav = source('src/components/BottomNav.jsx')
  for (const [path, label] of [['/', 'Projects'], ['/my-stuff', 'My Stuff'], ['/goals', 'Goals'], ['/analyze', 'Analyze'], ['/analytics', 'Analytics']]) {
    assert.match(nav, new RegExp(`path: '${path.replace('/', '\\/')}'.*label: '${label}'`))
  }
  assert.doesNotMatch(nav, /label: 'Settings'/)
  assert.match(source('src/pages/Home.jsx'), /navigate\('\/settings'\)/)
})

test('optional product routes have build-safe import hooks and placeholders', () => {
  const app = source('src/App.jsx')
  assert.match(app, /import\.meta\.glob/)
  assert.match(app, /<Route path="\/my-stuff"/)
  assert.match(app, /<Route path="\/analyze"/)
  assert.match(source('src/pages/FeaturePlaceholder.jsx'), /Coming to the PWA/)
})

test('PWA auth includes onboarding and inline password-reset completion', () => {
  const app = source('src/App.jsx')
  const auth = source('src/pages/AuthScreen.jsx')
  assert.match(app, /needsOnboarding/)
  assert.match(app, /<Onboarding/)
  assert.match(auth, /const \[mode, setMode\] = useState\('signin'\)/)
  assert.match(auth, /Check your email for a reset link/)
  assert.match(auth, /trim\(\)\.toLowerCase\(\)/)
})

test('account deletion requires exact DELETE and supports retryable local cleanup', () => {
  const deletion = source('src/pages/DeleteAccount.jsx')
  assert.match(deletion, /confirmation !== 'DELETE'/)
  assert.match(deletion, /method: 'POST'/)
  assert.match(deletion, /body: JSON\.stringify\(\{ confirmation: 'DELETE' \}\)/)
  assert.match(deletion, /Retry/)
  assert.match(deletion, /clearSideFlipBrowserData/)
  assert.match(source('src/pages/Settings.jsx'), /Delete Account/)
})

test('browser cleanup removes SideFlip-owned keys but not unrelated storage', async () => {
  const storage = values => ({
    get length() { return values.size },
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => values.delete(key),
  })
  const localValues = new Map([['flipledger_projects', 'x'], ['sideflip_analytics_x', 'x'], ['sideflip:saved-analyses:real-user-id', 'private'], ['unrelated', 'keep']])
  const sessionValues = new Map([['sideflip_referral_v1', 'x'], ['other', 'keep']])
  await clearSideFlipBrowserData({ localStorage: storage(localValues), sessionStorage: storage(sessionValues) })
  assert.deepEqual([...localValues], [['unrelated', 'keep']])
  assert.deepEqual([...sessionValues], [['other', 'keep']])
})

test('shared currency model covers profile currencies, negative placement, and JPY decimals', () => {
  assert.deepEqual(CURRENCIES.map(item => item.code), ['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'MXN', 'JPY', 'INR'])
  assert.equal(formatMoneyForCurrency(-1234.5, 'GBP'), '-£1,234.50')
  assert.equal(formatMoneyForCurrency(1234.5, 'JPY'), '¥1,235')
  assert.equal(formatMoneyForCurrency(-1234.5, 'JPY'), '-¥1,235')
  assert.equal(formatMoneyForCurrency(10, 'unknown'), '$10.00')
})

test('entitlement and data loading expose canonical unavailable and retry states', () => {
  const auth = source('src/context/AuthContext.jsx')
  const data = source('src/context/DataContext.jsx')
  const home = source('src/pages/Home.jsx')
  assert.match(auth, /entitlementStatus/)
  assert.match(auth, /'loading'/)
  assert.match(auth, /'resolved'/)
  assert.match(auth, /'unavailable'/)
  assert.match(auth, /visibilitychange/)
  assert.match(auth, /window\.addEventListener\('focus'/)
  assert.match(data, /setError/)
  assert.match(home, /Retry/)
})

test('Settings preserves web Stripe management and matches currency and analytics disclosure', () => {
  const settings = source('src/pages/Settings.jsx')
  assert.match(settings, /create-portal-session/)
  assert.match(settings, /CURRENCIES/)
  assert.match(settings, /stable pseudonymous account ID/)
  assert.match(settings, /campaign\/referral attribution/)
  assert.match(settings, /project financials/)
})
