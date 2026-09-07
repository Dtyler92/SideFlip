import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const source = path => readFileSync(new URL(path, root), 'utf8')

test('obsolete receipt scanner and unused Stripe browser SDK are removed', () => {
  const packageJson = JSON.parse(source('package.json'))
  const detail = source('src/pages/ProjectDetail.jsx')

  assert.equal(packageJson.dependencies['@stripe/stripe-js'], undefined)
  assert.equal(existsSync(new URL('api/_lib/receipt-security.js', root)), false)
  assert.doesNotMatch(detail, /scan-receipt|scanReceipt|receiptItems|importReceiptExpenses/)
  assert.doesNotMatch(source('src/capabilities.js'), /receipt_scanning/)
})

test('test-only and invalid package entry scaffolding is removed', () => {
  const packageJson = JSON.parse(source('package.json'))
  assert.equal(packageJson.main, undefined)
  assert.doesNotMatch(source('api/_lib/analytics.js'), /export async function captureServerEvent/)
  assert.doesNotMatch(source('src/goals.js'), /export function (splitSaleProceeds|calculateTradeBasis)/)
  assert.doesNotMatch(source('api/decode-vin.js'), /export function maskVin/)
  assert.match(source('.gitignore'), /^\.env\.local$/m)
})

test('unused billing and paywall compatibility parameters are removed', () => {
  assert.doesNotMatch(source('src/billing.js'), /export function (getTrialDaysLeft|isTrialActive|isSubscribed|hasAccess)/)
  assert.doesNotMatch(source('src/pages/Paywall.jsx'), /trialExpired/)
  assert.doesNotMatch(source('src/App.jsx'), /trialExpired=/)
})

test('Stripe activation polling is sequential and reuses refresh results', () => {
  const app = source('src/App.jsx')
  const auth = source('src/context/AuthContext.jsx')

  assert.doesNotMatch(app, /setInterval/)
  assert.doesNotMatch(app, /import\(['"]\.\/supabase['"]\)/)
  assert.match(app, /\{\s*entitlement:\s*freshEntitlement\s*\}\s*=\s*await refreshProfile\(\)/)
  assert.match(app, /freshEntitlement\?\.plan === 'pro'/)
  assert.doesNotMatch(app, /freshProfile\?\.subscription_status/)
  assert.match(source('src/supabase.js'), /return data\s*$/m)
  assert.match(auth, /const refreshProfile = useCallback\(async \(\) =>/)
  assert.match(auth, /serverEntitlement\?\.plan === 'pro'/)
  assert.doesNotMatch(auth, /serverEntitlement\?\.isPro/)
  assert.match(auth, /return\s+\{\s*profile:\s*nextProfile,\s*entitlement:\s*serverEntitlement\s*\}/)
})

test('page routes are lazy loaded instead of shipping one oversized initial bundle', () => {
  const app = source('src/App.jsx')
  assert.match(app, /import \{[^}]*lazy[^}]*Suspense[^}]*\} from 'react'/)
  assert.match(app, /const ProjectDetail = lazy\(\(\) => import\('\.\/pages\/ProjectDetail'\)\)/)
  assert.match(app, /const Analytics = lazy\(\(\) => import\('\.\/pages\/Analytics'\)\)/)
  assert.match(app, /<Suspense fallback=/)
  assert.doesNotMatch(app, /import ProjectDetail from '\.\/pages\/ProjectDetail'/)
})

test('deployment applies baseline browser security headers to every route', () => {
  const config = JSON.parse(source('vercel.json'))
  const global = config.headers?.find(entry => entry.source === '/(.*)')
  assert.ok(global, 'global response headers must be configured')
  const headers = new Map(global.headers.map(({ key, value }) => [key.toLowerCase(), value]))

  assert.match(headers.get('content-security-policy') || '', /default-src 'self'/)
  assert.match(headers.get('content-security-policy') || '', /frame-ancestors 'none'/)
  assert.equal(headers.get('x-content-type-options'), 'nosniff')
  assert.equal(headers.get('x-frame-options'), 'DENY')
  assert.equal(headers.get('referrer-policy'), 'strict-origin-when-cross-origin')
  assert.match(headers.get('permissions-policy') || '', /camera=\(\)/)
})
