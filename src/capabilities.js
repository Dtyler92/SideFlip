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
  'receipt_scanning',
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

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function hasActiveAppleEntitlement(entitlement, now = Date.now()) {
  if (entitlement?.source !== 'apple' || entitlement.status !== 'active') return false
  if (typeof entitlement.expires_at !== 'string' || !CANONICAL_UTC_TIMESTAMP.test(entitlement.expires_at)) {
    return false
  }

  const expiresAt = new Date(entitlement.expires_at).getTime()
  return Number.isFinite(expiresAt)
    && new Date(expiresAt).toISOString() === entitlement.expires_at
    && expiresAt > now
}

export function getPlan(profile, entitlement, now = Date.now()) {
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
