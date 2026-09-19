import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createXaiMaintenanceProvider } from '../supabase/functions/maintenance-research-worker/xai-provider.js'
import { processLeasedJob } from '../supabase/functions/maintenance-research-worker/worker-core.js'
import { failureDiagnostic, emitFailureDiagnostic } from '../supabase/functions/maintenance-research-worker/failure-diagnostics.js'

const privateText = 'PRIVATE_VIN_OWNER_QUOTE https://private.test/?secret=abc'
const url = 'https://scion.com/manual.pdf'
const today = new Date().toISOString()
const item = { id: 'e1', title: 'Manual', section: 'Maintenance', canonicalUrl: url, exactExcerpt: 'Replace engine oil every 5000 miles or 6 months.', accessedAt: today, applicability: '2012 Scion xD', sourceClass: 'manufacturer', locationVerified: false, verificationStatus: 'provider_citation_unconfirmed' }
const domains = [{ domain: 'scion.com', sourceClass: 'manufacturer', includeSubdomains: true, allowedPathPrefixes: ['/'], termsReviewedOn: today.slice(0,10), robotsReviewedOn: today.slice(0,10) }]
const discovery = () => ({ evidence: [item], proofs: [{ canonicalUrl: url }], usage: { costInUsdTicks: 5, searches: 1, fetches: 0 } })
const normalized = () => ({ candidates: [], unresolved: [], proposals: [], usage: { costInUsdTicks: 7 } })
const reply = text => ({ status: 'completed', model: 'grok-4.6', usage: { cost_in_usd_ticks: 7, num_server_side_tools_used: 1, server_side_tool_usage_details: { web_search_calls: 1 } }, output: [{ type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url }] } }, { type: 'message', status: 'completed', content: [{ type: 'output_text', text, annotations: [{ type: 'url_citation', url }] }] }] })
async function run(provider, settle = async () => {}, fail = async () => {}) {
  return processLeasedJob({ lease: { id: 'private-job', lease_token: 'private-token', reserved_cents: 100, request_snapshot: { modelYear: 2012, make: 'Scion', model: 'xD' } }, config: { maxSearches: 3, maxFetches: 2 }, domains, provider, db: { settle, fail } })
}
function adapter(body) { return createXaiMaintenanceProvider({ apiKey: 'offline', model: 'grok-4.6', timeoutSeconds: 10, fetchImpl: async () => new Response(body) }) }
async function rejectsAt(provider, stage, reason, ticks, settle) {
  let failed
  await assert.rejects(() => run(provider, settle, async v => { failed = v }), error => {
    const value = failureDiagnostic(error)
    assert.equal(value.stage, stage)
    assert.equal(value.reason, reason)
    assert.deepEqual(Object.keys(value).sort(), ['code', 'event', 'reason', 'stage'])
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE|private|secret|https|quote|token/)
    assert.doesNotThrow(() => emitFailureDiagnostic(error, () => { throw new Error(privateText) }))
    return true
  })
  assert.equal(failed.costInUsdTicks, ticks)
  assert.equal(failed.detail, failed.code)
}
test('actual adapter distinguishes decode, schema, proof and action limits without payload logs', async () => {
  await rejectsAt(adapter(privateText), 'discovery_response', 'response_json_invalid', null)
  await rejectsAt(adapter(JSON.stringify(reply(privateText))), 'discovery_schema', 'output_json_invalid', 7)
  const uncited = reply(JSON.stringify({ evidence: [item] })); uncited.output[1].content[0].annotations = []
  await rejectsAt(adapter(JSON.stringify(uncited)), 'discovery_proof', 'evidence_uncited', 7)
  const capped = reply('{}'); capped.output[0].action.type = 'open_page'; capped.output[0].action.url = url
  await rejectsAt(adapter(JSON.stringify(capped)), 'discovery_limits', 'action_cap_invalid', 7)
})
test('normalization decode/schema and support keep both known paid stages', async () => {
  await rejectsAt({ discover: async () => discovery(), normalize: adapter(privateText).normalize }, 'normalization_response', 'response_json_invalid', null)
  await rejectsAt({ discover: async () => discovery(), normalize: adapter(JSON.stringify(reply(privateText))).normalize }, 'normalization_schema', 'output_json_invalid', 12)
  await rejectsAt({ discover: async () => discovery(), normalize: async () => ({ ...normalized(), candidates: [{ name: privateText }] }) }, 'normalization_support', 'boundary_failed', 12)
})
test('worker distinguishes validation, settlement and fail RPC; never trusts arbitrary properties/messages', async () => {
  const forged = Object.assign(new Error('xAI output JSON is invalid'), { code: privateText, stage: 'discovery_schema', reason: 'output_json_invalid', costInUsdTicks: 7 })
  await rejectsAt({ discover: async () => { throw forged } }, 'discovery_response', 'boundary_failed', 7)
  assert.equal(failureDiagnostic(forged).code, 'WORKER_ERROR')
  await rejectsAt({ discover: async () => ({ ...discovery(), evidence: null }) }, 'discovery_proof', 'boundary_failed', 5)
  await rejectsAt({ discover: async () => discovery(), normalize: async () => normalized() }, 'settlement', 'boundary_failed', 12, async () => { throw new Error(privateText) })
  const failError = new Error(privateText)
  await assert.rejects(() => run({ discover: async () => { throw new Error(privateText) } }, undefined, async () => { throw failError }), e => e === failError && failureDiagnostic(e).stage === 'failure_settlement')
})
test('actual adapter success and transient errors preserve calls, identity and exact costs', async () => {
  let calls = 0
  let settled
  const provider = createXaiMaintenanceProvider({ apiKey: 'offline', model: 'grok-4.6', timeoutSeconds: 10, fetchImpl: async () => {
    calls++
    return new Response(JSON.stringify(reply(JSON.stringify(calls === 1 ? { evidence: [item] } : { candidates: [], unresolved: [], proposals: [] }))))
  } })
  await run(provider, async value => { settled = value })
  assert.equal(calls, 2)
  assert.equal(settled.costInUsdTicks, 14)
  const original = Object.freeze(Object.assign(new Error(privateText), { code: 'PROVIDER_TRANSIENT', costInUsdTicks: 7 }))
  let attempts = 0
  await assert.rejects(() => run({ discover: async () => { attempts++; throw original } }), error => error === original)
  assert.equal(attempts, 1)
  assert.equal(failureDiagnostic(original).code, 'PROVIDER_TRANSIENT')
  await rejectsAt({ discover: async () => ({ ...discovery(), usage: {} }) }, 'discovery_schema', 'boundary_failed', null)
  await rejectsAt({ discover: async () => discovery(), normalize: async () => ({ ...normalized(), usage: {} }) }, 'normalization_schema', 'boundary_failed', 5)
})

test('success remains identical and Edge uses bounded diagnostic emitter', async () => {
  let settled
  const result = await run({ discover: async () => discovery(), normalize: async () => normalized() }, async v => { settled = v })
  assert.deepEqual(result, { jobId: 'private-job', candidateCount: 0 })
  assert.equal(settled.costInUsdTicks, 12)
  const index = readFileSync(new URL('../supabase/functions/maintenance-research-worker/index.ts', import.meta.url), 'utf8')
  assert.match(index, /emitFailureDiagnostic\(error\)/)
  assert.match(index, /error: 'worker_failed'/)
  const events = []
  emitFailureDiagnostic(new Error(privateText), v => events.push(v))
  assert.deepEqual(events, [{ event: 'maintenance_research_worker_failed', code: 'WORKER_ERROR', stage: 'worker_setup', reason: 'unclassified' }])
})
