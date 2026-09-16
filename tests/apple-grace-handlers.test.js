import test from 'node:test'
import assert from 'node:assert/strict'
import { createAppleServerNotificationsHandler } from '../api/apple-server-notifications.js'
import { createVerifyApplePurchaseHandler } from '../api/verify-apple-purchase.js'

const userId = '11111111-1111-4111-8111-111111111111'
const originalTransactionId = 'original-transaction'
const productId = 'com.sideflip.app.pro.monthly'
const transaction = {
  bundleId: 'com.sideflip.app', productId, originalTransactionId,
  transactionId: 'current-transaction', signedDate: Date.parse('2026-09-16T10:00:00.000Z'),
  expiresDate: Date.parse('2026-09-16T09:00:00.000Z'),
  originalPurchaseDate: Date.parse('2026-08-16T10:00:00.000Z'),
  appAccountToken: userId,
}
const renewalInfo = {
  originalTransactionId, autoRenewProductId: productId,
  isInBillingRetryPeriod: true,
  gracePeriodExpiresDate: Date.parse('2026-09-20T10:00:00.000Z'),
  signedDate: Date.parse('2026-09-16T12:00:00.000Z'),
}

function responseRecorder() {
  return {
    statusCode: null, body: null,
    status(value) { this.statusCode = value; return this },
    json(value) { this.body = value; return this },
  }
}

function lookupBuilder(result) {
  return {
    select() { return this }, contains() { return this }, eq() { return this },
    async maybeSingle() { return result },
  }
}

test('notification handler orders grace by verified renewal signedDate and reconciles duplicate through RPC helper', async () => {
  const rpcCalls = []
  const reconciliations = []
  let lookup = 0
  const client = {
    from() {
      lookup += 1
      return lookupBuilder(lookup === 1
        ? { data: null, error: null }
        : { data: { id: 'entitlement-id', user_id: userId }, error: null })
    },
    async rpc(name, args) { rpcCalls.push([name, args]); return { data: false, error: null } },
  }
  const verifier = {
    async verifyAndDecodeTransaction() { return transaction },
    async verifyAndDecodeRenewalInfo() { return renewalInfo },
  }
  const verifySignedData = async () => ({
    verifier,
    decoded: {
      notificationType: 'DID_FAIL_TO_RENEW', subtype: 'GRACE_PERIOD',
      signedDate: Date.parse('2026-09-16T13:00:00.000Z'),
      notificationUUID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      data: { signedTransactionInfo: 'tx-jws', signedRenewalInfo: 'renewal-jws' },
    },
  })
  const handler = createAppleServerNotificationsHandler({
    client, verifySignedData,
    reconcileExpiration: async input => { reconciliations.push(input); return true },
  })
  const res = responseRecorder()
  await handler({ method: 'POST', body: { signedPayload: 'notification-jws' } }, res)

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { received: true, status: 'grace_period', applied: true })
  assert.equal(rpcCalls[0][0], 'apply_apple_entitlement_event')
  assert.equal(rpcCalls[0][1].p_provider_signed_at, '2026-09-16T12:00:00.000Z')
  assert.equal(rpcCalls[0][1].p_expires_at, '2026-09-20T10:00:00.000Z')
  assert.equal(reconciliations[0].providerSignedAt, '2026-09-16T12:00:00.000Z')
})

test('purchase handler propagates renewal ordering into apply and authoritative duplicate reconciliation', async () => {
  const rpcCalls = []
  const reconciliations = []
  const client = {
    auth: { async getUser() { return { data: { user: { id: userId } }, error: null } } },
    async rpc(name, args) { rpcCalls.push([name, args]); return { data: false, error: null } },
  }
  const current = {
    transaction,
    status: 'grace_period',
    effectiveExpiresDate: renewalInfo.gracePeriodExpiresDate,
    providerSignedDate: renewalInfo.signedDate,
  }
  const handler = createVerifyApplePurchaseHandler({
    client,
    verifySignedData: async () => ({ verifier: {}, decoded: transaction, environmentName: 'sandbox' }),
    apiClientFactory: () => ({}),
    getCurrentSubscription: async () => current,
    reconcileExpiration: async input => { reconciliations.push(input); return true },
  })
  const res = responseRecorder()
  await handler({
    method: 'POST', headers: { authorization: 'Bearer token' },
    body: { signedTransaction: 'transaction-jws' },
  }, res)

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, {
    entitlement: { verified: true, status: 'grace_period', expiresAt: '2026-09-20T10:00:00.000Z' },
    applied: true,
  })
  assert.equal(rpcCalls[0][1].p_provider_signed_at, '2026-09-16T12:00:00.000Z')
  assert.equal(reconciliations[0].providerSignedAt, '2026-09-16T12:00:00.000Z')
})
