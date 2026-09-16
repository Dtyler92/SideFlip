import { normalizeAppleSubscriptionState } from './apple-subscription-state.js'

export function appleNotificationStatus({ notificationType, subtype, transaction, renewalInfo, now = Date.now() }) {
  return normalizeAppleSubscriptionState({
    notificationType,
    subtype,
    transaction,
    renewalInfo,
    expectedOriginalTransactionId: transaction?.originalTransactionId,
    now,
  }).status
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
