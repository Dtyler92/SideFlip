import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const privacy = readFileSync(new URL('../src/pages/PrivacyPolicy.jsx', import.meta.url), 'utf8')

test('privacy policy discloses listing-generation data sent to xAI', () => {
  assert.match(privacy, /xAI/)
  assert.match(privacy, /seller brief/i)
  assert.match(privacy, /project notes/i)
  assert.match(privacy, /expense descriptions/i)
  assert.match(privacy, /listing description/i)
})

test('privacy policy discloses bounded Grok maintenance research and no stale provider', () => {
  assert.match(privacy, /manufacturer maintenance research/i)
  assert.match(privacy, /confirmed year, make, model, trim, engine, transmission, drivetrain, fuel, and market/i)
  assert.match(privacy, /does not send the VIN, serial number, notes, location, costs, or expenses/i)
  assert.match(privacy, /review cited source links/i)
  assert.doesNotMatch(privacy, /Anthropic/i)
})
