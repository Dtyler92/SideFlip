import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

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

test('PostHog is loaded after consent instead of blocking the initial app bundle', () => {
  const analytics = source('src/analytics.js')
  assert.doesNotMatch(analytics, /^import posthog from 'posthog-js'$/m)
  assert.match(analytics, /import\('posthog-js'\)/)
  assert.match(analytics, /analyticsLoadGeneration/)
  assert.match(analytics, /pendingAnalyticsOperations/)
})

test('production manifest keeps PostHog outside the initial static bundle budget', () => {
  const output = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'sideflip-performance-'))
  try {
    execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--manifest', '--outDir', output], {
      cwd:new URL('..', import.meta.url),
      env:{ ...process.env, VITE_POSTHOG_KEY:'phc_bundle_acceptance_probe' },
      stdio:'pipe',
    })
    const manifest = JSON.parse(readFileSync(join(output, '.vite/manifest.json'), 'utf8'))
    const posthogKey = Object.keys(manifest).find(key => key.includes('node_modules/posthog-js/'))
    assert.ok(posthogKey && manifest[posthogKey].isDynamicEntry, 'PostHog must remain an emitted dynamic entry')

    const pending = ['index.html']
    const staticKeys = new Set()
    while (pending.length) {
      const key = pending.pop()
      if (staticKeys.has(key)) continue
      staticKeys.add(key)
      pending.push(...(manifest[key]?.imports || []))
    }
    assert.equal(staticKeys.has(posthogKey), false, 'PostHog must not enter the initial static dependency closure')
    const html = readFileSync(join(output, 'index.html'), 'utf8')
    assert.equal(html.includes(manifest[posthogKey].file), false, 'PostHog must not be module-preloaded')

    const initialGzipBytes = [...staticKeys].reduce((sum, key) => {
      const file = manifest[key]?.file
      return file ? sum + gzipSync(readFileSync(join(output, file)), { level:9 }).length : sum
    }, 0)
    assert.ok(initialGzipBytes <= 145 * 1024, `initial static JavaScript exceeded 145 KiB gzip: ${initialGzipBytes}`)
  } finally { rmSync(output, { recursive:true, force:true }) }
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
