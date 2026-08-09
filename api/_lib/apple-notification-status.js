export function appleNotificationStatus({ notificationType, subtype, transaction, renewalInfo, now = Date.now() }) {
  if (notificationType === 'REFUND') return 'refunded'
  if (notificationType === 'REVOKE') return 'revoked'
  if (transaction?.revocationDate) return 'revoked'
  const graceExpires = Number(renewalInfo?.gracePeriodExpiresDate || 0)
  const graceEvidence = subtype === 'GRACE_PERIOD'
    && renewalInfo?.isInBillingRetryPeriod === true
    && graceExpires > now
  if (graceEvidence) return 'grace_period'
  if (notificationType === 'GRACE_PERIOD_EXPIRED') return 'expired'
  return Number(transaction?.expiresDate || 0) > now ? 'active' : 'expired'
}

// These flags come only from Apple's verified outer notification. They are
// analytics semantics, not entitlement statuses: disabling renewal leaves
// access intact, and billing retry leaves access active until expiry unless a
// verified grace period extends it.
export function appleNotificationSemantics({ notificationType, subtype }) {
  return {
    cancellationScheduled: notificationType === 'DID_CHANGE_RENEWAL_STATUS' && subtype === 'AUTO_RENEW_DISABLED',
    billingFailure: notificationType === 'DID_FAIL_TO_RENEW',
  }
}
