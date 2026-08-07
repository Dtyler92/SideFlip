import { Status } from '@apple/app-store-server-library'
import { APPLE_BUNDLE_ID, isSideFlipProProduct } from './apple-products.js'

const statusForApple = new Map([[Status.ACTIVE, 'active'], [Status.BILLING_GRACE_PERIOD, 'grace_period'], [Status.BILLING_RETRY, 'expired'], [Status.EXPIRED, 'expired'], [Status.REVOKED, 'revoked']])
const severity = { active: 0, grace_period: 1, expired: 2, revoked: 3 }

export async function currentAppleSubscription({ apiClient, verifier, transactionId, expectedOriginalTransactionId }) {
  const response = await apiClient.getAllSubscriptionStatuses(transactionId)
  if (response.bundleId !== APPLE_BUNDLE_ID) throw new Error('Apple subscription response bundle mismatch')
  const candidates = []
  for (const item of (response.data || []).flatMap(group => group.lastTransactions || [])) {
    if (!item.signedTransactionInfo || !statusForApple.has(item.status)) continue
    const transaction = await verifier.verifyAndDecodeTransaction(item.signedTransactionInfo)
    if (transaction.bundleId !== APPLE_BUNDLE_ID || !isSideFlipProProduct(transaction.productId) || transaction.originalTransactionId !== expectedOriginalTransactionId || !transaction.transactionId || !transaction.signedDate || !transaction.expiresDate) continue
    candidates.push({ transaction, status: transaction.revocationDate ? 'revoked' : statusForApple.get(item.status) })
  }
  candidates.sort((a, b) => b.transaction.signedDate - a.transaction.signedDate || severity[b.status] - severity[a.status] || b.transaction.transactionId.localeCompare(a.transaction.transactionId))
  if (!candidates.length) throw new Error('No current SideFlip Pro subscription was found')
  return candidates[0]
}
