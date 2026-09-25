import test from 'node:test'
import assert from 'node:assert/strict'
import { createMaintenanceDeletionHandler } from '../api/_lib/maintenance-deletion-handler.js'

function response() {
  return {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

test('maintenance deletion cron is GET-only and requires the exact cron bearer secret', async () => {
  let calls = 0
  const handler = createMaintenanceDeletionHandler({}, {
    cronSecret: 'test-secret', deploymentIdentity: 'deployment-test',
    runWorker: async () => { calls++; return { claimed: 0, results: [] } },
  })
  for (const req of [
    { method: 'POST', headers: { authorization: 'Bearer test-secret' }, expected: 405 },
    { method: 'GET', headers: {}, expected: 401 },
    { method: 'GET', headers: { authorization: 'Bearer wrong' }, expected: 401 },
  ]) {
    const res = response()
    await handler(req, res)
    assert.equal(res.statusCode, req.expected)
  }
  assert.equal(calls, 0)
})

test('maintenance deletion cron accepts the dedicated production secret without replacing shared cron auth', async () => {
  const oldDedicated = process.env.MAINTENANCE_DELETION_CRON_SECRET
  const oldShared = process.env.CRON_SECRET
  process.env.MAINTENANCE_DELETION_CRON_SECRET = 'dedicated-secret'
  process.env.CRON_SECRET = 'shared-secret'
  try {
    const handler = createMaintenanceDeletionHandler({}, { runWorker: async () => ({ claimed:0, results:[] }) })
    for (const secret of ['dedicated-secret', 'shared-secret']) {
      const res = response()
      await handler({ method:'GET', headers:{ authorization:`Bearer ${secret}` } }, res)
      assert.equal(res.statusCode, 200)
    }
  } finally {
    if (oldDedicated === undefined) delete process.env.MAINTENANCE_DELETION_CRON_SECRET
    else process.env.MAINTENANCE_DELETION_CRON_SECRET = oldDedicated
    if (oldShared === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = oldShared
  }
})

test('maintenance deletion cron invokes a bounded worker and exposes counts only', async () => {
  let received
  const handler = createMaintenanceDeletionHandler({ marker: true }, {
    cronSecret: 'test-secret', deploymentIdentity: 'dpl_exact',
    runWorker: async options => {
      received = options
      return { claimed: 2, results: [{ status: 'complete' }, { status: 'failed', error: 'private' }] }
    },
  })
  const res = response()
  await handler({ method: 'GET', headers: { authorization: 'Bearer test-secret' } }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { claimed: 2, completed: 1, failed: 1 })
  assert.equal(received.workerId, 'vercel:dpl_exact')
  assert.equal(received.batchSize, 10)
  assert.equal(received.maxObjectsPerClaim, 1000)
  assert.equal(received.pageSize, 100)
  assert.equal(received.removeBatchSize, 100)
  assert.equal(received.maxDeletePasses, 12)
  assert.equal(received.maxTraversalDepth, 12)
  assert.equal(received.maxListRequests, 250)
  assert.equal(JSON.stringify(res.body).includes('private'), false)
})

test('maintenance deletion cron fails closed without leaking worker errors', async () => {
  const handler = createMaintenanceDeletionHandler({}, {
    cronSecret: 'test-secret',
    runWorker: async () => { throw new Error('storage secret detail') },
  })
  const res = response()
  await handler({ method: 'GET', headers: { authorization: 'Bearer test-secret' } }, res)
  assert.equal(res.statusCode, 503)
  assert.deepEqual(res.body, { error: 'Maintenance deletion worker unavailable' })
})
