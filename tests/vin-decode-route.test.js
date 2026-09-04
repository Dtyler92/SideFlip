import test from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL ||= 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= ['synthetic', 'service', 'key'].join('-')
process.env.VIN_CACHE_HMAC_SECRET ||= 'synthetic-test-secret-at-least-thirty-two-bytes'
process.env.VIN_CACHE_HMAC_KEY_VERSION ||= '2'

const {
  createDecodeVinHandler,
  isValidVinCheckDigit,
  maskVin,
  normalizeVin,
} = await import('../api/decode-vin.js')

const VALID_VIN = '1HGCM82633A004352'
const OTHER_VALID_VIN = '1M8GDM9AXKP042788'
const FOREIGN_VALID_VIN = 'WVWZZZ1JZXW000001'
const SUBJECT_ID = '11111111-1111-4111-8111-111111111111'
const REQUEST_ID = '22222222-2222-4222-8222-222222222222'

function query(result, onEq = () => {}) {
  const filters = {}
  const chain = {
    select() { return chain },
    eq(column, value) { filters[column] = value; onEq(column, value); return chain },
    gt(column, value) { onEq(column, value); return chain },
    limit() { return Promise.resolve(result) },
    maybeSingle() { return Promise.resolve(typeof result === 'function' ? result(filters) : result) },
    then(resolve, reject) { return Promise.resolve(typeof result === 'function' ? result(filters) : result).then(resolve, reject) },
  }
  return chain
}

function clientFor({
  userId = 'user-1',
  pro = true,
  stripeMode = 'compatibility',
  stripeModeError = null,
  entitlements = [],
  tombstone = null,
  tombstoneError = null,
  subject = { id: SUBJECT_ID },
  subjectError = null,
  cached = null,
  cacheByVersion = null,
  cacheError = null,
  rateDecision = 'allowed',
  rateError = null,
  onEq = () => {},
  onRpc = () => {},
} = {}) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
    async rpc(name, args) {
      onRpc(name, args)
      if (name === 'stripe_entitlement_read_mode') return { data: stripeMode, error: stripeModeError }
      if (name === 'claim_vin_decode_request') {
        return { data: { decision: rateDecision, retry_after_seconds: rateDecision === 'rate_limited' ? 42 : 0 }, error: rateError }
      }
      if (name === 'store_vin_decode_cache') return { data: true, error: null }
      if (name === 'cleanup_vin_decode_state') return { data: { invalid_cache_deleted: 1 }, error: null }
      throw new Error(`Unexpected RPC: ${name}`)
    },
    from(table) {
      if (table === 'account_deletion_tombstones') return query({ data: tombstone, error: tombstoneError }, (column, value) => onEq(table, column, value))
      if (table === 'profiles') return query({ data: pro ? { subscription_id: 'sub_synthetic', subscription_status: 'active' } : { subscription_id: null, subscription_status: 'inactive' }, error: null }, (column, value) => onEq(table, column, value))
      if (table === 'user_entitlements') return query({ data: entitlements, error: null }, (column, value) => onEq(table, column, value))
      if (table === 'projects' || table === 'my_stuff_items') return query({ data: subject, error: subjectError }, (column, value) => onEq(table, column, value))
      if (table === 'vin_decode_cache') return query(filters => ({
        data: cacheByVersion ? (cacheByVersion[filters.hmac_key_version] ?? null) : cached,
        error: cacheError,
      }), (column, value) => onEq(table, column, value))
      throw new Error(`Unexpected table: ${table}`)
    },
  }
}

function request(body, token = 'synthetic-token') {
  return { method: 'POST', headers: { authorization: `Bearer ${token}` }, body }
}

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

function nhtsaResponse(overrides = {}, responseUrl = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/test?format=json') {
  const result = {
    ErrorCode: '0',
    ErrorText: '0 - VIN decoded clean. Check Digit (9th position) is correct',
    ModelYear: '2003',
    Make: 'HONDA',
    Model: 'Accord',
    Trim: 'EX',
    BodyClass: 'Sedan/Saloon',
    VehicleType: 'PASSENGER CAR',
    Manufacturer: 'AMERICAN HONDA MOTOR CO., INC.',
    PlantCountry: 'UNITED STATES (USA)',
    FuelTypePrimary: 'Gasoline',
    EngineCylinders: '6',
    DisplacementL: '3',
    DriveType: '4x2',
    TransmissionStyle: 'Automatic',
    ...overrides,
  }
  const response = new Response(JSON.stringify({ Count: 1, Results: [result] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  if (responseUrl != null) Object.defineProperty(response, 'url', { value: responseUrl })
  return response
}

async function run(body, options = {}) {
  const res = responseRecorder()
  const handler = createDecodeVinHandler({
    client: clientFor(options.client),
    fetchImpl: options.fetchImpl || (async () => nhtsaResponse()),
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
    logger: options.logger,
    hmacKeys: options.hmacKeys,
    activeHmacKeyVersion: options.activeHmacKeyVersion,
    requestIdFactory: () => REQUEST_ID,
  })
  await handler(request(body), res)
  return res
}

test('normalizes VINs and validates both known-good check digits', () => {
  assert.equal(normalizeVin(' 1hg-cm826 33a004352 '), VALID_VIN)
  assert.equal(isValidVinCheckDigit(VALID_VIN), true)
  assert.equal(isValidVinCheckDigit(OTHER_VALID_VIN), true)
  assert.equal(isValidVinCheckDigit('1HGCM82643A004352'), false)
  assert.equal(maskVin(VALID_VIN), '1HG**********4352')
})

test('requires authentication and explicit supported subject domain', async () => {
  const handler = createDecodeVinHandler({ client: clientFor(), fetchImpl: async () => nhtsaResponse() })
  const unauthenticated = responseRecorder()
  await handler(request({ vin: VALID_VIN, subjectType: 'project' }, ''), unauthenticated)
  assert.equal(unauthenticated.statusCode, 401)

  for (const subjectType of [undefined, 'goal', 'myStuff']) {
    const res = await run({ vin: VALID_VIN, subjectType })
    assert.equal(res.statusCode, 400)
  }
})

test('denies Free users before ownership, rate-limit, cache, or NHTSA work', async () => {
  let fetchCalls = 0
  const rpcCalls = []
  const filters = []
  const res = await run({ vin: VALID_VIN, subjectType: 'project', subjectId: SUBJECT_ID }, {
    client: { pro: false, onRpc: name => rpcCalls.push(name), onEq: (...args) => filters.push(args) },
    fetchImpl: async () => { fetchCalls += 1; return nhtsaResponse() },
  })
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.manualEntry, true)
  assert.equal(fetchCalls, 0)
  assert.deepEqual(rpcCalls, ['stripe_entitlement_read_mode'])
  assert.equal(filters.some(([table]) => ['projects', 'my_stuff_items', 'vin_decode_cache'].includes(table)), false)
})

test('canonical Stripe cutover denies legacy profile-only Pro before private work', async () => {
  let fetchCalls = 0
  const calls = []
  const res = await run({ vin: VALID_VIN, subjectType: 'project', subjectId: SUBJECT_ID }, {
    client: { stripeMode: 'canonical', onRpc: name => calls.push(name) },
    fetchImpl: async () => { fetchCalls += 1; return nhtsaResponse() },
  })
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.code, 'PRO_REQUIRED')
  assert.deepEqual(calls, ['stripe_entitlement_read_mode'])
  assert.equal(fetchCalls, 0)
})

test('Stripe read-mode lookup failure denies access before private work', async () => {
  let fetchCalls = 0
  const calls = []
  const res = await run({ vin: VALID_VIN, subjectType: 'project', subjectId: SUBJECT_ID }, {
    client: { stripeModeError: { message: 'synthetic mode failure' }, onRpc: name => calls.push(name) },
    fetchImpl: async () => { fetchCalls += 1; return nhtsaResponse() },
  })
  assert.equal(res.statusCode, 503)
  assert.equal(res.body.code, 'ENTITLEMENT_UNAVAILABLE')
  assert.deepEqual(calls, ['stripe_entitlement_read_mode'])
  assert.equal(fetchCalls, 0)
})

test('fails closed for deleted/tombstoned users and tombstone lookup errors', async () => {
  for (const [label, options, expectedStatus] of [
    ['tombstoned', { tombstone: { status: 'requested' } }, 410],
    ['lookup error', { tombstoneError: { message: 'synthetic lookup failure' } }, 503],
  ]) {
    const tableReads = []
    const rpcCalls = []
    let fetchCalls = 0
    const res = await run({ vin: VALID_VIN, subjectType: 'project', subjectId: SUBJECT_ID }, {
      client: {
        ...options,
        onEq: table => tableReads.push(table),
        onRpc: name => rpcCalls.push(name),
      },
      fetchImpl: async () => { fetchCalls += 1; return nhtsaResponse() },
    })
    assert.equal(res.statusCode, expectedStatus, label)
    assert.deepEqual(tableReads, ['account_deletion_tombstones'], label)
    assert.deepEqual(rpcCalls, [], label)
    assert.equal(fetchCalls, 0, label)
  }
})

test('supports pre-create requests in both subject domains without an ID', async () => {
  for (const subjectType of ['project', 'my_stuff_item']) {
    const filters = []
    const res = await run({ vin: VALID_VIN, subjectType }, { client: { onEq: (...args) => filters.push(args) } })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.subjectType, subjectType)
    assert.equal(filters.some(([table]) => ['projects', 'my_stuff_items'].includes(table)), false)
  }
})

test('verifies supplied project and My Stuff ownership server-side', async () => {
  for (const [subjectType, expectedTable] of [['project', 'projects'], ['my_stuff_item', 'my_stuff_items']]) {
    const filters = []
    const res = await run({ vin: VALID_VIN, subjectType, subjectId: SUBJECT_ID }, { client: { onEq: (...args) => filters.push(args) } })
    assert.equal(res.statusCode, 200)
    assert.ok(filters.some(([table, column, value]) => table === expectedTable && column === 'id' && value === SUBJECT_ID))
    assert.ok(filters.some(([table, column, value]) => table === expectedTable && column === 'user_id' && value === 'user-1'))
  }
})

test('rejects invalid IDs and unowned subjects before rate-limit or NHTSA work', async () => {
  for (const [subjectType, subjectId, subject] of [
    ['project', 'not-a-uuid', { id: SUBJECT_ID }],
    ['project', SUBJECT_ID, null],
    ['my_stuff_item', SUBJECT_ID, null],
  ]) {
    let fetchCalls = 0
    const rpcCalls = []
    const res = await run({ vin: VALID_VIN, subjectType, subjectId }, {
      client: { subject, onRpc: name => rpcCalls.push(name) },
      fetchImpl: async () => { fetchCalls += 1; return nhtsaResponse() },
    })
    assert.ok([400, 404].includes(res.statusCode))
    assert.equal(fetchCalls, 0)
    assert.deepEqual(rpcCalls, ['stripe_entitlement_read_mode'])
  }
})

test('rejects forbidden characters, bad check digits, and directs older/nonstandard VINs to manual entry', async () => {
  for (const [vin, code] of [
    ['1HGCM82633A00I352', 'VIN_INVALID_CHARACTERS'],
    ['1HGCM82643A004352', 'VIN_INVALID_CHECK_DIGIT'],
    ['1234567890123', 'VIN_NONSTANDARD'],
  ]) {
    let fetchCalls = 0
    const res = await run({ vin, subjectType: 'project' }, { fetchImpl: async () => { fetchCalls += 1; return nhtsaResponse() } })
    assert.equal(res.statusCode, 422)
    assert.equal(res.body.code, code)
    assert.equal(res.body.manualEntry, true)
    assert.equal(fetchCalls, 0)
  }
})

test('bounds raw VIN input before normalization work', async () => {
  let fetchCalls = 0
  const res = await run({ vin: ' '.repeat(1_000_000) + VALID_VIN, subjectType: 'project' }, {
    fetchImpl: async () => { fetchCalls += 1; return nhtsaResponse() },
  })
  assert.equal(res.statusCode, 413)
  assert.equal(res.body.code, 'VIN_INPUT_TOO_LARGE')
  assert.equal(fetchCalls, 0)
})

test('allows a format-valid foreign VIN without a North American check digit', async () => {
  assert.equal(isValidVinCheckDigit(FOREIGN_VALID_VIN), false)
  const res = await run({ vin: FOREIGN_VALID_VIN, subjectType: 'project' }, {
    fetchImpl: async () => nhtsaResponse({ ErrorCode: '1', Make: 'VOLKSWAGEN', Model: 'Golf', ModelYear: '1999' }),
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.vehicle.make, 'VOLKSWAGEN')
  assert.equal(res.body.nhtsaWarnings[0].code, '1')
})

test('claims the persistent per-user limiter before every cache read, including cache hits', async () => {
  const events = []
  const cached = { decoded_fields: { modelYear: 2003, make: 'HONDA', model: 'Accord' }, nhtsa_error_codes: [] }
  const res = await run({ vin: VALID_VIN, subjectType: 'project' }, {
    client: {
      cached,
      onRpc: name => events.push(name),
      onEq: table => { if (table === 'vin_decode_cache') events.push('cache_read') },
    },
    fetchImpl: async () => { throw new Error('cache should avoid NHTSA') },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.cached, true)
  assert.deepEqual(events.slice(0, 2), [
    'stripe_entitlement_read_mode', 'claim_vin_decode_request',
  ])
  assert.ok(events.indexOf('claim_vin_decode_request') < events.indexOf('cache_read'))
})

test('does not expose malformed or record-like data from a shared cache entry', async () => {
  let fetchCalls = 0
  const res = await run({ vin: VALID_VIN, subjectType: 'project' }, {
    client: { cached: { decoded_fields: { make: 'HONDA', privateNote: 'another user record' }, nhtsa_error_codes: [] } },
    fetchImpl: async () => { fetchCalls += 1; return nhtsaResponse() },
    logger: { error() {} },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(fetchCalls, 1)
  assert.equal(res.body.cached, false)
  assert.doesNotMatch(JSON.stringify(res.body), /another user record/i)
})

test('quarantines an invalid cache entry through the bounded cleanup RPC before refetching', async () => {
  const calls = []
  const res = await run({ vin: VALID_VIN, subjectType: 'project' }, {
    client: {
      cached: { decoded_fields: { make: 'HONDA', privateNote: 'invalid' }, nhtsa_error_codes: [] },
      onRpc: (name, args) => calls.push([name, args]),
    },
    logger: { error() {} },
  })
  assert.equal(res.statusCode, 200)
  const cleanup = calls.find(([name]) => name === 'cleanup_vin_decode_state')
  assert.ok(cleanup)
  assert.equal(cleanup[1].p_batch_limit, 100)
  assert.match(cleanup[1].p_invalid_vin_hmac, /^[a-f0-9]{64}$/)
})

test('quarantines cached numeric fields that violate the upstream field bounds', async () => {
  for (const decodedFields of [
    { make: 'HONDA', modelYear: -1 },
    { make: 'HONDA', engineCylinders: 999 },
    { make: 'HONDA', displacementLiters: 999 },
    { make: 'HONDA', engineCylinders: 2.5 },
  ]) {
    const calls = []
    let fetchCalls = 0
    const res = await run({ vin: VALID_VIN, subjectType: 'project' }, {
      client: {
        cached: { decoded_fields: decodedFields, nhtsa_error_codes: [] },
        onRpc: (name, args) => calls.push([name, args]),
      },
      fetchImpl: async () => { fetchCalls += 1; return nhtsaResponse() },
      logger: { error() {} },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.cached, false)
    assert.equal(fetchCalls, 1)
    assert.ok(calls.some(([name]) => name === 'cleanup_vin_decode_state'))
  }
})

test('persistent rate limiting fails closed and returns retry guidance', async () => {
  for (const client of [
    { rateDecision: 'rate_limited' },
    { rateError: { message: 'synthetic RPC failure' } },
  ]) {
    let fetchCalls = 0
    const res = await run({ vin: VALID_VIN, subjectType: 'project' }, { client, fetchImpl: async () => { fetchCalls += 1; return nhtsaResponse() } })
    assert.equal(res.statusCode, client.rateDecision ? 429 : 503)
    assert.equal(fetchCalls, 0)
    assert.equal(res.body.manualEntry, true)
    if (client.rateDecision) assert.equal(res.headers['Retry-After'], '42')
  }
})

test('maps only allowlisted structured NHTSA fields and caches by HMAC without raw VIN', async () => {
  const calls = []
  const res = await run({ vin: '1hg-cm826 33a004352', subjectType: 'project' }, {
    client: { onRpc: (name, args) => calls.push([name, args]) },
    fetchImpl: async () => nhtsaResponse({ OtherField: 'do not return', Make: ' HONDA\u0000 ' }),
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body.vehicle, {
    modelYear: 2003,
    make: 'HONDA',
    model: 'Accord',
    trim: 'EX',
    bodyClass: 'Sedan/Saloon',
    vehicleType: 'PASSENGER CAR',
    manufacturer: 'AMERICAN HONDA MOTOR CO., INC.',
    plantCountry: 'UNITED STATES (USA)',
    fuelTypePrimary: 'Gasoline',
    engineCylinders: 6,
    displacementLiters: 3,
    driveType: '4x2',
    transmissionStyle: 'Automatic',
  })
  assert.equal('OtherField' in res.body.vehicle, false)
  const [, cacheArgs] = calls.find(([name]) => name === 'store_vin_decode_cache')
  assert.match(cacheArgs.p_vin_hmac, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(cacheArgs), new RegExp(VALID_VIN, 'i'))
  assert.deepEqual(cacheArgs.p_nhtsa_error_codes, [])
  assert.equal(cacheArgs.p_hmac_key_version, 2)
  assert.equal(res.body.subjectId, null)
  assert.equal(res.body.requestId, REQUEST_ID)
  assert.equal(res.headers['X-Request-ID'], REQUEST_ID)
})

test('returns official NHTSA correction and partial-data codes as warnings when useful data exists', async () => {
  const expected = {
    '7': 'Manufacturer is not registered with NHTSA for sale or importation in the U.S. for use on U.S. roads.',
    '8': 'No detailed data is currently available.',
    '9': 'Glider warning: this is not a motor vehicle and cannot be assigned a VIN meeting 49 CFR Part 565.',
    '10': 'Off-road vehicle warning: the manufacturer did not certify this product as a motor vehicle complying with applicable Federal Motor Vehicle Safety Standards.',
    '11': 'Incorrect model year: position 10 does not match a valid model year code. Decoded data may not be accurate.',
    '12': 'Model year warning: the model year submitted for decoding does not match the VIN model year.',
    '14': 'Unable to provide information for some VIN characters based on the manufacturer submission.',
  }
  for (const [code, message] of Object.entries(expected)) {
    const calls = []
    const res = await run({ vin: VALID_VIN, subjectType: 'project', subjectId: SUBJECT_ID }, {
      client: { onRpc: (name, args) => calls.push([name, args]) },
      fetchImpl: async () => nhtsaResponse({ ErrorCode: code, ErrorText: '<script>unsafe</script>' }),
    })
    assert.equal(res.statusCode, 200, `code ${code}`)
    assert.deepEqual(res.body.nhtsaWarnings, [{ code, message }])
    assert.equal(res.body.subjectId, SUBJECT_ID)
    assert.equal(res.body.requestId, REQUEST_ID)
    assert.doesNotMatch(JSON.stringify(res.body), /script|unsafe/i)
    const [, warningCacheArgs] = calls.find(([name]) => name === 'store_vin_decode_cache')
    assert.deepEqual(warningCacheArgs.p_nhtsa_error_codes, [code])
  }
})

test('treats official NHTSA code 400 as fatal and does not cache it', async () => {
  const rpcCalls = []
  const res = await run({ vin: VALID_VIN, subjectType: 'project' }, {
    client: { onRpc: name => rpcCalls.push(name) },
    fetchImpl: async () => nhtsaResponse({ ErrorCode: '400', ErrorText: '<script>sensitive upstream detail</script>', Make: '' }),
  })
  assert.equal(res.statusCode, 422)
  assert.deepEqual(res.body.nhtsaErrors, [
    { code: '400', message: 'Invalid characters are present.' },
  ])
  assert.equal(res.body.manualEntry, true)
  assert.doesNotMatch(JSON.stringify(res.body), /script|sensitive/i)
  assert.equal(rpcCalls.includes('store_vin_decode_cache'), false)
})

test('denies redirects and requires the exact HTTPS NHTSA final response origin', async () => {
  let fetchOptions
  const invalidResponses = [
    nhtsaResponse({}, null),
    { ok: true, url: 'http://attacker.example/result', headers: new Headers(), body: null, text: async () => JSON.stringify({ Results: [] }) },
    { ok: true, url: 'https://vpic.nhtsa.dot.gov:444/result', headers: new Headers(), body: null, text: async () => JSON.stringify({ Results: [] }) },
  ]
  assert.equal(invalidResponses[0].url, '')
  for (const response of invalidResponses) {
    const rejected = await run({ vin: VALID_VIN, subjectType: 'project' }, {
      fetchImpl: async (_url, options) => {
        fetchOptions = options
        return response
      },
      logger: { error() {} },
    })
    assert.equal(fetchOptions.redirect, 'error')
    assert.equal(rejected.statusCode, 502)
    assert.equal(rejected.body.code, 'NHTSA_INVALID_RESPONSE')
  }
})

test('times out NHTSA and provides retry plus manual-entry fallback without logging a full VIN', async () => {
  const logs = []
  const logger = { error: (...args) => logs.push(args.join(' ')) }
  const fetchImpl = async (_url, { signal }) => await new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error(`upstream timed out for ${VALID_VIN}`)
      error.name = 'AbortError'
      reject(error)
    }, { once: true })
  })
  const res = await run({ vin: VALID_VIN, subjectType: 'project' }, { fetchImpl, timeoutMs: 5, logger })
  assert.equal(res.statusCode, 504)
  assert.equal(res.body.retryable, true)
  assert.equal(res.body.manualEntry, true)
  assert.doesNotMatch(logs.join(' '), new RegExp(VALID_VIN, 'i'))
})

test('rejects malformed and oversized NHTSA responses with safe fallback', async () => {
  const malformed = new Response(JSON.stringify({ Results: [{}] }), { status: 200 })
  const oversized = new Response('x'.repeat(101), { status: 200, headers: { 'content-length': '101' } })
  for (const [fetchImpl, maxResponseBytes] of [[async () => malformed, 10_000], [async () => oversized, 100]]) {
    const res = await run({ vin: VALID_VIN, subjectType: 'project' }, { fetchImpl, maxResponseBytes })
    assert.equal(res.statusCode, 502)
    assert.equal(res.body.retryable, true)
    assert.equal(res.body.manualEntry, true)
  }
})

test('rejects an oversized streamed NHTSA response without content-length', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(60)))
      controller.enqueue(new TextEncoder().encode('x'.repeat(60)))
      controller.close()
    },
  })
  const res = await run({ vin: VALID_VIN, subjectType: 'project' }, {
    fetchImpl: async () => new Response(stream, { status: 200 }),
    maxResponseBytes: 100,
    logger: { error() {} },
  })
  assert.equal(res.statusCode, 502)
  assert.equal(res.body.code, 'NHTSA_INVALID_RESPONSE')
})

test('reads configured prior HMAC versions during rotation and ignores retired keys', async () => {
  const oldEntry = { decoded_fields: { modelYear: 2003, make: 'HONDA', model: 'Accord' }, nhtsa_error_codes: ['14'] }
  let fetchCalls = 0
  const keys = { 1: 'old-synthetic-test-secret-at-least-thirty-two-bytes', 2: 'new-synthetic-test-secret-at-least-thirty-two-bytes' }
  const rotated = await run({ vin: VALID_VIN, subjectType: 'project' }, {
    hmacKeys: keys,
    activeHmacKeyVersion: 2,
    client: { cacheByVersion: { 1: oldEntry } },
    fetchImpl: async () => { fetchCalls += 1; return nhtsaResponse() },
  })
  assert.equal(rotated.statusCode, 200)
  assert.equal(rotated.body.cached, true)
  assert.deepEqual(rotated.body.nhtsaWarnings.map(({ code }) => code), ['14'])
  assert.equal(fetchCalls, 0)

  const retired = await run({ vin: VALID_VIN, subjectType: 'project' }, {
    hmacKeys: { 2: keys[2] },
    activeHmacKeyVersion: 2,
    client: { cacheByVersion: { 1: oldEntry } },
    fetchImpl: async () => { fetchCalls += 1; return nhtsaResponse() },
  })
  assert.equal(retired.statusCode, 200)
  assert.equal(retired.body.cached, false)
  assert.equal(fetchCalls, 1)
})

test('uses private no-store response headers', async () => {
  const res = await run({ vin: VALID_VIN, subjectType: 'project' })
  assert.match(res.headers['Cache-Control'], /private.*no-store/)
  assert.equal(res.headers['CDN-Cache-Control'], 'no-store')
  assert.equal(res.headers.Vary, 'Authorization')
})
