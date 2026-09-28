const RPC_MISSING_CODES = new Set(['PGRST202'])

function unwrap(result) {
  if (result?.error) throw result.error
  return result?.data
}

function reportError(message) {
  const error = new Error(message)
  error.code = 'INTEGRITY_REPORT_CURSOR_MISMATCH'
  return error
}

function exportError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle || typeof TextEncoder === 'undefined') throw exportError('INTEGRITY_EXPORT_INVALID', 'Secure export hashing is unavailable.')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function verifyCanonicalExportPage(envelope) {
  if (!envelope || envelope.integrity_status !== 'verified'
    || !/^[0-9a-f]{64}$/.test(String(envelope.canonical_snapshot_sha256 || ''))
    || typeof envelope.canonical_payload_text !== 'string' || !envelope.canonical_payload_text
    || stableJson(Object.keys(envelope).sort()) !== stableJson(['canonical_payload_text','canonical_snapshot_sha256','integrity_status'])) {
    throw exportError('INTEGRITY_EXPORT_INVALID', 'Maintenance integrity export envelope is invalid.')
  }
  const digest = await sha256Hex(envelope.canonical_payload_text)
  if (digest !== envelope.canonical_snapshot_sha256) throw exportError('INTEGRITY_EXPORT_INVALID', 'Maintenance integrity export hash does not match its canonical payload.')
  try {
    const snapshot = JSON.parse(envelope.canonical_payload_text)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('invalid canonical payload')
    return snapshot
  } catch {
    throw exportError('INTEGRITY_EXPORT_INVALID', 'Maintenance integrity export canonical payload is invalid.')
  }
}

export function isIntegrityRolloutRpcMissing(error) {
  const message = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`.toLowerCase()
  return RPC_MISSING_CODES.has(error?.code)
    && message.includes('schema cache')
    && message.includes('could not find')
    && message.includes('get_my_stuff_integrity_rollout_v4')
}

export function createMyStuffIntegrityV4Client(database) {
  const rpc = async (name, payload = {}) => unwrap(await database.rpc(name, payload))
  return {
    async getRollout() {
      const result = await database.rpc('get_my_stuff_integrity_rollout_v4')
      if (result?.error) {
        if (isIntegrityRolloutRpcMissing(result.error)) return { featureEnabled: false, legacyRetired: false, installed: false }
        throw result.error
      }
      if (!result?.data || typeof result.data.feature_enabled !== 'boolean' || typeof result.data.legacy_retired !== 'boolean') throw new Error('Maintenance rollout response is invalid.')
      return { featureEnabled: result.data.feature_enabled, legacyRetired: result.data.legacy_retired, installed: true }
    },

    recordCurrentReading(itemId, axis, value, mutationId) {
      const readingType = axis === 'miles' ? 'mileage' : axis
      return rpc('record_my_stuff_current_reading_v4', {
        p_item_id: itemId,
        p_reading_type: readingType,
        p_current_value: Number(value),
        p_device_now: new Date().toISOString(),
        p_mutation_id: mutationId,
      })
    },

    async getMaintenanceStates(definitions, concurrency = 4) {
      const rows = Array.isArray(definitions) ? definitions : []
      const output = new Array(rows.length)
      let next = 0
      const workers = Array.from({ length: Math.min(Math.max(1, concurrency), rows.length || 1) }, async () => {
        while (next < rows.length) {
          const index = next++
          output[index] = await rpc('get_my_stuff_maintenance_state_v4', { p_definition_id: rows[index].id })
        }
      })
      await Promise.all(workers)
      return output
    },

    setupDefinition(itemId, definition, setup, mutationId) {
      return rpc('setup_my_stuff_maintenance_preset_v4', {
        p_item_id: itemId,
        p_definition: definition,
        p_setup: setup,
        p_device_now: new Date().toISOString(),
        p_mutation_id: mutationId,
      })
    },

    updateDefinition(definitionId, patch, mutationId) {
      return rpc('update_my_stuff_maintenance_definition_v4', {
        p_definition_id: definitionId,
        p_patch: patch,
        p_device_now: new Date().toISOString(),
        p_mutation_id: mutationId,
      })
    },

    completeDefinition(definitionId, completion, mutationId) {
      return rpc('complete_my_stuff_maintenance_v4', {
        p_definition_id: definitionId,
        p_completion: completion,
        p_device_now: new Date().toISOString(),
        p_mutation_id: mutationId,
      })
    },

    editCompletion(entry, patch, reason, mutationId) {
      const withinWindow = !entry.historical_locked_from_window_edit && entry.original?.lock_deadline && Date.now() < new Date(entry.original.lock_deadline).getTime()
      return rpc(withinWindow ? 'edit_my_stuff_completion_v4' : 'correct_my_stuff_completion_v4', {
        p_occurrence_id: entry.occurrence_id,
        p_patch: patch,
        p_reason: reason || null,
        p_expected_revision: entry.latest_correction_number ?? Math.max(0, ...(entry.correction_chain || []).map(row => Number(row.revision_number ?? row.number ?? 0))),
        p_expected_snapshot_hash: entry.effective_snapshot_sha256,
        p_device_now: new Date().toISOString(),
        p_mutation_id: mutationId,
      })
    },

    async getReport(itemId, limit = 500) {
      const completions = []
      const seen = new Set()
      const pageHashes = []
      let first = null
      let cursorTime = null
      let cursorId = null
      for (let pageNumber = 0; pageNumber < 10000; pageNumber += 1) {
        const page = await rpc('get_my_stuff_maintenance_report_v4', {
          p_item_id: itemId,
          p_limit: limit,
          p_after_received_at: cursorTime,
          p_after_occurrence_id: cursorId,
        })
        if (!page || page.integrity_status !== 'verified' || !/^[0-9a-f]{64}$/.test(String(page.snapshot_sha256 || '')) || !page.page || !Array.isArray(page.completions)) {
          throw reportError('Maintenance report page is invalid.')
        }
        const metadata = page.page
        if (!Number.isInteger(metadata.total_count) || !Number.isInteger(metadata.remaining_count) || !Number.isInteger(metadata.returned_count)
          || typeof metadata.complete !== 'boolean' || typeof metadata.truncated !== 'boolean' || metadata.complete === metadata.truncated
          || metadata.returned_count !== page.completions.length || metadata.remaining_count !== metadata.total_count - completions.length - page.completions.length) {
          throw reportError('Maintenance report page counts are inconsistent.')
        }
        if (!first) first = page
        else if (page.schema_version !== first.schema_version
          || page.owner_report_disclaimer !== first.owner_report_disclaimer
          || metadata.total_count !== first.page.total_count
          || stableJson(page.item) !== stableJson(first.item)) {
          throw reportError('Maintenance report changed while pages were loading.')
        }
        for (const entry of page.completions) {
          const occurrenceId = String(entry?.occurrence_id || '')
          if (!occurrenceId || seen.has(occurrenceId)) throw reportError('Maintenance report cursor repeated an occurrence.')
          seen.add(occurrenceId)
          completions.push(entry)
        }
        pageHashes.push(page.snapshot_sha256)
        if (metadata.complete) {
          if (metadata.truncated || completions.length !== metadata.total_count || metadata.remaining_count !== 0
            || metadata.next_after_received_at !== null || metadata.next_after_occurrence_id !== null) {
            throw reportError('Maintenance report ended with inconsistent completeness metadata.')
          }
          return {
            ...first,
            completions,
            page: {
              limit,
              returned_count:completions.length,
              remaining_count:0,
              total_count:metadata.total_count,
              complete:true,
              truncated:false,
              next_after_received_at:null,
              next_after_occurrence_id:null,
              pages_loaded:pageHashes.length,
            },
            page_snapshot_sha256:pageHashes,
            integrity_status:'verified_paginated_pages',
            snapshot_sha256:null,
          }
        }
        const nextTime = metadata.next_after_received_at
        const nextId = metadata.next_after_occurrence_id
        const lastId = page.completions.at(-1)?.occurrence_id
        if (!metadata.truncated || !nextTime || !nextId || nextId !== lastId || (nextTime === cursorTime && nextId === cursorId) || page.completions.length === 0) {
          throw reportError('Maintenance report cursor did not advance consistently.')
        }
        cursorTime = nextTime
        cursorId = nextId
      }
      throw reportError('Maintenance report exceeded the pagination safety bound.')
    },

    async getIntegrityExport(itemId, limit = 25) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw exportError('INTEGRITY_EXPORT_INVALID', 'Maintenance integrity export page limit is invalid.')
      const completions = []
      const occurrenceIds = new Set()
      const cursorTokens = new Set()
      const pageHashes = []
      let cursorToken = null
      let pageLimit = Math.min(limit, 25)
      let first = null
      let correctionReturned = 0
      let attachmentReturned = 0
      for (let pageNumber = 0; pageNumber < 10000; pageNumber += 1) {
        let envelope
        try {
          envelope = await rpc('get_my_stuff_maintenance_integrity_export_v4', { p_item_id:itemId, p_limit:pageLimit, p_cursor_token:cursorToken })
        } catch (error) {
          if (String(error?.message || error).includes('EXPORT_PAGE_TOO_LARGE') && pageLimit > 1) {
            pageLimit = Math.max(1, Math.floor(pageLimit / 2))
            pageNumber -= 1
            continue
          }
          throw error
        }
        const snapshot = await verifyCanonicalExportPage(envelope)
        const page = snapshot?.page
        if (!snapshot || snapshot.schema_version !== 4
          || !snapshot.snapshot_at || !snapshot.item || !Array.isArray(snapshot.completions) || !page) {
          throw exportError('INTEGRITY_EXPORT_INVALID', 'Maintenance integrity export page is invalid.')
        }
        for (const field of ['returned_count','remaining_count','total_count','correction_total','correction_returned','attachment_total','attachment_returned']) {
          if (!Number.isInteger(page[field]) || page[field] < 0) throw exportError('INTEGRITY_EXPORT_INVALID', 'Maintenance integrity export counts are invalid.')
        }
        if (page.returned_count !== snapshot.completions.length || page.remaining_count !== page.total_count - completions.length - snapshot.completions.length) {
          throw exportError('INTEGRITY_EXPORT_INVALID', 'Maintenance integrity export page counts are inconsistent.')
        }
        if (!first) first = snapshot
        else if (snapshot.snapshot_at !== first.snapshot_at || snapshot.owner_report_disclaimer !== first.owner_report_disclaimer
          || stableJson(snapshot.item) !== stableJson(first.item) || page.total_count !== first.page.total_count
          || page.correction_total !== first.page.correction_total || page.attachment_total !== first.page.attachment_total) {
          throw exportError('INTEGRITY_EXPORT_INVALID', 'Maintenance integrity export snapshot changed between pages.')
        }
        let pageCorrections = 0
        let pageAttachments = 0
        for (const entry of snapshot.completions) {
          const occurrenceId = String(entry?.occurrence_id || '')
          if (!occurrenceId || occurrenceIds.has(occurrenceId) || !Array.isArray(entry.correction_chain) || !Array.isArray(entry.attachment_hashes)) {
            throw exportError('INTEGRITY_EXPORT_INVALID', 'Maintenance integrity export contains invalid or repeated records.')
          }
          occurrenceIds.add(occurrenceId)
          completions.push(entry)
          pageCorrections += entry.correction_chain.length
          pageAttachments += entry.attachment_hashes.length
        }
        if (pageCorrections !== page.correction_returned || pageAttachments !== page.attachment_returned) {
          throw exportError('INTEGRITY_EXPORT_INVALID', 'Maintenance integrity export child counts are inconsistent.')
        }
        correctionReturned += pageCorrections
        attachmentReturned += pageAttachments
        pageHashes.push(envelope.canonical_snapshot_sha256)
        if (page.complete) {
          if (page.truncated || page.next_cursor_token || completions.length !== page.total_count
            || correctionReturned !== page.correction_total || attachmentReturned !== page.attachment_total) {
            throw exportError('INTEGRITY_EXPORT_INCOMPLETE', 'Maintenance integrity export did not complete consistently.')
          }
          const result = {
            schema_version:4,
            owner_report_disclaimer:first.owner_report_disclaimer,
            snapshot_at:first.snapshot_at,
            item:first.item,
            completions,
            completeness:{ complete:true, truncated:false, completion_total:page.total_count, completion_returned:completions.length, correction_total:page.correction_total, correction_returned:correctionReturned, attachment_total:page.attachment_total, attachment_returned:attachmentReturned, pages_loaded:pageHashes.length },
            page_snapshot_sha256:pageHashes,
            canonical_hash_scope:'complete ordered signed-cursor export assembled from verified pages except canonical_snapshot_sha256 and integrity_status',
          }
          return { ...result, canonical_snapshot_sha256:await sha256Hex(stableJson(result)), integrity_status:'verified_paginated_pages' }
        }
        const next = page.next_cursor_token
        if (!page.truncated || !next || snapshot.completions.length === 0 || cursorTokens.has(next)) {
          throw exportError('INTEGRITY_EXPORT_INCOMPLETE', 'Maintenance integrity export cursor did not advance.')
        }
        cursorTokens.add(next)
        cursorToken = next
      }
      throw exportError('INTEGRITY_EXPORT_INCOMPLETE', 'Maintenance integrity export exceeded the pagination safety bound.')
    },

    requestItemDeletion(itemId, mutationId) {
      return rpc('request_my_stuff_deletion_v4', { p_object_type: 'item', p_object_id: itemId, p_mutation_id: mutationId })
    },

    getDeletionStatus(requestId) {
      return rpc('get_my_stuff_deletion_status_v4', { p_request_id: requestId })
    },
  }
}
