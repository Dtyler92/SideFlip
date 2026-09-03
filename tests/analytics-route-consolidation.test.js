import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createAnalyticsRouter } from '../api/_lib/analytics-router.js'
import { createAnalyticsDispatchHandler } from '../api/_lib/analytics-dispatch-handler.js'
import { createAnalyticsPreferenceHandler } from '../api/_lib/analytics-preference-handler.js'
import { createAnalyticsReadinessHandler } from '../api/_lib/analytics-readiness-handler.js'

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function response() {
  return {
    statusCode: 200,
    body: undefined,
    ended: false,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    end() { this.ended = true; return this },
  }
}

function functionFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      return entry.name.startsWith('_') ? [] : functionFiles(new URL(`${entry.name}/`, directory), relative)
    }
    return entry.isFile() && entry.name.endsWith('.js') ? [relative] : []
  })
}

test('analytics compatibility rewrites are explicit, ordered before the SPA fallback, and use fixed paths', () => {
  const config = JSON.parse(source('vercel.json'))
  assert.deepEqual(config.rewrites.slice(0, 5), [
    { source: '/api/analytics', destination: '/api/analytics/preference' },
    { source: '/api/analytics-worker', destination: '/api/analytics/dispatch' },
    { source: '/api/analytics-dispatch', destination: '/api/analytics/dispatch' },
    { source: '/api/analytics-preference', destination: '/api/analytics/preference' },
    { source: '/api/analytics-readiness', destination: '/api/analytics/readiness' },
  ])
  assert.equal(config.rewrites[5].destination, '/index.html')
})

test('the dynamic analytics entry is one of exactly ten Vercel functions and retains the 60-second maximum', () => {
  const entry = source('api/analytics/[operation].js')
  assert.match(entry, /maxDuration:\s*60/)
  assert.match(entry, /createAnalyticsRouter/)
  assert.deepEqual(functionFiles(new URL('../api/', import.meta.url)).sort(), [
    'analytics/[operation].js',
    'apple-server-notifications.js',
    'create-checkout.js',
    'create-portal-session.js',
    'delete-account.js',
    'entitlement.js',
    'generate-listing.js',
    'stripe-webhook.js',
    'update-profile-preferences.js',
    'verify-apple-purchase.js',
  ])
  for (const removed of ['api/analytics.js', 'api/analytics-dispatch.js', 'api/analytics-preference.js', 'api/analytics-readiness.js']) {
    assert.throws(() => source(removed), /ENOENT/)
  }
})

test('router maps every public alias and internal canonical path while ignoring routing markers', async () => {
  const calls = []
  const router = createAnalyticsRouter({
    dispatch: async req => calls.push(['dispatch', req]),
    preference: async req => calls.push(['preference', req]),
    readiness: async req => calls.push(['readiness', req]),
  })
  const routes = [
    ['/api/analytics', 'preference'],
    ['/api/analytics-worker', 'dispatch'],
    ['/api/analytics-dispatch', 'dispatch'],
    ['/api/analytics-preference', 'preference'],
    ['/api/analytics-readiness', 'readiness'],
    ['/api/analytics/dispatch', 'dispatch'],
    ['/api/analytics/preference', 'preference'],
    ['/api/analytics/readiness', 'readiness'],
  ]

  for (const [path, operation] of routes) {
    const wrongOperation = operation === 'dispatch' ? 'readiness' : 'dispatch'
    const req = {
      url: `${path}?operation=${wrongOperation}&__analytics_route=${wrongOperation}`,
      query: { operation: wrongOperation, __analytics_route: wrongOperation, keep: 'yes' },
      body: { operation: wrongOperation, __analytics_route: wrongOperation },
      headers: { 'x-analytics-operation': wrongOperation, 'x-vercel-route': wrongOperation },
    }
    await router(req, response())
    assert.deepEqual(calls.at(-1), [operation, req])
  }
  assert.equal(calls.length, routes.length)
})

test('encoded, nested, backslash, absolute, unknown, and marker-only paths cannot invoke an operation', async () => {
  let calls = 0
  const router = createAnalyticsRouter({
    dispatch: async () => { calls += 1 },
    preference: async () => { calls += 1 },
    readiness: async () => { calls += 1 },
  })

  for (const url of [
    '/api/unknown?operation=dispatch',
    '/api/analytics/arbitrary?operation=dispatch',
    '/api/analytics/%64ispatch',
    '/api/%61nalytics-dispatch',
    '/api/analytics/dispatch/nested',
    '/api/analytics-dispatch/nested',
    '/api/analytics-dispatch#nested',
    '/api/analytics\\dispatch',
    '/api/analytics-dispatch\\nested',
    'https://attacker.invalid/api/analytics/dispatch',
    '//attacker.invalid/api/analytics/dispatch',
    '',
  ]) {
    const res = response()
    await router({
      url,
      query: { operation: 'dispatch', __analytics_route: 'dispatch' },
      body: { operation: 'dispatch', __analytics_route: 'dispatch' },
      headers: { 'x-analytics-operation': 'dispatch', 'x-vercel-route': 'dispatch' },
    }, res)
    assert.equal(res.statusCode, 404, url)
    assert.deepEqual(res.body, { error: 'Not found' }, url)
  }
  assert.equal(calls, 0)
})

test('dispatch handler preserves methods and cron-secret authentication', async () => {
  const handler = createAnalyticsDispatchHandler({}, {})

  let res = response()
  await handler({ method: 'DELETE', headers: {} }, res)
  assert.equal(res.statusCode, 405)
  assert.deepEqual(res.body, { error: 'Method not allowed' })

  res = response()
  await handler({ method: 'POST', headers: {} }, res)
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.body, { error: 'Unauthorized' })
})

test('dispatch handler preserves successful cron response fields and serialized work order', async () => {
  const previous = process.env.CRON_SECRET
  process.env.CRON_SECRET = 'test-cron-secret'
  const calls = []
  const supabase = {
    rpc: async (name, args) => {
      calls.push([name, args])
      if (name === 'repair_analytics_deletion_queue') return { data: 2, error: null }
      return { data: { outbox: 0, deletions: 0 }, error: null }
    },
  }
  const handler = createAnalyticsDispatchHandler(supabase, {
    dispatchAnalyticsOutbox: async (_client, limit) => { calls.push(['outbox', limit]); return { claimed: 0, sent: 0 } },
    reconcileAuthDeleting: async (_client, limit) => { calls.push(['reconcile', limit]); return { completed: 1, failed: 0, claimed: 1 } },
    dispatchAnalyticsDeletionQueue: async (_client, limit) => { calls.push(['deletions', limit]); return { claimed: 0, completed: 0 } },
  })

  try {
    const res = response()
    await handler({ method: 'GET', headers: { authorization: 'Bearer test-cron-secret' } }, res)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body, {
      outbox: { batches: 1, claimed: 0, sent: 0 },
      deletions: { batches: 1, claimed: 0, completed: 0 },
      authReconciliation: { completed: 1, failed: 0, claimed: 1 },
      repairedDeletionRequests: 2,
      backlog: { outbox: 0, deletions: 0 },
      deadlineReached: false,
    })
    assert.deepEqual(calls.map(([name]) => name), [
      'outbox',
      'repair_analytics_deletion_queue',
      'reconcile',
      'deletions',
      'analytics_queue_backlog',
    ])
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = previous
  }
})

test('preference handler preserves validation-before-auth and bearer authentication', async () => {
  const supabase = { auth: { getUser: async () => { throw new Error('must not authenticate invalid input') } } }
  const handler = createAnalyticsPreferenceHandler(supabase)

  let res = response()
  await handler({ method: 'PUT', headers: {}, body: {} }, res)
  assert.equal(res.statusCode, 405)
  assert.deepEqual(res.body, { error: 'Method not allowed' })

  res = response()
  await handler({ method: 'POST', headers: {}, body: { enabled: 'yes' } }, res)
  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.body, { error: 'Invalid analytics preference' })

  res = response()
  await handler({ method: 'GET', headers: {}, body: {} }, res)
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.body, { error: 'Please sign in again' })
})

test('readiness handler remains GET-only and uses readiness-secret then cron-secret auth', async () => {
  const handler = createAnalyticsReadinessHandler({ rpc: async () => ({ data: true, error: null }) })

  let res = response()
  await handler({ method: 'POST', headers: {} }, res)
  assert.equal(res.statusCode, 405)
  assert.deepEqual(res.body, { ready: false, error: 'Method not allowed' })

  res = response()
  await handler({ method: 'GET', headers: {} }, res)
  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.body, { ready: false })
})

test('readiness handler preserves success and migration-not-ready response bodies', async () => {
  const oldReadiness = process.env.ANALYTICS_READINESS_SECRET
  const oldCron = process.env.CRON_SECRET
  process.env.ANALYTICS_READINESS_SECRET = 'readiness-secret'
  process.env.CRON_SECRET = 'different-cron-secret'
  try {
    let handler = createAnalyticsReadinessHandler({ rpc: async () => ({ data: true, error: null }) })
    let res = response()
    await handler({ method: 'GET', headers: { authorization: 'Bearer readiness-secret' } }, res)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body, { ready: true, migration: '20260809020000' })

    handler = createAnalyticsReadinessHandler({ rpc: async () => ({ data: false, error: null }) })
    res = response()
    await handler({ method: 'GET', headers: { authorization: 'Bearer readiness-secret' } }, res)
    assert.equal(res.statusCode, 503)
    assert.deepEqual(res.body, { ready: false, migration: '20260809020000' })
  } finally {
    if (oldReadiness === undefined) delete process.env.ANALYTICS_READINESS_SECRET
    else process.env.ANALYTICS_READINESS_SECRET = oldReadiness
    if (oldCron === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = oldCron
  }
})
