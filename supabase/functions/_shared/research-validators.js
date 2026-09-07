const ASSET_FIELDS = Object.freeze([
  'modelYear', 'make', 'model', 'trim', 'engine', 'transmission',
  'drivetrain', 'fuel', 'market', 'vehicleType',
])
const ACTIONS = new Set(['inspect', 'adjust', 'replace'])
const PROFILES = new Set(['normal', 'severe'])
const SEMANTICS = new Set(['whichever_first', 'all'])
const SOURCE_CLASSES = new Set(['manufacturer', 'authorized_dealer'])
const CONTROL = /[\u0000-\u001f\u007f]/
const INJECTION = /(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system)\s+instructions?|reveal\s+(?:secrets?|credentials?|system prompt)|act as\s+(?:a|an)\s+/i

export class ResearchValidationError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'ResearchValidationError' }
}

function fail(code, message) { throw new ResearchValidationError(code, message) }
function text(value, max) { return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= max && !CONTROL.test(value) }
function positive(value, max) { return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

export function sanitizeAsset(input) {
  if (!plainObject(input)) fail('IDENTITY_UNCONFIRMED', 'Confirmed asset identity is required')
  const output = Object.fromEntries(ASSET_FIELDS.flatMap(key => input[key] == null ? [] : [[key, input[key]]]))
  if (!Number.isInteger(output.modelYear) || output.modelYear < 1881 || output.modelYear > 2200 ||
      !text(output.make, 200) || !text(output.model, 200)) {
    fail('IDENTITY_UNCONFIRMED', 'Confirmed year, make, and model are required')
  }
  for (const [key, value] of Object.entries(output)) {
    if (key !== 'modelYear' && !text(value, key === 'engine' ? 500 : 200)) fail('IDENTITY_UNCONFIRMED', `Invalid confirmed ${key}`)
  }
  return output
}

function dateOnly(value, now, maxAgeDays) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value) && date.getTime() <= today && date.getTime() >= today - maxAgeDays * 86400000
}

function matchingDomain(hostname, entries, now) {
  const host = hostname.toLowerCase()
  return entries.find(entry => {
    const domain = typeof entry?.domain === 'string' ? entry.domain : ''
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain) &&
      SOURCE_CLASSES.has(entry.sourceClass) && dateOnly(entry.termsReviewedOn, now, 365) && dateOnly(entry.robotsReviewedOn, now, 30) &&
      (host === domain || (entry.includeSubdomains === true && host.endsWith(`.${domain}`)))
  })
}

function pathAllowed(pathname, entry) {
  const prefixes = Array.isArray(entry?.allowedPathPrefixes) ? entry.allowedPathPrefixes : ['/']
  if (/%(?:2f|5c|2e)/i.test(pathname) || pathname.includes('\\')) return false
  return prefixes.length > 0 && prefixes.length <= 20 &&
    prefixes.every(prefix => typeof prefix === 'string' && prefix.startsWith('/') && prefix.length <= 500 && !/%(?:2f|5c|2e)/i.test(prefix) && !prefix.includes('\\')) &&
    prefixes.some(prefix => prefix === '/' || pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))
}

export function validateEvidenceRegistry(values, approvedDomains, providerProofs = [], now = new Date()) {
  if (!Array.isArray(values) || values.length > 30 || !Array.isArray(approvedDomains) || !approvedDomains.length) fail('INVALID_EVIDENCE', 'Evidence registry is invalid')
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('INVALID_EVIDENCE', 'Evidence validation time is invalid')
  const proofs = providerProofs.map(proof => {
    if (!plainObject(proof) || !text(proof.canonicalUrl, 2048) || !text(proof.title, 500) || !text(proof.citedText, 4000) || !text(proof.retrievedAt, 40)) fail('INVALID_CITATION', 'Provider citation proof is invalid')
    let url
    try { url = new URL(proof.canonicalUrl) } catch { fail('INVALID_CITATION', 'Provider citation URL is invalid') }
    const retrieved = new Date(proof.retrievedAt)
    if (!Number.isFinite(retrieved.getTime()) || retrieved.toISOString() !== proof.retrievedAt || retrieved > now || retrieved < new Date(now.getTime() - 30 * 86400000)) fail('INVALID_CITATION', 'Provider citation retrieval time is invalid')
    return { canonicalUrl: url.href, title: proof.title, citedText: proof.citedText, retrievedAt: proof.retrievedAt }
  })
  const comparable = value => value.replace(/\s+/g, ' ').trim().toLowerCase()
  const registry = new Map()
  for (const evidence of values) {
    if (!plainObject(evidence) || !text(evidence.id, 100) || registry.has(evidence.id) ||
        !text(evidence.title, 500) || !text(evidence.canonicalUrl, 2048) || !text(evidence.exactExcerpt, 4000) ||
        !text(evidence.applicability, 1000) || !text(evidence.accessedAt, 40) ||
        !SOURCE_CLASSES.has(evidence.sourceClass) || evidence.locationVerified !== true ||
        !(text(evidence.page, 100) || text(evidence.section, 500)) ||
        INJECTION.test(`${evidence.title}\n${evidence.exactExcerpt}`)) fail('INVALID_EVIDENCE', 'Evidence is incomplete, unsafe, or unverified')
    let url
    try { url = new URL(evidence.canonicalUrl) } catch { fail('INVALID_EVIDENCE', 'Evidence URL is invalid') }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || url.hostname !== url.hostname.toLowerCase() || url.href !== evidence.canonicalUrl) fail('INVALID_EVIDENCE', 'Evidence URL must be canonical HTTPS')
    const approved = matchingDomain(url.hostname, approvedDomains, now)
    if (!approved || approved.sourceClass !== evidence.sourceClass || !pathAllowed(url.pathname, approved)) fail('UNAPPROVED_SOURCE', 'Evidence source is not enabled')
    const citation = proofs.find(proof => proof.canonicalUrl === url.href
      && comparable(proof.title) === comparable(evidence.title)
      && proof.retrievedAt === evidence.accessedAt
      && (comparable(proof.citedText).includes(comparable(evidence.exactExcerpt)) || comparable(evidence.exactExcerpt).includes(comparable(proof.citedText))))
    if (!citation) fail('UNCITED_EVIDENCE', 'Evidence excerpt is not backed by a provider citation')
    const accessed = new Date(evidence.accessedAt)
    if (!Number.isFinite(accessed.getTime()) || accessed.toISOString() !== evidence.accessedAt || accessed > now || accessed < new Date(now.getTime() - 30 * 86400000)) fail('INVALID_EVIDENCE', 'Evidence access time is invalid')
    registry.set(evidence.id, Object.freeze({ ...evidence, sourceDomain: approved.domain.toLowerCase() }))
  }
  return registry
}

function normalizedTaskName(value) { return value.trim().replace(/\s+/g, ' ').toLowerCase() }

export function validateNormalizedCandidates(values, evidenceById, unresolved = []) {
  if (!Array.isArray(values) || values.length > 100 || !(evidenceById instanceof Map)) fail('INVALID_CANDIDATE', 'Candidate list is invalid')
  const unresolvedNames = new Set((Array.isArray(unresolved) ? unresolved : []).map(value => normalizedTaskName(value.name || '')))
  const seen = new Map()
  const output = []
  for (const candidate of values) {
    if (!plainObject(candidate) || !text(candidate.name, 200) || !ACTIONS.has(candidate.action) ||
        !PROFILES.has(candidate.profile) || !SEMANTICS.has(candidate.dueSemantics) || !text(candidate.uncertainty, 500) ||
        candidate.conflict !== false || !Array.isArray(candidate.evidenceIds) || candidate.evidenceIds.length < 1 || candidate.evidenceIds.length > 10 ||
        candidate.evidenceIds.some(id => !text(id, 100) || !evidenceById.has(id))) fail('INVALID_CANDIDATE', 'Candidate is unresolved, conflicting, or uncited')
    const intervals = [
      ['intervalMiles', 10_000_000], ['intervalHours', 10_000_000],
      ['intervalCycles', 1_000_000_000], ['intervalMonths', 1200],
    ].filter(([key]) => candidate[key] != null)
    if (!intervals.length || intervals.some(([key, max]) => !positive(candidate[key], max))) fail('INVALID_CANDIDATE', 'Candidate interval is invalid')
    const name = normalizedTaskName(candidate.name)
    if (unresolvedNames.has(name)) fail('INVALID_CANDIDATE', 'Candidate conflicts with an unresolved task')
    const key = `${name}\u0000${candidate.profile}\u0000${candidate.action}`
    const comparable = JSON.stringify({ ...candidate, name: undefined })
    if (seen.has(key)) {
      if (seen.get(key) !== comparable) fail('INVALID_CANDIDATE', 'Inconsistent duplicate normalized candidate')
      continue
    }
    seen.set(key, comparable)
    output.push(candidate)
  }
  return output
}

export function validateUnresolvedResults(values) {
  if (!Array.isArray(values) || values.length > 50) fail('INVALID_UNRESOLVED', 'Unresolved result list is invalid')
  return values.map(value => {
    if (!plainObject(value) || !text(value.name, 200) || !text(value.reason, 1000) || INJECTION.test(`${value.name}\n${value.reason}`)) {
      fail('INVALID_UNRESOLVED', 'Unresolved result is invalid')
    }
    return Object.freeze({ name: value.name, reason: value.reason })
  })
}

export function registryToJson(registry) { return [...registry.values()] }
