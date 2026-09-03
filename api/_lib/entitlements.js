const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|\+00:00)$/

function parseFiniteUtcTimestamp(value) {
  if (typeof value !== 'string') return null
  const match = UTC_TIMESTAMP.exec(value)
  if (!match) return null

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const instant = Date.parse(value)
  if (!Number.isFinite(instant)) return null

  const parsed = new Date(instant)
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() + 1 !== month
    || parsed.getUTCDate() !== day
    || parsed.getUTCHours() !== hour
    || parsed.getUTCMinutes() !== minute
    || parsed.getUTCSeconds() !== second
  ) return null

  return instant
}

function isVerifiedActiveEntitlement(entitlement, now) {
  const accessStatus = entitlement?.source === 'stripe'
    ? ['active', 'trialing'].includes(entitlement.status)
    : entitlement?.source === 'apple'
      ? ['active', 'grace_period'].includes(entitlement.status)
      : false
  if (!accessStatus) return false

  const expiresAt = parseFiniteUtcTimestamp(entitlement.expires_at)
  const verifiedAt = parseFiniteUtcTimestamp(entitlement.last_verified_at)
  return expiresAt !== null && expiresAt > now && verifiedAt !== null && verifiedAt <= now
}

function hasLegacyStripeCompatibility(profile) {
  return Boolean(profile?.subscription_id && ['active', 'trialing'].includes(profile.subscription_status))
}

// Profile fallback is a temporary rollout compatibility path, never canonical
// provider state. Canonical terminal/malformed Stripe rows suppress that fallback,
// and the service-only database gate disables it after verified reconciliation.
export function resolveServerEntitlement(profile, entitlements, now = Date.now(), options = {}) {
  const rows = Array.isArray(entitlements) ? entitlements : []
  const entitlement = Array.isArray(entitlements)
    ? entitlements.find(row => isVerifiedActiveEntitlement(row, now))
    : null

  if (!entitlement) {
    const hasCanonicalStripeState = rows.some(row => row?.source === 'stripe')
    if (
      options.stripeCanonicalCutoverComplete !== true
      && !hasCanonicalStripeState
      && hasLegacyStripeCompatibility(profile)
    ) return { plan: 'pro', entitlement: null }
    return { plan: 'free', entitlement: null }
  }

  return {
    plan: 'pro',
    entitlement: {
      source: entitlement.source,
      status: entitlement.status,
      expires_at: entitlement.expires_at,
    },
  }
}
