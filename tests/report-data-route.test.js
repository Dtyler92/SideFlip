import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

process.env.VITE_SUPABASE_URL ||= 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= ['synthetic', 'service', 'key'].join('-')

const { createReportDataHandler } = await import('../api/report-data.js')
const SUBJECT_ID = '11111111-1111-4111-8111-111111111111'

function result(data, error = null) { return { data, error } }

function clientFor({ userId = 'user-1', plan = 'pro', tombstone = null, tableResults = {}, rpcResults = {}, onQuery = () => {}, authError = null } = {}) {
  const profile = plan === 'pro' ? { subscription_id: 'sub_synthetic', subscription_status: 'active' } : { subscription_id: null, subscription_status: null }
  return {
    auth: { getUser: async () => ({ data: { user: authError ? null : { id: userId } }, error: authError }) },
    from(table) {
      const state = { table, columns: null, filters: [], limit: null, referencedLimits: [], order: null }
      const chain = {
        select(columns) { state.columns = columns; return chain },
        eq(column, value) { state.filters.push([column, value]); return chain },
        order(column, options) { state.order = [column, options]; return chain },
        limit(value, options) {
          if (options?.referencedTable) state.referencedLimits.push([value, options])
          else state.limit = [value, options]
          return chain
        },
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
    rpc(name, parameters) {
      const state = { rpc: name, parameters, limit: null }
      const chain = {
        limit(value, options) { state.limit = [value, options]; return chain },
        then(resolve, reject) { return run().then(resolve, reject) },
      }
      async function run() {
        onQuery({ ...state })
        const configured = rpcResults[name]
        return typeof configured === 'function' ? configured(parameters) : (configured || result([]))
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

test('authorization gates run in auth, tombstone, Pro, then ownership order', async () => {
  const sequence = []
  const client = projectClient({ onQuery: query => sequence.push(query.table || query.rpc) })
  const res = responseRecorder()
  await createReportDataHandler({ client })(request(validBody()), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(sequence.slice(0, 5), [
    'account_deletion_tombstones', 'profiles', 'user_entitlements', 'projects', 'projects',
  ])
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
    modelNumber: 'M-1', serialNumber: 'S-1', engineModel: 'E-1', engineSerial: 'ES-1', vin: '••••VATE', hullNumber: 'H-1',
    vehicleYear: 1998, vehicleMake: 'Ford', vehicleModel: 'Ranger',
  })
  assert.deepEqual(res.body.report.detailedCosts, {
    purchasePrice: 1000, salePrice: 2500, expenseTotal: 300,
    expenses: [{ description: 'Clutch', category: 'parts', amount: 300, createdAt: '2026-02-01T00:00:00.000Z' }],
  })
})

test('My Stuff report preserves bounded V1 history and reads complete V2 report history', async () => {
  const queries = []
  const logs = Array.from({ length: 140 }, (_, index) => ({
    name: `Service ${index}`, completed_at: '2026-01-01T00:00:00.000Z', mileage: index, hours: null,
    cost: 10, notes: 'x'.repeat(2000),
  }))
  const occurrenceId = '22222222-2222-4222-8222-222222222222'
  const definitionId = '33333333-3333-4333-8333-333333333333'
  const client = clientFor({
    onQuery: query => queries.push(query),
    tableResults: {
      my_stuff_items: ({ columns }) => result(columns === 'id' ? { id: SUBJECT_ID } : {
        id: SUBJECT_ID, name: 'Generator', category: 'equipment', acquired_on: '2024-01-01', notes: 'Backup power',
        current_mileage: null, current_hours: 41, current_cycles: 8, created_at: '2024-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      }),
      my_stuff_schedules: result([]),
      my_stuff_service_logs: result(logs),
      my_stuff_maintenance_definitions: result([{
        id: definitionId, name: 'Oil service', description: 'Change oil', service_category: 'engine', service_action: 'service',
        due_semantics: 'whichever_first', active_profile: 'normal', cadence_anchor: 'last_completion', normal_interval_hours: 50,
        due_soon_hours: 10, provenance_type: 'ai_research', source_class: 'manufacturer_manual',
        citation_url: 'https://manufacturer.example/manual', citation_title: 'Owner manual', citation_page: '42',
        citation_section: 'Maintenance', citation_accessed_on: '2026-08-01', uncertain: false, enabled: true,
      }]),
      my_stuff_readings: result([{
        reading_type: 'hours', reading_value: 41, recorded_at: '2026-01-01T00:00:00.000Z', source: 'manual',
        correction_reason: null, created_at: '2026-01-01T00:00:01.000Z',
      }]),
      my_stuff_service_occurrences: result([{
        id: occurrenceId, definition_id: definitionId, service_name: 'Oil service', service_category: 'engine',
        service_action: 'service', scheduled: true, completed_at: '2026-02-01T00:00:00.000Z', mileage: null,
        hours: 40, cycles: 8, provenance_type: 'project_expense_snapshot',
        provenance: { description: 'Oil and filter', category: 'maintenance', amount: 85, user_id: 'must-not-leak' },
        my_stuff_service_occurrence_revisions: [{
          revision_number: 2, notes: 'Corrected receipt', revision_reason: 'Receipt correction', created_at: '2026-02-02T00:00:00.000Z',
          parts: [{ name: 'Filter', cost: 15, storagePath: 'private/key' }], labor: [{ description: 'Oil change', amount: 70 }],
          vendor: { name: 'Local shop', account: 'private' }, warranty: { description: '90 days', secret: 'private' },
        }],
      }]),
    },
    rpcResults: { get_my_stuff_due_state_v2: result([{
      definition_id: definitionId, next_due_at: null, next_due_mileage: null, next_due_hours: 90,
      next_due_cycles: null, due_status: 'upcoming',
    }]) },
  })
  const tokens = []
  const res = responseRecorder()
  await createReportDataHandler({ client, userClientFactory: token => { tokens.push(token); return client } })(request(validBody({ subjectType: 'my_stuff_item' })), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(tokens, ['synthetic-token'])
  assert.equal(res.body.report.currentCycles, 8)
  assert.equal(res.body.report.serviceHistory.length, 100)
  assert.equal(res.body.report.serviceHistory[0].source.version, 2)
  assert.equal(res.body.report.serviceHistory[0].latestRevision.revisionNumber, 2)
  assert.equal(res.body.report.serviceHistory[0].latestRevision.notes, 'Corrected receipt')
  assert.equal('parts' in res.body.report.serviceHistory[0].latestRevision, false)
  assert.deepEqual(res.body.report.serviceHistory[0].source.provenance, { description: 'Oil and filter', category: 'maintenance' })
  assert.equal(res.body.report.serviceHistory[1].notes.length, 1000)
  assert.equal('cost' in res.body.report.serviceHistory[1], false)
  assert.deepEqual(res.body.report.maintenanceDefinitions[0].dueState, { nextDueHours: 90, status: 'upcoming' })
  assert.equal(res.body.report.maintenanceDefinitions[0].source.citationTitle, 'Owner manual')
  assert.deepEqual(res.body.report.usageReadings, [{
    type: 'hours', value: 41, recordedAt: '2026-01-01T00:00:00.000Z', source: 'manual', createdAt: '2026-01-01T00:00:01.000Z',
  }])
  assert.doesNotMatch(JSON.stringify(res.body), /must-not-leak|private\/key|"account"|"secret"|"amount":85/)
  const historyQuery = queries.find(query => query.table === 'my_stuff_service_logs')
  assert.equal(historyQuery.limit[0], 100)
  assert.ok(historyQuery.columns.split(',').every(column => column.trim() !== 'cost'))
  const v2Query = queries.find(query => query.table === 'my_stuff_service_occurrences')
  assert.deepEqual(v2Query.limit, [100, undefined])
  assert.match(v2Query.columns, /my_stuff_service_occurrence_revisions/)
  const dueStateQuery = queries.find(query => query.rpc === 'get_my_stuff_due_state_v2')
  assert.deepEqual(dueStateQuery.limit, [50, undefined])
})

test('detailed-cost opt-in exposes only allowlisted V2 revision and provenance cost fields', async () => {
  const client = clientFor({ tableResults: {
    my_stuff_items: ({ columns }) => result(columns === 'id' ? { id: SUBJECT_ID } : columns.includes('purchase_price')
      ? { purchase_price: 1000, estimated_value: 1200 }
      : { id: SUBJECT_ID, name: 'Truck' }),
    my_stuff_schedules: result([]), my_stuff_service_logs: result([]), my_stuff_maintenance_definitions: result([]), my_stuff_readings: result([]),
    my_stuff_service_occurrences: result([{
      id: '22222222-2222-4222-8222-222222222222', service_name: 'Repair', completed_at: '2026-01-01T00:00:00Z', provenance_type: 'project_expense_snapshot',
      provenance: { amount: 85, description: 'Repair', provider_customer_id: 'nope' },
      my_stuff_service_occurrence_revisions: [{ revision_number: 1, parts: [{ name: 'Part', quantity: 2, cost: 10, private: 'nope' }], labor: [{ hours: 1, rate: 65 }], vendor: { name: 'Shop', phone: 'nope' }, warranty: { description: '90 days' } }],
    }]),
  } })
  const res = responseRecorder()
  await createReportDataHandler({ client, userClientFactory: () => client })(request(validBody({ subjectType: 'my_stuff_item', includeDetailedCosts: true })), res)
  assert.equal(res.statusCode, 200)
  const entry = res.body.report.serviceHistory[0]
  assert.equal(entry.source.provenance.amount, 85)
  assert.deepEqual(entry.latestRevision.parts, [{ name: 'Part', quantity: 2, cost: 10 }])
  assert.deepEqual(entry.latestRevision.labor, [{ hours: 1, rate: 65 }])
  assert.deepEqual(entry.latestRevision.vendor, { name: 'Shop' })
  assert.deepEqual(entry.latestRevision.warranty, { description: '90 days' })
  assert.doesNotMatch(JSON.stringify(entry), /provider_customer_id|private|phone/)
})

test('My Stuff identifiers use model_year and never expose a full VIN', async () => {
  const queries = []
  const client = clientFor({
    onQuery: query => queries.push(query),
    tableResults: {
      my_stuff_items: ({ columns }) => {
        if (columns === 'id') return result({ id: SUBJECT_ID })
        if (columns.includes('model_year')) return result({ manufacturer: 'Ford', model: 'Ranger', model_year: 1998, vin: '1FTYR10C8WTA12345' })
        return result({ id: SUBJECT_ID, name: 'Truck' })
      },
      my_stuff_schedules: result([]), my_stuff_service_logs: result([]), my_stuff_maintenance_definitions: result([]),
      my_stuff_readings: result([]), my_stuff_service_occurrences: result([]),
    },
  })
  const res = responseRecorder()
  await createReportDataHandler({ client, userClientFactory: () => client })(request(validBody({ subjectType: 'my_stuff_item', includeIdentifiers: true })), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body.report.identifiers, { manufacturer: 'Ford', model: 'Ranger', year: 1998, vin: '••••2345' })
  assert.doesNotMatch(JSON.stringify(res.body), /1FTYR10C8WTA12345/)
  const query = queries.find(entry => entry.table === 'my_stuff_items' && entry.columns?.includes('vin'))
  assert.match(query.columns, /\bmodel_year\b/)
  assert.doesNotMatch(query.columns, /(^|,)year(,|$)/)
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
  assert.equal(res.body.report.identifiers.vin, '••••VATE')
  assert.equal('vehicleYear' in res.body.report.identifiers, false)

  const failing = projectClient({ tableResults: { projects: ({ columns }) => columns === 'id' ? result({ id: SUBJECT_ID }) : result(null, { code: 'XX000', message: 'failure' }) } })
  const failedRes = responseRecorder()
  await createReportDataHandler({ client: failing })(request(validBody()), failedRes)
  assert.equal(failedRes.statusCode, 503)
  assert.equal(failedRes.body.code, 'SERVICE_UNAVAILABLE')
})

test('photo and document opt-ins fail closed without a real adapter and never echo private references', async () => {
  const unavailable = responseRecorder()
  await createReportDataHandler({ client: projectClient() })(request(validBody({ includePhotos: true })), unavailable)
  assert.equal(unavailable.statusCode, 503)
  assert.equal(unavailable.body.code, 'PRIVATE_MEDIA_UNAVAILABLE')

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
  assert.doesNotMatch(source, /select\(\s*['"]\*|\.\.\.(project|item|row|provenance|revision)|ownerEmail|provider_customer_id|provider_subscription_id|goal_id|goalFunding|outOfPocket|tradeCredit|storagePath/)
  assert.doesNotMatch(source, /\.select\(['"][^'"]*\byear\b/)
  assert.match(source, /model_year/)
  assert.match(source, /maskIdentifier/)
  assert.match(source, /MAX_RESPONSE_BYTES/)
  assert.match(source, /PRIVATE_MEDIA_ADAPTER_CONTRACT/)
})
