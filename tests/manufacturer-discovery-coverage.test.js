import test from 'node:test'
import assert from 'node:assert/strict'
import { createXaiMaintenanceProvider, SUPPORTED_MODEL } from '../supabase/functions/maintenance-research-worker/xai-provider.js'

test('discovery requests named schedule rows and retains conditional exclusions within existing caps', async () => {
  let body
  // Request-contract test only; no model output or live extraction is simulated.
  const provider = createXaiMaintenanceProvider({ apiKey: 'offline-test', model: SUPPORTED_MODEL, timeoutSeconds: 10,
    fetchImpl: async (_, options) => { body = JSON.parse(options.body); throw new Error('offline request captured') },
  })
  await assert.rejects(provider.discover({ asset: { make: 'Toyota', model: 'Scion xD', modelYear: 2012 },
    domains: [{ domain: 'assets.sia.toyota.com', sourceClass: 'manufacturer', includeSubdomains: true, allowedPathPrefixes: ['/'] }], maxSearches: 3, maxFetches: 2 }), /offline request captured/)
  const request = JSON.parse(body.input[1].content)
  assert.match(request.task, /named routine maintenance tasks/)
  assert.match(request.task, /schedule rows/)
  assert.match(request.task, /recurrence/)
  assert.match(request.task, /conditional oil/)
  assert.match(request.task, /initial.*subsequent/)
  assert.match(request.task, /Do not infer/)
  assert.equal(request.maxSearches, 3)
  assert.equal(request.maxFetches, 2)
  assert.equal(body.max_turns, 5)
  assert.equal(body.max_output_tokens, 12000)
})
