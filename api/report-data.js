import { createClient } from '@supabase/supabase-js'
import { resolveServerEntitlement } from './_lib/entitlements.js'

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SUBJECT_TABLES = Object.freeze({ project: 'projects', my_stuff_item: 'my_stuff_items' })
const REQUEST_KEYS = new Set(['subjectType', 'subjectId', 'disclaimer', 'includeIdentifiers', 'includeDetailedCosts', 'includePhotos', 'includeDocuments'])
const OPTION_KEYS = ['includeIdentifiers', 'includeDetailedCosts', 'includePhotos', 'includeDocuments']
const MAX_REQUEST_BYTES = 16_384
const MAX_RESPONSE_BYTES = 131_072
const MAX_DISCLAIMER_LENGTH = 1_000
const MAX_NOTES_LENGTH = 4_000
const MAX_HISTORY_NOTES_LENGTH = 1_000
const MAX_HISTORY_COUNT = 100
const MAX_SCHEDULE_COUNT = 50
const MAX_MEDIA_COUNT = 12
const MAX_MONEY = 1_000_000_000_000

// PRIVATE_MEDIA_ADAPTER_CONTRACT:
// listPrivateMedia({ userId, subjectType, subjectId, kinds, limit }) returns only
// authorized, short-lived render objects: { kind, label, url, expiresAt }.
// The adapter must resolve private storage server-side. It must never return raw
// object keys, bucket names, storage paths, permanent/public URLs, or documents
// that have not been independently authorized for this owner and subject.
const NO_PRIVATE_MEDIA = Object.freeze({
  async listPrivateMedia() { return [] },
})

function json(res, status, body) {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, max-age=0, must-revalidate')
  res.setHeader('CDN-Cache-Control', 'no-store')
  res.setHeader('Vary', 'Authorization')
  return res.status(status).json(body)
}

function failure(res, status, code, message) {
  return json(res, status, { code, error: message })
}

function cleanText(value, maxLength, { required = false } = {}) {
  if (typeof value !== 'string') return required ? null : undefined
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').trim()
  if (!cleaned) return required ? null : undefined
  return cleaned.slice(0, maxLength)
}

function cleanDate(value) {
  if (typeof value !== 'string' || value.length > 35) return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? value : undefined
}

function cleanNumber(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === undefined || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) && Math.abs(number) <= maximum ? number : undefined
}

function assignDefined(target, entries) {
  for (const [key, value] of entries) if (value !== undefined) target[key] = value
  return target
}

function parseRequest(req) {
  const contentLength = Number(req.headers?.['content-length'])
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) return { error: 'too_large' }
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid' }
  let encoded
  try { encoded = JSON.stringify(body) } catch { return { error: 'invalid' } }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST_BYTES) return { error: 'too_large' }
  if (Object.keys(body).some(key => !REQUEST_KEYS.has(key))) return { error: 'invalid' }
  if (!Object.hasOwn(SUBJECT_TABLES, body.subjectType) || !UUID_PATTERN.test(body.subjectId || '')) return { error: 'invalid' }
  if (OPTION_KEYS.some(key => body[key] !== undefined && typeof body[key] !== 'boolean')) return { error: 'invalid' }
  const disclaimer = cleanText(body.disclaimer, MAX_DISCLAIMER_LENGTH, { required: true })
  if (!disclaimer || body.disclaimer.trim().length > MAX_DISCLAIMER_LENGTH) return { error: 'invalid' }
  return {
    value: {
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      disclaimer,
      includeIdentifiers: body.includeIdentifiers === true,
      includeDetailedCosts: body.includeDetailedCosts === true,
      includePhotos: body.includePhotos === true,
      includeDocuments: body.includeDocuments === true,
    },
  }
}

function isMissingOptionalColumn(error) {
  return error?.code === '42703' || error?.code === 'PGRST204'
}

async function optionalSingle(query) {
  const result = await query.maybeSingle()
  if (!result.error) return { data: result.data || {} }
  if (isMissingOptionalColumn(result.error)) return { data: {} }
  return { error: result.error }
}

function projectSummary(row) {
  return assignDefined({}, [
    ['title', cleanText(row?.title, 300)],
    ['category', cleanText(row?.category, 100)],
    ['status', cleanText(row?.status, 40)],
    ['notes', cleanText(row?.notes, MAX_NOTES_LENGTH)],
    ['createdAt', cleanDate(row?.created_at)],
    ['soldAt', cleanDate(row?.sold_at)],
  ])
}

function projectIdentifiers(legacy, vehicle) {
  return assignDefined({}, [
    ['modelNumber', cleanText(legacy?.model_number, 200)],
    ['serialNumber', cleanText(legacy?.serial_number, 200)],
    ['engineModel', cleanText(legacy?.engine_model, 200)],
    ['engineSerial', cleanText(legacy?.engine_serial, 200)],
    ['vin', cleanText(legacy?.vin, 100)],
    ['hullNumber', cleanText(legacy?.hull_number, 100)],
    ['vehicleYear', cleanNumber(vehicle?.vehicle_year, 3000)],
    ['vehicleMake', cleanText(vehicle?.vehicle_make, 100)],
    ['vehicleModel', cleanText(vehicle?.vehicle_model, 100)],
  ])
}

function expenseRows(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, MAX_HISTORY_COUNT).map(row => assignDefined({}, [
    ['description', cleanText(row?.description, 500)],
    ['category', cleanText(row?.category, 100)],
    ['amount', cleanNumber(row?.amount, MAX_MONEY)],
    ['createdAt', cleanDate(row?.created_at)],
  ]))
}

async function loadProjectReport(client, userId, input) {
  const baseResult = await client.from('projects')
    .select('id,title,category,status,notes,created_at,sold_at')
    .eq('id', input.subjectId).eq('user_id', userId).maybeSingle()
  if (baseResult.error || !baseResult.data) return { error: true }
  const report = projectSummary(baseResult.data)

  if (input.includeIdentifiers) {
    const [legacy, vehicle] = await Promise.all([
      optionalSingle(client.from('projects').select('model_number,serial_number,engine_model,engine_serial,vin,hull_number').eq('id', input.subjectId).eq('user_id', userId)),
      optionalSingle(client.from('projects').select('vehicle_year,vehicle_make,vehicle_model').eq('id', input.subjectId).eq('user_id', userId)),
    ])
    if (legacy.error || vehicle.error) return { error: true }
    report.identifiers = projectIdentifiers(legacy.data, vehicle.data)
  }

  if (input.includeDetailedCosts) {
    const [costResult, expenseResult] = await Promise.all([
      client.from('projects').select('purchase_price,sale_price').eq('id', input.subjectId).eq('user_id', userId).maybeSingle(),
      client.from('expenses').select('description,category,amount,created_at').eq('project_id', input.subjectId).eq('user_id', userId).order('created_at', { ascending: false }).limit(MAX_HISTORY_COUNT),
    ])
    if (costResult.error || expenseResult.error) return { error: true }
    const expenses = expenseRows(expenseResult.data)
    const amounts = expenses.map(row => row.amount).filter(Number.isFinite)
    report.detailedCosts = assignDefined({
      expenseTotal: amounts.reduce((sum, amount) => sum + amount, 0),
      expenses,
    }, [
      ['purchasePrice', cleanNumber(costResult.data?.purchase_price, MAX_MONEY)],
      ['salePrice', cleanNumber(costResult.data?.sale_price, MAX_MONEY)],
    ])
    // Keep the stable key order convenient for local renderers.
    report.detailedCosts = {
      ...(Object.hasOwn(report.detailedCosts, 'purchasePrice') ? { purchasePrice: report.detailedCosts.purchasePrice } : {}),
      ...(Object.hasOwn(report.detailedCosts, 'salePrice') ? { salePrice: report.detailedCosts.salePrice } : {}),
      expenseTotal: report.detailedCosts.expenseTotal,
      expenses: report.detailedCosts.expenses,
    }
  }
  return { report }
}

function itemSummary(row) {
  return assignDefined({}, [
    ['name', cleanText(row?.name, 300)],
    ['category', cleanText(row?.category, 100)],
    ['acquiredOn', cleanDate(row?.acquired_on)],
    ['notes', cleanText(row?.notes, MAX_NOTES_LENGTH)],
    ['currentMileage', cleanNumber(row?.current_mileage)],
    ['currentHours', cleanNumber(row?.current_hours)],
    ['createdAt', cleanDate(row?.created_at)],
    ['updatedAt', cleanDate(row?.updated_at)],
  ])
}

function schedules(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, MAX_SCHEDULE_COUNT).map(row => assignDefined({}, [
    ['name', cleanText(row?.name, 300)],
    ['trackingType', ['mileage', 'hours', 'calendar'].includes(row?.tracking_type) ? row.tracking_type : undefined],
    ['intervalValue', cleanNumber(row?.interval_value)],
    ['lastCompletedAt', cleanDate(row?.last_completed_at)],
    ['lastCompletedValue', cleanNumber(row?.last_completed_value)],
    ['nextDueAt', cleanDate(row?.next_due_at)],
    ['nextDueValue', cleanNumber(row?.next_due_value)],
  ]))
}

function serviceHistory(rows, includeCosts) {
  return (Array.isArray(rows) ? rows : []).slice(0, MAX_HISTORY_COUNT).map(row => assignDefined({}, [
    ['name', cleanText(row?.name, 300)],
    ['completedAt', cleanDate(row?.completed_at)],
    ['mileage', cleanNumber(row?.mileage)],
    ['hours', cleanNumber(row?.hours)],
    ...(includeCosts ? [['cost', cleanNumber(row?.cost, MAX_MONEY)]] : []),
    ['notes', cleanText(row?.notes, MAX_HISTORY_NOTES_LENGTH)],
  ]))
}

async function loadMyStuffReport(client, userId, input) {
  const baseResult = await client.from('my_stuff_items')
    .select('id,name,category,acquired_on,notes,current_mileage,current_hours,created_at,updated_at')
    .eq('id', input.subjectId).eq('user_id', userId).maybeSingle()
  if (baseResult.error || !baseResult.data) return { error: true }
  const logColumns = input.includeDetailedCosts
    ? 'name,completed_at,mileage,hours,cost,notes'
    : 'name,completed_at,mileage,hours,notes'
  const [scheduleResult, logResult] = await Promise.all([
    client.from('my_stuff_schedules')
      .select('name,tracking_type,interval_value,last_completed_at,last_completed_value,next_due_at,next_due_value')
      .eq('item_id', input.subjectId).eq('user_id', userId).order('created_at', { ascending: true }).limit(MAX_SCHEDULE_COUNT),
    client.from('my_stuff_service_logs').select(logColumns)
      .eq('item_id', input.subjectId).eq('user_id', userId).order('completed_at', { ascending: false }).limit(MAX_HISTORY_COUNT),
  ])
  if (scheduleResult.error || logResult.error) return { error: true }
  const report = itemSummary(baseResult.data)
  report.schedules = schedules(scheduleResult.data)
  report.serviceHistory = serviceHistory(logResult.data, input.includeDetailedCosts)

  if (input.includeIdentifiers) {
    const optional = await optionalSingle(client.from('my_stuff_items')
      .select('manufacturer,model,year,serial_number,vin').eq('id', input.subjectId).eq('user_id', userId))
    if (optional.error) return { error: true }
    report.identifiers = assignDefined({}, [
      ['manufacturer', cleanText(optional.data?.manufacturer, 100)],
      ['model', cleanText(optional.data?.model, 200)],
      ['year', cleanNumber(optional.data?.year, 3000)],
      ['serialNumber', cleanText(optional.data?.serial_number, 200)],
      ['vin', cleanText(optional.data?.vin, 100)],
    ])
  }
  if (input.includeDetailedCosts) {
    const optional = await optionalSingle(client.from('my_stuff_items')
      .select('purchase_price,estimated_value').eq('id', input.subjectId).eq('user_id', userId))
    if (optional.error) return { error: true }
    report.detailedCosts = assignDefined({}, [
      ['purchasePrice', cleanNumber(optional.data?.purchase_price, MAX_MONEY)],
      ['estimatedValue', cleanNumber(optional.data?.estimated_value, MAX_MONEY)],
    ])
  }
  return { report }
}

function sanitizeMedia(rows, requestedKinds) {
  const allowed = new Set(requestedKinds)
  const now = Date.now()
  return (Array.isArray(rows) ? rows : []).slice(0, MAX_MEDIA_COUNT).flatMap(row => {
    if (!allowed.has(row?.kind) || typeof row?.url !== 'string' || typeof row?.expiresAt !== 'string') return []
    let url
    try { url = new URL(row.url) } catch { return [] }
    const expiry = Date.parse(row.expiresAt)
    if (url.protocol !== 'https:' || !Number.isFinite(expiry) || expiry <= now || expiry > now + 3_600_000) return []
    return [assignDefined({ kind: row.kind, url: url.toString(), expiresAt: row.expiresAt }, [
      ['label', cleanText(row.label, 200)],
    ])]
  })
}

export function createReportDataHandler({ client = supabase, privateMediaAdapter = NO_PRIVATE_MEDIA } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return failure(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST for private report data.')
    const parsed = parseRequest(req)
    if (parsed.error === 'too_large') return failure(res, 413, 'REQUEST_TOO_LARGE', 'The report request is too large.')
    if (parsed.error) return failure(res, 400, 'INVALID_REQUEST', 'The report request is invalid.')
    const input = parsed.value

    try {
      const authHeader = req.headers?.authorization || ''
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) return failure(res, 401, 'AUTH_REQUIRED', 'Sign in to create a report.')
    const { data: { user } = {}, error: authError } = await client.auth.getUser(token)
    if (authError || !user?.id) return failure(res, 401, 'AUTH_REQUIRED', 'Sign in again to create a report.')

    const [tombstoneResult, profileResult, entitlementResult] = await Promise.all([
      client.from('account_deletion_tombstones').select('status').eq('user_id', user.id).maybeSingle(),
      client.from('profiles').select('subscription_id,subscription_status').eq('id', user.id).maybeSingle(),
      client.from('user_entitlements').select('source,status,expires_at,last_verified_at').eq('user_id', user.id),
    ])
    if (tombstoneResult.error || profileResult.error || entitlementResult.error) {
      return failure(res, 503, 'SERVICE_UNAVAILABLE', 'Report access could not be verified.')
    }
    if (tombstoneResult.data) return failure(res, 410, 'ACCOUNT_DELETED', 'This account is unavailable.')
    if (resolveServerEntitlement(profileResult.data, entitlementResult.data).plan !== 'pro') {
      return failure(res, 403, 'PRO_REQUIRED', 'SideFlip Pro is required for reports.')
    }

    const table = SUBJECT_TABLES[input.subjectType]
    const ownership = await client.from(table).select('id').eq('id', input.subjectId).eq('user_id', user.id).maybeSingle()
    if (ownership.error) return failure(res, 503, 'SERVICE_UNAVAILABLE', 'Report data is temporarily unavailable.')
    if (!ownership.data) return failure(res, 404, 'SUBJECT_NOT_FOUND', 'The requested item was not found.')

    const loaded = input.subjectType === 'project'
      ? await loadProjectReport(client, user.id, input)
      : await loadMyStuffReport(client, user.id, input)
    if (loaded.error) return failure(res, 503, 'SERVICE_UNAVAILABLE', 'Report data is temporarily unavailable.')

    if (input.includePhotos || input.includeDocuments) {
      const kinds = [input.includePhotos ? 'photo' : null, input.includeDocuments ? 'document' : null].filter(Boolean)
      let mediaRows
      try {
        mediaRows = await privateMediaAdapter.listPrivateMedia({
          userId: user.id, subjectType: input.subjectType, subjectId: input.subjectId, kinds, limit: MAX_MEDIA_COUNT,
        })
      } catch {
        return failure(res, 503, 'SERVICE_UNAVAILABLE', 'Private media is temporarily unavailable.')
      }
      const media = sanitizeMedia(mediaRows, kinds)
      loaded.report.media = {
        ...(input.includePhotos ? { photos: media.filter(entry => entry.kind === 'photo').map(({ kind, ...mediaFields }) => mediaFields) } : {}),
        ...(input.includeDocuments ? { documents: media.filter(entry => entry.kind === 'document').map(({ kind, ...mediaFields }) => mediaFields) } : {}),
      }
    }

    const response = {
      schemaVersion: 1,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      disclaimer: input.disclaimer,
      report: loaded.report,
    }
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_RESPONSE_BYTES) {
      return failure(res, 500, 'RESPONSE_TOO_LARGE', 'The report contains too much data to render safely.')
    }
      return json(res, 200, response)
    } catch {
      return failure(res, 503, 'SERVICE_UNAVAILABLE', 'Report data is temporarily unavailable.')
    }
  }
}

export default createReportDataHandler()
