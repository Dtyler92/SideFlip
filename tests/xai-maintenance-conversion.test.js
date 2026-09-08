import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const providerUrl = new URL('../supabase/functions/maintenance-research-worker/xai-provider.js', import.meta.url)
const workerUrl = new URL('../supabase/functions/maintenance-research-worker/worker-core.js', import.meta.url)
const validatorsUrl = new URL('../supabase/functions/_shared/research-validators.js', import.meta.url)
const migrationUrl = new URL('../supabase/migrations/20260908120000_convert_maintenance_research_to_xai.sql', import.meta.url)
const SUPPORTED_MODEL = 'grok-4.6'
const sourceUrl = 'https://www.scion.com/owners/manuals/2012-xd-maintenance.pdf'

function response({ text, ticks = 12_345_678, status = 'completed', model = SUPPORTED_MODEL, actions = [], annotations = [] }) {
  return {
    status, model, usage: {
      cost_in_usd_ticks: ticks,
      num_server_side_tools_used: actions.length,
      server_side_tool_usage_details: { web_search_calls: actions.length },
    },
    output: [
      ...actions.map((action, index) => ({ type: 'web_search_call', id: `ws-${index}`, status: 'completed', action })),
      { type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations }] },
    ],
  }
}

function evidence() {
  return {
    id: 'e1', title: '2012 Scion xD Warranty and Maintenance Guide', canonicalUrl: sourceUrl,
    exactExcerpt: 'Replace engine oil and oil filter every 5,000 miles or 6 months.',
    accessedAt: new Date().toISOString(), applicability: '2012 Scion xD', sourceClass: 'manufacturer',
    section: 'Maintenance Log', locationVerified: false, verificationStatus: 'provider_citation_unconfirmed',
  }
}

function discoveryReply(overrides = {}) {
  const item = evidence()
  return response({
    text: JSON.stringify({ evidence: [item] }),
    actions: [{ type: 'search', query: 'site:scion.com 2012 xD maintenance', sources: [{ type: 'url', url: sourceUrl }] }],
    annotations: [{ type: 'url_citation', url: sourceUrl, start_index: 0, end_index: 1, title: '1' }],
    ...overrides,
  })
}

function normalizedReply(overrides = {}) {
  return response({ text: JSON.stringify({ candidates: [{ name: 'Engine oil and filter', action: 'replace', profile: 'normal', dueSemantics: 'whichever_first', intervalMiles: 5000, intervalMonths: 6, evidenceIds: ['e1'], uncertainty: 'provider citation requires user review', conflict: false }], unresolved: [] }), ticks: 1, ...overrides })
}

function providerWithReplies(replies, calls = []) {
  return import(providerUrl).then(({ createXaiMaintenanceProvider }) => createXaiMaintenanceProvider({
    apiKey: 'test-key', model: SUPPORTED_MODEL, timeoutSeconds: 10,
    fetchImpl: async (url, options) => {
      calls.push({ url, headers: options.headers, body: JSON.parse(options.body) })
      return new Response(JSON.stringify(replies.shift()), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }))
}

test('xAI adapter sends fixed production-safe Responses requests and isolates normalization', async () => {
  const calls = []
  const provider = await providerWithReplies([discoveryReply(), normalizedReply()], calls)
  const domains = [{ domain: 'scion.com', sourceClass: 'manufacturer', includeSubdomains: true, allowedPathPrefixes: ['/'] }]
  const discovered = await provider.discover({ asset: { modelYear: 2012, make: 'Scion', model: 'xD' }, domains, maxSearches: 3, maxFetches: 2 })
  await provider.normalize({ evidence: discovered.evidence })
  assert.equal(calls[0].url, 'https://api.x.ai/v1/responses')
  assert.equal(calls[0].headers.Authorization, 'Bearer test-key')
  assert.equal(calls[0].body.model, SUPPORTED_MODEL)
  assert.equal(calls[0].body.store, false)
  assert.equal(calls[0].body.parallel_tool_calls, false)
  assert.equal(calls[0].body.max_turns, 5)
  assert.equal(calls[0].body.reasoning.effort, 'low')
  assert.ok(Number.isInteger(calls[0].body.max_output_tokens) && calls[0].body.max_output_tokens <= 12_000)
  assert.deepEqual(calls[0].body.include, ['web_search_call.action.sources'])
  assert.deepEqual(calls[0].body.tools, [{ type: 'web_search', filters: { allowed_domains: ['scion.com'] }, enable_image_search: false, enable_image_understanding: false }])
  assert.equal(calls[0].body.tool_choice, 'required')
  assert.equal('tools' in calls[1].body, false)
  const normalizationInput = JSON.parse(calls[1].body.input[1].content)
  assert.deepEqual(Object.keys(normalizationInput).sort(), ['evidence', 'task'])
  assert.doesNotMatch(JSON.stringify(normalizationInput), /confirmedVehicle|approvedSources|modelYear/)
  assert.deepEqual(discovered.proofs, [{ canonicalUrl: sourceUrl }])
  assert.equal(discovered.evidence[0].locationVerified, false)
  assert.equal(discovered.evidence[0].verificationStatus, 'provider_citation_unconfirmed')

  const narrowCalls = []
  const narrowProvider = await providerWithReplies([discoveryReply()], narrowCalls)
  await assert.rejects(() => narrowProvider.discover({
    asset: { modelYear: 2012, make: 'Scion', model: 'xD' },
    domains: [{ domain: 'scion.com', sourceClass: 'manufacturer', includeSubdomains: true, allowedPathPrefixes: ['/owners'] }],
    maxSearches: 3, maxFetches: 2,
  }), { code: 'RESEARCH_DISABLED' })
  assert.equal(narrowCalls.length, 0)
})

test('xAI adapter requires completed exact-model responses and valid exact cost ticks', async () => {
  for (const reply of [
    discoveryReply({ status: 'incomplete' }),
    discoveryReply({ model: 'grok-other' }),
    discoveryReply({ ticks: -1 }),
    discoveryReply({ ticks: 1.5 }),
    { ...discoveryReply(), usage: {} },
  ]) {
    const provider = await providerWithReplies([reply])
    await assert.rejects(() => provider.discover({ asset: { modelYear: 2012, make: 'Scion', model: 'xD' }, domains: [{ domain: 'scion.com', sourceClass: 'manufacturer', includeSubdomains: true, allowedPathPrefixes: ['/'] }], maxSearches: 3, maxFetches: 2 }), { code: 'INVALID_PROVIDER_RESPONSE' })
  }
  const incompleteProvider = await providerWithReplies([discoveryReply({ status: 'incomplete', ticks: 123 })])
  await assert.rejects(
    () => incompleteProvider.discover({ asset: { modelYear: 2012, make: 'Scion', model: 'xD' }, domains: [{ domain: 'scion.com', sourceClass: 'manufacturer', includeSubdomains: true, allowedPathPrefixes: ['/'] }], maxSearches: 3, maxFetches: 2 }),
    error => error?.code === 'INVALID_PROVIDER_RESPONSE' && error?.costInUsdTicks === 123,
  )
})

test('xAI adapter enforces action caps and source/citation URL intersection', async () => {
  const searches = Array.from({ length: 4 }, (_, index) => ({ type: 'search', query: `q${index}`, sources: [{ url: sourceUrl }] }))
  const overSearch = await providerWithReplies([discoveryReply({ actions: searches })])
  await assert.rejects(() => overSearch.discover({ asset: { modelYear: 2012, make: 'Scion', model: 'xD' }, domains: [{ domain: 'scion.com', sourceClass: 'manufacturer', includeSubdomains: true, allowedPathPrefixes: ['/'] }], maxSearches: 3, maxFetches: 2 }), /action cap/i)

  const browsing = [{ type: 'open_page', url: sourceUrl }, { type: 'find_in_page', url: sourceUrl, pattern: 'oil' }, { type: 'open_page', url: sourceUrl }]
  const overBrowse = await providerWithReplies([discoveryReply({ actions: browsing })])
  await assert.rejects(() => overBrowse.discover({ asset: { modelYear: 2012, make: 'Scion', model: 'xD' }, domains: [{ domain: 'scion.com', sourceClass: 'manufacturer', includeSubdomains: true, allowedPathPrefixes: ['/'] }], maxSearches: 3, maxFetches: 2 }), /action cap/i)

  for (const reply of [
    discoveryReply({ actions: [] }),
    { ...discoveryReply(), usage: { ...discoveryReply().usage, num_server_side_tools_used: 0 } },
  ]) {
    const provider = await providerWithReplies([reply])
    await assert.rejects(() => provider.discover({ asset: { modelYear: 2012, make: 'Scion', model: 'xD' }, domains: [{ domain: 'scion.com', sourceClass: 'manufacturer', includeSubdomains: true, allowedPathPrefixes: ['/'] }], maxSearches: 3, maxFetches: 2 }), { code: 'INVALID_PROVIDER_RESPONSE' })
  }

  for (const reply of [
    discoveryReply({ annotations: [{ type: 'url_citation', url: 'https://scion.com/other' }] }),
    discoveryReply({ actions: [{ type: 'search', query: 'q', sources: [{ url: 'https://scion.com/other' }] }] }),
  ]) {
    const provider = await providerWithReplies([reply])
    await assert.rejects(() => provider.discover({ asset: { modelYear: 2012, make: 'Scion', model: 'xD' }, domains: [{ domain: 'scion.com', sourceClass: 'manufacturer', includeSubdomains: true, allowedPathPrefixes: ['/'] }], maxSearches: 3, maxFetches: 2 }), { code: 'UNCITED_EVIDENCE' })
  }

  const escapedSource = await providerWithReplies([discoveryReply({ actions: [{ type: 'search', query: 'q', sources: [{ url: sourceUrl }, { url: 'https://evil.test/stolen' }] }] })])
  await assert.rejects(() => escapedSource.discover({ asset: { modelYear: 2012, make: 'Scion', model: 'xD' }, domains: [{ domain: 'scion.com', sourceClass: 'manufacturer', includeSubdomains: true, allowedPathPrefixes: ['/'] }], maxSearches: 3, maxFetches: 2 }), { code: 'UNAPPROVED_SOURCE' })
})

test('unconfirmed xAI evidence passes citation and path policy but never claims location verification', async () => {
  const { validateEvidenceRegistry } = await import(validatorsUrl)
  const item = evidence()
  const now = new Date(item.accessedAt)
  const domain = { domain: 'scion.com', sourceClass: 'manufacturer', includeSubdomains: true, allowedPathPrefixes: ['/owners/manuals'], termsReviewedOn: item.accessedAt.slice(0, 10), robotsReviewedOn: item.accessedAt.slice(0, 10) }
  const registry = validateEvidenceRegistry([item], [domain], [{ canonicalUrl: sourceUrl }], now)
  assert.equal(registry.get('e1').locationVerified, false)
  assert.equal(registry.get('e1').verificationStatus, 'provider_citation_unconfirmed')
  assert.throws(() => validateEvidenceRegistry([{ ...item, canonicalUrl: 'https://www.scion.com/sales/x' }], [domain], [{ canonicalUrl: 'https://www.scion.com/sales/x' }], now), { code: 'UNAPPROVED_SOURCE' })
  assert.throws(() => validateEvidenceRegistry([{ ...item, locationVerified: true }], [domain], [{ canonicalUrl: sourceUrl }], now), { code: 'INVALID_EVIDENCE' })
})

test('worker adds exact xAI ticks, uses 100 million ticks per cent, and preserves exact settlement usage', async () => {
  const { processLeasedJob } = await import(workerUrl)
  const item = evidence()
  const reviewedOn = item.accessedAt.slice(0, 10)
  let settled
  const provider = {
    discover: async () => ({ evidence: [item], proofs: [{ canonicalUrl: sourceUrl }], usage: { costInUsdTicks: 10_000_001, searches: 1, fetches: 2 } }),
    normalize: async () => ({ ...JSON.parse(normalizedReply().output[0].content[0].text), usage: { costInUsdTicks: 9_999_999 } }),
  }
  await processLeasedJob({
    lease: { id: 'job', lease_token: 'token', reserved_cents: 306, request_snapshot: { modelYear: 2012, make: 'Scion', model: 'xD' } },
    config: { maxSearches: 3, maxFetches: 2 },
    domains: [{ domain: 'scion.com', sourceClass: 'manufacturer', includeSubdomains: true, allowedPathPrefixes: ['/owners/manuals'], termsReviewedOn: reviewedOn, robotsReviewedOn: reviewedOn }],
    provider, db: { settle: async value => { settled = value }, fail: async value => { throw value } },
  })
  assert.equal(settled.costInUsdTicks, 20_000_000)
  assert.equal('costCents' in settled, false)
  assert.equal(settled.evidence[0].verificationStatus, 'provider_citation_unconfirmed')

  const overBudgetProvider = {
    ...provider,
    discover: async () => ({ evidence: [item], proofs: [{ canonicalUrl: sourceUrl }], usage: { costInUsdTicks: 100_000_001, searches: 1, fetches: 0 } }),
    normalize: async () => ({ ...JSON.parse(normalizedReply().output[0].content[0].text), usage: { costInUsdTicks: 0 } }),
  }
  let failed
  await assert.rejects(() => processLeasedJob({
    lease: { id: 'job-2', lease_token: 'token-2', reserved_cents: 1, request_snapshot: { modelYear: 2012, make: 'Scion', model: 'xD' } },
    config: { maxSearches: 3, maxFetches: 2 }, domains: [{ domain: 'scion.com', sourceClass: 'manufacturer', includeSubdomains: true, allowedPathPrefixes: ['/owners/manuals'], termsReviewedOn: reviewedOn, robotsReviewedOn: reviewedOn }],
    provider: overBudgetProvider, db: { settle: async () => {}, fail: async value => { failed = value } },
  }), { code: 'BUDGET_EXCEEDED' })
  assert.equal(failed.costInUsdTicks, 100_000_001)
})

test('worker reports known provider ticks on failure and null when accepted spend is unknowable', async () => {
  const { processLeasedJob } = await import(workerUrl)
  const lease = { id: 'job', lease_token: 'token', reserved_cents: 2500, request_snapshot: { modelYear: 2012, make: 'Scion', model: 'xD' } }
  const config = { maxSearches: 3, maxFetches: 2 }
  const reviewedOn = new Date().toISOString().slice(0, 10)
  const domains = [{ domain: 'scion.com', sourceClass: 'manufacturer', includeSubdomains: true, allowedPathPrefixes: ['/'], termsReviewedOn: reviewedOn, robotsReviewedOn: reviewedOn }]
  const item = { ...evidence(), canonicalUrl: sourceUrl }
  for (const [error, expected] of [
    [Object.assign(new Error('bad response'), { code: 'INVALID_PROVIDER_RESPONSE', costInUsdTicks: 123 }), 123],
    [Object.assign(new Error('timeout'), { code: 'PROVIDER_TRANSIENT' }), null],
  ]) {
    let failure
    await assert.rejects(() => processLeasedJob({ lease, config, domains, provider: { discover: async () => { throw error } }, db: { settle: async () => {}, fail: async value => { failure = value } } }))
    assert.equal(failure.costInUsdTicks, expected)
  }
  let failure
  const normalizationError = Object.assign(new Error('invalid normalization'), { code: 'INVALID_PROVIDER_RESPONSE', costInUsdTicks: 7 })
  await assert.rejects(() => processLeasedJob({ lease, config, domains, provider: {
    discover: async () => ({ evidence: [item], proofs: [{ canonicalUrl: sourceUrl }], usage: { costInUsdTicks: 5, searches: 1, fetches: 0 } }),
    normalize: async () => { throw normalizationError },
  }, db: { settle: async () => {}, fail: async value => { failure = value } } }))
  assert.equal(failure.costInUsdTicks, 12)
})

test('additive conversion migration disables first, supersedes work, and gates explicit source review', () => {
  const source = readFileSync(migrationUrl, 'utf8')
  assert.match(source, /update private\.my_stuff_research_runtime_config\s+set enabled=false[\s\S]+cron\.unschedule/i)
  assert.match(source, /status in \('queued','running','awaiting_review','approved'\)/i)
  assert.match(source, /reservation_month[\s\S]+reserved_cents-coalesce\([^)]*actual_cents/i)
  assert.match(source, /provider_name='xai'[\s\S]+provider_model='grok-4\.6'[\s\S]+retention_policy='standard-30-days-store-false'/i)
  assert.match(source, /per_job_budget_cents=2500[\s\S]+monthly_user_budget_cents=2500/i)
  assert.match(source, /my_stuff_research_one_global_running_idx[\s\S]+where status='running'/i)
  assert.match(source, /p_cost_ticks::numeric\/100000000/i)
  assert.match(source, /fail_my_stuff_research_job_v2[\s\S]+p_cost_ticks is null then least\(1250/i)
  assert.match(source, /verification_status[^;]+provider_citation_unconfirmed/is)
  assert.match(source, /create or replace function public\.approve_my_stuff_research_v2\(p_job_id uuid,p_candidate_ids uuid\[\],p_sources_verified boolean,p_mutation_id text\)/i)
  assert.equal((source.match(/from private\.my_stuff_research_approvals where user_id=v_user and client_mutation_id=trim\(p_mutation_id\)/gi) || []).length, 2)
  assert.match(source, /pg_advisory_xact_lock[\s\S]+Recheck before reading mutable job identity[\s\S]+client_mutation_id=trim\(p_mutation_id\)/i)
  assert.match(source, /if p_sources_verified is not true then raise exception 'SOURCES_NOT_VERIFIED'/i)
  assert.match(source, /approve_my_stuff_research_v1[\s\S]+UNCONFIRMED_EVIDENCE_REQUIRES_V2_APPROVAL/i)
  assert.match(source, /enabled=false/i)
  const installation = source.split('create or replace function private.activate_my_stuff_research_v1()', 1)[0]
  assert.doesNotMatch(installation, /update private\.my_stuff_research_runtime_config\s+set enabled=true/i)
  assert.doesNotMatch(installation, /cron\.schedule/i)
})

test('Edge worker is xAI-only and uses exact-tick v2 worker RPCs under a 2500-cent reservation', () => {
  const index = readFileSync(new URL('../supabase/functions/maintenance-research-worker/index.ts', import.meta.url), 'utf8')
  assert.match(index, /createXaiMaintenanceProvider/)
  assert.match(index, /required\(['"]XAI_API_KEY['"]\)/)
  assert.match(index, /lease_my_stuff_research_worker_v2/)
  assert.match(index, /settle_my_stuff_research_worker_v2[\s\S]+p_cost_ticks/)
  assert.match(index, /fail_my_stuff_research_worker_v2[\s\S]+p_cost_ticks/)
  assert.doesNotMatch(index, /ANTHROPIC_API_KEY|createAnthropicMaintenanceProvider/)
  const migration = readFileSync(migrationUrl, 'utf8')
  assert.match(migration, /per_job_budget_cents=2500/i)
  assert.match(migration, /max_attempts\s*\*\s*1250/i)
})
