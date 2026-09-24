import test from 'node:test'
import assert from 'node:assert/strict'
import { CATEGORIES, getExtraFields, getProjectPhotoPair, shouldDeleteReplacedProjectPhoto } from '../src/store.js'

test('Airplane Project is available with model and engine identification but no automotive VIN', () => {
  assert.ok(CATEGORIES.some(category => category.value === 'airplane' && category.label.includes('Airplane')))
  assert.deepEqual(getExtraFields('airplane'), {
    hasEngine: true,
    hasVin: false,
    hasHull: false,
    hasModel: true,
    hasVehicleDetails: false,
  })
})

test('Home Improvement is available with Android model and serial identifier fields', () => {
  assert.ok(CATEGORIES.some(category => category.value === 'house' && category.label === '🏠 Home Improvement'))
  assert.deepEqual(getExtraFields('house'), {
    hasEngine: false,
    hasVin: false,
    hasHull: false,
    hasModel: true,
    hasVehicleDetails: false,
  })
})

test('project photo pair uses explicit before and after photos', () => {
  assert.deepEqual(getProjectPhotoPair({
    photo: 'https://example.test/legacy-main.jpg',
    beforePhoto: 'https://example.test/before.jpg',
    afterPhoto: 'https://example.test/after.jpg',
  }), {
    beforePhoto: 'https://example.test/before.jpg',
    afterPhoto: 'https://example.test/after.jpg',
  })
})

test('project photo pair keeps a legacy main photo as the before photo', () => {
  assert.deepEqual(getProjectPhotoPair({ photo: 'https://example.test/legacy-main.jpg' }), {
    beforePhoto: 'https://example.test/legacy-main.jpg',
    afterPhoto: null,
  })
})

test('project photo pair keeps an after-only project out of the before slot', () => {
  assert.deepEqual(getProjectPhotoPair({
    photo: 'https://example.test/after.jpg',
    afterPhoto: 'https://example.test/after.jpg',
  }), {
    beforePhoto: null,
    afterPhoto: 'https://example.test/after.jpg',
  })
})

test('does not delete a replaced photo still referenced by the other slot or legacy gallery', () => {
  const sharedUrl = 'https://example.test/shared.jpg'
  assert.equal(shouldDeleteReplacedProjectPhoto({ afterPhoto: sharedUrl }, 'before', sharedUrl), false)
  assert.equal(shouldDeleteReplacedProjectPhoto({ beforePhoto: 'https://example.test/before.jpg', photos: [sharedUrl] }, 'after', sharedUrl), false)
  assert.equal(shouldDeleteReplacedProjectPhoto({ beforePhoto: 'https://example.test/before.jpg' }, 'after', sharedUrl), true)
})

test('project photo pair tolerates missing photos', () => {
  assert.deepEqual(getProjectPhotoPair({}), { beforePhoto: null, afterPhoto: null })
})
