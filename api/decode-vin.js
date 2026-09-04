import { createHmac, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { loadServerEntitlementState } from './_lib/entitlements.js'

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const STANDARD_VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/
const SUBJECT_TABLES = Object.freeze({ project: 'projects', my_stuff_item: 'my_stuff_items' })
const VIN_WEIGHTS = Object.freeze([8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2])
const VIN_VALUES = Object.freeze({
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
})
// Source: vPIC Vehicle Variable 143 (Error Code). Codes 1-4 are corrections
// or check-digit notices; 7-14 are limited-data/product warnings. Only 5, 6,
// and 400 make the submitted VIN unusable.
const NHTSA_CODES = Object.freeze({
  '1': { severity: 'warning', message: 'The VIN check digit does not calculate properly.' },
  '2': { severity: 'warning', message: 'VIN corrected: one position contained an error.' },
  '3': { severity: 'warning', message: 'VIN corrected: one position contained an error, assuming the check digit is correct.' },
  '4': { severity: 'warning', message: 'VIN corrected in one position, but multiple matches were found.' },
  '5': { severity: 'fatal', message: 'The VIN has errors in several positions.' },
  '6': { severity: 'fatal', message: 'The VIN is incomplete.' },
  '7': { severity: 'warning', message: 'Manufacturer is not registered with NHTSA for sale or importation in the U.S. for use on U.S. roads.' },
  '8': { severity: 'warning', message: 'No detailed data is currently available.' },
  '9': { severity: 'warning', message: 'Glider warning: this is not a motor vehicle and cannot be assigned a VIN meeting 49 CFR Part 565.' },
  '10': { severity: 'warning', message: 'Off-road vehicle warning: the manufacturer did not certify this product as a motor vehicle complying with applicable Federal Motor Vehicle Safety Standards.' },
  '11': { severity: 'warning', message: 'Incorrect model year: position 10 does not match a valid model year code. Decoded data may not be accurate.' },
  '12': { severity: 'warning', message: 'Model year warning: the model year submitted for decoding does not match the VIN model year.' },
  '14': { severity: 'warning', message: 'Unable to provide information for some VIN characters based on the manufacturer submission.' },
  '400': { severity: 'fatal', message: 'Invalid characters are present.' },
})
const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024
const RATE_LIMIT = 20
const RATE_WINDOW_SECONDS = 60 * 60
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_RAW_VIN_BYTES = 256
const CACHE_CLEANUP_BATCH = 100
const VEHICLE_NUMBER_RULES = Object.freeze({
  modelYear: Object.freeze({ integer: true, min: 1881, max: 2200 }),
  engineCylinders: Object.freeze({ integer: true, min: 1, max: 32 }),
  displacementLiters: Object.freeze({ min: 0.1, max: 30 }),
})

export function normalizeVin(value) {
  return typeof value === 'string' ? value.toUpperCase().replace(/[\s-]+/g, '') : ''
}

export function isValidVinCheckDigit(vin) {
  if (!STANDARD_VIN_PATTERN.test(vin)) return false
  const sum = [...vin].reduce((total, character, index) => {
    const value = /\d/.test(character) ? Number(character) : VIN_VALUES[character]
    return total + value * VIN_WEIGHTS[index]
  }, 0)
  const remainder = sum % 11
  return vin[8] === (remainder === 10 ? 'X' : String(remainder))
}

export function maskVin(vin) {
  const normalized = normalizeVin(vin)
  if (normalized.length < 8) return '***'
  return `${normalized.slice(0, 3)}${'*'.repeat(Math.max(1, normalized.length - 7))}${normalized.slice(-4)}`
}

function json(res, status, body) {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, max-age=0, must-revalidate')
  res.setHeader('CDN-Cache-Control', 'no-store')
  res.setHeader('Vary', 'Authorization')
  return res.status(status).json(body)
}

function fallback(error, code, retryable = false) {
  return { error, code, retryable, manualEntry: true }
}

function validateRequest(body) {
  if (!Object.hasOwn(SUBJECT_TABLES, body?.subjectType)) {
    return { error: fallback('Choose whether this VIN belongs to a Project or My Stuff item.', 'SUBJECT_TYPE_INVALID') }
  }
  if (body?.subjectId != null && !UUID_PATTERN.test(body.subjectId)) {
    return { error: fallback('The selected item is invalid.', 'SUBJECT_ID_INVALID') }
  }

  if (typeof body?.vin !== 'string') {
    return { error: fallback('Enter a VIN or use manual entry.', 'VIN_REQUIRED') }
  }
  if (Buffer.byteLength(body.vin, 'utf8') > MAX_RAW_VIN_BYTES) {
    return { status: 413, error: fallback('The VIN input is too large. Enter it manually or use manual entry.', 'VIN_INPUT_TOO_LARGE') }
  }

  const vin = normalizeVin(body.vin)
  if (!vin) return { error: fallback('Enter a VIN or use manual entry.', 'VIN_REQUIRED') }
  if (vin.length !== 17) {
    return { status: 422, error: fallback('Older or nonstandard VINs are not supported. Please use manual entry.', 'VIN_NONSTANDARD') }
  }
  if (/[IOQ]/.test(vin) || !/^[A-Z0-9]+$/.test(vin)) {
    return { status: 422, error: fallback('VINs cannot contain I, O, Q, or other invalid characters. Please use manual entry.', 'VIN_INVALID_CHARACTERS') }
  }
  // 49 CFR Part 565 requires the check digit for North American WMIs. It is
  // not universal for foreign-market VINs, so vPIC must assess those.
  if (/^[1-5]/.test(vin) && !isValidVinCheckDigit(vin)) {
    return { status: 422, error: fallback('The VIN check digit is invalid. Check the VIN or use manual entry.', 'VIN_INVALID_CHECK_DIGIT') }
  }
  return { vin, subjectType: body.subjectType, subjectId: body.subjectId ?? null }
}

function safeText(value, maxLength = 160) {
  if (typeof value !== 'string') return null
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return sanitized ? sanitized.slice(0, maxLength) : null
}

function safeNumber(value, { integer = false, min = 0, max = 100_000 } = {}) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const stringValue = String(value).trim()
  if (!/^(?:\d+|\d+\.\d+)$/.test(stringValue)) return null
  const number = Number(stringValue)
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) return null
  return number
}

function mapNhtsaCodes(errorCode) {
  if (typeof errorCode !== 'string' || !/^\d+(?:\s*,\s*\d+)*$/.test(errorCode.trim())) return null
  const codes = [...new Set(errorCode.split(',').map(code => String(Number(code.trim()))))]
  if (codes.includes('0') && codes.length > 1) return null
  return codes.filter(code => code !== '0').map(code => ({
    code,
    severity: NHTSA_CODES[code]?.severity || 'fatal',
    message: NHTSA_CODES[code]?.message || 'NHTSA could not decode this VIN.',
  }))
}

function mapVehicle(result) {
  const mapped = {
    modelYear: safeNumber(result.ModelYear, VEHICLE_NUMBER_RULES.modelYear),
    make: safeText(result.Make),
    model: safeText(result.Model),
    trim: safeText(result.Trim),
    bodyClass: safeText(result.BodyClass),
    vehicleType: safeText(result.VehicleType),
    manufacturer: safeText(result.Manufacturer),
    plantCountry: safeText(result.PlantCountry),
    fuelTypePrimary: safeText(result.FuelTypePrimary),
    engineCylinders: safeNumber(result.EngineCylinders, VEHICLE_NUMBER_RULES.engineCylinders),
    displacementLiters: safeNumber(result.DisplacementL, VEHICLE_NUMBER_RULES.displacementLiters),
    driveType: safeText(result.DriveType),
    transmissionStyle: safeText(result.TransmissionStyle),
  }
  return Object.fromEntries(Object.entries(mapped).filter(([, value]) => value != null))
}

function parseNhtsaPayload(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.Results) || payload.Results.length !== 1) {
    throw new Error('schema')
  }
  const result = payload.Results[0]
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('schema')
  const notices = mapNhtsaCodes(result.ErrorCode)
  if (!notices) throw new Error('schema')
  const errors = notices.filter(({ severity }) => severity === 'fatal').map(({ code, message }) => ({ code, message }))
  if (errors.length) return { errors }
  const vehicle = mapVehicle(result)
  if (!vehicle.modelYear && !vehicle.make && !vehicle.model) return { errors: notices.map(({ code, message }) => ({ code, message })) }
  const warnings = notices.map(({ code, message }) => ({ code, message }))
  return { vehicle, warnings, warningCodes: warnings.map(({ code }) => code) }
}

function mapCachedWarnings(codes) {
  if (!Array.isArray(codes) || codes.some(code => typeof code !== 'string' || NHTSA_CODES[code]?.severity !== 'warning')) return null
  return [...new Set(codes)].map(code => ({ code, message: NHTSA_CODES[code].message }))
}

function validCachedVehicle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = new Set(['modelYear', 'make', 'model', 'trim', 'bodyClass', 'vehicleType', 'manufacturer', 'plantCountry', 'fuelTypePrimary', 'engineCylinders', 'displacementLiters', 'driveType', 'transmissionStyle'])
  if (Object.keys(value).some(key => !keys.has(key))) return null
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (Object.hasOwn(VEHICLE_NUMBER_RULES, key)) {
      const validated = typeof entry === 'number' ? safeNumber(entry, VEHICLE_NUMBER_RULES[key]) : null
      if (validated == null || validated !== entry) return null
      result[key] = validated
    } else {
      const text = safeText(entry)
      if (!text || text !== entry) return null
      result[key] = text
    }
  }
  return result.modelYear || result.make || result.model ? result : null
}

async function readResponseText(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('oversize')

  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('oversize')
      }
      chunks.push(value)
    }
    const combined = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      combined.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(combined)
  }

  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('oversize')
  return text
}

async function loadEntitlementState(client, userId) {
  const tombstoneResult = await client.from('account_deletion_tombstones').select('status').eq('user_id', userId).maybeSingle()
  if (tombstoneResult.error) return { error: true }
  if (tombstoneResult.data) return { deleted: true }

  const entitlementState = await loadServerEntitlementState(client, userId)
  if (entitlementState.error) return { error: true }
  return entitlementState
}

async function verifyOwnership(client, userId, subjectType, subjectId) {
  if (!subjectId) return { owned: true }
  const { data, error } = await client.from(SUBJECT_TABLES[subjectType])
    .select('id').eq('id', subjectId).eq('user_id', userId).maybeSingle()
  if (error) return { error: true }
  return { owned: Boolean(data) }
}

function configuredHmacKeys(explicitKeys, activeVersion, currentSecret) {
  let keys = explicitKeys
  if (keys == null) {
    keys = { [activeVersion]: currentSecret }
    if (process.env.VIN_CACHE_HMAC_PREVIOUS_KEYS) {
      try {
        keys = { ...JSON.parse(process.env.VIN_CACHE_HMAC_PREVIOUS_KEYS), ...keys }
      } catch {
        return null
      }
    }
  }
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return null
  const entries = Object.entries(keys).map(([version, secret]) => [Number(version), secret])
  if (!Number.isInteger(activeVersion) || activeVersion < 1 || activeVersion > 2_147_483_647) return null
  if (!entries.length || entries.some(([version, secret]) => (
    !Number.isInteger(version) || version < 1 || version > 2_147_483_647 ||
    typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32
  ))) return null
  const unique = new Map(entries)
  if (!unique.has(activeVersion) || unique.size !== entries.length) return null
  return [
    [activeVersion, unique.get(activeVersion)],
    ...[...unique.entries()].filter(([version]) => version !== activeVersion).sort(([a], [b]) => b - a),
  ]
}

function assertNhtsaResponseUrl(response) {
  if (typeof response?.url !== 'string' || response.url.length === 0) throw new Error('schema')
  let finalUrl
  try {
    finalUrl = new URL(response.url)
  } catch {
    throw new Error('schema')
  }
  if (finalUrl.origin !== 'https://vpic.nhtsa.dot.gov') throw new Error('schema')
}

function successBody(input, requestId, vehicle, warnings, cached) {
  return {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    requestId,
    vehicle,
    nhtsaWarnings: warnings,
    nhtsaErrors: [],
    cached,
  }
}

export function createDecodeVinHandler({
  client = supabase,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  logger = console,
  hmacSecret = process.env.VIN_CACHE_HMAC_SECRET,
  hmacKeys,
  activeHmacKeyVersion = Number(process.env.VIN_CACHE_HMAC_KEY_VERSION || 1),
  requestIdFactory = randomUUID,
} = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' })

    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) return json(res, 401, { error: 'Sign in to decode a VIN.' })
    const { data: authData, error: authError } = await client.auth.getUser(token)
    const user = authData?.user
    if (authError || !user) return json(res, 401, { error: 'Please sign in again.' })

    const state = await loadEntitlementState(client, user.id)
    if (state.error) return json(res, 503, fallback('Could not verify SideFlip Pro access. Try again or use manual entry.', 'ENTITLEMENT_UNAVAILABLE', true))
    if (state.deleted) return json(res, 410, fallback('This account is being deleted and cannot decode VINs.', 'ACCOUNT_DELETED'))
    if (state.entitlement.plan !== 'pro') {
      return json(res, 403, fallback('SideFlip Pro is required for VIN decoding. Manual entry is still available.', 'PRO_REQUIRED'))
    }

    const input = validateRequest(req.body)
    if (input.error) return json(res, input.status || 400, input.error)

    const ownership = await verifyOwnership(client, user.id, input.subjectType, input.subjectId)
    if (ownership.error) return json(res, 503, fallback('Could not verify the selected item. Try again or use manual entry.', 'OWNERSHIP_UNAVAILABLE', true))
    if (!ownership.owned) return json(res, 404, fallback('The selected item was not found.', 'SUBJECT_NOT_FOUND'))

    const configuredKeys = configuredHmacKeys(hmacKeys, activeHmacKeyVersion, hmacSecret)
    if (!configuredKeys) {
      logger.error('VIN decode configuration unavailable')
      return json(res, 503, fallback('VIN decoding is temporarily unavailable. Try again or use manual entry.', 'SERVICE_UNAVAILABLE', true))
    }
    const requestId = requestIdFactory()
    res.setHeader('X-Request-ID', requestId)

    const { data: rate, error: rateError } = await client.rpc('claim_vin_decode_request', {
      p_user_id: user.id,
      p_limit: RATE_LIMIT,
      p_window_seconds: RATE_WINDOW_SECONDS,
    })
    if (rateError || !rate || !['allowed', 'rate_limited'].includes(rate.decision)) {
      return json(res, 503, fallback('VIN decoding is temporarily unavailable. Try again or use manual entry.', 'RATE_LIMIT_UNAVAILABLE', true))
    }
    if (rate.decision === 'rate_limited') {
      const retryAfter = Number.isInteger(rate.retry_after_seconds) ? Math.min(86_400, Math.max(1, rate.retry_after_seconds)) : RATE_WINDOW_SECONDS
      res.setHeader('Retry-After', String(retryAfter))
      return json(res, 429, fallback('Too many VIN decode requests. Try again later or use manual entry.', 'RATE_LIMITED', true))
    }

    const hashes = configuredKeys.map(([version, secret]) => ({
      version,
      vinHmac: createHmac('sha256', secret).update(input.vin, 'utf8').digest('hex'),
    }))
    const activeHash = hashes[0]
    for (const { version, vinHmac } of hashes) {
      const { data: cached, error: cacheError } = await client.from('vin_decode_cache')
        .select('decoded_fields,nhtsa_error_codes')
        .eq('hmac_key_version', version)
        .eq('vin_hmac', vinHmac)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle()
      if (cacheError) return json(res, 503, fallback('VIN decoding is temporarily unavailable. Try again or use manual entry.', 'CACHE_UNAVAILABLE', true))
      if (!cached) continue

      const vehicle = validCachedVehicle(cached.decoded_fields)
      const warnings = mapCachedWarnings(cached.nhtsa_error_codes)
      if (vehicle && warnings) {
        if (version !== activeHash.version) {
          const { error: rotationError } = await client.rpc('store_vin_decode_cache', {
            p_hmac_key_version: activeHash.version,
            p_vin_hmac: activeHash.vinHmac,
            p_decoded_fields: vehicle,
            p_nhtsa_error_codes: warnings.map(({ code }) => code),
            p_expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
          })
          if (rotationError) logger.error('VIN decode cache rotation write failed')
        }
        return json(res, 200, successBody(input, requestId, vehicle, warnings, true))
      }

      logger.error('VIN decode cache entry invalid')
      const { error: cleanupError } = await client.rpc('cleanup_vin_decode_state', {
        p_batch_limit: CACHE_CLEANUP_BATCH,
        p_invalid_hmac_key_version: version,
        p_invalid_vin_hmac: vinHmac,
      })
      if (cleanupError) logger.error('VIN decode cache quarantine failed')
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(input.vin)}?format=json`, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })
      assertNhtsaResponseUrl(response)
      if (!response?.ok) throw new Error('upstream_status')
      let payload
      try {
        payload = JSON.parse(await readResponseText(response, maxResponseBytes))
      } catch (error) {
        if (error?.message === 'oversize') throw error
        throw new Error('schema')
      }
      const decoded = parseNhtsaPayload(payload)
      if (decoded.errors) {
        return json(res, 422, {
          ...fallback('NHTSA could not verify this VIN. Check it or use manual entry.', 'VIN_NOT_DECODED'),
          nhtsaErrors: decoded.errors,
        })
      }

      const { error: storeError } = await client.rpc('store_vin_decode_cache', {
        p_hmac_key_version: activeHash.version,
        p_vin_hmac: activeHash.vinHmac,
        p_decoded_fields: decoded.vehicle,
        p_nhtsa_error_codes: decoded.warningCodes,
        p_expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
      })
      if (storeError) logger.error('VIN decode cache write failed')
      return json(res, 200, successBody(input, requestId, decoded.vehicle, decoded.warnings, false))
    } catch (error) {
      const timeoutFailure = error?.name === 'AbortError'
      const malformed = ['schema', 'oversize'].includes(error?.message)
      logger.error('VIN decode failed:', timeoutFailure ? 'timeout' : malformed ? 'invalid_upstream_response' : 'upstream_unavailable')
      if (timeoutFailure) return json(res, 504, fallback('VIN decoding timed out. Try again or use manual entry.', 'NHTSA_TIMEOUT', true))
      if (malformed) return json(res, 502, fallback('VIN decoding returned an invalid response. Try again or use manual entry.', 'NHTSA_INVALID_RESPONSE', true))
      return json(res, 503, fallback('NHTSA is unavailable. Try again later or use manual entry.', 'NHTSA_UNAVAILABLE', true))
    } finally {
      clearTimeout(timeout)
    }
  }
}

export default createDecodeVinHandler()
