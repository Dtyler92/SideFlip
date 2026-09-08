function dataOrThrow(result) {
  if (result?.error) throw result.error
  return result?.data
}

/**
 * Supabase wrappers for the V2 maintenance RPC contract.
 *
 * Callers build canonical wire payloads separately so retries can derive and
 * reuse an idempotency key from the payload before invoking these methods.
 */
export function createMyStuffMaintenanceClient(database) {
  const rpc = async (name, payload) => dataOrThrow(await database.rpc(name, payload))

  return {
    async listDefinitions(itemId) {
      const result = await database
        .from('my_stuff_maintenance_definitions')
        .select('*')
        .eq('item_id', itemId)
        .order('created_at', { ascending: true })
      return dataOrThrow(result) || []
    },

    createDefinition(wirePayload, mutationId) {
      return rpc('create_my_stuff_maintenance_definition_v2', {
        ...wirePayload,
        p_mutation_id: mutationId,
      })
    },

    updateDefinition(wirePayload, mutationId) {
      return rpc('update_my_stuff_maintenance_definition_v2', {
        ...wirePayload,
        p_mutation_id: mutationId,
      })
    },

    recordServiceOccurrence(wirePayload, mutationId) {
      return rpc('record_my_stuff_service_occurrence_v2', {
        ...wirePayload,
        p_mutation_id: mutationId,
      })
    },

    async getDueState(itemId, asOf = new Date().toISOString()) {
      return (await rpc('get_my_stuff_due_state_v2', {
        p_item_id: itemId,
        p_as_of: asOf,
      })) || []
    },

    async listServiceHistory(itemId) {
      const [occurrences, revisions] = await Promise.all([
        database.from('my_stuff_service_occurrences').select('*').eq('item_id', itemId).order('completed_at', { ascending: false }),
        database.from('my_stuff_service_occurrence_revisions').select('*').eq('item_id', itemId).order('revision_number', { ascending: false }),
      ])
      const rows = dataOrThrow(occurrences) || []
      const revisionRows = dataOrThrow(revisions) || []
      const byOccurrence = new Map()
      for (const revision of revisionRows) {
        const values = byOccurrence.get(revision.occurrence_id) || []
        values.push(revision)
        byOccurrence.set(revision.occurrence_id, values)
      }
      return rows.map(occurrence => {
        const values = byOccurrence.get(occurrence.id) || []
        return { ...occurrence, latest_revision: values[0] || null, revisions: values }
      })
    },

    async listStatusEvents(itemId) {
      const result = await database
        .from('my_stuff_occurrence_status_events')
        .select('*')
        .eq('item_id', itemId)
        .order('created_at', { ascending: false })
      return dataOrThrow(result) || []
    },
  }
}
