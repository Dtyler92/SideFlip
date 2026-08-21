import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { appleVerificationEnvironments } from '../api/_lib/apple-verifier.js'
import { applePurchaseMayBindToUser } from '../api/_lib/apple-account-binding.js'

const verifyPurchaseSource = readFileSync(new URL('../api/verify-apple-purchase.js', import.meta.url), 'utf8')

test('production Apple verification falls back to Sandbox for TestFlight', () => {
  assert.deepEqual(appleVerificationEnvironments('production'), ['production', 'sandbox'])
})

test('sandbox Apple verification falls back to Production for live purchases', () => {
  assert.deepEqual(appleVerificationEnvironments('sandbox'), ['sandbox', 'production'])
})

test('Apple verification rejects an invalid environment configuration', () => {
  assert.throws(() => appleVerificationEnvironments('invalid'), /sandbox or production/)
})

test('authenticated first bind accepts an Apple transaction when sandbox omits appAccountToken', () => {
  const userId = '11111111-1111-4111-8111-111111111111'
  assert.equal(applePurchaseMayBindToUser(null, userId), true)
  assert.equal(applePurchaseMayBindToUser(undefined, userId), true)
})

test('Apple account token must match when Apple supplies it', () => {
  const userId = '11111111-1111-4111-8111-111111111111'
  assert.equal(applePurchaseMayBindToUser(userId, userId), true)
  assert.equal(applePurchaseMayBindToUser('22222222-2222-4222-8222-222222222222', userId), false)
})

test('purchase verifier imports the bundle constant from its exporting module', () => {
  assert.match(verifyPurchaseSource, /import \{ APPLE_BUNDLE_ID, isSideFlipProProduct \} from '\.\/_lib\/apple-products\.js'/)
  assert.doesNotMatch(verifyPurchaseSource, /import \{ APPLE_BUNDLE_ID, verifyAppleSignedData \} from '\.\/_lib\/apple-verifier\.js'/)
})
