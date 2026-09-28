import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createMyStuffIntegrityV4Client } from '../src/myStuff/integrityV4Client.js'
import { createMaintenanceLoadGate } from '../src/myStuff/maintenanceClient.js'

function mockDatabase(handler) {
  return { rpc: async (name, payload) => handler(name, payload) }
}

function verifiedExportPage(payload) {
  const canonicalPayloadText = JSON.stringify(payload)
  return {
    canonical_payload_text:canonicalPayloadText,
    canonical_snapshot_sha256:createHash('sha256').update(canonicalPayloadText).digest('hex'),
    integrity_status:'verified',
  }
}

test('rollout falls back only when the capability RPC is absent', async () => {
  const missing = createMyStuffIntegrityV4Client(mockDatabase(async () => ({ error:{ code:'PGRST202', message:'Could not find get_my_stuff_integrity_rollout_v4 in the schema cache' } })))
  assert.deepEqual(await missing.getRollout(), { featureEnabled:false, legacyRetired:false, installed:false })

  const denied = createMyStuffIntegrityV4Client(mockDatabase(async () => ({ error:{ code:'42501', message:'permission denied' } })))
  await assert.rejects(denied.getRollout(), error => error?.code === '42501' && error?.message === 'permission denied')

  const internalUndefinedFunction = createMyStuffIntegrityV4Client(mockDatabase(async () => ({ error:{ code:'42883', message:'operator does not exist inside rollout RPC' } })))
  await assert.rejects(internalUndefinedFunction.getRollout(), error => error?.code === '42883')

  const codeWithoutEvidence = createMyStuffIntegrityV4Client(mockDatabase(async () => ({ error:{ code:'PGRST202', message:'Unrelated API error' } })))
  await assert.rejects(codeWithoutEvidence.getRollout(), error => error?.code === 'PGRST202')

  const evidenceWithoutCode = createMyStuffIntegrityV4Client(mockDatabase(async () => ({ error:{ code:'42501', message:'Could not find get_my_stuff_integrity_rollout_v4 in the schema cache' } })))
  await assert.rejects(evidenceWithoutCode.getRollout(), error => error?.code === '42501')

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

test('V4 setup, definition edit, completion, correction, export, and deletion payloads are explicit', async () => {
  const calls = []
  const client = createMyStuffIntegrityV4Client(mockDatabase(async (name, payload) => {
    calls.push({ name, payload })
    if (name === 'request_my_stuff_deletion_v4') return { data:{ id:'request-1' } }
    if (name === 'get_my_stuff_maintenance_integrity_export_v4') return { data:verifiedExportPage({
      schema_version:4, owner_report_disclaimer:'Owner records', item:{ item_id:'item-1' }, completions:[],
      snapshot_at:'2026-09-28T00:00:00Z', page:{ complete:true, truncated:false, returned_count:0, remaining_count:0, total_count:0, correction_total:0, correction_returned:0, attachment_total:0, attachment_returned:0, next_cursor_token:null },
    }) }
    return { data:{} }
  }))
  await client.setupDefinition('item-1', { name:'Oil', service_action:'service' }, { anchor_mode:'known', current_mileage:500, current_hours:25, current_cycles:3 }, 'setup-key')
  await client.updateDefinition('definition-1', { name:'Oil service' }, 'edit-key')
  await client.completeDefinition('definition-1', { service_performed_on:'2026-09-24', service_mileage:450, current_mileage:500 }, 'completion-key')
  await client.editCompletion({ occurrence_id:'occurrence-1', correction_chain:[{ revision_number:1 }, { revision_number:2 }], effective_snapshot_sha256:'hash' }, { notes:'fixed' }, 'reason', 'correction-key')
  await client.getIntegrityExport('item-1')
  await client.requestItemDeletion('item-1', 'delete-key')
  await client.getDeletionStatus('request-1')
  assert.deepEqual(calls.map(call => call.name), [
    'setup_my_stuff_maintenance_preset_v4', 'update_my_stuff_maintenance_definition_v4', 'complete_my_stuff_maintenance_v4', 'correct_my_stuff_completion_v4',
    'get_my_stuff_maintenance_integrity_export_v4', 'request_my_stuff_deletion_v4', 'get_my_stuff_deletion_status_v4',
  ])
  assert.equal(calls[0].payload.p_mutation_id, 'setup-key')
  assert.equal(calls[0].payload.p_setup.anchor_mode, 'known')
  assert.equal(calls[0].payload.p_setup.current_hours, 25)
  assert.equal(calls[1].payload.p_definition_id, 'definition-1')
  assert.deepEqual(calls[1].payload.p_patch, { name:'Oil service' })
  assert.equal(calls[2].payload.p_completion.current_mileage, 500)
  assert.equal(calls[3].payload.p_expected_revision, 2)
  assert.deepEqual(calls[5].payload, { p_object_type:'item', p_object_id:'item-1', p_mutation_id:'delete-key' })
})

test('integrity export follows signed cursors and fails closed on malformed, tampered, or stalled pages', async () => {
  const payloadBody = {
    schema_version:4, owner_report_disclaimer:'Owner records', snapshot_at:'2026-09-28T00:00:00Z', item:{ item_id:'item-1' }, completions:[{ occurrence_id:'o-2', correction_chain:[], attachment_hashes:[] }],
    page:{ complete:false, truncated:true, returned_count:1, remaining_count:1, total_count:2, correction_total:0, correction_returned:0, attachment_total:0, attachment_returned:0, next_cursor_token:'signed-next' },
  }
  const payload = verifiedExportPage(payloadBody)
  const pages = [payload, verifiedExportPage({ ...payloadBody, completions:[{ occurrence_id:'o-1', correction_chain:[], attachment_hashes:[] }], page:{ ...payloadBody.page, complete:true, truncated:false, remaining_count:0, next_cursor_token:null } })]
  const calls = []
  const complete = createMyStuffIntegrityV4Client(mockDatabase(async (name, request) => { calls.push(request); return { data:pages.shift() } }))
  const report = await complete.getIntegrityExport('item-1', 1)
  assert.deepEqual(report.completions.map(row => row.occurrence_id), ['o-2','o-1'])
  assert.equal(report.completeness.complete, true)
  assert.equal(report.completeness.completion_returned, 2)
  assert.equal(calls[1].p_cursor_token, 'signed-next')
  const incomplete = createMyStuffIntegrityV4Client(mockDatabase(async () => ({ data:verifiedExportPage({ ...payloadBody, page:{ ...payloadBody.page, next_cursor_token:null } }) })))
  await assert.rejects(incomplete.getIntegrityExport('item-1'), error => error.code === 'INTEGRITY_EXPORT_INCOMPLETE')
  const malformed = createMyStuffIntegrityV4Client(mockDatabase(async () => ({ data:{ ...payload, canonical_snapshot_sha256:'not-a-hash' } })))
  await assert.rejects(malformed.getIntegrityExport('item-1'), error => error.code === 'INTEGRITY_EXPORT_INVALID')
  const wrongValidHash = createMyStuffIntegrityV4Client(mockDatabase(async () => ({ data:{ ...payload, canonical_snapshot_sha256:'f'.repeat(64) } })))
  await assert.rejects(wrongValidHash.getIntegrityExport('item-1'), error => error.code === 'INTEGRITY_EXPORT_INVALID')
  const tamperedContent = createMyStuffIntegrityV4Client(mockDatabase(async () => ({ data:{ ...payload, canonical_payload_text:payload.canonical_payload_text.replace('Owner records', 'Tampered owner record') } })))
  await assert.rejects(tamperedContent.getIntegrityExport('item-1'), error => error.code === 'INTEGRITY_EXPORT_INVALID')
})

test('integrity export backs page size down when the server rejects an oversized canonical page', async () => {
  const requests = []
  const page = verifiedExportPage({ schema_version:4, owner_report_disclaimer:'Owner records', snapshot_at:'2026-09-28T00:00:00Z', item:{ item_id:'item-1' }, completions:[], page:{ complete:true, truncated:false, returned_count:0, remaining_count:0, total_count:0, correction_total:0, correction_returned:0, attachment_total:0, attachment_returned:0, next_cursor_token:null } })
  const client = createMyStuffIntegrityV4Client(mockDatabase(async (name, request) => {
    requests.push(request.p_limit)
    if (requests.length === 1) return { error:{ message:'EXPORT_PAGE_TOO_LARGE' } }
    return { data:page }
  }))
  await client.getIntegrityExport('item-1', 50)
  assert.deepEqual(requests, [25, 12])
})

test('maintenance load gate rejects reverse-order stale rollout responses', () => {
  const gate = createMaintenanceLoadGate()
  const legacy = gate.begin('item-1:false:false')
  const current = gate.begin('item-1:true:true')
  const committed = []
  const settle = (request, value) => { if (gate.isCurrent(request)) committed.push(value) }
  settle(current, 'v4')
  settle(legacy, 'legacy')
  assert.deepEqual(committed, ['v4'])
  gate.invalidate()
  assert.equal(gate.isCurrent(current), false)
})

test('V4 report loading follows first, middle, and final cursors and rejects malformed metadata', async () => {
  const pages = [
    { schema_version:4, owner_report_disclaimer:'Owner records', item:{ item_id:'item-1' }, completions:[{ occurrence_id:'o-3' }], page:{ limit:1, returned_count:1, remaining_count:2, total_count:3, complete:false, truncated:true, next_after_received_at:'2026-09-03T00:00:00Z', next_after_occurrence_id:'o-3' }, snapshot_sha256:'a'.repeat(64), integrity_status:'verified' },
    { schema_version:4, owner_report_disclaimer:'Owner records', item:{ item_id:'item-1' }, completions:[{ occurrence_id:'o-2' }], page:{ limit:1, returned_count:1, remaining_count:1, total_count:3, complete:false, truncated:true, next_after_received_at:'2026-09-02T00:00:00Z', next_after_occurrence_id:'o-2' }, snapshot_sha256:'b'.repeat(64), integrity_status:'verified' },
    { schema_version:4, owner_report_disclaimer:'Owner records', item:{ item_id:'item-1' }, completions:[{ occurrence_id:'o-1' }], page:{ limit:1, returned_count:1, remaining_count:0, total_count:3, complete:true, truncated:false, next_after_received_at:null, next_after_occurrence_id:null }, snapshot_sha256:'c'.repeat(64), integrity_status:'verified' },
  ]
  const calls = []
  const client = createMyStuffIntegrityV4Client(mockDatabase(async (name, payload) => {
    calls.push({ name, payload })
    return { data:pages.shift() }
  }))
  const report = await client.getReport('item-1', 1)
  assert.deepEqual(report.completions.map(entry => entry.occurrence_id), ['o-3','o-2','o-1'])
  assert.equal(report.page.complete, true)
  assert.equal(report.page.pages_loaded, 3)
  assert.equal(report.integrity_status, 'verified_paginated_pages')
  assert.deepEqual(calls[1].payload, { p_item_id:'item-1', p_limit:1, p_after_received_at:'2026-09-03T00:00:00Z', p_after_occurrence_id:'o-3' })
  assert.deepEqual(calls[2].payload, { p_item_id:'item-1', p_limit:1, p_after_received_at:'2026-09-02T00:00:00Z', p_after_occurrence_id:'o-2' })

  const malformedPages = [
    { limit:1, returned_count:1, remaining_count:1, total_count:2, truncated:true, next_after_received_at:'2026-09-01T00:00:00Z', next_after_occurrence_id:'o-1' },
    { limit:1, returned_count:1, remaining_count:1, total_count:2, complete:false, truncated:false, next_after_received_at:'2026-09-01T00:00:00Z', next_after_occurrence_id:'o-1' },
    { limit:1, returned_count:1, remaining_count:0, total_count:1, complete:true, truncated:false, next_after_received_at:'2026-09-01T00:00:00Z', next_after_occurrence_id:'o-1' },
  ]
  for (const page of malformedPages) {
    const malformed = createMyStuffIntegrityV4Client(mockDatabase(async () => ({ data:{
      schema_version:4, owner_report_disclaimer:'Owner records', item:{ item_id:'item-1' }, completions:[{ occurrence_id:'o-1' }],
      page, snapshot_sha256:'d'.repeat(64), integrity_status:'verified',
    } })))
    await assert.rejects(malformed.getReport('item-1', 1), error => error.code === 'INTEGRITY_REPORT_CURSOR_MISMATCH')
  }
})
