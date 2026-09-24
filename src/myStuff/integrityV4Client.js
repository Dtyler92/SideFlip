const RPC_MISSING_CODES = new Set(['PGRST202'])

function unwrap(result) {
  if (result?.error) throw result.error
  return result?.data
}

export function isIntegrityRolloutRpcMissing(error) {
  const message = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`.toLowerCase()
  return RPC_MISSING_CODES.has(error?.code) || (message.includes('schema cache') && message.includes('could not find') && message.includes('get_my_stuff_integrity_rollout_v4'))
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

    getReport(itemId, limit = 500) {
      return rpc('get_my_stuff_maintenance_report_v4', { p_item_id: itemId, p_limit: limit })
    },

    requestItemDeletion(itemId, mutationId) {
      return rpc('request_my_stuff_deletion_v4', { p_object_type: 'item', p_object_id: itemId, p_mutation_id: mutationId })
    },

    getDeletionStatus(requestId) {
      return rpc('get_my_stuff_deletion_status_v4', { p_request_id: requestId })
    },
  }
}
