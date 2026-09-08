import { registryToJson, sanitizeAsset, validateEvidenceRegistry, validateNormalizedCandidates, validateUnresolvedResults } from '../_shared/research-validators.js'

function disabled(message = 'Maintenance research is disabled or incompletely configured') {
  const error = new Error(message); error.code = 'RESEARCH_DISABLED'; return error
}

const ERROR_CODES = new Set([
  'BUDGET_EXCEEDED', 'INVALID_CANDIDATE', 'INVALID_CITATION', 'INVALID_EVIDENCE', 'INVALID_PROVIDER_RESPONSE',
  'PROVIDER_REJECTED', 'PROVIDER_TRANSIENT', 'POLICY_SUPERSEDED', 'RESEARCH_DISABLED', 'UNAPPROVED_SOURCE', 'UNCITED_EVIDENCE',
])

function safeErrorCode(error) {
  return ERROR_CODES.has(error?.code) ? error.code : 'WORKER_ERROR'
}

export async function processLeasedJob({ lease, config, domains, provider, db }) {
  if (!lease?.id || !lease?.lease_token || !db?.fail) throw disabled()
  let failureCostTicks = null
  try {
    if (!config || !provider || !db?.settle || !Array.isArray(domains) || !domains.length ||
        !Number.isInteger(config.maxSearches) || config.maxSearches < 1 || config.maxSearches > 3 ||
        !Number.isInteger(config.maxFetches) || config.maxFetches < 1 || config.maxFetches > 2 ||
        !Number.isInteger(lease.reserved_cents) || lease.reserved_cents < 1 || lease.reserved_cents > 100000) throw disabled()
    const asset = sanitizeAsset(lease.request_snapshot)
    let discovered
    try {
      discovered = await provider.discover({ asset, domains, maxSearches: config.maxSearches, maxFetches: config.maxFetches })
    } catch (error) {
      failureCostTicks = Number.isSafeInteger(error?.costInUsdTicks) && error.costInUsdTicks >= 0 ? error.costInUsdTicks : null
      throw error
    }
    if (!discovered || !Number.isSafeInteger(discovered.usage?.costInUsdTicks) || discovered.usage.costInUsdTicks < 0 ||
        !Number.isInteger(discovered.usage.searches) || discovered.usage.searches < 0 || discovered.usage.searches > config.maxSearches ||
        !Number.isInteger(discovered.usage.fetches) || discovered.usage.fetches < 0 || discovered.usage.fetches > config.maxFetches) {
      throw Object.assign(new Error('Provider discovery usage is invalid'), { code: 'INVALID_PROVIDER_RESPONSE' })
    }
    failureCostTicks = discovered.usage.costInUsdTicks
    const registry = validateEvidenceRegistry(discovered.evidence, domains, discovered.proofs)
    let normalized
    try {
      normalized = await provider.normalize({ evidence: registryToJson(registry) })
    } catch (error) {
      failureCostTicks = Number.isSafeInteger(error?.costInUsdTicks) && error.costInUsdTicks >= 0 &&
        Number.isSafeInteger(discovered.usage.costInUsdTicks + error.costInUsdTicks)
        ? discovered.usage.costInUsdTicks + error.costInUsdTicks : null
      throw error
    }
    if (!normalized || !Number.isSafeInteger(normalized.usage?.costInUsdTicks) || normalized.usage.costInUsdTicks < 0) {
      throw Object.assign(new Error('Provider normalization usage is invalid'), { code: 'INVALID_PROVIDER_RESPONSE' })
    }
    const unresolved = validateUnresolvedResults(normalized.unresolved || [])
    const candidates = validateNormalizedCandidates(normalized.candidates, registry, unresolved)
    const totalTicks = discovered.usage.costInUsdTicks + normalized.usage.costInUsdTicks
    if (!Number.isSafeInteger(totalTicks)) throw Object.assign(new Error('Provider usage cost is too large'), { code: 'INVALID_PROVIDER_RESPONSE' })
    failureCostTicks = totalTicks
    const costCents = Math.ceil(totalTicks / 100_000_000)
    if (!Number.isSafeInteger(costCents) || costCents > lease.reserved_cents) throw Object.assign(new Error('Reserved job budget exceeded'), { code: 'BUDGET_EXCEEDED' })
    await db.settle({ jobId: lease.id, leaseToken: lease.lease_token, costInUsdTicks: totalTicks, evidence: registryToJson(registry), candidates, unresolved })
    return { jobId: lease.id, candidateCount: candidates.length }
  } catch (error) {
    const code = safeErrorCode(error)
    await db.fail({ jobId: lease.id, leaseToken: lease.lease_token, costInUsdTicks: failureCostTicks, code, detail: code })
    throw error
  }
}
