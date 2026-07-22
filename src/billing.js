// Subscription status helpers
// Trial = 7 days from account creation, no card required

export const MONTHLY_PRICE = 8.99
export const ANNUAL_PRICE = 59
export const ANNUAL_MONTHLY_EQUIV = (ANNUAL_PRICE / 12).toFixed(2)
export const SAVINGS_PCT = Math.round((1 - ANNUAL_PRICE / (MONTHLY_PRICE * 12)) * 100)
export const TRIAL_DAYS = 7

export function getTrialDaysLeft(createdAt) {
  const created = new Date(createdAt)
  const now = new Date()
  const diffMs = now - created
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  return Math.max(0, TRIAL_DAYS - diffDays)
}

export function isTrialActive(createdAt) {
  return getTrialDaysLeft(createdAt) > 0
}

export function isSubscribed(profile) {
  if (!profile) return false
  if (profile.subscription_status === 'active') return true
  if (profile.subscription_status === 'trialing') return true
  return false
}

export function hasAccess(profile) {
  if (!profile) return false
  if (isSubscribed(profile)) return true
  if (isTrialActive(profile.created_at)) return true
  return false
}
