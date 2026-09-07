import { createHash } from 'node:crypto'

const SERVER_EVENTS = new Set([
  'stripe_checkout_created',
  'checkout_completed',
  'subscription_trial_started',
  'subscription_started',
  'subscription_reactivated',
  'subscription_updated',
  'subscription_cancellation_scheduled',
  'subscription_ended',
  'subscription_payment_succeeded',
  'subscription_payment_failed',
  'subscription_trial_ending',
  'subscription_refunded',
  'subscription_revoked',
])
const ALLOWED_PROPERTIES = new Set([
  'provider', 'plan', 'status', 'previous_status', 'billing_interval',
  'environment', 'source', 'is_trial', 'is_restore', 'platform', 'product_id',
  'currency', 'amount_minor', 'payment_type', 'was_trial', 'churn_type',
])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function normalizeBillingInterval(value) {
  if (value === 'month' || value === 'monthly') return 'monthly'
  if (value === 'year' || value === 'annual') return 'annual'
  return undefined
}

function sanitize(properties = {}) {
  const result = {}
  for (const [key, value] of Object.entries(properties || {})) {
    if (!ALLOWED_PROPERTIES.has(key)) continue
    if (key === 'billing_interval') {
      const interval = normalizeBillingInterval(value)
      if (interval) result[key] = interval
    } else if (typeof value === 'boolean') result[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value
    else if (typeof value === 'string' && value.trim()) result[key] = value.trim().slice(0, 80)
  }
  return result
}

export function deterministicInsertId(...parts) {
  return createHash('sha256').update(parts.map(value => String(value ?? '')).join('|')).digest('hex')
}

export function buildServerAnalyticsEvent({ distinctId, event, insertId, eventUuid, occurredAt, properties = {} }) {
  if (!UUID.test(distinctId || '')) throw new Error('Invalid analytics distinctId')
  if (!SERVER_EVENTS.has(event)) throw new Error('Invalid analytics event')
  if (eventUuid && !UUID.test(eventUuid)) throw new Error('Invalid analytics event UUID')
  return {
    distinctId,
    event,
    eventUuid,
    occurredAt,
    properties: {
      ...sanitize(properties),
      $insert_id: insertId || eventUuid || deterministicInsertId(event, distinctId),
      $geoip_disable: true,
      platform: properties.platform === 'ios' || properties.provider === 'apple' ? 'ios' : 'web',
    },
  }
}

async function deliverServerEvent(input) {
  const key = process.env.POSTHOG_KEY
  if (!key) return { captured: false, reason: 'not_configured' }
  try {
    const payload = buildServerAnalyticsEvent(input)
    const host = (process.env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/$/, '')
    const body = { api_key: key, event: payload.event, distinct_id: payload.distinctId, properties: payload.properties }
    if (payload.eventUuid) body.uuid = payload.eventUuid
    if (payload.occurredAt) body.timestamp = new Date(payload.occurredAt).toISOString()
    const response = await fetch(`${host}/i/v0/e`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new Error(`PostHog returned ${response.status}`)
    return { captured: true }
  } catch (error) {
    console.error('Analytics capture failed:', error.message)
    return { captured: false, reason: 'delivery_failed' }
  }
}


export async function enqueueServerEvent(supabase, { dedupeKey, distinctId, event, occurredAt = new Date(), properties = {} }) {
  if (!SERVER_EVENTS.has(event)) throw new Error('Invalid durable analytics event')
  if (!UUID.test(distinctId || '')) throw new Error('Invalid analytics distinctId')
  const { data, error } = await supabase.rpc('enqueue_analytics_outbox', {
    p_dedupe_key: String(dedupeKey).slice(0, 240),
    p_distinct_id: distinctId,
    p_event_name: event,
    p_occurred_at: new Date(occurredAt).toISOString(),
    p_properties: sanitize(properties),
  })
  if (error) throw error
  return data
}

async function mapWithConcurrency(items, concurrency, operation) {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, async () => {
    while (queue.length) await operation(queue.shift())
  })
  await Promise.all(workers)
}

export async function dispatchAnalyticsOutbox(supabase, limit = 25) {
  if (!process.env.POSTHOG_KEY) return { delivered: 0, failed: 0, reason: 'not_configured' }
  const { data: rows, error } = await supabase.rpc('claim_analytics_outbox', { p_limit: limit })
  if (error) throw error
  let delivered = 0
  let failed = 0
  await mapWithConcurrency(rows || [], 10, async row => {
    const result = await deliverServerEvent({
      distinctId: row.distinct_id, event: row.event_name, eventUuid: row.id,
      occurredAt: row.occurred_at, properties: row.properties || {},
    })
    const { data: finished, error: finishError } = await supabase.rpc('finish_analytics_outbox', {
      p_id: row.id,
      p_claim_token: row.claim_token,
      p_delivered: result.captured,
      p_error_code: result.captured ? null : result.reason || 'delivery_failed',
    })
    if (finishError) throw finishError
    if (!finished) return // stale workers cannot finish a row reclaimed after lease expiry
    if (result.captured) delivered += 1
    else failed += 1
  })
  return { delivered, failed, claimed: (rows || []).length }
}

async function deletePostHogPersonAndEvents(distinctId) {
  const personalKey = process.env.POSTHOG_PERSONAL_API_KEY
  const projectId = process.env.POSTHOG_PROJECT_ID
  if (!personalKey || !projectId) return { submitted: false, reason: 'deletion_not_configured' }
  const host = (process.env.POSTHOG_API_HOST || 'https://us.posthog.com').replace(/\/$/, '')
  const headers = { Authorization: `Bearer ${personalKey}`, 'Content-Type': 'application/json' }
  const response = await fetch(`${host}/api/projects/${encodeURIComponent(projectId)}/persons/bulk_delete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      distinct_ids: [distinctId],
      delete_events: true,
      delete_recordings: true,
      keep_person: false,
    }),
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`PostHog person deletion returned ${response.status}`)
  // bulk_delete is asynchronous (normally HTTP 202). Acceptance is not proof
  // of provider completion; the durable queue remains submitted and repeats.
  return { submitted: true, asynchronous: response.status === 202 }
}

export async function dispatchAnalyticsDeletionQueue(supabase, limit = 25) {
  const { data: rows, error } = await supabase.rpc('claim_analytics_deletions', { p_limit: limit })
  if (error) throw error
  let submitted = 0
  let failed = 0
  await mapWithConcurrency(rows || [], 3, async row => {
    let result
    try {
      result = await deletePostHogPersonAndEvents(row.user_id)
    } catch (error) {
      console.error('Analytics deletion failed:', error.message)
      result = { submitted: false, reason: 'posthog_deletion_failed' }
    }
    const { data: finished, error: finishError } = await supabase.rpc('finish_analytics_deletion', {
      p_user_id: row.user_id,
      p_claim_token: row.claim_token,
      p_submitted: result.submitted,
      p_error_code: result.submitted ? null : result.reason,
    })
    if (finishError) throw finishError
    if (!finished) return
    if (result.submitted) submitted += 1
    else failed += 1
  })
  return { submitted, failed, claimed: (rows || []).length }
}

function isAuthUserAbsent(error, user) {
  return !user && (!error || error.status === 404 || error.code === 'user_not_found')
}

export async function reconcileAuthDeleting(supabase, limit = 5) {
  const { data: rows, error } = await supabase.rpc('claim_account_deletion_reconciliations', { p_limit: limit })
  if (error) throw error
  let completed = 0
  let failed = 0
  await mapWithConcurrency(rows || [], 2, async row => {
    let authAbsent = false
    let errorCode = null
    try {
      let lookup = await supabase.auth.admin.getUserById(row.user_id)
      let user = lookup.data?.user
      if (isAuthUserAbsent(lookup.error, user)) authAbsent = true
      else if (lookup.error) throw lookup.error
      else {
        const removal = await supabase.auth.admin.deleteUser(row.user_id)
        if (removal.error && removal.error.status !== 404 && removal.error.code !== 'user_not_found') throw removal.error
        lookup = await supabase.auth.admin.getUserById(row.user_id)
        user = lookup.data?.user
        if (isAuthUserAbsent(lookup.error, user)) authAbsent = true
        else if (lookup.error) throw lookup.error
      }
    } catch (error) {
      console.error('Auth deletion reconciliation failed:', error.message)
      errorCode = 'auth_reconciliation_failed'
    }
    const { data: finished, error: finishError } = await supabase.rpc('finish_account_deletion_reconciliation', {
      p_user_id: row.user_id,
      p_claim_token: row.claim_token,
      p_auth_absent: authAbsent,
      p_error_code: errorCode,
    })
    if (finishError) throw finishError
    if (!finished) return
    if (authAbsent) completed += 1
    else failed += 1
  })
  return { completed, failed, claimed: (rows || []).length }
}
