const FREE_CAPABILITIES = new Set([
  'projects',
  'project_profit',
  'calculator',
  'one_goal',
])

const PRO_CAPABILITIES = new Set([
  ...FREE_CAPABILITIES,
  'portfolio_analytics',
  'additional_goals',
  'ai_listings',
  'reports',
  'exports',
  'public_shares',
])

function hasActiveLegacyStripeSubscription(profile) {
  return Boolean(
    profile?.subscription_id
      && (profile.subscription_status === 'active' || profile.subscription_status === 'trialing')
  )
}

const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|\+00:00)$/

function parseFiniteUtcTimestamp(value) {
  if (typeof value !== 'string') return null
  const match = UTC_TIMESTAMP.exec(value)
  if (!match) return null

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
  const instant = Date.parse(value)
  if (!Number.isFinite(instant)) return null

  const parsed = new Date(instant)
  if (
    parsed.getUTCFullYear() !== Number(yearText)
    || parsed.getUTCMonth() + 1 !== Number(monthText)
    || parsed.getUTCDate() !== Number(dayText)
    || parsed.getUTCHours() !== Number(hourText)
    || parsed.getUTCMinutes() !== Number(minuteText)
    || parsed.getUTCSeconds() !== Number(secondText)
  ) return null

  return instant
}

function hasActiveAppleEntitlement(entitlement, now = Date.now()) {
  if (entitlement?.source !== 'apple' || entitlement.status !== 'active') return false
  const expiresAt = parseFiniteUtcTimestamp(entitlement.expires_at)
  return expiresAt !== null && expiresAt > now
}

function hasCurrentServerEnvelope(envelope, now) {
  const row = envelope?.entitlement
  if (row === null) return true
  if (!row || typeof row !== 'object') return false
  if (!['active', 'trialing', 'billing_grace', 'grace_period'].includes(row.status)) return false
  if (row.expires_at == null) return true
  const expiresAt = parseFiniteUtcTimestamp(row.expires_at)
  return expiresAt !== null && expiresAt > now
}

export function getPlan(profile, entitlement, now = Date.now()) {
  if (entitlement?.plan === 'free') return 'free'
  if (entitlement?.plan === 'pro') return hasCurrentServerEnvelope(entitlement, now) ? 'pro' : 'free'
  if (hasActiveLegacyStripeSubscription(profile)) return 'pro'
  if (hasActiveAppleEntitlement(entitlement, now)) return 'pro'
  return 'free'
}

export function canCreateGoal(profile, entitlement, goals, now = Date.now()) {
  if (can(profile, entitlement, 'additional_goals', now)) return true
  if (!Array.isArray(goals)) return true
  return !goals.some(goal => goal?.status === 'active')
}

export function can(profile, entitlement, capability, now = Date.now()) {
  const capabilities = getPlan(profile, entitlement, now) === 'pro'
    ? PRO_CAPABILITIES
    : FREE_CAPABILITIES
  return capabilities.has(capability)
}
