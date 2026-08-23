const EXPLICIT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/

function hasActiveLegacyStripeSubscription(profile) {
  return Boolean(
    profile?.subscription_id
      && ['active', 'trialing'].includes(profile.subscription_status)
  )
}

function isVerifiedAppleEntitlement(entitlement, now) {
  if (entitlement?.source !== 'apple' || !['active', 'grace_period'].includes(entitlement.status) || !entitlement.last_verified_at) return false
  if (typeof entitlement.expires_at !== 'string' || !EXPLICIT_UTC_TIMESTAMP.test(entitlement.expires_at)) return false
  const expiresAt = Date.parse(entitlement.expires_at)
  return Number.isFinite(expiresAt) && expiresAt > now
}

export function resolveServerEntitlement(profile, entitlements, now = Date.now()) {
  const apple = Array.isArray(entitlements)
    ? entitlements.find(entitlement => isVerifiedAppleEntitlement(entitlement, now))
    : null

  if (hasActiveLegacyStripeSubscription(profile) || apple) {
    return {
      plan: 'pro',
      entitlement: apple ? {
        source: 'apple',
        status: apple.status,
        expires_at: apple.expires_at,
      } : null,
    }
  }

  return { plan: 'free', entitlement: null }
}
