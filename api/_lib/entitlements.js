const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function hasActiveLegacyStripeSubscription(profile) {
  return Boolean(
    profile?.subscription_id
      && ['active', 'trialing'].includes(profile.subscription_status)
  )
}

function isVerifiedActiveAppleEntitlement(entitlement, now) {
  if (entitlement?.source !== 'apple' || entitlement.status !== 'active' || !entitlement.last_verified_at) return false
  if (typeof entitlement.expires_at !== 'string' || !CANONICAL_UTC_TIMESTAMP.test(entitlement.expires_at)) return false
  const expiresAt = new Date(entitlement.expires_at).getTime()
  return Number.isFinite(expiresAt) && new Date(expiresAt).toISOString() === entitlement.expires_at && expiresAt > now
}

export function resolveServerEntitlement(profile, entitlements, now = Date.now()) {
  const apple = Array.isArray(entitlements)
    ? entitlements.find(entitlement => isVerifiedActiveAppleEntitlement(entitlement, now))
    : null

  if (hasActiveLegacyStripeSubscription(profile) || apple) {
    return {
      plan: 'pro',
      entitlement: apple ? {
        source: 'apple',
        status: 'active',
        expires_at: apple.expires_at,
      } : null,
    }
  }

  return { plan: 'free', entitlement: null }
}
