import test from 'node:test'
import assert from 'node:assert/strict'
import { listExactPrefix, runMaintenanceDeletionBatch } from '../api/_lib/my-stuff-deletion-worker.js'

const userId = '11111111-1111-4111-8111-111111111111'
const itemId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const token = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const prefix = `${userId}/items/${itemId}/`

function memoryStorage(paths, failFirstRemove = false) {
  const objects = new Set(paths)
  let removeCalls = 0
  return {
    objects,
    async list(bucket, directory, { limit, offset }) {
      assert.equal(bucket, 'my-stuff-media')
      const childMap = new Map()
      const start = `${directory}/`
      for (const object of objects) {
        if (!object.startsWith(start)) continue
        const rest = object.slice(start.length)
        const [name, ...tail] = rest.split('/')
        childMap.set(name, tail.length ? { name, id: null, metadata: null } : { name, id: `id-${name}`, metadata: {} })
      }
      return [...childMap.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(offset, offset + limit)
    },
    async remove(bucket, names) {
      assert.equal(bucket, 'my-stuff-media')
      removeCalls += 1
      if (failFirstRemove && removeCalls === 1) throw new Error('temporary storage failure')
      for (const name of names) {
        assert.ok(name.startsWith(prefix), `escaped prefix: ${name}`)
        objects.delete(name)
      }
    },
  }
}

function claim() {
  return { id: requestId, user_id: userId, item_id: itemId, object_type: 'item', worker_id: 'worker-a',
    lease_token: token, bucket_id: 'my-stuff-media', storage_prefix: prefix }
}

test('exact-prefix listing paginates recursively without touching siblings', async () => {
  const sibling = `${userId}/items/dddddddd-dddd-4ddd-8ddd-dddddddddddd/photos/no.jpg`
  const storage = memoryStorage([`${prefix}photos/a.jpg`, `${prefix}photos/b.jpg`, `${prefix}documents/c.pdf`, sibling])
  assert.deepEqual((await listExactPrefix(storage, 'my-stuff-media', prefix, 1)).sort(),
    [`${prefix}documents/c.pdf`, `${prefix}photos/a.jpg`, `${prefix}photos/b.jpg`])
  assert.ok(storage.objects.has(sibling))
})

test('worker deletes, reads back, acknowledges token, and finalizes', async () => {
  const storage = memoryStorage([`${prefix}photos/a.jpg`, `${prefix}photos/b.jpg`])
  const calls = []
  const db = {
    claim: async args => { calls.push(['claim', args]); return [claim()] },
    ack: async args => { calls.push(['ack', args]); return { status: 'deleting_database' } },
    finalize: async args => { calls.push(['finalize', args]); return { status: 'complete' } },
  }
  const result = await runMaintenanceDeletionBatch({ db, storage, workerId: 'worker-a', pageSize: 1, removeBatchSize: 1 })
  assert.equal(result.claimed, 1)
  assert.equal(result.results[0].status, 'complete')
  assert.deepEqual([...storage.objects], [])
  assert.equal(calls[1][1].leaseToken, token)
  assert.deepEqual({ expected: calls[1][1].expected, deleted: calls[1][1].deleted, remaining: calls[1][1].remaining },
    { expected: 2, deleted: 2, remaining: 0 })
})

test('item completion drains an object raced after the first readback', async () => {
  const raced = `${prefix}photos/raced.jpg`
  const storage = memoryStorage([])
  const acks = []
  const db = {
    claim: async () => [{ ...claim(), phase: 'leased' }],
    ack: async args => { acks.push(args); return { status: acks.length === 1 ? 'deleting_database' : 'complete' } },
    finalize: async () => { storage.objects.add(raced); return { status: 'verifying_storage' } },
  }
  const result = await runMaintenanceDeletionBatch({ db, storage, workerId: 'worker-a' })
  assert.equal(result.results[0].status, 'complete')
  assert.equal(storage.objects.size, 0)
  assert.equal(acks.length, 2)
  assert.deepEqual({ expected: acks[1].expected, deleted: acks[1].deleted, remaining: acks[1].remaining },
    { expected: 1, deleted: 1, remaining: 0 })
})

test('reclaimed deleting_database phase resumes at database finalization', async () => {
  const calls = []
  const db = {
    claim: async () => [{ ...claim(), phase: 'deleting_database' }],
    ack: async args => { calls.push(['ack', args]); return { status: 'complete' } },
    finalize: async args => { calls.push(['finalize', args]); return { status: 'verifying_storage' } },
  }
  const result = await runMaintenanceDeletionBatch({ db, storage: memoryStorage([]), workerId: 'worker-b' })
  assert.equal(result.results[0].status, 'complete')
  assert.deepEqual(calls.map(([name]) => name), ['finalize', 'ack'])
})

test('failure is acknowledged and later retry converges', async () => {
  const path = `${prefix}photos/a.jpg`
  const storage = memoryStorage([path], true)
  let attempt = 0
  const acks = []
  const db = {
    claim: async () => attempt++ < 2 ? [claim()] : [],
    ack: async args => { acks.push(args); return args.error ? { status: 'failed' } : { status: 'deleting_database' } },
    finalize: async () => ({ status: 'complete' }),
  }
  const first = await runMaintenanceDeletionBatch({ db, storage, workerId: 'worker-a' })
  assert.equal(first.results[0].status, 'failed')
  assert.ok(storage.objects.has(path))
  const second = await runMaintenanceDeletionBatch({ db, storage, workerId: 'worker-a' })
  assert.equal(second.results[0].status, 'complete')
  assert.equal(storage.objects.size, 0)
  assert.match(acks[0].error, /temporary storage failure/)
})

test('claim prefix must exactly match user and item IDs', async () => {
  const bad = { ...claim(), storage_prefix: `${userId}/items/dddddddd-dddd-4ddd-8ddd-dddddddddddd/` }
  let acked = false
  const result = await runMaintenanceDeletionBatch({
    db: { claim: async () => [bad], ack: async () => { acked = true; return { status: 'failed' } }, finalize: async () => ({}) },
    storage: memoryStorage([]), workerId: 'worker-a',
  })
  assert.equal(result.results[0].status, 'failed')
  assert.match(result.results[0].error, /INVALID_DELETION_PREFIX/)
  assert.equal(acked, true)
})

test('worker bounds total objects before issuing any Storage delete', async () => {
  const storage = memoryStorage([`${prefix}photos/a.jpg`, `${prefix}photos/b.jpg`])
  let acknowledged
  const result = await runMaintenanceDeletionBatch({
    db: {
      claim: async () => [claim()],
      ack: async args => { acknowledged = args; return { status: 'failed' } },
      finalize: async () => { throw new Error('must not finalize overflow') },
    },
    storage,
    workerId: 'worker-a',
    maxObjectsPerClaim: 1,
  })
  assert.equal(result.results[0].status, 'failed')
  assert.match(result.results[0].error, /STORAGE_OBJECT_LIMIT_EXCEEDED/)
  assert.match(acknowledged.error, /STORAGE_OBJECT_LIMIT_EXCEEDED/)
  assert.equal(storage.objects.size, 2)
})

test('worker enforces one cumulative object budget across both storage drains', async () => {
  const currentClaim = claim()
  let listCall = 0
  const removed = []
  const storage = {
    async list() {
      listCall += 1
      if (listCall === 1) return [{ id: 'a', name: 'a.jpg', metadata: {} }]
      if (listCall === 2) return []
      if (listCall === 3) return [{ id: 'b', name: 'b.jpg', metadata: {} }]
      return []
    },
    async remove(_bucket, paths) { removed.push(...paths) },
  }
  const acknowledgements = []
  const db = {
    claim: async () => [currentClaim],
    ack: async args => { acknowledgements.push(args); return { status: args.error ? 'failed' : 'deleting_database' } },
    finalize: async () => ({ status: 'verifying_storage' }),
  }
  const result = await runMaintenanceDeletionBatch({ db, storage, workerId: currentClaim.worker_id, maxObjectsPerClaim: 1, maxDeletePasses: 2 })
  assert.equal(result.results[0].status, 'failed')
  assert.match(result.results[0].error, /STORAGE_OBJECT_LIMIT_EXCEEDED/)
  assert.deepEqual(removed, [`${currentClaim.storage_prefix}a.jpg`])
  assert.equal(acknowledgements.at(-1).error, 'STORAGE_OBJECT_LIMIT_EXCEEDED')
})

test('exact-prefix listing bounds recursive traversal depth', async () => {
  const storage = memoryStorage([`${prefix}a/b/c/d/e.jpg`])
  await assert.rejects(
    listExactPrefix(storage, 'my-stuff-media', prefix, 100, 500, { maxDepth: 2, maxListRequests: 250 }),
    /STORAGE_TRAVERSAL_DEPTH_EXCEEDED/,
  )
})

test('exact-prefix listing bounds total list requests across pagination and recursion', async () => {
  const storage = memoryStorage([`${prefix}a/one.jpg`, `${prefix}b/two.jpg`])
  await assert.rejects(
    listExactPrefix(storage, 'my-stuff-media', prefix, 1, 500, { maxDepth: 12, maxListRequests: 2 }),
    /STORAGE_LIST_REQUEST_LIMIT_EXCEEDED/,
  )
})
