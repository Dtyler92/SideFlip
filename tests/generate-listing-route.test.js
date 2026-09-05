import test from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL ||= 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= ['synthetic', 'service', 'key'].join('-')
process.env.ANTHROPIC_API_KEY ||= ['synthetic', 'anthropic', 'key'].join('-')

const { createGenerateListingHandler } = await import('../api/generate-listing.js')

function query(result, onEq = () => {}) {
  const chain = {
    select() { return chain },
    eq(column, value) { onEq(column, value); return chain },
    limit() { return Promise.resolve(result) },
    maybeSingle() { return Promise.resolve(result) },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject) },
  }
  return chain
}

const CLAIM_TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function clientFor({ userId = 'user-1', project = { id: '11111111-1111-4111-8111-111111111111', title: '1998 Ford Ranger', category: 'Vehicles', notes: '5-speed. Rust over rear wheel wells.' }, expenses = [{ description: 'New clutch' }], claimDecision = 'allowed', claimError = null, renewAllowed = true, stripeMode = 'compatibility', stripeModeError = null, profile = { subscription_id: 'sub_synthetic', subscription_status: 'active' }, entitlements = [{ source: 'stripe', status: 'active', expires_at: '2030-01-01T00:00:00Z', last_verified_at: '2026-09-01T00:00:00Z' }], tombstone = null, tombstoneError = null, onEq = () => {}, onRpc = () => {}, onRead = () => {} } = {}) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
    async rpc(name) {
      onRpc(name)
      if (name === 'claim_ai_generation_request') {
        return { data: claimDecision === 'allowed' ? { decision: 'allowed', claim_token: CLAIM_TOKEN } : { decision: claimDecision }, error: claimError }
      }
      if (name === 'renew_ai_generation_request') return { data: renewAllowed, error: null }
      if (name === 'release_ai_generation_request') return { data: true, error: null }
      if (name === 'stripe_entitlement_read_mode') return { data: stripeMode, error: stripeModeError }
      throw new Error(`Unexpected RPC: ${name}`)
    },
    from(table) {
      onRead(table)
      if (table === 'account_deletion_tombstones') return query({ data: tombstone, error: tombstoneError }, (column, value) => onEq(table, column, value))
      if (table === 'profiles') return query({ data: profile, error: null }, (column, value) => onEq(table, column, value))
      if (table === 'user_entitlements') return query({ data: entitlements, error: null }, (column, value) => onEq(table, column, value))
      if (table === 'projects') return query({ data: project, error: null }, (column, value) => onEq(table, column, value))
      if (table === 'expenses') return query({ data: expenses, error: null }, (column, value) => onEq(table, column, value))
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

function anthropicResponse(text = 'Runs and drives.\n\nNew clutch; rust is visible over the rear wheel wells.', stopReason = 'end_turn') {
  return { ok: true, status: 200, json: async () => ({ stop_reason: stopReason, content: [{ type: 'text', text }] }) }
}

test('canonical read-mode failures fail closed before limiter, private project reads, or provider work', async () => {
  for (const [label, stripeMode, stripeModeError] of [
    ['rpc error', null, { message: 'synthetic mode failure' }],
    ['missing row', null, null],
    ['invalid mode', 'legacy', null],
  ]) {
    const rpcCalls = []
    const tableReads = []
    let providerCalls = 0
    const handler = createGenerateListingHandler({
      client: clientFor({
        userId: `user-mode-${label}`,
        stripeMode,
        stripeModeError,
        entitlements: [],
        onRpc: name => rpcCalls.push(name),
        onEq: table => tableReads.push(table),
      }),
      fetchImpl: async () => { providerCalls += 1; return anthropicResponse() },
    })
    const res = responseRecorder()
    await handler(request({ projectId: '11111111-1111-4111-8111-111111111111', style: 'normal' }), res)

    assert.equal(res.statusCode, 503, label)
    assert.deepEqual(res.body, { error: 'Could not verify SideFlip Pro access.' }, label)
    assert.deepEqual(rpcCalls, ['stripe_entitlement_read_mode'], label)
    assert.equal(tableReads.some(table => ['projects', 'expenses'].includes(table)), false, label)
    assert.equal(providerCalls, 0, label)
  }
})

test('compatibility read mode preserves legacy profile Pro fallback', async () => {
  let providerCalls = 0
  const handler = createGenerateListingHandler({
    client: clientFor({ stripeMode: 'compatibility', entitlements: [] }),
    fetchImpl: async () => { providerCalls += 1; return anthropicResponse() },
  })
  const res = responseRecorder()
  await handler(request({ projectId: '11111111-1111-4111-8111-111111111111', style: 'normal' }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(providerCalls, 1)
})

test('deletion tombstones and lookup errors stop listing work before entitlement, limiter, private reads, or provider spend', async () => {
  for (const [label, options, expectedStatus] of [
    ['tombstoned', { tombstone: { status: 'requested' } }, 410],
    ['lookup error', { tombstoneError: { message: 'synthetic lookup failure' } }, 503],
  ]) {
    const tableReads = []
    const rpcCalls = []
    let providerCalls = 0
    const handler = createGenerateListingHandler({
      client: clientFor({
        userId: `user-deletion-${label}`,
        ...options,
        onRead: table => tableReads.push(table),
        onRpc: name => rpcCalls.push(name),
      }),
      fetchImpl: async () => { providerCalls += 1; return anthropicResponse() },
    })
    const res = responseRecorder()
    await handler(request({ projectId: '11111111-1111-4111-8111-111111111111', style: 'normal' }), res)
    assert.equal(res.statusCode, expectedStatus, label)
    assert.deepEqual(tableReads, ['account_deletion_tombstones'], label)
    assert.deepEqual(rpcCalls, [], label)
    assert.equal(providerCalls, 0, label)
  }
})

test('new client request loads canonical owner-scoped project facts and returns new and legacy response keys', async () => {
  let providerBody
  const filters = []
  const handler = createGenerateListingHandler({
    client: clientFor({ onEq: (table, column, value) => filters.push([table, column, value]) }),
    fetchImpl: async (_url, options) => { providerBody = JSON.parse(options.body); return anthropicResponse() },
  })
  const res = responseRecorder()
  await handler(request({ projectId: '11111111-1111-4111-8111-111111111111', style: 'funny', humorLevel: 'balanced', existingDescription: 'Seller draft.' }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.description, res.body.listing)
  assert.match(res.headers['Cache-Control'], /private.*no-store/)
  assert.equal(res.headers['CDN-Cache-Control'], 'no-store')
  assert.equal(res.headers.Vary, 'Authorization')
  assert.equal(providerBody.model, 'claude-haiku-4-5-20251001')
  assert.deepEqual(filters.filter(([table, column]) => ['projects', 'expenses'].includes(table) && column === 'user_id'), [
    ['projects', 'user_id', 'user-1'],
    ['expenses', 'user_id', 'user-1'],
  ])
  assert.match(providerBody.system, /Balanced humor level/)
  assert.match(providerBody.system, /silently identify up to five comedy hooks/i)
  assert.match(providerBody.system, /at least three distinct comedic beats/i)
  assert.deepEqual(JSON.parse(providerBody.messages[0].content), {
    title: '1998 Ford Ranger',
    category: 'Vehicles',
    sellerNotes: '5-speed. Rust over rear wheel wells.',
    existingDescription: 'Seller draft.',
    workAndParts: ['New clutch'],
  })
})

test('concurrent requests lock before project reads and spend on only one provider call', async () => {
  let releaseProject
  let markProjectReadStarted
  const projectReadStarted = new Promise(resolve => { markProjectReadStarted = resolve })
  const projectResult = new Promise(resolve => { releaseProject = () => resolve({ data: { id: '11111111-1111-4111-8111-111111111111', title: 'Desk', category: 'Furniture', notes: 'Solid wood.' }, error: null }) })
  const base = clientFor({ userId: 'user-concurrent' })
  const client = {
    ...base,
    from(table) {
      if (table !== 'projects') return base.from(table)
      const chain = {
        select() { return chain },
        eq() { return chain },
        maybeSingle() { markProjectReadStarted(); return projectResult },
      }
      return chain
    },
  }
  let providerCalls = 0
  const handler = createGenerateListingHandler({
    client,
    fetchImpl: async () => { providerCalls += 1; return anthropicResponse() },
  })
  const firstRes = responseRecorder()
  const secondRes = responseRecorder()
  const first = handler(request({ projectId: '11111111-1111-4111-8111-111111111111', style: 'normal' }), firstRes)
  await projectReadStarted
  await handler(request({ projectId: '11111111-1111-4111-8111-111111111111', style: 'normal' }), secondRes)
  assert.equal(secondRes.statusCode, 409)
  releaseProject()
  await first
  assert.equal(firstRes.statusCode, 200)
  assert.equal(providerCalls, 1)
})

test('durable limiter blocks cross-instance in-flight and rate-limited requests before provider spend', async () => {
  for (const [claimDecision, expectedStatus] of [['in_flight', 409], ['rate_limited', 429]]) {
    let providerCalls = 0
    const handler = createGenerateListingHandler({
      client: clientFor({ userId: `user-${claimDecision}`, claimDecision }),
      fetchImpl: async () => { providerCalls += 1; return anthropicResponse() },
    })
    const res = responseRecorder()
    await handler(request({ projectId: '11111111-1111-4111-8111-111111111111', style: 'normal' }), res)
    assert.equal(res.statusCode, expectedStatus)
    assert.equal(providerCalls, 0)
  }
})

test('durable limiter failure fails closed before provider spend', async () => {
  let providerCalls = 0
  const handler = createGenerateListingHandler({
    client: clientFor({ userId: 'user-limiter-error', claimError: { message: 'synthetic failure' } }),
    fetchImpl: async () => { providerCalls += 1; return anthropicResponse() },
  })
  const res = responseRecorder()
  await handler(request({ projectId: '11111111-1111-4111-8111-111111111111', style: 'normal' }), res)
  assert.equal(res.statusCode, 503)
  assert.equal(providerCalls, 0)
  assert.deepEqual(res.body, { error: "Couldn't generate a description. Try again." })
})

test('expired or superseded lease fails closed before provider spend', async () => {
  let providerCalls = 0
  const handler = createGenerateListingHandler({
    client: clientFor({ userId: 'user-stale-lease', renewAllowed: false }),
    fetchImpl: async () => { providerCalls += 1; return anthropicResponse() },
  })
  const res = responseRecorder()
  await handler(request({ projectId: '11111111-1111-4111-8111-111111111111', style: 'normal' }), res)
  assert.equal(res.statusCode, 503)
  assert.equal(providerCalls, 0)
})

test('missing owned project fails before provider spend', async () => {
  let calls = 0
  const handler = createGenerateListingHandler({
    client: clientFor({ userId: 'user-2', project: null }),
    fetchImpl: async () => { calls += 1; return anthropicResponse() },
  })
  const res = responseRecorder()
  await handler(request({ projectId: '22222222-2222-4222-8222-222222222222', style: 'normal' }), res)
  assert.equal(res.statusCode, 404)
  assert.equal(calls, 0)
})

test('invalid style and humor combinations fail before provider spend', async () => {
  let calls = 0
  const handler = createGenerateListingHandler({
    client: clientFor({ userId: 'user-3' }),
    fetchImpl: async () => { calls += 1; return anthropicResponse() },
  })
  const res = responseRecorder()
  await handler(request({ projectId: '11111111-1111-4111-8111-111111111111', style: 'normal', humorLevel: 'unhinged' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(calls, 0)
})

test('released-client payload remains supported and bounded by centralized prompt handling', async () => {
  let providerBody
  const handler = createGenerateListingHandler({
    client: clientFor({ userId: 'user-4' }),
    fetchImpl: async (_url, options) => { providerBody = JSON.parse(options.body); return anthropicResponse('A clean, editable description.') },
  })
  const res = responseRecorder()
  await handler(request({ title: 'Desk', category: 'Furniture', notes: 'Solid wood.', expenses: [{ description: 'Refinished top', amount: 999 }] }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.description, 'A clean, editable description.')
  assert.equal(res.body.listing, 'Desk\n\nA clean, editable description.')
  assert.doesNotMatch(providerBody.messages[0].content, /999|amount/)
  assert.match(providerBody.system, /Normal style/)
})

test('listing facts omit tax, tags, registration, and gas expenses without hiding repairs', async () => {
  let providerBody
  const handler = createGenerateListingHandler({
    client: clientFor({ expenses: [
      { description: 'Sales tax', category: 'fees' },
      { description: 'Tags', category: 'fees' },
      { description: 'Annual registration', category: 'registration' },
      { description: 'Gas', category: 'fuel' },
      { description: 'Gas tank repair', category: 'parts' },
      { description: 'New clutch', category: 'parts' },
    ] }),
    fetchImpl: async (_url, options) => { providerBody = JSON.parse(options.body); return anthropicResponse('Runs and drives.') },
  })
  const res = responseRecorder()
  await handler(request({ projectId: '11111111-1111-4111-8111-111111111111', style: 'normal' }), res)

  assert.equal(res.statusCode, 200)
  const promptFacts = JSON.parse(providerBody.messages[0].content)
  assert.deepEqual(promptFacts.workAndParts, ['Gas tank repair', 'New clutch'])
})

test('released legacy bodies apply the same administrative filter and preserve fuel-system repairs', async () => {
  let providerBody
  const handler = createGenerateListingHandler({
    client: clientFor(),
    fetchImpl: async (_url, options) => { providerBody = JSON.parse(options.body); return anthropicResponse('Runs and drives.') },
  })
  const res = responseRecorder()
  await handler(request({
    title: 'Truck',
    category: 'Vehicles',
    notes: 'Runs and drives.',
    style: 'normal',
    expenses: [
      { description: 'Registration renewal fee', category: 'other' },
      { description: 'DMV Tags!', category: 'fees' },
      { description: 'State Taxes', category: 'fees' },
      { description: 'Fuel refill', category: 'other' },
      { description: 'Sales tax service', category: 'fees' },
      { description: 'Vehicle registration service', category: 'other' },
      { description: 'Gasoline tank fill-up', category: 'gasoline' },
      { description: 'Diesel tank refill', category: 'diesel' },
      { description: 'Gas tank repair', category: 'fuel' },
      { description: 'Fuel pump replacement', category: 'gas' },
      { description: 'Diesel engine rebuilt', category: 'diesel' },
      { description: 'Fuel system overhauled', category: 'fuel' },
    ],
  }), res)

  assert.equal(res.statusCode, 200)
  const promptFacts = JSON.parse(providerBody.messages[0].content)
  assert.deepEqual(promptFacts.workAndParts, [
    'Gas tank repair',
    'Fuel pump replacement',
    'Diesel engine rebuilt',
    'Fuel system overhauled',
  ])
})

test('provider failures return a friendly generic error without leaking provider details', async () => {
  const handler = createGenerateListingHandler({
    client: clientFor({ userId: 'user-5' }),
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: { message: 'sensitive upstream diagnostic' } }) }),
  })
  const res = responseRecorder()
  await handler(request({ projectId: '11111111-1111-4111-8111-111111111111', style: 'professional' }), res)
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.body, { error: "Couldn't generate a description. Try again." })
})

test('truncated or malformed provider output is rejected instead of returned as a successful listing', async () => {
  for (const [index, response] of [
    anthropicResponse('Incomplete sentence', 'max_tokens'),
    { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [] }) },
  ].entries()) {
    const handler = createGenerateListingHandler({
      client: clientFor({ userId: `user-provider-${index}` }),
      fetchImpl: async () => response,
    })
    const res = responseRecorder()
    await handler(request({ projectId: '11111111-1111-4111-8111-111111111111', style: 'normal' }), res)
    assert.equal(res.statusCode, 500)
    assert.deepEqual(res.body, { error: "Couldn't generate a description. Try again." })
  }
})

test('unsupported transaction and paperwork claims are rejected before reaching the seller', async () => {
  let releaseCalls = 0
  const handler = createGenerateListingHandler({
    client: clientFor({
      userId: 'user-grounding-guard',
      onRpc: name => { if (name === 'release_ai_generation_request') releaseCalls += 1 },
    }),
    fetchImpl: async () => anthropicResponse('Runs and drives. Tax, tags, and title are already handled.'),
  })
  const res = responseRecorder()
  await handler(request({ projectId: '11111111-1111-4111-8111-111111111111', style: 'funny', humorLevel: 'balanced' }), res)
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.body, { error: "Couldn't generate a description. Try again." })
  assert.equal(releaseCalls, 1)
})

test('directly supplied transaction and paperwork facts may be repeated', async () => {
  const notes = 'Runs and drives. Seller states tax, tags, and title are already handled.'
  const handler = createGenerateListingHandler({
    client: clientFor({
      userId: 'user-grounding-supported',
      project: { id: '11111111-1111-4111-8111-111111111111', title: '1998 Ford Ranger', category: 'Vehicles', notes },
    }),
    fetchImpl: async () => anthropicResponse(notes),
  })
  const res = responseRecorder()
  await handler(request({ projectId: '11111111-1111-4111-8111-111111111111', style: 'normal' }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.description, notes)
})

test('provider abort errors return a retryable timeout without leaking details', async () => {
  const abortError = new Error('synthetic timeout detail')
  abortError.name = 'AbortError'
  const handler = createGenerateListingHandler({
    client: clientFor({ userId: 'user-timeout' }),
    fetchImpl: async () => { throw abortError },
  })
  const res = responseRecorder()
  await handler(request({ projectId: '11111111-1111-4111-8111-111111111111', style: 'normal' }), res)
  assert.equal(res.statusCode, 504)
  assert.deepEqual(res.body, { error: "Couldn't generate a description. Try again." })
})
