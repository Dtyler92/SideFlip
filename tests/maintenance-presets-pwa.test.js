import test from 'node:test'
import assert from 'node:assert/strict'
import { MAINTENANCE_PRESET_DISCLAIMER, MAINTENANCE_PRESETS, presetTaskDraft } from '../src/maintenance/presets.js'

const expected = [
  ['oil-filter', 'Oil and filter change', 'replace', 'service', 5000, 6],
  ['tire-rotation', 'Tire rotation', 'rotate', 'service', 5000, 6],
  ['brake-inspection', 'Brake inspection', 'inspect', 'inspect', 10000, 12],
  ['brake-fluid', 'Brake fluid service', 'replace', 'service', null, 24],
  ['transmission-fluid', 'Transmission fluid service', 'replace', 'service', 60000, 48],
  ['coolant', 'Coolant service', 'replace', 'service', 60000, 60],
  ['engine-air-filter', 'Engine air filter', 'replace', 'service', 30000, 36],
  ['cabin-air-filter', 'Cabin air filter', 'replace', 'service', 15000, 12],
  ['spark-plugs', 'Spark plugs', 'replace', 'service', 60000, 60],
  ['battery-inspection', 'Battery inspection', 'inspect', 'inspect', null, 12],
  ['timing-belt-chain-inspection', 'Timing belt/chain inspection', 'inspect', 'inspect', 60000, 60],
  ['fuel-filter', 'Fuel filter', 'replace', 'service', 30000, 36],
]

test('PWA common maintenance presets match the canonical independent fixture', () => {
  assert.equal(MAINTENANCE_PRESET_DISCLAIMER, 'Common starting points — check your owner’s manual.')
  assert.deepEqual(MAINTENANCE_PRESETS.map(p => [p.id, p.name, p.catalogAction, p.persistedAction, p.miles, p.months]), expected)
})

test('preset drafts omit unsupported mileage and preserve unknown service anchors', () => {
  const preset = MAINTENANCE_PRESETS[0]
  const calendarOnlyItem = { usage_dimensions: ['time'], current_mileage: 1234 }
  const calendarDraft = presetTaskDraft(preset, calendarOnlyItem)
  assert.equal(calendarDraft.intervalMiles, '')
  assert.equal(calendarDraft.currentMileage, '')
  assert.equal(calendarDraft.lastServiceMileage, '')
  assert.equal(calendarDraft.lastServiceDate, '')

  const mileageItem = { usage_dimensions: ['mileage'], effective_current_mileage: 4321 }
  const mileageDraft = presetTaskDraft(preset, mileageItem)
  assert.equal(mileageDraft.intervalMiles, '5000')
  assert.equal(mileageDraft.currentMileage, '4321')
  assert.equal(mileageDraft.lastServiceMileage, '')
})
