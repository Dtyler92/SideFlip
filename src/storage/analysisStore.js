export const ANALYSIS_SCHEMA_VERSION = 1
export const MAX_SAVED_ANALYSES = 100
export const MAX_ANALYSIS_RECORD_BYTES = 4096
export const MAX_ANALYSIS_STORE_BYTES = 256000
export const SUPPORTED_CURRENCIES = Object.freeze(['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'MXN', 'JPY', 'INR'])

const keyFor = userId => `sideflip:saved-analyses:${userId}`
const MONEY_FIELDS = ['purchasePrice', 'estimatedExpenses', 'expectedSellingPrice', 'projectedProfit', 'maximumPurchasePrice', 'recommendedListPrice']
const INPUT_FIELDS = ['purchasePrice', 'repairsMaterials', 'parts', 'fuelTravel', 'shippingCost', 'otherExpenses', 'expectedSellingPrice', 'platformFeePct', 'sellerPaidShipping', 'salesTaxOtherFees', 'desiredMinimumProfit']
const PLATFORM_KEYS = new Set(['none', 'facebook', 'craigslist', 'ebay', 'custom'])
const MAX_INPUT_MONEY = 1_000_000_000
const MAX_DERIVED_MONEY = 80_000_000_000_000

function boundedString(value, max, allowEmpty = false) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return (allowEmpty || text) && text.length <= max ? text : null
}
function finiteBounded(value, { min = -1e9, max = 1e9, nullable = false } = {}) {
  if (nullable && value == null) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= min && number <= max ? number : undefined
}

const byteLength = value => new TextEncoder().encode(value).byteLength
const defaultStorage = () => {
  try { return globalThis.localStorage }
  catch { return null }
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.schemaVersion !== ANALYSIS_SCHEMA_VERSION) return null
  const id = boundedString(record.id, 100)
  const itemName = boundedString(record.itemName, 120)
  const analyzedAt = boundedString(record.analyzedAt, 40)
  const currency = boundedString(record.currency, 3)
  const platform = boundedString(record.platform, 30)
  if (!id || !itemName || !analyzedAt || Number.isNaN(Date.parse(analyzedAt)) || !SUPPORTED_CURRENCIES.includes(currency) || !platform || !PLATFORM_KEYS.has(platform)) return null
  if (!record.inputs || typeof record.inputs !== 'object' || Array.isArray(record.inputs)) return null
  const inputs = {}
  for (const field of INPUT_FIELDS) {
    const value = finiteBounded(record.inputs[field], { min: 0, max: MAX_INPUT_MONEY })
    if (value === undefined) return null
    inputs[field] = String(record.inputs[field]).trim()
  }
  const normalized = {
    schemaVersion: ANALYSIS_SCHEMA_VERSION, id,
    projectId: record.projectId == null ? null : boundedString(record.projectId, 100),
    itemName, platform, currency, estimateSource: 'user_entered', calculationVersion: 1, analyzedAt, inputs,
  }
  if (record.projectId != null && !normalized.projectId) return null
  for (const field of MONEY_FIELDS) {
    const limit = field === 'purchasePrice' || field === 'expectedSellingPrice' ? MAX_INPUT_MONEY : MAX_DERIVED_MONEY
    const value = finiteBounded(record[field], { min: -limit, max: limit })
    if (value === undefined) return null
    normalized[field] = Math.round(value * 100) / 100
  }
  const roi = finiteBounded(record.projectedRoi, { min: -1e6, max: 1e6, nullable: true })
  if (roi === undefined) return null
  normalized.projectedRoi = roi == null ? null : Math.round(roi * 100) / 100
  return byteLength(JSON.stringify(normalized)) <= MAX_ANALYSIS_RECORD_BYTES ? normalized : null
}

export function normalizeSavedAnalyses(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const result = []
  for (const candidate of value) {
    const record = normalizeRecord(candidate)
    if (!record || seen.has(record.id)) continue
    seen.add(record.id)
    result.push(record)
    if (result.length === MAX_SAVED_ANALYSES) break
  }
  return result
}

export function assertAnalysisCurrency(record, currency) {
  if (!record || record.currency !== currency) throw new Error(`This snapshot was saved in ${record?.currency || 'another currency'}. Change your profile currency to ${record?.currency || 'that currency'} before loading it.`)
  return record
}

export function createAnalysisStore(storage = defaultStorage()) {
  const queues = new Map()
  const availableStorage = () => {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
      throw new Error('Local storage is unavailable.')
    }
    return storage
  }
  async function read(userId) {
    if (!userId) return []
    const raw = await availableStorage().getItem(keyFor(userId))
    if (!raw) return []
    if (byteLength(raw) > MAX_ANALYSIS_STORE_BYTES) throw new Error('Saved analysis data is too large.')
    let parsed
    try { parsed = JSON.parse(raw) } catch { throw new Error('Saved analysis data is corrupted.') }
    return normalizeSavedAnalyses(parsed)
  }
  async function load(userId) {
    if (!userId) return []
    const pending = queues.get(userId)
    if (pending) await pending
    return read(userId)
  }
  function mutate(userId, operation) {
    if (!userId) return Promise.reject(new Error('Sign in to manage saved analyses.'))
    const previous = queues.get(userId) || Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    queues.set(userId, next)
    return next.finally(() => { if (queues.get(userId) === next) queues.delete(userId) })
  }
  async function write(userId, records) {
    const json = JSON.stringify(records)
    if (byteLength(json) > MAX_ANALYSIS_STORE_BYTES) throw new Error('Saved analysis storage limit reached.')
    await availableStorage().setItem(keyFor(userId), json)
  }
  return {
    loadSavedAnalyses: load,
    assertCurrency: assertAnalysisCurrency,
    saveAnalysis(userId, record) {
      return mutate(userId, async () => {
        const id = record?.id || `${Date.now()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 10)}`
        const candidate = { ...record, id, analyzedAt: record?.analyzedAt || new Date().toISOString(), schemaVersion: ANALYSIS_SCHEMA_VERSION }
        const normalized = normalizeRecord(candidate)
        if (!normalized) throw new Error('Analysis data is invalid.')
        const current = await read(userId)
        const next = [normalized, ...current.filter(item => item.id !== normalized.id)].slice(0, MAX_SAVED_ANALYSES)
        await write(userId, next)
        return normalized
      })
    },
    deleteSavedAnalysis(userId, analysisId) {
      return mutate(userId, async () => {
        const current = await read(userId)
        const next = current.filter(item => item.id !== analysisId)
        await write(userId, next)
        return next
      })
    },
    clearSavedAnalyses(userId) { return mutate(userId, () => availableStorage().removeItem(keyFor(userId))) },
  }
}

let defaultStore
const browserStore = () => (defaultStore ||= createAnalysisStore())
export const loadSavedAnalyses = (...args) => browserStore().loadSavedAnalyses(...args)
export const saveAnalysis = (...args) => browserStore().saveAnalysis(...args)
export const deleteSavedAnalysis = (...args) => browserStore().deleteSavedAnalysis(...args)
export const clearSavedAnalyses = (...args) => browserStore().clearSavedAnalyses(...args)
