const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function assertClaim(claim) {
  if (!claim || !UUID.test(claim.id) || !UUID.test(claim.user_id) || !UUID.test(claim.item_id) ||
      !UUID.test(claim.lease_token) || typeof claim.worker_id !== 'string') throw new Error('INVALID_DELETION_CLAIM')
  const expected = claim.object_type === 'item' ? `${claim.user_id}/items/${claim.item_id}/` : null
  if (claim.storage_prefix !== expected || claim.bucket_id !== 'my-stuff-media') throw new Error('INVALID_DELETION_PREFIX')
}

async function listDirectory(storage, bucket, directory, pageSize, maxObjects, output, depth, maxDepth, budget) {
  if (depth > maxDepth) throw new Error('STORAGE_TRAVERSAL_DEPTH_EXCEEDED')
  for (let offset = 0; ; offset += pageSize) {
    budget.requests += 1
    if (budget.requests > budget.maxRequests) throw new Error('STORAGE_LIST_REQUEST_LIMIT_EXCEEDED')
    const entries = await storage.list(bucket, directory, { limit: pageSize, offset, sortBy: { column: 'name', order: 'asc' } })
    if (!Array.isArray(entries)) throw new Error('INVALID_STORAGE_LIST_RESPONSE')
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string' || entry.name.includes('/') || entry.name === '.' || entry.name === '..') throw new Error('INVALID_STORAGE_ENTRY')
      const path = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.id == null && entry.metadata == null) await listDirectory(storage, bucket, path, pageSize, maxObjects, output, depth + 1, maxDepth, budget)
      else {
        output.push(path)
        if (output.length > maxObjects) throw new Error('STORAGE_OBJECT_LIMIT_EXCEEDED')
      }
    }
    if (entries.length < pageSize) return
  }
}

export async function listExactPrefix(storage, bucket, prefix, pageSize = 100, maxObjects = 500,
  { maxDepth = 12, maxListRequests = 250, budget = { requests: 0, maxRequests: maxListRequests } } = {}) {
  if (bucket !== 'my-stuff-media' || !/^[0-9a-f-]{36}\/items\/[0-9a-f-]{36}\/$/i.test(prefix) ||
      !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000 || !Number.isInteger(maxObjects) || maxObjects < 1 || maxObjects > 5000 ||
      !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 32 || !Number.isInteger(maxListRequests) || maxListRequests < 1 || maxListRequests > 1000 ||
      !budget || !Number.isInteger(budget.requests) || budget.requests < 0 || !Number.isInteger(budget.maxRequests) || budget.maxRequests !== maxListRequests) throw new Error('INVALID_DELETION_PREFIX')
  const output = []
  await listDirectory(storage, bucket, prefix.slice(0, -1), pageSize, maxObjects, output, 0, maxDepth, budget)
  if (output.some(path => !path.startsWith(prefix))) throw new Error('STORAGE_PREFIX_ESCAPE')
  return output
}

function registerObjects(paths, objectBudget) {
  for (const path of paths) objectBudget.paths.add(path)
  if (objectBudget.paths.size > objectBudget.maxObjects) throw new Error('STORAGE_OBJECT_LIMIT_EXCEEDED')
}

async function deleteAndReadBack({ storage, claim, pageSize, maxObjects, removeBatchSize, maxTraversalDepth, maxListRequests, listBudget, objectBudget, passBudget }) {
  const limits = { maxDepth: maxTraversalDepth, maxListRequests, budget: listBudget }
  const initiallyFound = await listExactPrefix(storage, claim.bucket_id, claim.storage_prefix, pageSize, maxObjects, limits)
  registerObjects(initiallyFound, objectBudget)
  const seen = new Set(initiallyFound)
  let remaining = initiallyFound
  while (remaining.length && passBudget.used < passBudget.maxPasses) {
    passBudget.used += 1
    for (let i = 0; i < remaining.length; i += removeBatchSize) {
      const batch = remaining.slice(i, i + removeBatchSize)
      if (batch.some(path => !path.startsWith(claim.storage_prefix))) throw new Error('STORAGE_PREFIX_ESCAPE')
      await storage.remove(claim.bucket_id, batch)
    }
    remaining = await listExactPrefix(storage, claim.bucket_id, claim.storage_prefix, pageSize, maxObjects, limits)
    registerObjects(remaining, objectBudget)
    for (const path of remaining) seen.add(path)
  }
  const remainingSet = new Set(remaining)
  const deleted = [...seen].filter(path => !remainingSet.has(path)).length
  return { expected: deleted + remaining.length, deleted, remaining: remaining.length }
}

export async function runMaintenanceDeletionBatch({ db, storage, workerId, batchSize = 10, leaseSeconds = 120,
  pageSize = 100, maxObjectsPerClaim = 500, removeBatchSize = 100, maxDeletePasses = 3,
  maxTraversalDepth = 12, maxListRequests = 250 } = {}) {
  if (!db?.claim || !db?.ack || !db?.finalize || !storage?.list || !storage?.remove || typeof workerId !== 'string' || workerId.trim() === '') throw new Error('DELETION_WORKER_NOT_CONFIGURED')
  const claims = await db.claim({ workerId: workerId.trim(), batchSize, leaseSeconds })
  if (!Array.isArray(claims) || claims.length > batchSize) throw new Error('INVALID_DELETION_CLAIMS')
  const results = []
  for (const claim of claims) {
    try {
      assertClaim(claim)
      const listBudget = { requests: 0, maxRequests: maxListRequests }
      const objectBudget = { paths: new Set(), maxObjects: maxObjectsPerClaim }
      const passBudget = { used: 0, maxPasses: maxDeletePasses }
      const cleanup = () => claim.object_type === 'item'
        ? deleteAndReadBack({ storage, claim, pageSize, maxObjects: maxObjectsPerClaim, removeBatchSize, maxTraversalDepth, maxListRequests, listBudget, objectBudget, passBudget })
        : { expected: 0, deleted: 0, remaining: 0 }
      if (claim.phase === 'verifying_storage') {
        const counts = await cleanup()
        const completed = await db.ack({ requestId: claim.id, workerId: claim.worker_id, leaseToken: claim.lease_token, ...counts,
          error: counts.remaining ? 'STORAGE_OBJECTS_REMAIN_AFTER_DATABASE_DELETE' : null })
        results.push({ requestId: claim.id, status: completed?.status || 'failed', ...counts })
        continue
      }
      if (claim.phase === 'deleting_database') {
        const finalized = await db.finalize({ requestId: claim.id, workerId: claim.worker_id, leaseToken: claim.lease_token })
        if (finalized?.status === 'complete') { results.push({ requestId: claim.id, status: 'complete' }); continue }
        if (finalized?.status !== 'verifying_storage') throw new Error(finalized?.error || 'DELETION_FINALIZE_UNCONFIRMED')
        const counts = await cleanup()
        const completed = await db.ack({ requestId: claim.id, workerId: claim.worker_id, leaseToken: claim.lease_token, ...counts,
          error: counts.remaining ? 'STORAGE_OBJECTS_REMAIN_AFTER_DATABASE_DELETE' : null })
        results.push({ requestId: claim.id, status: completed?.status || 'failed', ...counts })
        continue
      }
      const counts = await cleanup()
      const acknowledged = await db.ack({ requestId: claim.id, workerId: claim.worker_id, leaseToken: claim.lease_token, ...counts,
        error: counts.remaining ? 'STORAGE_OBJECTS_REMAIN_AFTER_READBACK' : null })
      if (counts.remaining) { results.push({ requestId: claim.id, status: 'failed', ...counts }); continue }
      if (acknowledged?.status !== 'deleting_database') throw new Error('DELETION_ACK_UNCONFIRMED')
      const finalized = await db.finalize({ requestId: claim.id, workerId: claim.worker_id, leaseToken: claim.lease_token })
      if (finalized?.status === 'verifying_storage') {
        const finalCounts = await cleanup()
        const completed = await db.ack({ requestId: claim.id, workerId: claim.worker_id, leaseToken: claim.lease_token, ...finalCounts,
          error: finalCounts.remaining ? 'STORAGE_OBJECTS_REMAIN_AFTER_DATABASE_DELETE' : null })
        results.push({ requestId: claim.id, status: completed?.status || 'failed', expected: counts.expected + finalCounts.expected,
          deleted: counts.deleted + finalCounts.deleted, remaining: finalCounts.remaining })
      } else {
        if (finalized?.status !== 'complete') throw new Error(finalized?.error || 'DELETION_FINALIZE_UNCONFIRMED')
        results.push({ requestId: claim.id, status: 'complete', ...counts })
      }
    } catch (error) {
      try {
        await db.ack({ requestId: claim?.id, workerId: claim?.worker_id || workerId, leaseToken: claim?.lease_token,
          expected: 0, deleted: 0, remaining: 0, error: error instanceof Error ? error.message : 'DELETION_WORKER_ERROR' })
      } catch { /* stale leases cannot acknowledge another worker's claim */ }
      results.push({ requestId: claim?.id || null, status: 'failed', error: error instanceof Error ? error.message : 'DELETION_WORKER_ERROR' })
    }
  }
  return { claimed: claims.length, results }
}

function unwrap(result, code) {
  if (result?.error) throw Object.assign(new Error(code), { cause: result.error })
  return result?.data
}

export async function runMyStuffDeletionWorker({ supabase, workerId, ...options }) {
  const db = {
    claim: async ({ workerId: id, batchSize, leaseSeconds }) => unwrap(await supabase.rpc('claim_my_stuff_deletions_v4', { p_worker_id: id, p_batch_size: batchSize, p_lease_seconds: leaseSeconds }), 'DELETION_CLAIM_FAILED'),
    ack: async ({ requestId, workerId: id, leaseToken, expected, deleted, remaining, error }) => unwrap(await supabase.rpc('ack_my_stuff_deletion_storage_v4', { p_request_id: requestId, p_worker_id: id, p_lease_token: leaseToken, p_expected: expected, p_deleted: deleted, p_remaining: remaining, p_error: error }), 'DELETION_ACK_FAILED'),
    finalize: async ({ requestId, workerId: id, leaseToken }) => unwrap(await supabase.rpc('finalize_my_stuff_deletion_v4', { p_request_id: requestId, p_worker_id: id, p_lease_token: leaseToken }), 'DELETION_FINALIZE_FAILED'),
  }
  const storage = {
    list: async (bucket, path, listOptions) => unwrap(await supabase.storage.from(bucket).list(path, listOptions), 'STORAGE_LIST_FAILED'),
    remove: async (bucket, paths) => { unwrap(await supabase.storage.from(bucket).remove(paths), 'STORAGE_REMOVE_FAILED') },
  }
  return runMaintenanceDeletionBatch({ db, storage, workerId, ...options })
}
