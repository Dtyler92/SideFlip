import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const privacy = readFileSync(new URL('../src/pages/PrivacyPolicy.jsx', import.meta.url), 'utf8')
const publicPrivacy = readFileSync(new URL('../public/privacy/index.html', import.meta.url), 'utf8')

test('privacy policy discloses listing-generation data sent to xAI', () => {
  assert.match(privacy, /xAI/)
  assert.match(privacy, /seller brief/i)
  assert.match(privacy, /project notes/i)
  assert.match(privacy, /expense descriptions/i)
  assert.match(privacy, /listing description/i)
})

test('privacy policy states maintenance research is retired with transitional retention', () => {
  assert.match(privacy, /automated maintenance research is disabled/i)
  assert.match(privacy, /no longer sends new vehicle or item details/i)
  assert.match(privacy, /applicable retention window/i)
  assert.doesNotMatch(privacy, /Anthropic/i)
})

test('public privacy route matches the xAI listing and retired-maintenance disclosures', () => {
  for (const policy of [privacy, publicPrivacy]) {
    assert.match(policy, /xAI/)
    assert.match(policy, /seller brief/i)
    assert.match(policy, /expense descriptions/i)
    assert.match(policy, /automated maintenance research is disabled/i)
    assert.match(policy, /no longer sends new vehicle or item details/i)
    assert.match(policy, /applicable retention window/i)
    assert.doesNotMatch(policy, /Anthropic/i)
  }
})

test('VIN decode UI and policies disclose full-VIN transmission to NHTSA and bounded handling', () => {
  for (const panelPath of ['src/components/VinDecodePanel.jsx', 'src/components/MyStuffVinDecodePanel.jsx']) {
    const panel = readFileSync(new URL(`../${panelPath}`, import.meta.url), 'utf8')
    assert.match(panel, /full VIN is sent to NHTSA/i)
    assert.ok(panel.indexOf('full VIN is sent to NHTSA') < panel.indexOf('Decode VIN'))
  }
  for (const policy of [privacy, publicPrivacy]) {
    assert.match(policy, /National Highway Traffic Safety Administration \(NHTSA\)/i)
    assert.match(policy, /full VIN/i)
    assert.match(policy, /decode vehicle details/i)
    assert.match(policy, /30 days/i)
    assert.match(policy, /HMAC/i)
    assert.match(policy, /does not store or log the full VIN/i)
  }
})
