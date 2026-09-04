const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|\+00:00)$/
const STRIPE_ENTITLEMENT_READ_MODES = new Set(['compatibility', 'canonical'])
const ENTITLEMENT_SOURCES = new Set(['stripe', 'apple', 'admin'])
const ENTITLEMENT_STATUSES = new Set(['active', 'trialing', 'grace_period', 'expired', 'revoked', 'refunded', 'canceled'])

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

function isSuccessfulEnvelope(result) {
  return Boolean(
    result
    && typeof result === 'object'
    && !Array.isArray(result)
    && Object.hasOwn(result, 'data')
    && Object.hasOwn(result, 'error')
    && result.error === null
  )
}

function isProfileRow(profile) {
  return Boolean(
    profile
    && typeof profile === 'object'
    && !Array.isArray(profile)
    && Object.hasOwn(profile, 'subscription_id')
    && Object.hasOwn(profile, 'subscription_status')
    && (profile.subscription_id === null || typeof profile.subscription_id === 'string')
    && (profile.subscription_status === null || typeof profile.subscription_status === 'string')
  )
}

function isEntitlementRow(row) {
  return Boolean(
    row
    && typeof row === 'object'
    && !Array.isArray(row)
    && Object.hasOwn(row, 'source')
    && Object.hasOwn(row, 'status')
    && Object.hasOwn(row, 'expires_at')
    && Object.hasOwn(row, 'last_verified_at')
    && ENTITLEMENT_SOURCES.has(row.source)
    && ENTITLEMENT_STATUSES.has(row.status)
    && (row.expires_at === null || parseFiniteUtcTimestamp(row.expires_at) !== null)
    && parseFiniteUtcTimestamp(row.last_verified_at) !== null
  )
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

export async function loadServerEntitlementState(client, userId, now = Date.now()) {
  try {
    const [modeResult, profileResult, entitlementResult] = await Promise.all([
      client.rpc('stripe_entitlement_read_mode'),
      client.from('profiles').select('subscription_id, subscription_status').eq('id', userId).maybeSingle(),
      client.from('user_entitlements').select('source, status, expires_at, last_verified_at').eq('user_id', userId),
    ])
    if (
      !isSuccessfulEnvelope(modeResult)
      || !STRIPE_ENTITLEMENT_READ_MODES.has(modeResult.data)
      || !isSuccessfulEnvelope(profileResult)
      || !isProfileRow(profileResult.data)
      || !isSuccessfulEnvelope(entitlementResult)
      || !Array.isArray(entitlementResult.data)
      || entitlementResult.data.some(row => !isEntitlementRow(row))
    ) return { error: true }

    return {
      entitlement: resolveServerEntitlement(profileResult.data, entitlementResult.data, now, {
        stripeCanonicalCutoverComplete: modeResult.data === 'canonical',
      }),
    }
  } catch {
    return { error: true }
  }
}
