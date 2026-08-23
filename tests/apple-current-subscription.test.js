import test from 'node:test'
import assert from 'node:assert/strict'
import { Status } from '@apple/app-store-server-library'
import { currentAppleSubscription } from '../api/_lib/apple-current-subscription.js'

const originalTransactionId = 'original-transaction'
const productId = 'com.sideflip.app.pro.monthly'
const now = Date.parse('2026-08-23T22:00:00.000Z')
const transaction = {
  bundleId: 'com.sideflip.app',
  productId,
  originalTransactionId,
  transactionId: 'current-transaction',
  signedDate: now - 1000,
  expiresDate: now - 60_000,
}

function verifier({ renewalInfo } = {}) {
  return {
    async verifyAndDecodeTransaction() { return transaction },
    async verifyAndDecodeRenewalInfo() { return renewalInfo },
  }
}

function apiClient(lastTransaction) {
  return {
    async getAllSubscriptionStatuses() {
      return { bundleId: 'com.sideflip.app', data: [{ lastTransactions: [lastTransaction] }] }
    },
  }
}

test('billing grace uses the verified signed renewal grace expiration', async () => {
  const gracePeriodExpiresDate = now + 3_600_000
  const current = await currentAppleSubscription({
    apiClient: apiClient({
      status: Status.BILLING_GRACE_PERIOD,
      signedTransactionInfo: 'signed-transaction',
      signedRenewalInfo: 'signed-renewal',
    }),
    verifier: verifier({ renewalInfo: {
      originalTransactionId,
      autoRenewProductId: productId,
      isInBillingRetryPeriod: true,
      gracePeriodExpiresDate,
    } }),
    transactionId: transaction.transactionId,
    expectedOriginalTransactionId: originalTransactionId,
    now,
  })

  assert.equal(current.status, 'grace_period')
  assert.equal(current.effectiveExpiresDate, gracePeriodExpiresDate)
})

test('billing grace fails closed when signed renewal grace evidence is expired', async () => {
  const current = await currentAppleSubscription({
    apiClient: apiClient({
      status: Status.BILLING_GRACE_PERIOD,
      signedTransactionInfo: 'signed-transaction',
      signedRenewalInfo: 'signed-renewal',
    }),
    verifier: verifier({ renewalInfo: {
      originalTransactionId,
      autoRenewProductId: productId,
      isInBillingRetryPeriod: true,
      gracePeriodExpiresDate: now - 1,
    } }),
    transactionId: transaction.transactionId,
    expectedOriginalTransactionId: originalTransactionId,
    now,
  })

  assert.equal(current.status, 'expired')
  assert.equal(current.effectiveExpiresDate, transaction.expiresDate)
})

test('billing grace fails closed without signed renewal information', async () => {
  const current = await currentAppleSubscription({
    apiClient: apiClient({
      status: Status.BILLING_GRACE_PERIOD,
      signedTransactionInfo: 'signed-transaction',
    }),
    verifier: verifier(),
    transactionId: transaction.transactionId,
    expectedOriginalTransactionId: originalTransactionId,
    now,
  })

  assert.equal(current.status, 'expired')
})
