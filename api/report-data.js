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
const MAX_REVISION_LINE_ITEMS = 50
const MAX_MONEY = 1_000_000_000_000

// PRIVATE_MEDIA_ADAPTER_CONTRACT:
// listPrivateMedia({ userId, subjectType, subjectId, kinds, limit }) returns only
// authorized, short-lived render objects: { kind, label, url, expiresAt }.
// The adapter must resolve private storage server-side. It must never return raw
// object keys, bucket names, storage paths, permanent/public URLs, or documents
// that have not been independently authorized for this owner and subject.
const NO_PRIVATE_MEDIA = null

function defaultUserClientFactory(token) {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

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

function cleanBoolean(value) {
  return typeof value === 'boolean' ? value : undefined
}

function cleanHttpsUrl(value) {
  const cleaned = cleanText(value, 2_048)
  if (!cleaned) return undefined
  try {
    const url = new URL(cleaned)
    return url.protocol === 'https:' ? url.toString() : undefined
  } catch { return undefined }
}

function maskIdentifier(value) {
  const cleaned = cleanText(value, 100)
  return cleaned && cleaned.length >= 4 ? `••••${cleaned.slice(-4)}` : undefined
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
    ['vin', maskIdentifier(legacy?.vin)],
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
    ['currentCycles', cleanNumber(row?.current_cycles)],
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

function legacyServiceHistory(rows, includeCosts) {
  return (Array.isArray(rows) ? rows : []).slice(0, MAX_HISTORY_COUNT).map(row => assignDefined({ source: { version: 1 } }, [
    ['name', cleanText(row?.name, 300)],
    ['completedAt', cleanDate(row?.completed_at)],
    ['mileage', cleanNumber(row?.mileage)],
    ['hours', cleanNumber(row?.hours)],
    ...(includeCosts ? [['cost', cleanNumber(row?.cost, MAX_MONEY)]] : []),
    ['notes', cleanText(row?.notes, MAX_HISTORY_NOTES_LENGTH)],
  ]))
}

function dueState(row) {
  if (!row) return undefined
  const status = ['needs_usage_update', 'overdue', 'due_now', 'due_soon', 'upcoming'].includes(row.due_status)
    ? row.due_status : undefined
  return assignDefined({}, [
    ['nextDueAt', cleanDate(row.next_due_at)],
    ['nextDueMileage', cleanNumber(row.next_due_mileage)],
    ['nextDueHours', cleanNumber(row.next_due_hours)],
    ['nextDueCycles', cleanNumber(row.next_due_cycles)],
    ['status', status],
  ])
}

function maintenanceDefinitions(rows, dueRows) {
  const dueByDefinition = new Map((Array.isArray(dueRows) ? dueRows : []).map(row => [row?.definition_id, row]))
  return (Array.isArray(rows) ? rows : []).slice(0, MAX_SCHEDULE_COUNT).map(row => {
    const source = assignDefined({}, [
      ['provenanceType', cleanText(row?.provenance_type, 40)],
      ['sourceClass', cleanText(row?.source_class, 50)],
      ['citationUrl', cleanHttpsUrl(row?.citation_url)],
      ['citationTitle', cleanText(row?.citation_title, 500)],
      ['citationPage', cleanText(row?.citation_page, 100)],
      ['citationSection', cleanText(row?.citation_section, 500)],
      ['citationAccessedOn', cleanDate(row?.citation_accessed_on)],
      ['uncertain', cleanBoolean(row?.uncertain)],
      ['uncertaintyReason', cleanText(row?.uncertainty_reason, 2_000)],
    ])
    return assignDefined({ source }, [
      ['name', cleanText(row?.name, 200)],
      ['description', cleanText(row?.description, 4_000)],
      ['serviceCategory', cleanText(row?.service_category, 80)],
      ['serviceAction', cleanText(row?.service_action, 40)],
      ['dueSemantics', cleanText(row?.due_semantics, 40)],
      ['activeProfile', cleanText(row?.active_profile, 40)],
      ['cadenceAnchor', cleanText(row?.cadence_anchor, 40)],
      ['normalIntervalMiles', cleanNumber(row?.normal_interval_miles)],
      ['normalIntervalHours', cleanNumber(row?.normal_interval_hours)],
      ['normalIntervalCycles', cleanNumber(row?.normal_interval_cycles)],
      ['normalCalendarMonths', cleanNumber(row?.normal_calendar_months, 1_200)],
      ['severeIntervalMiles', cleanNumber(row?.severe_interval_miles)],
      ['severeIntervalHours', cleanNumber(row?.severe_interval_hours)],
      ['severeIntervalCycles', cleanNumber(row?.severe_interval_cycles)],
      ['severeCalendarMonths', cleanNumber(row?.severe_calendar_months, 1_200)],
      ['firstIntervalMiles', cleanNumber(row?.first_interval_miles)],
      ['firstIntervalHours', cleanNumber(row?.first_interval_hours)],
      ['firstIntervalCycles', cleanNumber(row?.first_interval_cycles)],
      ['firstCalendarMonths', cleanNumber(row?.first_calendar_months, 1_200)],
      ['dueSoonMiles', cleanNumber(row?.due_soon_miles)],
      ['dueSoonHours', cleanNumber(row?.due_soon_hours)],
      ['dueSoonCycles', cleanNumber(row?.due_soon_cycles)],
      ['dueSoonDays', cleanNumber(row?.due_soon_days, 36_500)],
      ['enabled', cleanBoolean(row?.enabled)],
      ['dueState', dueState(dueByDefinition.get(row?.id))],
    ])
  })
}

function usageReadings(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, MAX_HISTORY_COUNT).map(row => assignDefined({}, [
    ['type', ['mileage', 'hours', 'cycles'].includes(row?.reading_type) ? row.reading_type : undefined],
    ['value', cleanNumber(row?.reading_value)],
    ['recordedAt', cleanDate(row?.recorded_at)],
    ['source', cleanText(row?.source, 40)],
    ['correctionReason', cleanText(row?.correction_reason, 1_000)],
    ['createdAt', cleanDate(row?.created_at)],
  ]))
}

function revisionLineItems(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, MAX_REVISION_LINE_ITEMS).map(row => assignDefined({}, [
    ['name', cleanText(row?.name, 300)],
    ['description', cleanText(row?.description, 500)],
    ['quantity', cleanNumber(row?.quantity, 1_000_000)],
    ['cost', cleanNumber(row?.cost, MAX_MONEY)],
    ['amount', cleanNumber(row?.amount, MAX_MONEY)],
    ['hours', cleanNumber(row?.hours, 1_000_000)],
    ['rate', cleanNumber(row?.rate, MAX_MONEY)],
  ]))
}

function latestRevision(rows, includeCosts) {
  const candidates = Array.isArray(rows) ? rows : []
  const row = candidates.reduce((latest, candidate) => (cleanNumber(candidate?.revision_number, 1_000_000) ?? -1) > (cleanNumber(latest?.revision_number, 1_000_000) ?? -1) ? candidate : latest, null)
  if (!row) return undefined
  const revision = assignDefined({}, [
    ['revisionNumber', cleanNumber(row.revision_number, 1_000_000)],
    ['notes', cleanText(row.notes, MAX_HISTORY_NOTES_LENGTH)],
    ['revisionReason', cleanText(row.revision_reason, 1_000)],
    ['createdAt', cleanDate(row.created_at)],
  ])
  if (includeCosts) {
    revision.parts = revisionLineItems(row.parts)
    revision.labor = revisionLineItems(row.labor)
    revision.vendor = assignDefined({}, [['name', cleanText(row.vendor?.name, 300)]])
    revision.warranty = assignDefined({}, [
      ['description', cleanText(row.warranty?.description, 500)],
      ['months', cleanNumber(row.warranty?.months, 1_200)],
      ['expiresAt', cleanDate(row.warranty?.expires_at)],
    ])
  }
  return revision
}

function occurrenceProvenance(value, includeCosts) {
  const result = assignDefined({}, [
    ['description', cleanText(value?.description, 500)],
    ['category', cleanText(value?.category, 100)],
    ['createdAt', cleanDate(value?.created_at)],
  ])
  if (includeCosts) assignDefined(result, [['amount', cleanNumber(value?.amount, MAX_MONEY)]])
  return result
}

function v2ServiceHistory(rows, includeCosts) {
  return (Array.isArray(rows) ? rows : []).slice(0, MAX_HISTORY_COUNT).map(row => {
    const source = assignDefined({ version: 2, provenance: occurrenceProvenance(row?.provenance, includeCosts) }, [
      ['provenanceType', cleanText(row?.provenance_type, 50)],
    ])
    return assignDefined({ source }, [
      ['name', cleanText(row?.service_name, 300)],
      ['category', cleanText(row?.service_category, 80)],
      ['action', cleanText(row?.service_action, 40)],
      ['scheduled', cleanBoolean(row?.scheduled)],
      ['completedAt', cleanDate(row?.completed_at)],
      ['mileage', cleanNumber(row?.mileage)],
      ['hours', cleanNumber(row?.hours)],
      ['cycles', cleanNumber(row?.cycles)],
      ['latestRevision', latestRevision(row?.my_stuff_service_occurrence_revisions, includeCosts)],
    ])
  })
}

function historyTime(row) {
  const value = Date.parse(row?.completedAt || '')
  return Number.isFinite(value) ? value : 0
}

async function loadMyStuffReport(client, userClient, userId, input) {
  const baseResult = await client.from('my_stuff_items')
    .select('id,name,category,acquired_on,notes,current_mileage,current_hours,current_cycles,created_at,updated_at')
    .eq('id', input.subjectId).eq('user_id', userId).maybeSingle()
  if (baseResult.error || !baseResult.data) return { error: true }
  const logColumns = input.includeDetailedCosts
    ? 'name,completed_at,mileage,hours,cost,notes'
    : 'name,completed_at,mileage,hours,notes'
  const definitionColumns = 'id,name,description,service_category,service_action,due_semantics,active_profile,cadence_anchor,normal_interval_miles,normal_interval_hours,normal_interval_cycles,normal_calendar_months,severe_interval_miles,severe_interval_hours,severe_interval_cycles,severe_calendar_months,first_interval_miles,first_interval_hours,first_interval_cycles,first_calendar_months,due_soon_miles,due_soon_hours,due_soon_cycles,due_soon_days,provenance_type,source_class,citation_url,citation_title,citation_page,citation_section,citation_accessed_on,uncertain,uncertainty_reason,enabled'
  const occurrenceColumns = 'id,definition_id,service_name,service_category,service_action,scheduled,completed_at,mileage,hours,cycles,provenance_type,provenance,my_stuff_service_occurrence_revisions(revision_number,parts,labor,vendor,warranty,notes,revision_reason,created_at)'
  const occurrenceQuery = userClient.from('my_stuff_service_occurrences').select(occurrenceColumns)
    .eq('item_id', input.subjectId).eq('user_id', userId)
    .order('revision_number', { ascending: false, referencedTable: 'my_stuff_service_occurrence_revisions' })
    .limit(1, { referencedTable: 'my_stuff_service_occurrence_revisions' })
    .order('completed_at', { ascending: false }).limit(MAX_HISTORY_COUNT)
  const [scheduleResult, logResult, definitionResult, dueResult, readingResult, occurrenceResult] = await Promise.all([
    client.from('my_stuff_schedules')
      .select('name,tracking_type,interval_value,last_completed_at,last_completed_value,next_due_at,next_due_value')
      .eq('item_id', input.subjectId).eq('user_id', userId).order('created_at', { ascending: true }).limit(MAX_SCHEDULE_COUNT),
    client.from('my_stuff_service_logs').select(logColumns)
      .eq('item_id', input.subjectId).eq('user_id', userId).order('completed_at', { ascending: false }).limit(MAX_HISTORY_COUNT),
    userClient.from('my_stuff_maintenance_definitions').select(definitionColumns)
      .eq('item_id', input.subjectId).eq('user_id', userId).order('created_at', { ascending: true }).limit(MAX_SCHEDULE_COUNT),
    userClient.rpc('get_my_stuff_due_state_v2', { p_item_id: input.subjectId, p_as_of: new Date().toISOString() })
      .limit(MAX_SCHEDULE_COUNT),
    userClient.from('my_stuff_readings').select('reading_type,reading_value,recorded_at,source,correction_reason,created_at')
      .eq('item_id', input.subjectId).eq('user_id', userId).order('recorded_at', { ascending: false }).limit(MAX_HISTORY_COUNT),
    occurrenceQuery,
  ])
  if ([scheduleResult, logResult, definitionResult, dueResult, readingResult, occurrenceResult].some(result => result.error)) return { error: true }
  const report = itemSummary(baseResult.data)
  report.schedules = schedules(scheduleResult.data)
  report.maintenanceDefinitions = maintenanceDefinitions(definitionResult.data, dueResult.data)
  report.usageReadings = usageReadings(readingResult.data)
  report.serviceHistory = [
    ...v2ServiceHistory(occurrenceResult.data, input.includeDetailedCosts),
    ...legacyServiceHistory(logResult.data, input.includeDetailedCosts),
  ].sort((left, right) => historyTime(right) - historyTime(left)).slice(0, MAX_HISTORY_COUNT)

  if (input.includeIdentifiers) {
    const optional = await optionalSingle(client.from('my_stuff_items')
      .select('manufacturer,make,model,trim,model_year,model_number,engine_model,serial_number,engine_serial,vin,hull_number,registration_number')
      .eq('id', input.subjectId).eq('user_id', userId))
    if (optional.error) return { error: true }
    report.identifiers = assignDefined({}, [
      ['manufacturer', cleanText(optional.data?.manufacturer, 100)],
      ['make', cleanText(optional.data?.make, 100)],
      ['model', cleanText(optional.data?.model, 200)],
      ['trim', cleanText(optional.data?.trim, 100)],
      ['year', cleanNumber(optional.data?.model_year, 3000)],
      ['modelNumber', cleanText(optional.data?.model_number, 200)],
      ['engineModel', cleanText(optional.data?.engine_model, 200)],
      ['serialNumber', cleanText(optional.data?.serial_number, 200)],
      ['engineSerial', cleanText(optional.data?.engine_serial, 200)],
      ['vin', maskIdentifier(optional.data?.vin)],
      ['hullNumber', cleanText(optional.data?.hull_number, 100)],
      ['registrationNumber', cleanText(optional.data?.registration_number, 100)],
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

export function createReportDataHandler({ client = supabase, userClientFactory = defaultUserClientFactory, privateMediaAdapter = NO_PRIVATE_MEDIA } = {}) {
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

    const tombstoneResult = await client.from('account_deletion_tombstones').select('status').eq('user_id', user.id).maybeSingle()
    if (tombstoneResult.error) return failure(res, 503, 'SERVICE_UNAVAILABLE', 'Report access could not be verified.')
    if (tombstoneResult.data) return failure(res, 410, 'ACCOUNT_DELETED', 'This account is unavailable.')

    const [modeResult, profileResult, entitlementResult] = await Promise.all([
      client.rpc('stripe_entitlement_read_mode'),
      client.from('profiles').select('subscription_id,subscription_status').eq('id', user.id).maybeSingle(),
      client.from('user_entitlements').select('source,status,expires_at,last_verified_at').eq('user_id', user.id),
    ])
    if (modeResult.error || !['compatibility', 'canonical'].includes(modeResult.data) || profileResult.error || entitlementResult.error) {
      return failure(res, 503, 'SERVICE_UNAVAILABLE', 'Report access could not be verified.')
    }
    if (resolveServerEntitlement(profileResult.data, entitlementResult.data, Date.now(), {
      stripeCanonicalCutoverComplete: modeResult.data === 'canonical',
    }).plan !== 'pro') {
      return failure(res, 403, 'PRO_REQUIRED', 'SideFlip Pro is required for reports.')
    }

    const table = SUBJECT_TABLES[input.subjectType]
    const ownership = await client.from(table).select('id').eq('id', input.subjectId).eq('user_id', user.id).maybeSingle()
    if (ownership.error) return failure(res, 503, 'SERVICE_UNAVAILABLE', 'Report data is temporarily unavailable.')
    if (!ownership.data) return failure(res, 404, 'SUBJECT_NOT_FOUND', 'The requested item was not found.')

    const loaded = input.subjectType === 'project'
      ? await loadProjectReport(client, user.id, input)
      : await loadMyStuffReport(client, userClientFactory(token), user.id, input)
    if (loaded.error) return failure(res, 503, 'SERVICE_UNAVAILABLE', 'Report data is temporarily unavailable.')

    if (input.includePhotos || input.includeDocuments) {
      if (!privateMediaAdapter || typeof privateMediaAdapter.listPrivateMedia !== 'function') {
        return failure(res, 503, 'PRIVATE_MEDIA_UNAVAILABLE', 'Private media is not available for reports.')
      }
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
