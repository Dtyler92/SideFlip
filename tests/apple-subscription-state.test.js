import test from 'node:test'
import assert from 'node:assert/strict'
import { Status } from '@apple/app-store-server-library'
import { normalizeAppleSubscriptionState } from '../api/_lib/apple-subscription-state.js'
import { currentAppleSubscription } from '../api/_lib/apple-current-subscription.js'

const now = Date.parse('2026-09-16T12:00:00.000Z')
const originalTransactionId = 'original-transaction'
const productId = 'com.sideflip.app.pro.monthly'
const transaction = {
  bundleId: 'com.sideflip.app',
  productId,
  originalTransactionId,
  transactionId: 'current-transaction',
  signedDate: now - 1_000,
  expiresDate: now - 60_000,
}
const validRenewalInfo = {
  originalTransactionId,
  autoRenewProductId: productId,
  isInBillingRetryPeriod: true,
  gracePeriodExpiresDate: now + 3_600_000,
  signedDate: now - 500,
}

const graceState = renewalInfo => ({
  status: 'grace_period',
  effectiveExpiresDate: renewalInfo.gracePeriodExpiresDate,
  providerSignedDate: renewalInfo.signedDate,
})

const expiredTransactionState = {
  status: 'expired',
  effectiveExpiresDate: transaction.expiresDate,
  providerSignedDate: transaction.signedDate,
}

test('shared Apple normalizer uses only complete verified renewal evidence for grace', () => {
  assert.deepEqual(normalizeAppleSubscriptionState({
    status: 'grace_period', transaction, renewalInfo: validRenewalInfo,
    expectedOriginalTransactionId: originalTransactionId, now,
  }), graceState(validRenewalInfo))

  for (const renewalInfo of [
    null,
    { ...validRenewalInfo, originalTransactionId: 'different-original' },
    { ...validRenewalInfo, autoRenewProductId: 'com.sideflip.app.pro.unlisted' },
    { ...validRenewalInfo, isInBillingRetryPeriod: false },
    { ...validRenewalInfo, gracePeriodExpiresDate: now },
    { ...validRenewalInfo, gracePeriodExpiresDate: 'not-a-date' },
    { ...validRenewalInfo, signedDate: undefined },
    { ...validRenewalInfo, signedDate: 'not-a-date' },
  ]) {
    assert.deepEqual(normalizeAppleSubscriptionState({
      status: 'grace_period', transaction, renewalInfo,
      expectedOriginalTransactionId: originalTransactionId, now,
    }), expiredTransactionState)
  }
})

test('shared Apple normalizer preserves active and terminal semantics', () => {
  const futureTransaction = { ...transaction, expiresDate: now + 60_000 }
  assert.deepEqual(normalizeAppleSubscriptionState({ status: 'active', transaction: futureTransaction, now }), {
    status: 'active', effectiveExpiresDate: futureTransaction.expiresDate, providerSignedDate: futureTransaction.signedDate,
  })
  assert.equal(normalizeAppleSubscriptionState({ status: 'active', transaction, now }).status, 'expired')
  assert.equal(normalizeAppleSubscriptionState({ status: 'expired', transaction: futureTransaction, now }).status, 'expired')
  assert.equal(normalizeAppleSubscriptionState({ status: 'refunded', transaction: futureTransaction, now }).status, 'refunded')
  assert.equal(normalizeAppleSubscriptionState({ status: 'active', transaction: { ...futureTransaction, revocationDate: now }, now }).status, 'revoked')
})

test('notification semantics are normalized through the same grace rules', () => {
  assert.deepEqual(normalizeAppleSubscriptionState({
    notificationType: 'DID_FAIL_TO_RENEW', subtype: 'GRACE_PERIOD', transaction,
    renewalInfo: validRenewalInfo, expectedOriginalTransactionId: originalTransactionId, now,
  }), graceState(validRenewalInfo))
  assert.equal(normalizeAppleSubscriptionState({ notificationType: 'REFUND', transaction, now }).status, 'refunded')
  assert.equal(normalizeAppleSubscriptionState({ notificationType: 'REVOKE', transaction, now }).status, 'revoked')
  assert.equal(normalizeAppleSubscriptionState({ notificationType: 'GRACE_PERIOD_EXPIRED', transaction, now }).status, 'expired')
})

test('authenticated subscription lookup verifies renewal JWS and returns normalized expiration', async () => {
  let renewalJws = null
  const verifier = {
    async verifyAndDecodeTransaction() { return transaction },
    async verifyAndDecodeRenewalInfo(value) { renewalJws = value; return validRenewalInfo },
  }
  const apiClient = {
    async getAllSubscriptionStatuses() {
      return { bundleId: 'com.sideflip.app', data: [{ lastTransactions: [{
        status: Status.BILLING_GRACE_PERIOD,
        signedTransactionInfo: 'signed-transaction',
        signedRenewalInfo: 'signed-renewal',
      }] }] }
    },
  }

  const current = await currentAppleSubscription({
    apiClient, verifier, transactionId: transaction.transactionId,
    expectedOriginalTransactionId: originalTransactionId, now,
  })

  assert.equal(renewalJws, 'signed-renewal')
  assert.equal(current.status, 'grace_period')
  assert.equal(current.effectiveExpiresDate, validRenewalInfo.gracePeriodExpiresDate)
  assert.equal(current.providerSignedDate, validRenewalInfo.signedDate)
})

test('authenticated lookup orders renewal-derived grace by renewal JWS signedDate', async () => {
  const olderRenewal = { ...validRenewalInfo, signedDate: now - 2_000, gracePeriodExpiresDate: now + 7_200_000 }
  const newerRenewal = { ...validRenewalInfo, signedDate: now + 2_000, gracePeriodExpiresDate: now + 1_800_000 }
  const transactions = {
    'transaction-jws-newer': { ...transaction, transactionId: 'wrong-if-transaction-ordered', signedDate: now + 10_000 },
    'transaction-jws-older': { ...transaction, transactionId: 'renewal-wins', signedDate: now - 10_000 },
  }
  const renewals = { 'renewal-older': olderRenewal, 'renewal-newer': newerRenewal }
  const verifier = {
    async verifyAndDecodeTransaction(value) { return transactions[value] },
    async verifyAndDecodeRenewalInfo(value) { return renewals[value] },
  }
  const apiClient = { async getAllSubscriptionStatuses() {
    return { bundleId: 'com.sideflip.app', data: [{ lastTransactions: [
      { status: Status.BILLING_GRACE_PERIOD, signedTransactionInfo: 'transaction-jws-newer', signedRenewalInfo: 'renewal-older' },
      { status: Status.BILLING_GRACE_PERIOD, signedTransactionInfo: 'transaction-jws-older', signedRenewalInfo: 'renewal-newer' },
    ] }] }
  } }

  const current = await currentAppleSubscription({
    apiClient, verifier, transactionId: transaction.transactionId,
    expectedOriginalTransactionId: originalTransactionId, now,
  })
  assert.equal(current.transaction.transactionId, 'renewal-wins')
  assert.equal(current.providerSignedDate, newerRenewal.signedDate)
  assert.equal(current.effectiveExpiresDate, newerRenewal.gracePeriodExpiresDate)
})
