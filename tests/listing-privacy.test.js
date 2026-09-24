import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const privacy = readFileSync(new URL('../src/pages/PrivacyPolicy.jsx', import.meta.url), 'utf8')
const publicPrivacy = readFileSync(new URL('../public/privacy/index.html', import.meta.url), 'utf8')

test('privacy policy discloses listing-generation data sent to xAI', () => {
  for (const policy of [privacy, publicPrivacy]) {
    assert.match(policy, /xAI/)
    assert.match(policy, /seller brief/i)
    assert.match(policy, /project notes/i)
    assert.match(policy, /expense descriptions/i)
    assert.match(policy, /listing description/i)
    assert.match(policy, /xAI may retain request data[\s\S]{0,100}up to 30 days/i)
    assert.match(policy, /automated manufacturer maintenance research is disabled/i)
    assert.match(policy, /no new vehicle details are sent/i)
    assert.match(policy, /previously submitted requests may remain with xAI[\s\S]{0,100}up to 30 days[\s\S]{0,100}safety and abuse monitoring/i)
    assert.doesNotMatch(policy, /Research manufacturer schedule/i)
    assert.doesNotMatch(policy, /Anthropic/i)
  }
})

test('public privacy route matches listing and transitional xAI processing disclosures', () => {
  for (const policy of [privacy, publicPrivacy]) {
    assert.match(policy, /listing-description generation/i)
    assert.match(policy, /automated manufacturer maintenance research is disabled/i)
    assert.match(policy, /Last updated: September 23, 2026/i)
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

test('live and static policies cover subscription identifiers, processors, and deletion timing', () => {
  for (const policy of [privacy, publicPrivacy]) {
    assert.match(policy, /transaction and original.transaction identifiers/i)
    assert.match(policy, /Apple processes/i)
    assert.match(policy, /PostHog/i)
    assert.match(policy, /12 months/i)
    assert.match(policy, /deletion.suppression record/i)
    assert.match(policy, /prevent delayed Apple or Stripe events/i)
    assert.match(policy, /billing, transaction, fraud.prevention, security, or legal records/i)
    assert.match(policy, /analytics deletion request/i)
    assert.match(policy, /asynchronous/i)
  }
})
