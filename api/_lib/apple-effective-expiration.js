import { isSideFlipProProduct } from './apple-products.js'

export function appleEffectiveExpiration({ status, transaction, renewalInfo, expectedOriginalTransactionId, now = Date.now() }) {
  let resolvedStatus = status
  let effectiveExpiresDate = Number(transaction?.expiresDate || 0)

  if (resolvedStatus === 'active' && effectiveExpiresDate <= now) resolvedStatus = 'expired'
  if (resolvedStatus === 'grace_period') {
    const gracePeriodExpiresDate = Number(renewalInfo?.gracePeriodExpiresDate || 0)
    const validGraceEvidence = renewalInfo?.originalTransactionId === expectedOriginalTransactionId
      && isSideFlipProProduct(renewalInfo?.autoRenewProductId)
      && renewalInfo?.isInBillingRetryPeriod === true
      && gracePeriodExpiresDate > now
    if (validGraceEvidence) effectiveExpiresDate = gracePeriodExpiresDate
    else resolvedStatus = 'expired'
  }

  return { status: resolvedStatus, effectiveExpiresDate }
}
