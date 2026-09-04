import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

process.env.VITE_SUPABASE_URL ||= 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= ['synthetic', 'service', 'key'].join('-')

const { createReportDataHandler } = await import('../api/report-data.js')
const SUBJECT_ID = '11111111-1111-4111-8111-111111111111'

function result(data, error = null) { return { data, error } }

function clientFor({ userId = 'user-1', plan = 'pro', tombstone = null, tableResults = {}, onQuery = () => {}, authError = null } = {}) {
  const profile = plan === 'pro' ? { subscription_id: 'sub_synthetic', subscription_status: 'active' } : { subscription_id: null, subscription_status: null }
  return {
    auth: { getUser: async () => ({ data: { user: authError ? null : { id: userId } }, error: authError }) },
    from(table) {
      const state = { table, columns: null, filters: [], limit: null, order: null }
      const chain = {
        select(columns) { state.columns = columns; return chain },
        eq(column, value) { state.filters.push([column, value]); return chain },
        order(column, options) { state.order = [column, options]; return chain },
        limit(value) { state.limit = value; return run(false) },
        maybeSingle() { return run(true) },
        then(resolve, reject) { return run(false).then(resolve, reject) },
      }
      async function run(single) {
        onQuery({ ...state, single })
        const configured = tableResults[table]
        if (typeof configured === 'function') return configured({ ...state, single })
        if (configured) return configured
        if (table === 'profiles') return result(profile)
        if (table === 'user_entitlements') return result([])
        if (table === 'account_deletion_tombstones') return result(tombstone)
        return result(single ? null : [])
      }
      return chain
    },
  }
}

function request(body, { method = 'POST', token = 'synthetic-token', contentLength } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {}
  if (contentLength != null) headers['content-length'] = String(contentLength)
  return { method, headers, body }
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

function validBody(overrides = {}) {
  return { subjectType: 'project', subjectId: SUBJECT_ID, disclaimer: 'Prepared by the owner; verify details independently.', ...overrides }
}

function projectClient(options = {}) {
  const project = {
    id: SUBJECT_ID,
    title: '  1998 Ford\u0000 Ranger  ',
    category: 'Vehicles',
    status: 'sold',
    notes: 'Restored carefully.',
    created_at: '2026-01-01T00:00:00.000Z',
    sold_at: '2026-08-01T00:00:00.000Z',
  }
  return clientFor({
    ...options,
    tableResults: {
      projects: ({ columns }) => {
        if (columns === 'id') return result({ id: SUBJECT_ID })
        if (columns.includes('vehicle_year')) return result({ vehicle_year: 1998, vehicle_make: 'Ford', vehicle_model: 'Ranger' })
        if (columns.includes('vin')) return result({ model_number: 'M-1', serial_number: 'S-1', engine_model: 'E-1', engine_serial: 'ES-1', vin: 'VIN-PRIVATE', hull_number: 'H-1' })
        if (columns.includes('purchase_price')) return result({ purchase_price: 1000, sale_price: 2500 })
        return result(project)
      },
      expenses: result([{ description: 'Clutch', category: 'parts', amount: 300, created_at: '2026-02-01T00:00:00.000Z' }]),
      ...options.tableResults,
    },
  })
}

test('route accepts POST only and validates a small exact request contract before database access', async () => {
  let queries = 0
  const handler = createReportDataHandler({ client: projectClient({ onQuery: () => { queries += 1 } }) })
  for (const [req, expectedCode] of [
    [request(validBody(), { method: 'GET' }), 'METHOD_NOT_ALLOWED'],
    [request(validBody({ subjectType: 'projects' })), 'INVALID_REQUEST'],
    [request(validBody({ subjectId: 'not-a-uuid' })), 'INVALID_REQUEST'],
    [request(validBody({ disclaimer: '   ' })), 'INVALID_REQUEST'],
    [request(validBody({ includeIdentifiers: 'true' })), 'INVALID_REQUEST'],
    [request(validBody({ surprise: true })), 'INVALID_REQUEST'],
    [request(validBody(), { contentLength: 20_000 }), 'REQUEST_TOO_LARGE'],
  ]) {
    const res = responseRecorder()
    await handler(req, res)
    assert.equal(res.body.code, expectedCode)
  }
  assert.equal(queries, 0)
})

test('authentication, deletion tombstone, and authoritative Pro checks fail closed', async () => {
  for (const [client, expectedStatus, expectedCode] of [
    [projectClient({ authError: { message: 'bad token' } }), 401, 'AUTH_REQUIRED'],
    [projectClient({ tombstone: { status: 'processing' } }), 410, 'ACCOUNT_DELETED'],
    [projectClient({ plan: 'free' }), 403, 'PRO_REQUIRED'],
    [projectClient({ tableResults: { user_entitlements: result(null, { message: 'db unavailable' }) } }), 503, 'SERVICE_UNAVAILABLE'],
  ]) {
    const res = responseRecorder()
    await createReportDataHandler({ client })(request(validBody()), res)
    assert.equal(res.statusCode, expectedStatus)
    assert.equal(res.body.code, expectedCode)
  }
})

test('thrown database failures are converted to a stable fail-closed response', async () => {
  const client = projectClient()
  client.from = () => { throw new Error('network details must not escape') }
  const res = responseRecorder()
  await createReportDataHandler({ client })(request(validBody()), res)
  assert.equal(res.statusCode, 503)
  assert.deepEqual(res.body, { code: 'SERVICE_UNAVAILABLE', error: 'Report data is temporarily unavailable.' })
})

test('ownership is checked with UUID and user_id before report fields are read', async () => {
  const queries = []
  const client = projectClient({
    onQuery: query => queries.push(query),
    tableResults: { projects: ({ columns }) => result(columns === 'id' ? null : assert.fail('read details before ownership')) },
  })
  const res = responseRecorder()
  await createReportDataHandler({ client })(request(validBody()), res)
  assert.equal(res.statusCode, 404)
  assert.equal(res.body.code, 'SUBJECT_NOT_FOUND')
  const ownership = queries.find(query => query.table === 'projects')
  assert.equal(ownership.columns, 'id')
  assert.deepEqual(ownership.filters, [['id', SUBJECT_ID], ['user_id', 'user-1']])
})

test('project defaults are sanitized and omit identifiers, costs, and media', async () => {
  const res = responseRecorder()
  await createReportDataHandler({ client: projectClient() })(request(validBody()), res)
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['Cache-Control'], /private.*no-store/)
  assert.equal(res.headers['CDN-Cache-Control'], 'no-store')
  assert.equal(res.headers.Vary, 'Authorization')
  assert.deepEqual(res.body, {
    schemaVersion: 1,
    subjectType: 'project',
    subjectId: SUBJECT_ID,
    disclaimer: 'Prepared by the owner; verify details independently.',
    report: {
      title: '1998 Ford Ranger', category: 'Vehicles', status: 'sold', notes: 'Restored carefully.',
      createdAt: '2026-01-01T00:00:00.000Z', soldAt: '2026-08-01T00:00:00.000Z',
    },
  })
  assert.doesNotMatch(JSON.stringify(res.body), /VIN-PRIVATE|S-1|purchasePrice|salePrice|expenses|photos|documents/i)
})

test('explicit project opt-ins expose only allowlisted identifiers and detailed costs', async () => {
  const res = responseRecorder()
  await createReportDataHandler({ client: projectClient() })(request(validBody({ includeIdentifiers: true, includeDetailedCosts: true })), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body.report.identifiers, {
    modelNumber: 'M-1', serialNumber: 'S-1', engineModel: 'E-1', engineSerial: 'ES-1', vin: 'VIN-PRIVATE', hullNumber: 'H-1',
    vehicleYear: 1998, vehicleMake: 'Ford', vehicleModel: 'Ranger',
  })
  assert.deepEqual(res.body.report.detailedCosts, {
    purchasePrice: 1000, salePrice: 2500, expenseTotal: 300,
    expenses: [{ description: 'Clutch', category: 'parts', amount: 300, createdAt: '2026-02-01T00:00:00.000Z' }],
  })
})

test('My Stuff report bounds maintenance history and keeps costs opt-in', async () => {
  const queries = []
  const logs = Array.from({ length: 140 }, (_, index) => ({
    name: `Service ${index}`, completed_at: '2026-01-01T00:00:00.000Z', mileage: index, hours: null,
    cost: 10, notes: 'x'.repeat(2000),
  }))
  const client = clientFor({
    onQuery: query => queries.push(query),
    tableResults: {
      my_stuff_items: ({ columns }) => result(columns === 'id' ? { id: SUBJECT_ID } : {
        id: SUBJECT_ID, name: 'Generator', category: 'equipment', acquired_on: '2024-01-01', notes: 'Backup power',
        current_mileage: null, current_hours: 41, created_at: '2024-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      }),
      my_stuff_schedules: result([]),
      my_stuff_service_logs: result(logs),
    },
  })
  const res = responseRecorder()
  await createReportDataHandler({ client })(request(validBody({ subjectType: 'my_stuff_item' })), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.report.serviceHistory.length, 100)
  assert.equal(res.body.report.serviceHistory[0].notes.length, 1000)
  assert.equal('cost' in res.body.report.serviceHistory[0], false)
  const historyQuery = queries.find(query => query.table === 'my_stuff_service_logs')
  assert.equal(historyQuery.limit, 100)
  assert.ok(historyQuery.columns.split(',').every(column => column.trim() !== 'cost'))
})

test('optional V2 column absence degrades safely, while other database errors fail closed', async () => {
  const missingColumn = { code: '42703', message: 'column does not exist' }
  const client = projectClient({ tableResults: {
    projects: ({ columns }) => {
      if (columns === 'id') return result({ id: SUBJECT_ID })
      if (columns.includes('vehicle_year')) return result(null, missingColumn)
      if (columns.includes('vin')) return result({ vin: 'VIN-PRIVATE' })
      return result({ id: SUBJECT_ID, title: 'Desk', category: 'Furniture', status: 'active', notes: null, created_at: null, sold_at: null })
    },
  } })
  const res = responseRecorder()
  await createReportDataHandler({ client })(request(validBody({ includeIdentifiers: true })), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.report.identifiers.vin, 'VIN-PRIVATE')
  assert.equal('vehicleYear' in res.body.report.identifiers, false)

  const failing = projectClient({ tableResults: { projects: ({ columns }) => columns === 'id' ? result({ id: SUBJECT_ID }) : result(null, { code: 'XX000', message: 'failure' }) } })
  const failedRes = responseRecorder()
  await createReportDataHandler({ client: failing })(request(validBody()), failedRes)
  assert.equal(failedRes.statusCode, 503)
  assert.equal(failedRes.body.code, 'SERVICE_UNAVAILABLE')
})

test('photo and document opt-ins use a private-media adapter and never echo private references', async () => {
  const calls = []
  const adapter = {
    async listPrivateMedia(input) { calls.push(input); return [] },
  }
  const res = responseRecorder()
  await createReportDataHandler({ client: projectClient(), privateMediaAdapter: adapter })(request(validBody({ includePhotos: true, includeDocuments: true })), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body.report.media, { photos: [], documents: [] })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].kinds, ['photo', 'document'])
  assert.equal('userId' in res.body, false)
})

test('source uses explicit allowlists and contains no raw-row or forbidden-account output contract', async () => {
  const source = await fs.readFile(new URL('../api/report-data.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /select\(\s*['"]\*|\.\.\.(project|item|row)|ownerEmail|provider_customer_id|provider_subscription_id|goal_id|goalFunding|outOfPocket|tradeCredit|storagePath/)
  assert.match(source, /MAX_RESPONSE_BYTES/)
  assert.match(source, /PRIVATE_MEDIA_ADAPTER_CONTRACT/)
})
