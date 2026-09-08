import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { CATEGORIES, categoryIcon, getExtraFields } from '../src/store.js'

const newProjectSource = readFileSync(new URL('../src/pages/NewProject.jsx', import.meta.url), 'utf8')

const ANDROID_1_4_CATEGORIES = [
  { value: 'mower', label: '🚜 Lawn Mower' },
  { value: 'car', label: '🚗 Car' },
  { value: 'truck', label: '🛻 Truck' },
  { value: 'motorcycle', label: '🏍️ Motorcycle' },
  { value: 'atv', label: '🏎️ ATV / Powersports' },
  { value: 'side_by_side', label: '🏁 Side-by-side' },
  { value: 'trailer', label: '🚛 Trailer' },
  { value: 'rv', label: '🚐 RV' },
  { value: 'boat', label: '⛵ Boat' },
  { value: 'airplane', label: '✈️ Airplane' },
  { value: 'bicycle', label: '🚲 Bicycle / E-Bike' },
  { value: 'watch', label: '⌚ Watch' },
  { value: 'electronics', label: '📱 Electronics' },
  { value: 'gaming', label: '🎮 Gaming / Console' },
  { value: 'tool', label: '🔧 Tool / Equipment' },
  { value: 'exercise', label: '💪 Exercise Equipment' },
  { value: 'instrument', label: '🎸 Musical Instrument' },
  { value: 'furniture', label: '🪑 Furniture' },
  { value: 'house', label: '🏠 Home Improvement' },
  { value: 'other', label: '📦 Other' },
]

const VEHICLE_CATEGORIES = ['car', 'truck', 'motorcycle', 'atv', 'side_by_side', 'trailer', 'rv']

test('Project category catalog exactly matches Android 1.4.0', () => {
  assert.deepEqual(CATEGORIES, ANDROID_1_4_CATEGORIES)
})

test('all Android vehicle Project categories expose VIN and vehicle details', () => {
  for (const category of VEHICLE_CATEGORIES) {
    assert.deepEqual(getExtraFields(category), {
      hasEngine: true,
      hasVin: true,
      hasHull: false,
      hasModel: true,
      hasVehicleDetails: true,
    }, category)
  }
})

test('every selected category retains Android model and serial identification while boats retain hull details', () => {
  for (const { value } of CATEGORIES) assert.equal(getExtraFields(value).hasModel, true, value)
  assert.equal(getExtraFields('').hasModel, false)
  assert.deepEqual(getExtraFields('boat'), {
    hasEngine: true,
    hasVin: false,
    hasHull: true,
    hasModel: true,
    hasVehicleDetails: false,
  })
  assert.deepEqual(getExtraFields('house'), {
    hasEngine: false,
    hasVin: false,
    hasHull: false,
    hasModel: true,
    hasVehicleDetails: false,
  })
})

test('legacy Project category aliases preserve their category-specific fields and icons', () => {
  assert.deepEqual(getExtraFields('side by side'), getExtraFields('side_by_side'))
  assert.deepEqual(getExtraFields('lawn mower'), getExtraFields('mower'))
  assert.deepEqual(getExtraFields('home improvement'), getExtraFields('house'))
  assert.equal(categoryIcon('side by side'), '🏁')
  assert.equal(categoryIcon('lawn mower'), '🚜')
})

test('New Project requires an explicit category instead of silently defaulting to mower', () => {
  assert.match(newProjectSource, /title: '', category: ''/)
  assert.match(newProjectSource, /if \(!form\.category\) return alert\('Select a category'/)
  assert.match(newProjectSource, /<option value="" disabled>Select a category<\/option>/)
  assert.match(newProjectSource, /<label>Category \*<\/label>/)
})
