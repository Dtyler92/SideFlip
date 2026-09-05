import { createClient } from '@supabase/supabase-js'
import { loadServerEntitlementState } from './_lib/entitlements.js'
import {
  buildAnthropicRequest,
  createListingFacts,
  normalizeGenerationOptions,
  parseGeneratedDescription,
  validateGeneratedDescriptionGrounding,
} from './_lib/listing-description-prompts.js'

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const IN_FLIGHT = new Set()
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const GENERATION_TIMEOUT_MS = 20_000
const LISTING_MODEL = 'claude-haiku-4-5-20251001'

async function claimGenerationSlot(client, userId) {
  const { data, error } = await client.rpc('claim_ai_generation_request', {
    p_user_id: userId,
    p_limit: 15,
    p_window_seconds: 60,
    p_lease_seconds: 30,
  })
  if (error) return { decision: 'unavailable' }
  if (data?.decision === 'allowed' && PROJECT_ID_PATTERN.test(data.claim_token || '')) {
    return { decision: 'allowed', claimToken: data.claim_token }
  }
  if (data?.decision === 'in_flight' || data?.decision === 'rate_limited') return { decision: data.decision }
  return { decision: 'unavailable' }
}

async function renewGenerationSlot(client, userId, claimToken) {
  const { data, error } = await client.rpc('renew_ai_generation_request', {
    p_user_id: userId,
    p_claim_token: claimToken,
    p_lease_seconds: 45,
  })
  return !error && data === true
}

async function releaseGenerationSlot(client, userId, claimToken) {
  const { error } = await client.rpc('release_ai_generation_request', {
    p_user_id: userId,
    p_claim_token: claimToken,
  })
  if (error) console.error('Listing generation lease release failed')
}

function json(res, status, body) {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, max-age=0, must-revalidate')
  res.setHeader('CDN-Cache-Control', 'no-store')
  res.setHeader('Vary', 'Authorization')
  return res.status(status).json(body)
}

async function loadOwnedListingFacts(client, userId, projectId, existingDescription = '') {
  if (!PROJECT_ID_PATTERN.test(projectId || '')) return { error: 'invalid' }
  const [projectResult, expenseResult] = await Promise.all([
    client.from('projects').select('id,title,category,notes').eq('id', projectId).eq('user_id', userId).maybeSingle(),
    client.from('expenses').select('description,category').eq('project_id', projectId).eq('user_id', userId).limit(30),
  ])
  if (projectResult.error || expenseResult.error) return { error: 'lookup' }
  if (!projectResult.data) return { error: 'not_found' }
  return { facts: createListingFacts(projectResult.data, expenseResult.data || [], existingDescription) }
}

function legacyListingFacts(body) {
  return createListingFacts({
    title: body?.title,
    category: body?.category,
    notes: body?.notes,
  }, body?.expenses, body?.existingDescription)
}

export function createGenerateListingHandler({ client = supabase, fetchImpl = fetch } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' })

    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) return json(res, 401, { error: 'Sign in to use the Listing Description Generator.' })

    const { data: { user }, error: authError } = await client.auth.getUser(token)
    if (authError || !user) return json(res, 401, { error: 'Please sign in again.' })

    const tombstoneResult = await client.from('account_deletion_tombstones').select('status').eq('user_id', user.id).maybeSingle()
    if (tombstoneResult.error) return json(res, 503, { error: 'Could not verify SideFlip Pro access.' })
    if (tombstoneResult.data) return json(res, 410, { error: 'This account is being deleted.' })

    const entitlementState = await loadServerEntitlementState(client, user.id)
    if (entitlementState.error) return json(res, 503, { error: 'Could not verify SideFlip Pro access.' })
    if (entitlementState.entitlement.plan !== 'pro') {
      return json(res, 403, { error: 'SideFlip Pro is required for the Listing Description Generator.' })
    }

    let options
    try {
      options = normalizeGenerationOptions({
        style: req.body?.style || 'normal',
        humorLevel: req.body?.humorLevel,
      })
    } catch {
      return json(res, 400, { error: 'Choose a valid description style.' })
    }

    const legacyRequest = req.body?.projectId == null
    if (!legacyRequest && !PROJECT_ID_PATTERN.test(req.body.projectId || '')) {
      return json(res, 400, { error: 'Project information is invalid.' })
    }

    const requestKey = `user:${user.id}`
    if (IN_FLIGHT.has(requestKey)) {
      return json(res, 409, { error: 'A description is already being written.' })
    }

    const claim = await claimGenerationSlot(client, user.id)
    if (claim.decision === 'in_flight') return json(res, 409, { error: 'A description is already being written.' })
    if (claim.decision === 'rate_limited') {
      return json(res, 429, { error: 'Too many requests. Please wait a moment and try again.' })
    }
    if (claim.decision !== 'allowed') {
      return json(res, 503, { error: "Couldn't generate a description. Try again." })
    }

    IN_FLIGHT.add(requestKey)
    let timeout
    try {
      let facts
      if (!legacyRequest) {
        const owned = await loadOwnedListingFacts(client, user.id, req.body.projectId, req.body.existingDescription)
        if (owned.error === 'not_found') return json(res, 404, { error: 'Project not found.' })
        if (owned.error) return json(res, 500, { error: 'Could not load project information.' })
        facts = owned.facts
      } else {
        // Compatibility for already-released clients. New clients send projectId so
        // the server can load canonical owner-scoped project facts.
        facts = legacyListingFacts(req.body)
      }

      let prompt
      try {
        prompt = buildAnthropicRequest(facts, options)
      } catch {
        return json(res, 400, { error: 'Add some useful project details before generating a description.' })
      }
      if (!process.env.ANTHROPIC_API_KEY) {
        return json(res, 503, { error: "Couldn't generate a description. Try again." })
      }
      if (!await renewGenerationSlot(client, user.id, claim.claimToken)) {
        return json(res, 503, { error: "Couldn't generate a description. Try again." })
      }

      const controller = new AbortController()
      timeout = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS)
      try {
        const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: LISTING_MODEL,
            max_tokens: 650,
            temperature: options.style === 'professional' ? 0.5 : options.style === 'normal' ? 0.7 : 0.9,
            system: prompt.system,
            messages: [{ role: 'user', content: prompt.user }],
          }),
        })
        if (!response.ok) throw new Error(`provider_status_${response.status}`)
        const description = validateGeneratedDescriptionGrounding(
          parseGeneratedDescription(await response.json()),
          facts,
        )
        const listing = legacyRequest && facts.title ? `${facts.title}\n\n${description}` : description
        return json(res, 200, { description, listing })
      } catch (error) {
        const reason = error?.name === 'AbortError' ? 'timeout' : 'provider_failure'
        console.error('Listing generation failed:', reason)
        return json(res, error?.name === 'AbortError' ? 504 : 500, {
          error: "Couldn't generate a description. Try again.",
        })
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      IN_FLIGHT.delete(requestKey)
      await releaseGenerationSlot(client, user.id, claim.claimToken)
    }
  }
}

export default createGenerateListingHandler()
