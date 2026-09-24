const DEFAULT_ENDPOINT = '/api/report-data'
const MAX_RESPONSE_BYTES = 128 * 1024
const SUBJECT_TYPES = new Set(['project', 'my_stuff_item'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OPTION_KEYS = ['includeIdentifiers', 'includeDetailedCosts']

export const REPORT_SUBJECT_TYPES = Object.freeze({ project: 'project', myStuffItem: 'my_stuff_item' })
export const REPORT_DISCLAIMER = 'Prepared by the owner from SideFlip records. Verify details independently before relying on this private report.'

const SAFE_ERRORS = Object.freeze({
  AUTH_REQUIRED: 'Please sign in again to create a report.',
  PRO_REQUIRED: 'SideFlip Pro is required to create reports.',
  ACCOUNT_DELETED: 'This account is unavailable.',
  SUBJECT_NOT_FOUND: 'This item is no longer available.',
  REQUEST_TOO_LARGE: 'The report request is too large.',
  RESPONSE_TOO_LARGE: 'This report contains too much data to create safely.',
  PRIVATE_MEDIA_UNAVAILABLE: 'Private photos or documents are not available for this report.',
  SERVICE_UNAVAILABLE: 'Report data is temporarily unavailable. Try again later.',
})

export class ReportDataError extends Error {
  constructor(message, { code = 'REPORT_FAILED', retryable = false, proRequired = false } = {}) {
    super(message)
    this.name = 'ReportDataError'
    this.code = code
    this.retryable = Boolean(retryable)
    this.proRequired = Boolean(proRequired)
  }
}

function invalidResponse() {
  return new ReportDataError('The report service returned an invalid response. Try again later.', { code: 'INVALID_RESPONSE', retryable: true })
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).byteLength
}

async function rejectResponse(reader, abort) {
  try { await reader?.cancel?.() } catch { /* best effort */ }
  abort()
  throw invalidResponse()
}

async function readBoundedJson(response, maxBytes, abort) {
  const rawLength = response?.headers?.get?.('content-length')
  const declared = typeof rawLength === 'string' && /^\d+$/.test(rawLength.trim()) ? Number(rawLength) : null
  if (declared != null && (!Number.isSafeInteger(declared) || declared > maxBytes)) await rejectResponse(null, abort)

  let text
  if (response?.body?.getReader) {
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || !Number.isSafeInteger(value.byteLength)) await rejectResponse(reader, abort)
      total += value.byteLength
      if (!Number.isSafeInteger(total) || total > maxBytes) await rejectResponse(reader, abort)
      chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength))
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { await rejectResponse(reader, abort) }
  } else {
    if (declared == null || typeof response?.text !== 'function') await rejectResponse(null, abort)
    text = await response.text()
    if (typeof text !== 'string' || utf8ByteLength(text) > maxBytes) await rejectResponse(null, abort)
  }
  try { return JSON.parse(text) } catch { throw invalidResponse() }
}

function responseError(status, body) {
  const code = typeof body?.code === 'string' && /^[A-Z0-9_]{1,50}$/.test(body.code) ? body.code : 'REPORT_FAILED'
  const message = SAFE_ERRORS[code] || (status === 401 ? SAFE_ERRORS.AUTH_REQUIRED : status === 403 ? SAFE_ERRORS.PRO_REQUIRED : 'Could not create the report. Try again later.')
  return new ReportDataError(message, { code, retryable: status >= 500, proRequired: status === 403 || code === 'PRO_REQUIRED' })
}

function validateCanonicalResponse(body, subjectType, subjectId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  if (body.schemaVersion !== 1 || body.subjectType !== subjectType || body.subjectId !== subjectId) return null
  if (typeof body.disclaimer !== 'string' || !body.disclaimer.trim() || body.disclaimer.length > 1_000) return null
  if (!body.report || typeof body.report !== 'object' || Array.isArray(body.report)) return null
  return { schemaVersion: 1, subjectType, subjectId, disclaimer: body.disclaimer, report: body.report }
}

export function createReportDataClient({ auth, fetchImpl = globalThis.fetch, endpoint = DEFAULT_ENDPOINT, timeoutMs = 15_000, maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
  if (!auth?.getSession) throw new TypeError('Report auth adapter is required.')
  if (typeof fetchImpl !== 'function') throw new TypeError('Report fetch adapter is required.')
  return {
    async load({ subjectType, subjectId, options = {}, signal } = {}) {
      if (!SUBJECT_TYPES.has(subjectType)) throw new ReportDataError('Choose a supported report type.', { code: 'SUBJECT_TYPE_INVALID' })
      if (typeof subjectId !== 'string' || !UUID_PATTERN.test(subjectId)) throw new ReportDataError('The selected item is invalid.', { code: 'SUBJECT_ID_INVALID' })
      let sessionResult
      try { sessionResult = await auth.getSession() } catch { throw new ReportDataError(SAFE_ERRORS.AUTH_REQUIRED, { code: 'AUTH_REQUIRED' }) }
      const token = sessionResult?.data?.session?.access_token
      if (sessionResult?.error || !token) throw new ReportDataError(SAFE_ERRORS.AUTH_REQUIRED, { code: 'AUTH_REQUIRED' })

      const controller = new AbortController()
      let timedOut = false
      const abortFromCaller = () => controller.abort()
      if (signal?.aborted) controller.abort()
      else signal?.addEventListener?.('abort', abortFromCaller, { once: true })
      const timeout = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
      const requestBody = { subjectType, subjectId, disclaimer: REPORT_DISCLAIMER }
      for (const key of OPTION_KEYS) requestBody[key] = options[key] === true
      requestBody.includePhotos = false
      requestBody.includeDocuments = false

      let response
      let body
      try {
        if (controller.signal.aborted) throw Object.assign(new Error('Request aborted'), { name: 'AbortError' })
        response = await fetchImpl(endpoint, {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(requestBody),
        })
        body = await readBoundedJson(response, maxResponseBytes, () => controller.abort())
      } catch (error) {
        if (error instanceof ReportDataError) throw error
        const callerCancelled = signal?.aborted === true
        throw new ReportDataError(callerCancelled ? 'Report creation was cancelled.' : timedOut ? 'Report creation timed out. Try again.' : 'Report data is temporarily unavailable. Try again later.', {
          code: callerCancelled ? 'REPORT_CANCELLED' : timedOut ? 'REPORT_TIMEOUT' : 'NETWORK_UNAVAILABLE', retryable: !callerCancelled,
        })
      } finally {
        clearTimeout(timeout)
        signal?.removeEventListener?.('abort', abortFromCaller)
      }
      if (!response.ok) throw responseError(response.status, body)
      const result = validateCanonicalResponse(body, subjectType, subjectId)
      if (!result) throw invalidResponse()
      return result
    },
  }
}

export function createReportRequestGate() {
  let generation = 0
  let active = null
  return {
    begin(requestKey) {
      active?.controller.abort()
      const request = { generation: ++generation, requestKey, controller: new AbortController() }
      active = request
      return request
    },
    isCurrent(request, requestKey = request?.requestKey) { return active === request && request.generation === generation && request.requestKey === requestKey && !request.controller.signal.aborted },
    finish(request) { if (active !== request) return false; active = null; return true },
    invalidate() { generation += 1; active?.controller.abort(); active = null },
  }
}

export function escapeReportHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

function renderValue(value) {
  if (Array.isArray(value)) return `<ol>${value.map(entry => `<li>${renderValue(entry)}</li>`).join('')}</ol>`
  if (value && typeof value === 'object') return `<dl>${Object.entries(value).filter(([, entry]) => entry != null).map(([key, entry]) => `<dt>${escapeReportHtml(key)}</dt><dd>${renderValue(entry)}</dd>`).join('')}</dl>`
  return escapeReportHtml(value)
}

function reportDate(value) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new RangeError('A valid report date is required.')
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(date)
}

export function renderCanonicalReportHtml(payload = {}, { generatedAt = new Date().toISOString() } = {}) {
  if (!payload.report || typeof payload.report !== 'object' || Array.isArray(payload.report)) throw new TypeError('Canonical report data is required.')
  const titleText = payload.subjectType === 'my_stuff_item' ? 'SideFlip My Stuff Report' : 'SideFlip Project Report'
  const title = escapeReportHtml(titleText)
  const date = escapeReportHtml(reportDate(generatedAt))
  const disclaimer = escapeReportHtml(payload.disclaimer)
  const body = Object.entries(payload.report).filter(([, value]) => value != null).map(([key, value]) => `<section><h2>${escapeReportHtml(key)}</h2>${renderValue(value)}</section>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1a1917;margin:36px;line-height:1.45}h1{margin-bottom:4px}h2{font-size:15px;text-transform:capitalize;border-bottom:1px solid #ddd;padding-bottom:5px}section{break-inside:avoid;margin-top:22px}dl{margin:6px 0 6px 14px}dt{font-weight:700;margin-top:6px}dd{margin-left:14px;white-space:pre-wrap}.meta,.privacy{color:#5c5850}.privacy{border:1px solid #d7d2cb;border-radius:8px;padding:12px}</style></head><body><h1>${title}</h1><p class="meta">Report date: ${date}</p><p class="privacy"><strong>Private report:</strong> Share only with people you trust. ${disclaimer}</p>${body}</body></html>`
}
