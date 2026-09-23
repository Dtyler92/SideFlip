import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const privacy = readFileSync(new URL('../src/pages/PrivacyPolicy.jsx', import.meta.url), 'utf8')
const publicPrivacy = readFileSync(new URL('../public/privacy/index.html', import.meta.url), 'utf8')
const maintenanceResearchDisclosure = 'When you start manufacturer maintenance research, SideFlip sends only the confirmed vehicle year, make, model, and engine size, plus transmission when available, to xAI so Grok can search approved manufacturer or authorized-dealer sources.'
const staleMaintenanceFieldList = 'vehicle or item type and available confirmed year, make, model, trim, engine, transmission, drivetrain, fuel, and market details'

test('privacy policy discloses listing-generation data sent to xAI', () => {
  assert.match(privacy, /xAI/)
  assert.match(privacy, /seller brief/i)
  assert.match(privacy, /project notes/i)
  assert.match(privacy, /expense descriptions/i)
  assert.match(privacy, /listing description/i)
})

test('privacy policy discloses bounded Grok maintenance research and no stale provider', () => {
  assert.ok(privacy.includes(maintenanceResearchDisclosure))
  assert.ok(!privacy.includes(staleMaintenanceFieldList))
  assert.match(privacy, /does not send the VIN, serial number, notes, location, costs, or expenses/i)
  assert.match(privacy, /review cited source links/i)
  assert.doesNotMatch(privacy, /Anthropic/i)
})

test('public privacy route matches the xAI listing and maintenance disclosures', () => {
  for (const policy of [privacy, publicPrivacy]) {
    assert.match(policy, /xAI/)
    assert.match(policy, /seller brief/i)
    assert.match(policy, /expense descriptions/i)
    assert.ok(policy.includes(maintenanceResearchDisclosure))
    assert.ok(!policy.includes(staleMaintenanceFieldList))
    assert.match(policy, /does not send the VIN, serial number, notes, location, costs, or expenses/i)
    assert.match(policy, /review cited source links/i)
    assert.match(policy, /Last updated: September 23, 2026/i)
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

test('live and static policies accurately bound xAI listing and maintenance processing', () => {
  for (const policy of [privacy, publicPrivacy]) {
    assert.match(policy, /listing description/i)
    assert.match(policy, /manufacturer maintenance research/i)
    assert.match(policy, /xAI may retain request data[\s\S]{0,100}up to 30 days/i)
  }
})
