import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { prepareTemplateIngestion, ingestTemplate } from '../supabase/functions/_shared/manufacturer-template-ingestion.js'
const template = JSON.parse(readFileSync(new URL('./fixtures/scion-2012-xd-template.json', import.meta.url)))
const input = () => ({ extraction: structuredClone(template), provenance: { documentId: template.source.id, sha256: template.source.sha256, sourceVersion: template.source.version, authenticity: 'user_uploaded_unverified' }, templateKey: 'ingestion-test', version: 1 })
test('validated extraction remains review-only and preserves full payload', () => {
  const record = prepareTemplateIngestion(input())
  assert.deepEqual(record.payload, template)
  assert.equal(record.status, 'needs_review')
  assert.equal(record.applicability_reviewed, false)
  assert.equal(record.source_authenticity, 'user_uploaded_unverified')
})
for (const [name, mutate] of [
  ['mismatched source', x => { x.provenance.sha256 = 'c'.repeat(64) }],
  ['mismatched version', x => { x.provenance.sourceVersion = 'wrong' }],
  ['malformed condition', x => { x.extraction.rules[0].condition = {op: 'bogus'} }],
  ['missing citations', x => { x.extraction.rules[0].evidenceIds = [] }],
  ['provider publisher claim', x => { x.provenance.authenticity = 'publisher_verified' }],
  ['identity review mismatch', x => { x.identityReview = {reviewedBy: 'operator', evidence: 'review', applicability: {...template.applicability, year: 2013}} }],
]) test(name + ' fails before storage', async () => {
  const x = input(); mutate(x)
  let called = false
  await assert.rejects(ingestTemplate(x, {ownerId: '11111111-1111-4111-8111-111111111111', storage: {append: () => { called = true }}}))
  assert.equal(called, false)
})
test('only explicit operator identity review marks applicability reviewed', () => {
  const x = input(); x.extraction.applicability_reviewed = true
  assert.equal(prepareTemplateIngestion(x).applicability_reviewed, false)
  x.identityReview = {reviewedBy: 'local operator', evidence: 'retained document identity review', applicability: template.applicability}
  const record = prepareTemplateIngestion(x)
  assert.equal(record.applicability_reviewed, true)
  assert.equal(record.status, 'needs_review')
  assert.equal(record.source_authenticity, 'user_uploaded_unverified')
})
test('storage failure propagates without fallback', async () => {
  await assert.rejects(ingestTemplate(input(), {ownerId: '11111111-1111-4111-8111-111111111111', storage: {append: async () => {throw Error('RPC unavailable')}}}), /RPC unavailable/)
})
test('readback mismatch is not success', async () => {
  await assert.rejects(ingestTemplate(input(), {ownerId: '11111111-1111-4111-8111-111111111111', storage: {append: async () => 'id', read: async () => ({record: {}})}}), /readback/)
})
