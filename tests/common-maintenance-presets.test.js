import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  COMMON_MAINTENANCE_DISCLAIMER,
  COMMON_MAINTENANCE_PRESETS,
  activeDefinitionMatchesPreset,
  buildCommonMaintenanceDraft,
  normalizeMaintenanceIdentity,
} from '../src/myStuff/commonMaintenancePresets.js'
import { addCommonMaintenancePresets, archiveMaintenanceDefinition } from '../src/myStuff/commonMaintenancePresetWorkflow.js'
import { normalizeDueSemantics } from '../src/myStuff/maintenanceModel.js'
import { buildUpdateMaintenanceDefinitionV2WirePayload } from '../src/myStuff/payloads.js'

const source = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

function sourceFiles(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : [path]
  }).filter(path => /\.(?:js|jsx|css)$/.test(path))
}

test('common vehicle presets match the frozen iOS contract exactly and in order', () => {
  assert.equal(COMMON_MAINTENANCE_DISCLAIMER, 'Common starting points — check your owner’s manual.')
  assert.deepEqual(COMMON_MAINTENANCE_PRESETS, [
    { id:'oil-filter', name:'Oil and filter change', catalogAction:'replace', persistedAction:'service', miles:5000, months:6 },
    { id:'tire-rotation', name:'Tire rotation', catalogAction:'rotate', persistedAction:'service', miles:5000, months:6 },
    { id:'brake-inspection', name:'Brake inspection', catalogAction:'inspect', persistedAction:'inspect', miles:10000, months:12 },
    { id:'brake-fluid', name:'Brake fluid service', catalogAction:'replace', persistedAction:'service', miles:null, months:24 },
    { id:'transmission-fluid', name:'Transmission fluid service', catalogAction:'replace', persistedAction:'service', miles:60000, months:48 },
    { id:'coolant', name:'Coolant service', catalogAction:'replace', persistedAction:'service', miles:60000, months:60 },
    { id:'engine-air-filter', name:'Engine air filter', catalogAction:'replace', persistedAction:'service', miles:30000, months:36 },
    { id:'cabin-air-filter', name:'Cabin air filter', catalogAction:'replace', persistedAction:'service', miles:15000, months:12 },
    { id:'spark-plugs', name:'Spark plugs', catalogAction:'replace', persistedAction:'service', miles:60000, months:60 },
    { id:'battery-inspection', name:'Battery inspection', catalogAction:'inspect', persistedAction:'inspect', miles:null, months:12 },
    { id:'timing-belt-chain-inspection', name:'Timing belt/chain inspection', catalogAction:'inspect', persistedAction:'inspect', miles:60000, months:60 },
  ])
})

test('preset drafts are generic, editable V2 definitions with exact whichever-first defaults', () => {
  const preset = COMMON_MAINTENANCE_PRESETS[0]
  assert.deepEqual(buildCommonMaintenanceDraft(preset, { measurements:['miles'], usage_profile:'severe' }), {
    name:'Oil and filter change',
    description:'Common starting point only; edit it for this vehicle and check your owner’s manual.',
    serviceAction:'service',
    dueSemantics:'whichever_first',
    activeProfile:'severe',
    cadenceAnchor:'last_completion',
    intervals:{ miles:5000, hours:null, cycles:null },
    calendarMonths:6,
  })
  assert.equal(buildCommonMaintenanceDraft(preset, { measurements:[] }).intervals.miles, null)
  assert.equal(normalizeDueSemantics('all'), 'all')
  assert.equal(normalizeDueSemantics('whichever_first'), 'whichever_first')
  assert.equal(normalizeDueSemantics('unexpected'), 'whichever_first')
  assert.deepEqual(buildUpdateMaintenanceDefinitionV2WirePayload({ definitionId:'definition-1', dueSemantics:'all' }), {
    p_definition_id:'definition-1', p_definition:{ due_semantics:'all' },
  })
})

test('duplicate matching is normalized, skips only enabled definitions, and permits archived re-add', () => {
  const preset = COMMON_MAINTENANCE_PRESETS[0]
  assert.equal(normalizeMaintenanceIdentity('  Oil & FILTER— '), 'oil and filter')
  assert.equal(activeDefinitionMatchesPreset({ name:' Oil & Filter Change ', service_action:'SERVICE', enabled:true }, preset), true)
  assert.equal(activeDefinitionMatchesPreset({ name:'Oil and filter change', service_action:'service', enabled:false }, preset), false)
  assert.equal(activeDefinitionMatchesPreset({ name:'Oil and filter change', service_action:'service', enabled:false, archived_at:'2026-09-01' }, preset), false)
  assert.equal(activeDefinitionMatchesPreset({ name:'Oil and filter change', service_action:'inspect', enabled:true }, preset), false)
})

test('preset workflow skips active duplicates and reconciles ambiguous creates by authoritative reread', async () => {
  const oil = COMMON_MAINTENANCE_PRESETS[0]
  const tires = COMMON_MAINTENANCE_PRESETS[1]
  let definitions = [
    { id:'active-oil', name:'Oil & filter change', service_action:'service', enabled:true },
    { id:'archived-tires', name:'Tire rotation', service_action:'service', enabled:false },
  ]
  const events = []
  const confirmed = []
  const result = await addCommonMaintenancePresets({
    presets:[oil, tires],
    readDefinitions:async () => { events.push('read'); return structuredClone(definitions) },
    mutationIdForPreset:preset => `${preset.id}-stable`,
    createDefinition:async (preset, mutationId) => {
      events.push(['create', preset.id, mutationId])
      definitions.push({ id:'created-tires', name:preset.name, service_action:preset.persistedAction, enabled:true })
      throw new Error('response lost')
    },
    onConfirmed:preset => confirmed.push(preset.id),
  })
  assert.deepEqual(result, { created:['tire-rotation'], skipped:['oil-filter'] })
  assert.deepEqual(events, ['read', ['create', 'tire-rotation', 'tire-rotation-stable'], 'read'])
  assert.deepEqual(confirmed, ['oil-filter', 'tire-rotation'])

  let calls = 0
  await assert.rejects(() => addCommonMaintenancePresets({
    presets:[tires],
    readDefinitions:async () => [],
    mutationIdForPreset:() => 'same-id-after-real-failure',
    createDefinition:async (_preset, mutationId) => {
      calls += 1
      assert.equal(mutationId, 'same-id-after-real-failure')
      throw new Error('not saved')
    },
  }), /not saved/)
  assert.equal(calls, 1)

  let archiveDefinitions = [{ id:'definition-1', name:'Oil and filter change', enabled:true }]
  const archiveEvents = []
  await archiveMaintenanceDefinition({
    definitionId:'definition-1', mutationId:'archive-stable',
    updateDefinition:async (wire, mutationId) => {
      archiveEvents.push(['update', wire, mutationId])
      archiveDefinitions = archiveDefinitions.map(value => value.id === 'definition-1' ? { ...value, enabled:false } : value)
      throw new Error('response lost')
    },
    readDefinitions:async () => { archiveEvents.push('read'); return structuredClone(archiveDefinitions) },
  })
  assert.deepEqual(archiveEvents, [
    ['update', { p_definition_id:'definition-1', p_definition:{ enabled:false } }, 'archive-stable'],
    'read',
  ])
  await assert.rejects(() => archiveMaintenanceDefinition({
    definitionId:'missing', mutationId:'archive-stable',
    updateDefinition:async () => {}, readDefinitions:async () => archiveDefinitions,
  }), /not found after archiving/i)
})

test('reachable PWA replaces paid maintenance research with vehicle-only selectable presets and keeps VIN decode', () => {
  const combined = sourceFiles(new URL('../src', import.meta.url).pathname).map(path => readFileSync(path, 'utf8')).join('\n')
  for (const forbidden of [
    /ManufacturerMaintenanceResearch/,
    /maintenanceResearchClient/,
    /maintenanceResearchModel/,
    /enqueue_my_stuff_research/i,
    /get_my_stuff_research/i,
    /approve_my_stuff_research/i,
    /apply_my_stuff_research/i,
    /cancel_my_stuff_research/i,
    /Research manufacturer schedule/i,
    /my_stuff_research_(?:started|completed|failed)/i,
  ]) assert.doesNotMatch(combined, forbidden)

  const maintenance = source('src/components/MyStuffMaintenancePanel.jsx')
  const detail = source('src/pages/MyStuffDetail.jsx')
  const vin = source('src/components/MyStuffVinDecodePanel.jsx')
  assert.match(maintenance, /supportsVinDecoder\(item\.itemType\)/)
  assert.match(maintenance, /Common maintenance schedules/)
  assert.match(maintenance, /COMMON_MAINTENANCE_DISCLAIMER/)
  assert.match(maintenance, /Add selected/)
  assert.match(maintenance, /Add this schedule/)
  assert.match(maintenance, /Whichever first/)
  assert.match(maintenance, /All intervals/)
  assert.match(maintenance, /Archive this maintenance task\?/)
  assert.match(maintenance, /It will stop affecting due status\. Its service history stays visible\./)
  assert.match(maintenance, /These generic presets are not vehicle-specific recommendations\. Select several or add one, then edit the saved intervals below\./)
  assert.match(detail, /MyStuffVinDecodePanel/)
  assert.match(vin, /\/api\/decode-vin/)
  assert.match(vin, /full VIN is sent to NHTSA/i)
})
