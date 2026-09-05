const ALLOWED_ACTIONS = new Set(['inspection', 'adjustment', 'replacement'])
const ALLOWED_PROFILES = new Set(['normal', 'severe'])
const ALLOWED_SOURCE_CLASSES = new Set(['manufacturer', 'government_manufacturer', 'secondary'])
const ASSET_KEYS = Object.freeze([
  'modelYear', 'make', 'model', 'engineModel', 'displacementLiters',
  'transmissionStyle', 'driveType', 'market',
])
const INJECTION_PATTERN = /(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system)\s+instructions?|reveal\s+(?:secrets?|credentials?|system prompt)|act as\s+(?:a|an)\s+/i

function researchError(code, message) {
  return Object.assign(new Error(message), { code })
}

function nonempty(value, max = 1000) {
  return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}

function boundedNumber(value, max = 1_000_000) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max
}

function validateEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) ||
      !nonempty(evidence.id, 100) || !nonempty(evidence.title, 300) ||
      !nonempty(evidence.canonicalUrl, 2048) || !nonempty(evidence.exactExcerpt, 4000) ||
      !nonempty(evidence.applicability, 1000) || !nonempty(evidence.accessedAt, 40) ||
      !ALLOWED_SOURCE_CLASSES.has(evidence.sourceClass) ||
      !(nonempty(evidence.page, 100) || nonempty(evidence.section, 300))) {
    throw researchError('INVALID_EVIDENCE', 'Research evidence is incomplete or invalid')
  }
  let url
  try { url = new URL(evidence.canonicalUrl) } catch { throw researchError('INVALID_EVIDENCE', 'Evidence URL is invalid') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw researchError('INVALID_EVIDENCE', 'Evidence URL must be canonical HTTPS')
  const accessed = new Date(evidence.accessedAt)
  if (!Number.isFinite(accessed.getTime()) || accessed.toISOString() !== evidence.accessedAt) throw researchError('INVALID_EVIDENCE', 'Evidence access timestamp is invalid')
  if (INJECTION_PATTERN.test(`${evidence.title}\n${evidence.exactExcerpt}`)) throw researchError('PROMPT_INJECTION', 'Evidence contains instruction-shaped content')
  return evidence
}

export function validateResearchCandidate(candidate, evidenceById) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
      !nonempty(candidate.name, 200) || !ALLOWED_ACTIONS.has(candidate.action) ||
      !ALLOWED_PROFILES.has(candidate.profile) || !nonempty(candidate.uncertainty, 500) ||
      !Array.isArray(candidate.evidenceIds) || candidate.evidenceIds.length < 1 || candidate.evidenceIds.length > 20 ||
      candidate.evidenceIds.some(id => !nonempty(id, 100) || !evidenceById.has(id))) {
    throw researchError('INVALID_CANDIDATE', 'Research candidate is incomplete or uncited')
  }
  const intervals = ['intervalMiles', 'intervalHours', 'intervalMonths'].filter(key => candidate[key] != null)
  if (!intervals.length || intervals.some(key => !boundedNumber(candidate[key], key === 'intervalMonths' ? 1200 : 10_000_000))) {
    throw researchError('INVALID_CANDIDATE', 'Research candidate interval is invalid')
  }
  return candidate
}

function validatedConfig(provider, config) {
  return Boolean(provider && typeof provider.execute === 'function' && config?.enabled === true &&
    nonempty(config.providerName, 100) && nonempty(config.model, 200) &&
    nonempty(config.retentionPolicy, 500) && Number.isInteger(config.perJobBudgetCents) && config.perJobBudgetCents > 0 &&
    Number.isInteger(config.monthlyBudgetCents) && config.monthlyBudgetCents >= config.perJobBudgetCents)
}

export function createResearchExecutor({ provider, config } = {}) {
  return {
    async run(job) {
      if (!validatedConfig(provider, config)) throw researchError('RESEARCH_DISABLED', 'Research provider is not fully configured')
      if (!job || !/^[a-f0-9]{64}$/.test(job.confirmedFingerprint || '')) throw researchError('IDENTITY_UNCONFIRMED', 'Confirmed vehicle identity is required')
      const asset = Object.fromEntries(ASSET_KEYS.flatMap(key => job.asset?.[key] == null ? [] : [[key, job.asset[key]]]))
      if (!Number.isInteger(asset.modelYear) || asset.modelYear < 1881 || asset.modelYear > 2200 || !nonempty(asset.make, 160) || !nonempty(asset.model, 160)) {
        throw researchError('IDENTITY_UNCONFIRMED', 'Confirmed vehicle identity is incomplete')
      }
      const result = await provider.execute({ asset, model: config.model, retentionPolicy: config.retentionPolicy })
      if (!result || !Array.isArray(result.evidence) || !Array.isArray(result.candidates) ||
          !Number.isInteger(result.usage?.costCents) || result.usage.costCents < 0) {
        throw researchError('INVALID_PROVIDER_RESPONSE', 'Research provider returned an invalid response')
      }
      if (result.usage.costCents > config.perJobBudgetCents) throw researchError('BUDGET_EXCEEDED', 'Research exceeded its reserved budget')
      const evidence = result.evidence.map(validateEvidence)
      const evidenceById = new Map(evidence.map(value => [value.id, value]))
      if (evidenceById.size !== evidence.length) throw researchError('INVALID_EVIDENCE', 'Evidence IDs must be unique')
      const candidates = result.candidates.map(value => validateResearchCandidate(value, evidenceById))
      return { evidence, candidates, usage: { costCents: result.usage.costCents } }
    },
  }
}
