import test from 'node:test'
import assert from 'node:assert/strict'
import { createMyStuffIntegrityV4Client } from '../src/myStuff/integrityV4Client.js'

function mockDatabase(handler) {
  return { rpc: async (name, payload) => handler(name, payload) }
}

test('rollout falls back only when the capability RPC is absent', async () => {
  const missing = createMyStuffIntegrityV4Client(mockDatabase(async () => ({ error:{ code:'PGRST202', message:'Could not find get_my_stuff_integrity_rollout_v4 in the schema cache' } })))
  assert.deepEqual(await missing.getRollout(), { featureEnabled:false, legacyRetired:false, installed:false })

  const denied = createMyStuffIntegrityV4Client(mockDatabase(async () => ({ error:{ code:'42501', message:'permission denied' } })))
  await assert.rejects(denied.getRollout(), error => error?.code === '42501' && error?.message === 'permission denied')

  const internalUndefinedFunction = createMyStuffIntegrityV4Client(mockDatabase(async () => ({ error:{ code:'42883', message:'operator does not exist inside rollout RPC' } })))
  await assert.rejects(internalUndefinedFunction.getRollout(), error => error?.code === '42883')

  const malformed = createMyStuffIntegrityV4Client(mockDatabase(async () => ({ data:{ feature_enabled:'false', legacy_retired:false } })))
  await assert.rejects(malformed.getRollout(), /response is invalid/)
})

test('V4 current readings map UI miles and retain the supplied mutation key', async () => {
  const calls = []
  const client = createMyStuffIntegrityV4Client(mockDatabase(async (name, payload) => { calls.push({ name, payload }); return { data:{ ok:true } } }))
  await client.recordCurrentReading('item-1', 'miles', '1234', 'stable-key')
  assert.equal(calls[0].name, 'record_my_stuff_current_reading_v4')
  assert.equal(calls[0].payload.p_reading_type, 'mileage')
  assert.equal(calls[0].payload.p_current_value, 1234)
  assert.equal(calls[0].payload.p_mutation_id, 'stable-key')
  assert.match(calls[0].payload.p_device_now, /^\d{4}-\d{2}-\d{2}T/)
})

test('V4 state reads use bounded fan-out', async () => {
  let active = 0
  let maximum = 0
  const client = createMyStuffIntegrityV4Client(mockDatabase(async (name, payload) => {
    assert.equal(name, 'get_my_stuff_maintenance_state_v4')
    active += 1; maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 2))
    active -= 1
    return { data:{ definition_id:payload.p_definition_id } }
  }))
  const rows = await client.getMaintenanceStates(Array.from({ length:11 }, (_, index) => ({ id:`d-${index}` })), 3)
  assert.equal(rows.length, 11)
  assert.ok(maximum <= 3)
})

test('V4 setup, completion, correction, report, and deletion payloads are explicit', async () => {
  const calls = []
  const client = createMyStuffIntegrityV4Client(mockDatabase(async (name, payload) => {
    calls.push({ name, payload })
    if (name === 'request_my_stuff_deletion_v4') return { data:{ id:'request-1' } }
    return { data:{} }
  }))
  await client.setupDefinition('item-1', { name:'Oil', service_action:'service' }, { current_mileage:500 }, 'setup-key')
  await client.completeDefinition('definition-1', { service_performed_on:'2026-09-24', service_mileage:450, current_mileage:500 }, 'completion-key')
  await client.editCompletion({ occurrence_id:'occurrence-1', correction_chain:[{ revision_number:1 }, { revision_number:2 }], effective_snapshot_sha256:'hash' }, { notes:'fixed' }, 'reason', 'correction-key')
  await client.getReport('item-1')
  await client.requestItemDeletion('item-1', 'delete-key')
  await client.getDeletionStatus('request-1')
  assert.deepEqual(calls.map(call => call.name), [
    'setup_my_stuff_maintenance_preset_v4', 'complete_my_stuff_maintenance_v4', 'correct_my_stuff_completion_v4',
    'get_my_stuff_maintenance_report_v4', 'request_my_stuff_deletion_v4', 'get_my_stuff_deletion_status_v4',
  ])
  assert.equal(calls[0].payload.p_mutation_id, 'setup-key')
  assert.equal(calls[1].payload.p_completion.current_mileage, 500)
  assert.equal(calls[2].payload.p_expected_revision, 2)
  assert.deepEqual(calls[4].payload, { p_object_type:'item', p_object_id:'item-1', p_mutation_id:'delete-key' })
})
