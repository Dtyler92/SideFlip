// @ts-nocheck -- Supabase Edge resolves Deno globals and URL imports at deploy time.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { processLeasedJob } from './worker-core.js'
import { createAnthropicMaintenanceProvider } from './anthropic-provider.js'

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function response(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders })
}

function required(name: string) {
  const value = Deno.env.get(name)?.trim()
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function constantTimeEqual(left: string, right: string) {
  const encoder = new TextEncoder()
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index]
  return mismatch === 0
}

Deno.serve(async request => {
  if (request.method !== 'POST') return response(405, { error: 'method_not_allowed' })
  try {
    const workerSecret = required('MAINTENANCE_RESEARCH_WORKER_SECRET')
    const authorization = request.headers.get('authorization') || ''
    if (!authorization.startsWith('Bearer ') || !constantTimeEqual(authorization.slice(7), workerSecret)) return response(401, { error: 'unauthorized' })
    if (Number(request.headers.get('content-length') || 0) > 1024) return response(413, { error: 'request_too_large' })

    const supabase = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { 'x-sideflip-worker': 'maintenance-research-v1' } },
    })
    const anthropicApiKey = required('ANTHROPIC_API_KEY')
    const workerId = crypto.randomUUID()
    const { data: leasedState, error: leaseError } = await supabase.rpc('lease_my_stuff_research_worker_v1', { p_worker: workerId })
    if (leaseError) throw leaseError
    if (!leasedState) return response(200, { processed: 0 })
    const lease = leasedState.lease
    const rawConfig = leasedState.config
    const rawDomains = leasedState.domains
    if (!lease || !rawConfig || !Array.isArray(rawDomains) || !rawDomains.length || rawConfig.policy_version !== lease.policy_version || rawConfig.provider_name !== 'anthropic' || !rawConfig.provider_model || !rawConfig.retention_policy) throw Object.assign(new Error('Invalid sealed worker state'), { code: 'RESEARCH_DISABLED' })
    const timeoutSeconds = Math.min(rawConfig.provider_timeout_seconds, 140)
    const provider = createAnthropicMaintenanceProvider({ apiKey: anthropicApiKey, model: rawConfig.provider_model, timeoutSeconds })
    const domains = rawDomains.map(value => ({ domain: value.domain, sourceClass: value.source_class, includeSubdomains: value.include_subdomains, allowedPathPrefixes: value.allowed_path_prefixes, manufacturer: value.manufacturer, termsReviewedOn: value.terms_reviewed_on, robotsReviewedOn: value.robots_reviewed_on }))
    const db = {
      settle: async ({ jobId, leaseToken, costCents, evidence, candidates, unresolved }: any) => {
        const { error } = await supabase.rpc('settle_my_stuff_research_worker_v1', { p_job_id: jobId, p_lease_token: leaseToken, p_cost_cents: costCents, p_evidence: evidence, p_candidates: candidates, p_unresolved: unresolved })
        if (error) throw error
      },
      fail: async ({ jobId, leaseToken, code, detail }: any) => {
        const { error } = await supabase.rpc('fail_my_stuff_research_worker_v1', { p_job_id: jobId, p_lease_token: leaseToken, p_error_code: code, p_error_detail: detail })
        if (error) throw error
      },
    }
    const result = await processLeasedJob({
      lease,
      config: { maxSearches: rawConfig.max_searches, maxFetches: rawConfig.max_fetches },
      domains,
      provider,
      db,
    })
    return response(200, { processed: 1, job_id: result.jobId, candidate_count: result.candidateCount })
  } catch (error) {
    console.error(JSON.stringify({ event: 'maintenance_research_worker_failed', code: error?.code || 'WORKER_ERROR' }))
    return response(500, { error: 'worker_failed' })
  }
})
