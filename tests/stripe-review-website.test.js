import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('public pricing page shows Free and both Pro packages with concrete inclusions', () => {
  assert.equal(existsSync(new URL('../public/pricing/index.html', import.meta.url)), true)
  const pricing = source('public/pricing/index.html')
  assert.match(pricing, /Free/)
  assert.match(pricing, /\$0/)
  assert.match(pricing, /\$12\.99/)
  assert.match(pricing, /monthly/i)
  assert.match(pricing, /\$99\.99/)
  assert.match(pricing, /annual/i)
  assert.match(pricing, /Project tracking/i)
  assert.match(pricing, /per-project profit/i)
  assert.match(pricing, /One active Trade-Up Goal/i)
  assert.match(pricing, /Portfolio analytics dashboard/i)
  assert.match(pricing, /Realized ROI, win rate, and active-capital metrics/i)
  assert.match(pricing, /Category performance and best-flip insights/i)
  assert.match(pricing, /Average selling-time and recent-sales views/i)
  assert.match(pricing, /href="\/upgrade\?plan=monthly">Choose Monthly<\/a>/)
  assert.match(pricing, /href="\/upgrade\?plan=annual">Choose Annual<\/a>/)
  assert.match(pricing, /href="\/">Use SideFlip Free<\/a>/)
  assert.doesNotMatch(pricing, /Sign In to Choose|Create Free Account/)
  assert.match(pricing, /<article class="plan pro">[\s\S]*?<h2>Monthly<\/h2>/)
  assert.match(pricing, /<article class="plan pro recommended">[\s\S]*?<h2>Annual<\/h2>/)
  assert.match(pricing, /\.plan\.recommended\s*\{/)
  assert.match(pricing, /no free trial/i)
  assert.match(pricing, /charged immediately/i)
  assert.doesNotMatch(pricing, /7-day free trial|trial ends|after.*trial/i)
})

test('signed-in purchase page matches the public Pro package and preselects requested cadence', () => {
  const paywall = source('src/pages/Paywall.jsx')
  assert.match(paywall, /URLSearchParams\(window.location.search\)/)
  assert.match(paywall, /Portfolio analytics dashboard/)
  assert.match(paywall, /Realized ROI, win rate, and active-capital metrics/)
  assert.match(paywall, /Category performance and best-flip insights/)
  assert.match(paywall, /Average selling-time and recent-sales views/)
  assert.match(paywall, /Continue to.*Checkout/)
  assert.doesNotMatch(paywall, /getStoredReferral|discount|coupon|promotion/i)
})

test('pricing is public and discoverable from signed-out and support surfaces', () => {
  const vercel = source('vercel.json')
  const auth = source('src/pages/AuthScreen.jsx')
  const support = source('public/support/index.html')

  assert.match(vercel, /pricing/)
  assert.match(auth, /href="\/pricing"/)
  assert.match(support, /href="\/pricing"/)
  assert.match(support, /does not offer a free trial/i)
  assert.doesNotMatch(support, /7-day free trial|trial ends|after.*trial/i)
})

test('Settings avoids reviewer errors while preserving every legacy portal recovery path', () => {
  const settings = source('src/pages/Settings.jsx')
  assert.match(settings, /profile\?\.stripe_customer_id \|\| profile\?\.subscription_id/)
  assert.match(settings, /No active web subscription/)
  assert.match(settings, /View Pro Plans/)
  assert.match(settings, /Manage Web Subscription/)
  assert.match(settings, /Already subscribed on web\? Find Web Subscription/)
  assert.match(settings, /res\.status === 404/)
  assert.match(settings, /role="status"/)
  assert.match(settings, /href="\/pricing"/)
  assert.doesNotMatch(settings, /if \(!profile\?\.stripe_customer_id\) return/)
})
