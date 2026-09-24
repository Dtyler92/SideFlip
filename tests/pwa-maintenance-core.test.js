import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCreateMaintenanceDefinitionV2WirePayload,
  buildRecordServiceOccurrenceV2WirePayload,
  buildUpdateMaintenanceDefinitionV2WirePayload,
} from '../src/myStuff/payloads.js'
import { createMyStuffMaintenanceClient } from '../src/myStuff/maintenanceClient.js'
import {
  canCompleteMaintenanceDefinition,
  dueStateLabel,
  filterActiveDueStates,
  getMaintenanceDefinitionAxes,
} from '../src/myStuff/maintenanceModel.js'

function makeRpcDatabase() {
  const calls = []
  return {
    calls,
    database: {
      async rpc(name, payload) {
        calls.push({ name, payload })
        return name === 'get_my_stuff_due_state_v2'
          ? { data: [{ definition_id: 'definition-1', due_status: 'upcoming' }], error: null }
          : { data: `${name}-result`, error: null }
      },
    },
  }
}

test('maintenance payloads normalize definitions without writable provenance', () => {
  assert.deepEqual(buildCreateMaintenanceDefinitionV2WirePayload({
    itemId: 'item-1',
    name: '  Oil and annual service  ',
    description: '  Keep records  ',
    dueSemantics: 'whichever_first',
    activeProfile: 'normal',
    calendarMonths: '12',
    intervals: { miles: '5000', hours: '', cycles: null },
    provenanceType: 'manual',
  }), {
    p_item_id: 'item-1',
    p_definition: {
      name: 'Oil and annual service', description: 'Keep records', service_category: 'other',
      service_action: 'service', due_semantics: 'whichever_first', active_profile: 'normal',
      cadence_anchor: 'last_completion', normal_interval_miles: 5000, normal_calendar_months: 12,
      enabled: true,
    },
  })

  assert.deepEqual(buildUpdateMaintenanceDefinitionV2WirePayload({
    definitionId: 'definition-1', name: ' Archived ', intervals: {}, calendarMonths: null, enabled: false,
  }), {
    p_definition_id: 'definition-1',
    p_definition: {
      name: 'Archived', normal_interval_miles: null, normal_interval_hours: null,
      normal_interval_cycles: null, normal_calendar_months: null, enabled: false,
    },
  })
})

test('service occurrence payload emits only configured finite readings', () => {
  assert.deepEqual(buildRecordServiceOccurrenceV2WirePayload({
    itemId: 'item-1', definitionId: 'definition-1', completedAt: '2026-09-03T12:00:00.000Z',
    readings: { miles: '1234', hours: '', cycles: 999 }, configuredAxes: ['miles'], notes: '  Changed oil  ',
  }), {
    p_item_id: 'item-1', p_definition_id: 'definition-1',
    p_service: { completed_at: '2026-09-03T12:00:00.000Z', mileage: 1234, notes: 'Changed oil' },
  })
})

test('maintenance client uses exact V2 Supabase RPC contracts', async () => {
  const { database, calls } = makeRpcDatabase()
  const api = createMyStuffMaintenanceClient(database)
  const createWire = { p_item_id: 'item-1', p_definition: { name: 'Oil' } }
  const updateWire = { p_definition_id: 'definition-1', p_definition: { enabled: false } }
  const serviceWire = { p_item_id: 'item-1', p_definition_id: 'definition-1', p_service: { completed_at: '2026-09-03' } }

  await api.createDefinition(createWire, 'create-key')
  await api.updateDefinition(updateWire, 'update-key')
  await api.recordServiceOccurrence(serviceWire, 'service-key')
  const due = await api.getDueState('item-1', '2026-09-04T00:00:00.000Z')

  assert.deepEqual(calls, [
    { name: 'create_my_stuff_maintenance_definition_v2', payload: { ...createWire, p_mutation_id: 'create-key' } },
    { name: 'update_my_stuff_maintenance_definition_v2', payload: { ...updateWire, p_mutation_id: 'update-key' } },
    { name: 'record_my_stuff_service_occurrence_v2', payload: { ...serviceWire, p_mutation_id: 'service-key' } },
    { name: 'get_my_stuff_due_state_v2', payload: { p_item_id: 'item-1', p_as_of: '2026-09-04T00:00:00.000Z' } },
  ])
  assert.deepEqual(due, [{ definition_id: 'definition-1', due_status: 'upcoming' }])
})

test('maintenance client surfaces Supabase errors and normalizes empty due state', async () => {
  const expected = Object.assign(new Error('denied'), { code: '42501' })
  const failing = createMyStuffMaintenanceClient({ rpc: async () => ({ data: null, error: expected }) })
  await assert.rejects(() => failing.createDefinition({}, 'key'), error => error === expected)
  const empty = createMyStuffMaintenanceClient({ rpc: async () => ({ data: null, error: null }) })
  assert.deepEqual(await empty.getDueState('item-1', '2026-09-04T00:00:00.000Z'), [])
})

test('maintenance model derives active axes, completion eligibility and labels', () => {
  const definition = { enabled: true, normal_interval_miles: 5000, severe_interval_hours: 100, first_calendar_months: 12 }
  assert.deepEqual(getMaintenanceDefinitionAxes(definition), ['miles', 'hours', 'calendar'])
  assert.equal(canCompleteMaintenanceDefinition(definition, { measurements: ['miles', 'hours'] }), true)
  assert.equal(canCompleteMaintenanceDefinition(definition, { measurements: ['miles'] }), false)
  assert.equal(canCompleteMaintenanceDefinition({ normal_calendar_months: 12 }, { measurements: [] }), true)
  assert.equal(dueStateLabel('overdue'), 'Overdue')
  assert.equal(dueStateLabel('due'), 'Due now')
  assert.equal(dueStateLabel('upcoming'), 'Upcoming')
  assert.equal(dueStateLabel('unknown'), 'Not calculated')
})

test('due-state filtering excludes stale, missing-usage and invalid rows', () => {
  const dueStates = [
    { definition_id: 'miles', due_status: 'due_soon', next_due_mileage: 5000 },
    { definition_id: 'hours', due_status: 'due_now', next_due_hours: 100 },
    { definition_id: 'unknown', due_status: 'needs_usage_update', next_due_mileage: 2000 },
    { definition_id: 'calendar', due_status: 'upcoming', next_due_at: '2027-09-03T00:00:00.000Z' },
    { definition_id: 'empty', due_status: 'overdue' },
  ]
  const item = { measurements: ['miles'], currentUsage: { miles: 1000 } }
  assert.deepEqual(filterActiveDueStates(dueStates, item).map(row => row.definition_id), ['miles', 'calendar'])
  assert.deepEqual(filterActiveDueStates(null, item), [])
})
