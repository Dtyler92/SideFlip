import test from 'node:test'
import assert from 'node:assert/strict'
import { appleVerificationEnvironments } from '../api/_lib/apple-verifier.js'

test('production Apple verification falls back to Sandbox for TestFlight', () => {
  assert.deepEqual(appleVerificationEnvironments('production'), ['production', 'sandbox'])
})

test('sandbox Apple verification falls back to Production for live purchases', () => {
  assert.deepEqual(appleVerificationEnvironments('sandbox'), ['sandbox', 'production'])
})

test('Apple verification rejects an invalid environment configuration', () => {
  assert.throws(() => appleVerificationEnvironments('invalid'), /sandbox or production/)
})
