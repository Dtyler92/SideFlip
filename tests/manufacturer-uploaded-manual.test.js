import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createXaiMaintenanceProvider, SUPPORTED_MODEL } from '../supabase/functions/maintenance-research-worker/xai-provider.js'
import { validateEvidenceRegistry, validateNormalizedCandidates, validateUnresolvedResults, registryToJson } from '../supabase/functions/_shared/research-validators.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/2012-scion-xd-uploaded-manual.json', import.meta.url)))
const now = new Date('2026-09-16T12:00:00.000Z')
// Policy dates and URL proof below are test scaffolding, NOT real source approval or live citation proof.
const domains = [{ domain: 'assets.sia.toyota.com', sourceClass: 'manufacturer', includeSubdomains: true, allowedPathPrefixes: ['/'], termsReviewedOn: '2026-09-16', robotsReviewedOn: '2026-09-16' }]
const evidence = fixture.excerpts.map(row => ({ id: row.id, canonicalUrl: fixture.canonicalUrl, title: fixture.title,
  exactExcerpt: row.exactExcerpt, page: `printed ${row.printedPage}; PDF ${row.pdfPage}`, applicability: '2012 Scion xD; operating conditions and fluid type must be checked separately',
  accessedAt: now.toISOString(), sourceClass: 'manufacturer', locationVerified: false, verificationStatus: 'provider_citation_unconfirmed' }))
const registry = () => validateEvidenceRegistry(evidence, domains, [{ canonicalUrl: fixture.canonicalUrl }], now)

async function offlineNormalize(expected, entries = registryToJson(registry())) {
  let calls = 0
  const provider = createXaiMaintenanceProvider({ apiKey: 'offline-placeholder', model: SUPPORTED_MODEL, timeoutSeconds: 10,
    fetchImpl: async (_, options) => {
      calls++
      const body = JSON.parse(options.body)
      assert.equal(body.tools, undefined)
      assert.deepEqual(JSON.parse(body.input[1].content).evidence, entries)
      assert.match(body.input[0].content, /Never invent an interval or change an inspection/)
      // Explicitly scripted response exercises real parsing, not model inference.
      return new Response(JSON.stringify({ status: 'completed', model: SUPPORTED_MODEL, usage: { cost_in_usd_ticks: 0 },
        output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(expected) }] }] }), { status: 200 })
    } })
  const parsed = await provider.normalize({ evidence: entries })
  assert.equal(calls, 1)
  return parsed
}

test('uploaded guide: adapter preserves expectations but untyped chart scope fails closed', async () => {
  const parsed = await offlineNormalize(fixture.expected)
  const unresolved = validateUnresolvedResults(parsed.unresolved)
  assert.deepEqual(parsed.candidates, fixture.expected.candidates)
  assert.equal(parsed.candidates.length, 3)
  // Genuine source fixture remains unchanged. Its flattened chart excerpts cannot
  // authenticate heading/note scope or prove recurring rather than milestone use.
  for (const candidate of parsed.candidates) {
    assert.throws(() => validateNormalizedCandidates([candidate], registry(), unresolved), /support/i)
  }
  assert.deepEqual(unresolved, fixture.expected.unresolved)
  assert.equal(parsed.usage.costInUsdTicks, 0)
  assert.ok([...registry().values()].every(row => row.locationVerified === false && row.verificationStatus === 'provider_citation_unconfirmed'))
})

test('uploaded chart fixture retains repeated headings and named rows, not recurrence approval', () => {
  for (const candidate of fixture.expected.candidates) {
    const logs = candidate.evidenceIds.filter(id => id.startsWith('log-')).map(id => fixture.excerpts.find(row => row.id === id))
    assert.ok(logs.length >= 4)
    for (const row of logs) {
      const [, miles, months] = row.exactExcerpt.match(/^([\d,]+) miles or (\d+) months/)
      assert.equal(Number(miles.replaceAll(',', '')) % candidate.intervalMiles, 0)
      assert.equal(Number(months) % candidate.intervalMonths, 0)
      assert.ok(row.exactExcerpt.toLowerCase().includes(candidate.name))
      assert.equal(Number(row.printedPage), row.pdfPage)
      if (candidate.action === 'replace') assert.match(row.exactExcerpt, /Replace engine air filter/)
      else assert.ok(row.exactExcerpt.indexOf(candidate.name[0].toUpperCase() + candidate.name.slice(1)) > row.exactExcerpt.indexOf('Inspect the following:'))
    }
    assert.equal(candidate.dueSemantics, 'whichever_first')
  }
})

test('oil branches and initial/subsequent coolant stay unresolved; conflicting simple cycles reject', async () => {
  const parsed = await offlineNormalize(fixture.expected)
  for (const unresolved of parsed.unresolved) {
    const forced = { ...fixture.expected.candidates[0], name: unresolved.name, evidenceIds: [unresolved.name === 'engine coolant' ? 'coolant-repeat' : 'oil'] }
    assert.throws(() => validateNormalizedCandidates([forced], registry(), validateUnresolvedResults(parsed.unresolved)), /conflicts with an unresolved task/)
  }
  assert.match(fixture.excerpts.find(x => x.id === 'oil').exactExcerpt, /10,000 miles or 12 months IF 0W20/)
  assert.match(fixture.excerpts.find(x => x.id === 'oil').exactExcerpt, /5,000 miles or 6 months, REGARDLESS/)
  assert.match(fixture.excerpts.find(x => x.id === 'coolant-repeat').exactExcerpt, /Initial replacement at 100,000 miles\/120 months\. Replace every 50,000 miles\/60 months/)
})

test('prior generalized excerpt response yields no invented task; explicit unresolved conflict rejects', async () => {
  const general = registryToJson(registry()).filter(row => row.id === 'cadence')
  const expected = { candidates: [], unresolved: [{ name: 'scheduled maintenance', reason: 'General cadence names no specific inspect/adjust/replace task; no interval inferred.' }] }
  const parsed = await offlineNormalize(expected, general)
  const unresolved = validateUnresolvedResults(parsed.unresolved)
  assert.deepEqual(validateNormalizedCandidates(parsed.candidates, new Map(general.map(x => [x.id, x])), unresolved), [])
  assert.throws(() => validateNormalizedCandidates([{ ...fixture.expected.candidates[0], name: 'scheduled maintenance', evidenceIds: ['cadence'] }], registry(), unresolved), /conflicts/)
})

test('upload alone cannot satisfy provider citation or owner verification gates', () => {
  assert.throws(() => validateEvidenceRegistry(evidence, domains, [], now), /not backed by a provider citation/)
  assert.throws(() => validateEvidenceRegistry(evidence.map(row => ({ ...row, locationVerified: true })), domains, [{ canonicalUrl: fixture.canonicalUrl }], now), /incomplete, unsafe, or unverified/)
})

test('reject unsupported task, action, interval and isolated milestones without unresolved hints', () => {
  const base = fixture.expected.candidates[0]
  for (const candidate of [
    { ...base, name: 'invented unnamed task', evidenceIds: ['cadence'] },
    { ...base, evidenceIds: ['oil'] },
    { ...fixture.expected.candidates[1], action: 'replace' },
    { ...base, intervalMiles: 5000, intervalMonths: 6 },
    { ...base, intervalMonths: 18 },
    { ...base, evidenceIds: ['log-39', 'cadence'] },
    { ...base, profile: 'severe' },
    { ...base, intervalHours: 100 },
    { ...base, dueSemantics: 'all' },
    { ...base, name: 'engine coolant', evidenceIds: ['log-39', 'log-43'] },
    { ...base, name: 'engine oil and oil filter', intervalMiles: 10000, intervalMonths: 12, evidenceIds: ['oil'] },
    { ...base, name: 'engine coolant', intervalMiles: 50000, intervalMonths: 60, evidenceIds: ['coolant-first', 'coolant-repeat'] },
  ]) assert.throws(() => validateNormalizedCandidates([candidate], registry()), /support/i)
})

test('bounded grammar fails closed on unknown language, conditions and mismatched paired units', () => {
  const base = { ...fixture.expected.candidates[0], evidenceIds: ['e'], intervalMiles: 30000, intervalMonths: 36 }
  const check = (candidate, excerpt) => validateNormalizedCandidates([candidate], new Map([['e', { exactExcerpt: excerpt }]]))
  for (const excerpt of [
    'Replace engine air filter every 30,000 miles or 36 months if dusty.',
    'Initially replace engine air filter at 30,000 miles or 36 months; thereafter every 15,000 miles or 18 months.',
    'Inspect engine air filter every 30,000 miles or 36 months. Replace brake pads every 30,000 miles or 36 months.',
    'Remplacer le filtre à air tous les 30,000 miles ou 36 mois.',
    'Replace engine air filter every 30,000 miles or 18 months.',
    'Do not replace engine air filter every 30,000 miles or 36 months.',
  ]) assert.throws(() => check(base, excerpt), /support/i)
  assert.equal(check(base, 'Replace engine air filter every 30,000 miles or 36 months.').length, 1)
  assert.throws(() => check({ ...base, name: 'Engine oil and filter' }, 'Replace engine oil and oil filter every 30,000 miles or 36 months.'), /support/i)
  assert.equal(check({ ...base, name: 'Engine oil and oil filter' }, 'Replace engine oil and oil filter every 30,000 miles or 36 months.').length, 1)
  const rows = new Map([
    ['e', { exactExcerpt: 'Replace engine air filter every 30,000 miles or 36 months.' }],
    ['condition', { exactExcerpt: 'Engine air filter: use this interval only if dusty.' }],
  ])
  assert.throws(() => validateNormalizedCandidates([{ ...base, evidenceIds: ['e', 'condition'] }], rows), /support/i)
  const negativeChart = new Map([1, 2].map(n => [String(n), { exactExcerpt: `${30000 * n} miles or ${36 * n} months Do not Replace engine air filter` }]))
  assert.throws(() => validateNormalizedCandidates([{ ...base, evidenceIds: ['1', '2'] }], negativeChart), /support/i)
})
