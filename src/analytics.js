import posthog from 'posthog-js'

export const ANALYTICS_EVENTS = new Set([
  'app_opened', 'signup_started', 'signup_completed', 'signin_completed',
  'onboarding_started', 'onboarding_completed', 'screen_viewed',
  'project_created', 'project_deleted', 'project_marked_sold', 'project_sale_undone',
  'expense_added', 'expense_updated', 'expense_deleted',
  'goal_created', 'goal_completed',
  'ai_listing_requested', 'ai_listing_succeeded', 'ai_listing_failed',
  'paywall_viewed', 'plan_selected', 'stripe_checkout_started', 'stripe_checkout_cancelled', 'stripe_checkout_failed',
  'attribution_captured',
])

const ALLOWED_PROPERTIES = new Set([
  'platform', 'app_version', 'screen', 'plan', 'provider', 'status', 'source',
  'feature', 'result', 'error_type', 'project_category', 'expense_category',
  'goal_type', 'is_pro', 'is_goal_linked', 'has_campaign', 'billing_period',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'referral_code', 'first_utm_source', 'first_utm_medium', 'first_utm_campaign',
  'first_referral_code', 'last_utm_source', 'last_utm_medium', 'last_utm_campaign',
  'last_referral_code',
])
const ATTRIBUTION_KEYS = new Map([
  ['utm_source', 'utm_source'], ['utm_medium', 'utm_medium'],
  ['utm_campaign', 'utm_campaign'], ['utm_content', 'utm_content'],
  ['utm_term', 'utm_term'], ['ref', 'referral_code'],
])
const ATTRIBUTION_KEY = 'sideflip_analytics_attribution_v1'
const OPT_OUT_KEY_PREFIX = 'sideflip_analytics_opt_out_v1:'
const DEVICE_OPT_OUT_KEY = 'sideflip_analytics_device_opt_out_v1'
const ATTRIBUTION_PROPERTIES = new Set([...ATTRIBUTION_KEYS.values()])
let initialized = false
let runtimeReady = false
let analyticsEnabled = false
let activeUserId = null

function bounded(value, max = 80) {
  if (typeof value !== 'string') return null
  const clean = value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max)
  return clean || null
}

export function sanitizeAttributionValue(property, value) {
  if (!ATTRIBUTION_PROPERTIES.has(property) || typeof value !== 'string') return null
  const candidate = value.trim().replace(/[\u0000-\u001f\u007f]/g, '')
  if (!candidate) return null

  // Campaign fields are controlled labels, never a place for contact details,
  // links, credentials, or opaque identifiers.
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(candidate)) return null
  if (/^(?:\+?[\d\s().-]){7,}$/.test(candidate) && (candidate.match(/\d/g) || []).length >= 7) return null
  if (/(?:https?:\/\/|www\.)/i.test(candidate)) return null
  if (/(?:^|[\s;&?])(bearer\s+|(?:password|passwd|secret|token|api[_-]?key)\s*[:=])/i.test(candidate)) return null
  if (/^(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]+$/i.test(candidate)) return null
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(candidate)) return null
  if (/^[A-Za-z0-9_-]{64,}$/.test(candidate)) return null

  const pattern = property === 'referral_code'
    ? /^[A-Za-z0-9][A-Za-z0-9_-]*$/
    : /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/
  if (!pattern.test(candidate)) return null
  return candidate.slice(0, 80) || null
}

function normalizedUserId(userId) {
  return typeof userId === 'string' && userId ? userId : null
}

function preferenceKey(userId) {
  const normalized = normalizedUserId(userId)
  return normalized ? `${OPT_OUT_KEY_PREFIX}${normalized}` : null
}

function canUseAnalytics() {
  return runtimeReady && analyticsEnabled
}

function clearAttribution() {
  if (typeof window === 'undefined') return
  try { window.localStorage.removeItem(ATTRIBUTION_KEY) } catch { /* storage may be disabled */ }
}

function purgePostHogQueues() {
  if (!initialized) return
  // posthog-js has no public discard API: RequestQueue.unload/RetryQueue.unload
  // transmit buffered data. The pinned SDK exposes these stable fields, so
  // clear them synchronously and fail closed if a future version changes them.
  for (const queue of [posthog._requestQueue, posthog._retryQueue]) {
    if (!queue) continue
    try {
      if (queue._flushTimeout) clearTimeout(queue._flushTimeout)
      if (queue._poller) clearTimeout(queue._poller)
      queue._flushTimeout = undefined
      queue._poller = undefined
      queue._isPolling = false
      queue._isPaused = true
      queue._queue = []
    } catch { /* opt-out remains active even if internals change */ }
  }
}

function resetPostHogAndOptOut() {
  if (!initialized) return
  try {
    // Stop capture first, discard without sending, then reset identity. reset()
    // can clear consent, so opt out again before returning.
    posthog.opt_out_capturing()
    purgePostHogQueues()
    posthog.reset()
    purgePostHogQueues()
    posthog.opt_out_capturing()
  } catch { /* analytics must never break auth or settings */ }
}

function initAnalytics() {
  if (initialized || typeof window === 'undefined') return initialized
  if (!canUseAnalytics()) return false
  const key = import.meta.env?.VITE_POSTHOG_KEY
  if (!key) return false
  posthog.init(key, {
    api_host: import.meta.env?.VITE_POSTHOG_HOST || 'https://us.i.posthog.com',
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    capture_exceptions: false,
    disable_surveys: true,
    advanced_disable_feature_flags: true,
    advanced_disable_feature_flags_on_first_load: true,
    disable_external_dependency_loading: true,
    // Never retain a browser-side request batch across opt-out or identity reset.
    request_batching: false,
    persistence: 'localStorage',
    person_profiles: 'identified_only',
    respect_dnt: true,
    opt_out_capturing_by_default: true,
  })
  initialized = true
  return true
}

function applyRuntimePreference(enabled) {
  analyticsEnabled = Boolean(enabled)
  if (!analyticsEnabled) {
    clearAttribution()
    resetPostHogAndOptOut()
    return
  }
  if (!initAnalytics()) return
  try { posthog.opt_in_capturing() } catch { /* analytics must not break auth or settings */ }
}

function completeReconciliation(enabled) {
  analyticsEnabled = Boolean(enabled)
  runtimeReady = true
  applyRuntimePreference(analyticsEnabled)
  if (analyticsEnabled) captureEvent('app_opened')
  return analyticsEnabled
}

export function sanitizeAnalyticsProperties(properties = {}) {
  const result = {}
  for (const [key, value] of Object.entries(properties || {})) {
    if (!ALLOWED_PROPERTIES.has(key)) continue
    const attributionProperty = key.replace(/^(?:first|last)_/, '')
    if (ATTRIBUTION_PROPERTIES.has(attributionProperty)) {
      const clean = sanitizeAttributionValue(attributionProperty, value)
      if (clean !== null) result[key] = clean
    } else if (typeof value === 'boolean') result[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value
    else {
      const clean = bounded(value)
      if (clean !== null) result[key] = clean
    }
  }
  return result
}

export function extractAttribution(input) {
  let url
  try { url = new URL(input, 'https://sideflip.org') } catch { return {} }
  const result = {}
  for (const [queryKey, propertyKey] of ATTRIBUTION_KEYS) {
    const clean = sanitizeAttributionValue(propertyKey, url.searchParams.get(queryKey))
    if (clean !== null) result[propertyKey] = clean
  }
  return result
}

export function isAnalyticsEnabled(userId = activeUserId) {
  return normalizedUserId(userId) === activeUserId && canUseAnalytics()
}

export function isAnalyticsRuntimeReady(userId = activeUserId) {
  return normalizedUserId(userId) === activeUserId && runtimeReady
}

// This POST path is intentionally used only by an explicit Settings toggle.
export async function syncAnalyticsPreference(enabled, userId = activeUserId) {
  const normalized = normalizedUserId(userId)
  if (!normalized) return { ok: false, error: 'Please sign in again.' }
  try {
    const { supabase } = await import('./supabase')
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token || session.user?.id !== normalized || activeUserId !== normalized) {
      return { ok: false, error: 'Please sign in again.' }
    }
    const response = await fetch('/api/analytics-preference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ enabled: Boolean(enabled) }),
    })
    let body = {}
    try { body = await response.json() } catch { /* use the generic message below */ }
    if (!response.ok || body.saved !== true || body.enabled !== Boolean(enabled)) {
      return { ok: false, error: body.error || 'Could not save analytics preference.' }
    }
    return { ok: true, enabled: body.enabled }
  } catch { return { ok: false, error: 'Could not save analytics preference.' } }
}

export async function setAnalyticsEnabled(enabled, userId = activeUserId) {
  const normalized = normalizedUserId(userId)
  const requested = Boolean(enabled)
  if (!runtimeReady || !normalized || normalized !== activeUserId || typeof window === 'undefined') {
    return { ok: false, enabled: false, error: 'Analytics preference is not ready. Please try again.' }
  }
  const key = preferenceKey(userId)
  if (!requested) {
    // A denial takes effect before any network work and is intentionally kept
    // if the server cannot be reached.
    try {
      window.localStorage.setItem(key, 'true')
      window.localStorage.setItem(DEVICE_OPT_OUT_KEY, 'true')
    } catch { /* storage may be disabled */ }
    applyRuntimePreference(false)
  }

  const result = await syncAnalyticsPreference(requested, normalized)
  if (!result.ok || activeUserId !== normalized) {
    return { ok: false, enabled: isAnalyticsEnabled(normalized), error: result.error || 'Could not save analytics preference.' }
  }

  if (requested) {
    // Enabling is fail-closed: activate only after the server confirms the row.
    try {
      window.localStorage.setItem(key, 'false')
      window.localStorage.removeItem(DEVICE_OPT_OUT_KEY)
    } catch { /* storage may be disabled */ }
    applyRuntimePreference(true)
  }
  return { ok: true, enabled: requested }
}

export async function reconcileAnalyticsPreference(userId = null) {
  const normalized = normalizedUserId(userId)
  activeUserId = normalized
  runtimeReady = false
  analyticsEnabled = false

  // Signed-out analytics are always off. A later authenticated reconciliation
  // must explicitly confirm consent before capture can start.
  if (!normalized) return completeReconciliation(false)
  if (typeof window === 'undefined') return false

  try {
    const { supabase } = await import('./supabase')
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token || session.user?.id !== normalized) return false
    const response = await fetch('/api/analytics-preference', {
      method: 'GET',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    if (!response.ok || activeUserId !== normalized) return false
    const { enabled } = await response.json()
    if (typeof enabled !== 'boolean' || activeUserId !== normalized) return false

    // The server can deny collection globally. A device denial is an
    // additional fail-closed constraint until this device explicitly enables.
    const key = preferenceKey(userId)
    let deviceDenied = false
    try {
      deviceDenied = window.localStorage.getItem(DEVICE_OPT_OUT_KEY) === 'true'
      window.localStorage.setItem(key, enabled && !deviceDenied ? 'false' : 'true')
      if (!enabled) window.localStorage.setItem(DEVICE_OPT_OUT_KEY, 'true')
    } catch { /* storage may be disabled */ }
    return completeReconciliation(enabled && !deviceDenied)
  } catch {
    // Fail closed: do not initialize or emit when the preference is unknown.
    return false
  }
}

export function captureEvent(event, properties = {}) {
  if (!canUseAnalytics() || !ANALYTICS_EVENTS.has(event)) return false
  if (!initialized && !initAnalytics()) return false
  try {
    posthog.capture(event, {
      platform: 'web',
      ...sanitizeAnalyticsProperties(properties),
      $geoip_disable: true,
    })
    return true
  } catch { return false }
}

export function identifyAnalytics(userId, properties = {}) {
  if (!canUseAnalytics() || normalizedUserId(userId) !== activeUserId) return false
  if (!initialized && !initAnalytics()) return false
  try {
    posthog.identify(userId, { platform: 'web', ...sanitizeAnalyticsProperties(properties), $geoip_disable: true })
    const attribution = getStoredAttribution()
    const first = attribution.first || {}
    const last = attribution.last || {}
    posthog.setPersonProperties({
      ...Object.fromEntries(Object.entries(first).map(([key, value]) => [`first_${key}`, value])),
      ...Object.fromEntries(Object.entries(last).map(([key, value]) => [`last_${key}`, value])),
    })
    return true
  } catch { return false }
}

export function resetAnalytics() {
  runtimeReady = false
  analyticsEnabled = false
  activeUserId = null
  clearAttribution()
  resetPostHogAndOptOut()
}

export function captureAttribution(input = typeof window !== 'undefined' ? window.location.href : '') {
  if (!canUseAnalytics() || typeof window === 'undefined') return {}
  const current = extractAttribution(input)
  if (!Object.keys(current).length) return current
  let stored = {}
  try { stored = JSON.parse(window.localStorage.getItem(ATTRIBUTION_KEY) || '{}') } catch { stored = {} }
  const next = { first: stored.first || current, last: current }
  try { window.localStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(next)) } catch { /* storage may be disabled */ }
  captureEvent('attribution_captured', { ...current, has_campaign: true })
  return current
}

export function getStoredAttribution() {
  if (!canUseAnalytics() || typeof window === 'undefined') return {}
  try {
    const value = JSON.parse(window.localStorage.getItem(ATTRIBUTION_KEY) || '{}')
    return { first: sanitizeAnalyticsProperties(value.first), last: sanitizeAnalyticsProperties(value.last) }
  } catch { return {} }
}
