import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createMaintenanceResearchClient } from '../src/myStuff/maintenanceResearchClient.js'
import {
  createResearchRequestGate,
  evidenceForCandidate,
  formatResearchInterval,
  normalizeResearchReview,
  normalizeResearchStatus,
  researchCanPoll,
  researchEvidenceVerificationLabel,
  researchSourceAccessibilityLabel,
  researchSourceClassLabel,
} from '../src/myStuff/maintenanceResearchModel.js'
import {
  applyVinSuggestions,
  buildVehicleConfirmationSnapshot,
  createVinDecodeRequestGate,
  decodedVehicleSuggestions,
  maskVin,
  mergeDecodedSuggestions,
  normalizeVin,
  validateVin,
} from '../src/myStuff/vinModel.js'
import { requiresResearchIdentityReconfirmation, supportsVinDecoder } from '../src/myStuff/itemModel.js'

const source = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
const VIN = '1HGCM82633A004352'

test('VIN helpers validate, mask, merge, and snapshot confirmed identity', () => {
  assert.equal(normalizeVin(' 1hg-cm826 33a004352 '), VIN)
  assert.equal(validateVin(VIN).canDecode, true)
  assert.equal(validateVin('1HGCM82643A004352').canDecode, false)
  assert.match(validateVin('short-id').reason, /manual entry/i)
  assert.equal(maskVin(VIN), '•••••••••••••4352')
  const decoded = decodedVehicleSuggestions({ modelYear: 2003, make: 'HONDA', model: 'Accord', trim: 'EX', engineCylinders: 6, displacementLiters: 3, transmissionStyle: 'Automatic' })
  const current = { vin: VIN, year: '2003', make: 'Honda', model: '', trim: 'LX' }
  const preview = mergeDecodedSuggestions(current, decoded)
  assert.equal(preview.fields.model.status, 'suggested')
  assert.equal(preview.fields.trim.status, 'conflicting')
  assert.equal(applyVinSuggestions(current, preview.fields, { fields: ['trim'] }).trim, 'EX')
  const snapshot = buildVehicleConfirmationSnapshot(current, preview.fields)
  assert.equal(snapshot.vin, VIN)
  assert.equal(snapshot.model, 'Accord')
  assert.equal(snapshot.trim, 'LX')
})

test('VIN request gate aborts stale work and item type helpers fail closed', () => {
  const gate = createVinDecodeRequestGate()
  const first = gate.begin(VIN)
  assert.equal(gate.isCurrent(first, VIN), true)
  gate.invalidate()
  assert.equal(first.controller.signal.aborted, true)
  assert.equal(gate.isCurrent(first, VIN), false)
  assert.equal(supportsVinDecoder('car'), true)
  assert.equal(supportsVinDecoder('truck'), true)
  assert.equal(supportsVinDecoder('mower'), false)
  assert.equal(requiresResearchIdentityReconfirmation('car', 'truck'), true)
  assert.equal(requiresResearchIdentityReconfirmation('truck', 'truck'), false)
})

test('research client uses exact lifecycle RPC contracts and source attestation', async () => {
  const calls = []
  const client = createMaintenanceResearchClient({ rpc: async (name, payload) => { calls.push({ name, payload }); return { data: { name }, error: null } } })
  await client.enqueue('item-1', 'fingerprint', 'enqueue-1')
  await client.getStatus('item-1')
  await client.getReview('job-1')
  await client.approve('job-1', ['candidate-1'], true, 'approve-1')
  await client.apply('approval-1', 'apply-1')
  await client.cancel('job-1', 'cancel-1')
  assert.deepEqual(calls.map(value => value.name), ['enqueue_my_stuff_research_v3', 'get_my_stuff_research_status_v1', 'get_my_stuff_research_review_v1', 'approve_my_stuff_research_v2', 'apply_my_stuff_research_v1', 'cancel_my_stuff_research_v1'])
  assert.deepEqual(calls[3].payload, { p_job_id: 'job-1', p_candidate_ids: ['candidate-1'], p_sources_verified: true, p_mutation_id: 'approve-1' })
  await assert.rejects(() => client.approve('job-1', ['candidate-1'], false, 'approve-2'), /SOURCES_NOT_VERIFIED/)
  await assert.rejects(() => client.approve('job-1', [], true, 'approve-2'), /CANDIDATES_REQUIRED/)
})

test('research normalization joins evidence and labels unknown sources as unverified', () => {
  const status = normalizeResearchStatus({ id: 'job-1', status: 'awaiting_review', approval_id: null })
  assert.equal(status.jobId, 'job-1')
  const review = normalizeResearchReview({
    job: status,
    candidates: [{ id: 'candidate-1', name: 'Engine oil', interval_miles: 7500, evidence_ids: ['e1'] }],
    evidence: [{ evidence_key: 'e1', title: 'Owner guide', canonical_url: 'https://example.test/guide', exact_excerpt: 'Replace every 7,500 miles.', accessed_at: '2026-09-08T00:00:00Z', source_class: 'manufacturer', location_verified: false, page: '42' }],
    unresolved: [{ name: 'Coolant', reason: 'Conflicting intervals' }],
  })
  assert.equal(formatResearchInterval(review.candidates[0]), 'Every 7,500 mi')
  assert.equal(evidenceForCandidate(review.candidates[0], review.evidence)[0].key, 'e1')
  assert.match(researchEvidenceVerificationLabel(review.evidence[0]), /not verified/i)
  assert.equal(researchSourceClassLabel('unexpected'), 'Unverified source')
  assert.equal(researchSourceAccessibilityLabel(review.evidence[0]), 'Manufacturer source: Owner guide')
  assert.equal(researchCanPoll('running'), true)
  assert.equal(researchCanPoll('awaiting_review'), false)
})

test('research gate rejects stale item and inactive component requests', () => {
  const gate = createResearchRequestGate()
  gate.activate('item-a')
  const request = gate.snapshot('item-a')
  assert.equal(gate.isCurrent(request, 'item-a', true), true)
  assert.equal(gate.isCurrent(request, 'item-b', true), false)
  gate.invalidate()
  assert.equal(gate.isCurrent(request, 'item-a', true), false)
})

test('reusable PWA panels expose explicit VIN confirmation and research review gates', () => {
  const vin = source('src/components/MyStuffVinDecodePanel.jsx')
  const research = source('src/components/ManufacturerMaintenanceResearch.jsx')
  assert.match(vin, /\/api\/decode-vin/)
  assert.match(vin, /subjectType:\s*'my_stuff_item'/)
  assert.match(vin, /Unconfirmed editable review/)
  assert.match(vin, /Confirm Vehicle/)
  assert.match(vin, /persistIdentity/)
  assert.match(source('src/myStuff/client.js'), /confirm_my_stuff_vehicle_identity_v3/)
  assert.match(research, /Grok uses real web search/i)
  assert.match(research, /VIN, serial number, notes, location, costs, and expenses are never sent/i)
  assert.match(research, /Review suggestions/)
  assert.match(research, /Open source/)
  assert.match(research, /I checked the official source links and verified the selected maintenance intervals/)
  assert.match(research, /Approve cited suggestions/)
  assert.match(research, /Apply approved schedules/)
  assert.match(research, /Manual schedule entry stays available/)
})
