// Subscription pricing and provider-backed access helpers

export const MONTHLY_PRICE = 12.99
export const ANNUAL_PRICE = 99.99
export const ANNUAL_MONTHLY_EQUIV = '8.33'
export const SAVINGS_PCT = Math.round((1 - ANNUAL_PRICE / (MONTHLY_PRICE * 12)) * 100)

export function isSubscribed(profile) {
  if (!profile) return false
  if (!profile.subscription_id) return false // no real Stripe subscription
  if (profile.subscription_status === 'active') return true
  if (profile.subscription_status === 'trialing') return true
  return false
}

export function hasAccess(profile) {
  if (!profile) return false
  if (isSubscribed(profile)) return true
  return false
}
