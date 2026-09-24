import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
import { requiresVehicleIdentityReconfirmation, supportsVinDecoder } from '../src/myStuff/itemModel.js'

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

test('VIN request gate aborts stale work and vehicle type helpers fail closed', () => {
  const gate = createVinDecodeRequestGate()
  const first = gate.begin(VIN)
  assert.equal(gate.isCurrent(first, VIN), true)
  gate.invalidate()
  assert.equal(first.controller.signal.aborted, true)
  assert.equal(gate.isCurrent(first, VIN), false)
  for (const itemType of ['car', 'truck', 'motorcycle', 'atv', 'side_by_side', 'trailer', 'rv']) {
    assert.equal(supportsVinDecoder(itemType), true, `${itemType} should support VIN decoding`)
  }
  for (const itemType of ['boat', 'airplane', 'mower', 'equipment', 'other']) {
    assert.equal(supportsVinDecoder(itemType), false, `${itemType} should not support automotive VIN decoding`)
  }
  assert.equal(requiresVehicleIdentityReconfirmation('car', 'truck'), true)
  assert.equal(requiresVehicleIdentityReconfirmation('truck', 'truck'), false)
})

test('reusable PWA VIN panel keeps explicit review and confirmation', () => {
  const vin = source('src/components/MyStuffVinDecodePanel.jsx')
  assert.match(vin, /\/api\/decode-vin/)
  assert.match(vin, /subjectType:\s*'my_stuff_item'/)
  assert.match(vin, /Unconfirmed editable review/)
  assert.match(vin, /Confirm Vehicle/)
  assert.match(vin, /persistIdentity/)
  assert.match(source('src/myStuff/client.js'), /confirm_my_stuff_vehicle_identity_v3/)
})

test('My Stuff create uses the reusable VIN decoder in pre-save review mode', () => {
  const create = source('src/pages/MyStuffCreate.jsx')
  const vin = source('src/components/MyStuffVinDecodePanel.jsx')
  assert.match(create, /MyStuffVinDecodePanel/)
  assert.match(create, /preSave/)
  assert.match(create, /supportsVinDecoder\(draft\.itemType\)/)
  assert.doesNotMatch(create, /<Field label="VIN"/)
  assert.match(vin, /Apply reviewed values/)
  assert.match(vin, /if\(!preSave\)decodeBody\.subjectId=itemId/)
  assert.match(vin, /preSave\s*\?/)
  assert.match(vin, /never save automatically/i)
  assert.match(vin, /full VIN is sent to NHTSA/i)
})
