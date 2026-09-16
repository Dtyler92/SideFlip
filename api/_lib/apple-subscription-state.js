import { isSideFlipProProduct } from './apple-products.js'

const TERMINAL_STATUSES = new Set(['expired', 'revoked', 'refunded', 'canceled'])

function finiteTimestamp(value) {
  const timestamp = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0
}

function resolvedStatus({ status, notificationType, subtype, transaction, now }) {
  if (notificationType === 'REFUND') return 'refunded'
  if (notificationType === 'REVOKE' || transaction?.revocationDate) return 'revoked'
  if (notificationType === 'GRACE_PERIOD_EXPIRED') return 'expired'
  if (status) return status
  if (subtype === 'GRACE_PERIOD') return 'grace_period'
  return finiteTimestamp(transaction?.expiresDate) > now ? 'active' : 'expired'
}

export function normalizeAppleSubscriptionState({
  status,
  notificationType,
  subtype,
  transaction,
  renewalInfo,
  expectedOriginalTransactionId,
  now = Date.now(),
}) {
  const transactionExpiresDate = finiteTimestamp(transaction?.expiresDate)
  const transactionSignedDate = finiteTimestamp(transaction?.signedDate)
  let normalizedStatus = resolvedStatus({ status, notificationType, subtype, transaction, now })
  let effectiveExpiresDate = transactionExpiresDate
  let providerSignedDate = transactionSignedDate

  if (normalizedStatus === 'grace_period') {
    const gracePeriodExpiresDate = finiteTimestamp(renewalInfo?.gracePeriodExpiresDate)
    const renewalSignedDate = finiteTimestamp(renewalInfo?.signedDate)
    const validGraceEvidence = typeof expectedOriginalTransactionId === 'string'
      && expectedOriginalTransactionId.length > 0
      && renewalInfo?.originalTransactionId === expectedOriginalTransactionId
      && isSideFlipProProduct(renewalInfo?.autoRenewProductId)
      && renewalInfo?.isInBillingRetryPeriod === true
      && gracePeriodExpiresDate > now
      && renewalSignedDate > 0

    if (validGraceEvidence) {
      effectiveExpiresDate = gracePeriodExpiresDate
      providerSignedDate = renewalSignedDate
    }
    else normalizedStatus = 'expired'
  } else if (normalizedStatus === 'active' && transactionExpiresDate <= now) {
    normalizedStatus = 'expired'
  } else if (!TERMINAL_STATUSES.has(normalizedStatus) && normalizedStatus !== 'active') {
    normalizedStatus = 'expired'
  }

  return { status: normalizedStatus, effectiveExpiresDate, providerSignedDate }
}
