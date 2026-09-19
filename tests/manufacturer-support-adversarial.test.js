import test from 'node:test'
import assert from 'node:assert/strict'
import { validateNormalizedCandidates } from '../supabase/functions/_shared/research-validators.js'

// Synthetic adversarial grammar probes, NOT manufacturer excerpts or live results.
const base = { name: 'Brake hoses', action: 'inspect', profile: 'normal', dueSemantics: 'whichever_first', intervalMiles: 15000, intervalMonths: 18, uncertainty: 'Synthetic local test', conflict: false }
function validate(excerpts, changes = {}) {
  const registry = new Map(excerpts.map((exactExcerpt, i) => [String(i), { exactExcerpt }]))
  return validateNormalizedCandidates([{ ...base, ...changes, evidenceIds: [...registry.keys()] }], registry)
}
const direct = 'Inspect Brake hoses every 15000 miles or 18 months.'
const paired = body => [1, 2].map(n => `${15000 * n} miles or ${18 * n} months ${body}`)
const reject = (excerpts, changes) => assert.throws(() => validate(excerpts, changes), error => error.code === 'INVALID_CANDIDATE' && /support/i.test(error.message))

for (const [name, body] of [
  ['conditional prefix', 'If towing Inspect the following: __ Brake hoses'],
  ['conditional suffix', 'Inspect the following: __ Brake hoses __ If towing'],
  ['only condition', 'Only when towing Inspect the following: __ Brake hoses'],
  ['special condition', 'Special operating conditions Inspect the following: __ Brake hoses'],
  ['later action heading', 'Inspect the following: __ Brake pads Replace the following: __ Brake hoses'],
  ['later interval heading', 'Inspect the following: __ Brake pads 60000 miles or 72 months Inspect the following: __ Brake hoses'],
  ['governing note', 'Note: Do not perform these inspections unless towing. Inspect the following: __ Brake hoses'],
]) test(`reject grouped chart scope: ${name}`, () => reject(paired(body)))

test('recognized contradictory direct intervals veto support in either order', () => {
  const conflict = 'Inspect Brake hoses every 30000 miles or 36 months.'
  reject([direct, conflict]); reject([conflict, direct])
})
test('chart-headed negation vetoes otherwise valid direct support in either order', () => {
  const conflict = '15000 miles or 18 months Do not Inspect Brake hoses'
  reject([direct, conflict]); reject([conflict, direct])
})
test('component roles and word order cannot be permuted', () => {
  reject(['Inspect front brake and rear suspension every 15000 miles or 18 months.'], { name: 'rear brake and front suspension' })
})
test('uppercase AND means all, not whichever first', () => {
  const text = 'Inspect Brake hoses every 15000 miles AND 18 months.'
  reject([text]); assert.equal(validate([text], { dueSemantics: 'all' }).length, 1)
})
test('explicit whichever comes first overrides lowercase and', () => {
  const text = 'Inspect Brake hoses every 15000 miles and 18 months, whichever comes first.'
  reject([text], { dueSemantics: 'all' }); assert.equal(validate([text]).length, 1)
})
test('untyped chart scope fails closed even without known conditional words', () => {
  reject(paired('Inspect the following: __ Brake hoses'))
  reject([direct, ...paired('Inspect the following: __ Brake hoses')])
})
test('direct grammar preserves only case/whitespace, not word multiplicity', () => {
  assert.equal(validate([direct, direct]).length, 1)
  assert.equal(validate(['INSPECT brake   hoses every 15000 miles OR 18 months.']).length, 1)
  reject(['Replace engine oil and oil filter every 15000 miles or 18 months.'], { name: 'Engine oil and filter', action: 'replace' })
  reject(['Inspect rear brake brake and front suspension every 15000 miles or 18 months.'], { name: 'rear brake and front suspension' })
})
