import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabase.js'
import {
  getMyStuffDueViewsV3,
  listMyStuffScheduleGroupsV3,
  recordMyStuffServiceWithExpenseV3,
  setMyStuffOccurrenceStatusV3,
} from '../myStuff/api.js'
import { createMaintenanceLoadGate, createMyStuffMaintenanceClient } from '../myStuff/maintenanceClient.js'
import { createMyStuffIntegrityV4Client } from '../myStuff/integrityV4Client.js'
import { getMaintenanceDefinitionAxes } from '../myStuff/maintenanceModel.js'
import { buildCreateMaintenanceDefinitionV2WirePayload, buildUpdateMaintenanceDefinitionV2WirePayload } from '../myStuff/payloads.js'
import {
  buildServiceExpenseRequest,
  buildServicePayload,
  classifyDueOccurrences,
  normalizePlannedOccurrences,
  serviceCompletionDefaults,
} from '../myStuff/v3Model.js'
import { createMutationAttemptState, mutationIdForPayload, resetMutationAttemptState } from '../myStuff/mutation.js'
import MaintenanceReminderPanel from './MaintenanceReminderPanel.jsx'
import { MAINTENANCE_PRESET_DISCLAIMER, MAINTENANCE_PRESETS } from '../maintenance/presets.js'
import { createBrowserMaintenanceReminderRuntime } from '../myStuff/reminders.js'

const emptyDraft = () => ({
  name:'', description:'', serviceAction:'service', miles:'', hours:'', cycles:'', months:'',
  lastServiceKnown:false, lastServiceDate:'', lastServiceMiles:'', lastServiceHours:'', lastServiceCycles:'',
})
const emptyPresetSetup = () => ({ anchorMode:'unknown', lastServiceDate:'', lastServiceMiles:'', lastServiceHours:'', lastServiceCycles:'', currentMileage:'', currentHours:'', currentCycles:'' })
const today = () => new Date().toISOString().slice(0, 10)
const normalizedDefinitionName = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
const activeDefinitionMatches = (definition, name, action) => definition?.enabled !== false
  && (definition.lifecycle_state == null || definition.lifecycle_state === 'active')
  && normalizedDefinitionName(definition.name) === normalizedDefinitionName(name)
  && definition.service_action === action
const definitionPatchMatches = (definition, patch) => Object.entries(patch).every(([key, value]) => {
  const actual = definition?.[key]
  if (value == null || value === '') return actual == null
  if (typeof value === 'number') return Number(actual) === value
  return actual === value
})
const recurringDefinition = definition => [
  'normal_interval_miles','normal_interval_hours','normal_interval_cycles','normal_calendar_months',
  'severe_interval_miles','severe_interval_hours','severe_interval_cycles','severe_calendar_months',
  'first_interval_miles','first_interval_hours','first_interval_cycles','first_calendar_months',
].some(field => definition?.[field] != null)
const definitionSourceGroup = definition => ['manufacturer','ai_research'].includes(definition?.provenance_type) ? 'Manufacturer' : 'Owner-created'
const statusText = status => ({
  overdue: 'Overdue', due_now: 'Due now', due_soon: 'Due soon', upcoming: 'Upcoming',
  completed: 'Completed', completed_recently: 'Completed recently', not_completed: 'Due',
  not_applicable: 'Not applicable', skipped: 'Not visited / skipped', history_unknown: 'History unknown',
}[status] || 'Not calculated')
const STATUS_OPTIONS = [
  ['not_completed', 'Reset to due'],
  ['skipped', 'Not visited / skipped'],
  ['not_applicable', 'Not applicable'],
  ['history_unknown', 'History unknown'],
]

function dueDetails(row) {
  const values = []
  if (row.due_at) values.push(`Date ${String(row.due_at).slice(0, 10)}`)
  if (row.due_mileage != null) values.push(`${Number(row.due_mileage).toLocaleString()} miles`)
  if (row.due_hours != null) values.push(`${Number(row.due_hours).toLocaleString()} hours`)
  if (row.due_cycles != null) values.push(`${Number(row.due_cycles).toLocaleString()} cycles`)
  return values.join(' · ') || 'No due threshold recorded'
}

export default function MyStuffMaintenancePanel({ item, onChanged, mode = 'maintenance', integrityRollout = { featureEnabled:false, legacyRetired:false } }) {
  const client = useRef(createMyStuffMaintenanceClient(supabase))
  const integrityClient = useRef(createMyStuffIntegrityV4Client(supabase))
  const reminderRuntime = useRef(createBrowserMaintenanceReminderRuntime())
  const createAttempt = useRef(createMutationAttemptState())
  const updateAttempt = useRef(createMutationAttemptState())
  const serviceAttempts = useRef(new Map())
  const statusAttempts = useRef(new Map())
  const correctionAttempts = useRef(new Map())
  const presetAttempts = useRef(new Map())
  const [definitions, setDefinitions] = useState([])
  const [v2DueRows, setV2DueRows] = useState([])
  const [plannedRows, setPlannedRows] = useState([])
  const [dueViews, setDueViews] = useState([])
  const [serviceHistory, setServiceHistory] = useState([])
  const [statusEvents, setStatusEvents] = useState([])
  const [activeTab, setActiveTab] = useState('schedule')
  const [draft, setDraft] = useState(emptyDraft)
  const [editingId, setEditingId] = useState(null)
  const [serviceTarget, setServiceTarget] = useState(null)
  const [serviceDraft, setServiceDraft] = useState(null)
  const [statusDrafts, setStatusDrafts] = useState({})
  const [selectedPresets, setSelectedPresets] = useState([])
  const [presetSetup, setPresetSetup] = useState(emptyPresetSetup)
  const [correctionTarget, setCorrectionTarget] = useState(null)
  const [correctionDraft, setCorrectionDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const loadGate = useRef(createMaintenanceLoadGate())

  const load = useCallback(async () => {
    if (!item?.id) return
    const request = loadGate.current.begin(`${item.id}:${integrityRollout.featureEnabled}:${integrityRollout.legacyRetired}`)
    setLoading(true)
    setError('')
    try {
      const loadedDefinitions = await client.current.listDefinitions(item.id)
      if (!loadGate.current.isCurrent(request)) return
      const nextDefinitions = loadedDefinitions.filter(definition => definition.enabled !== false && (definition.lifecycle_state == null || definition.lifecycle_state === 'active'))
      const activeDefinitions = nextDefinitions
      const [nextV2Due, nextPlanned, nextDueViews, nextHistorySource, nextEvents] = await Promise.all([
        integrityRollout.featureEnabled ? integrityClient.current.getMaintenanceStates(activeDefinitions) : client.current.getDueState(item.id),
        integrityRollout.legacyRetired ? Promise.resolve([]) : listMyStuffScheduleGroupsV3(item.id),
        integrityRollout.legacyRetired ? Promise.resolve([]) : getMyStuffDueViewsV3(item.id),
        integrityRollout.featureEnabled ? integrityClient.current.getReport(item.id) : client.current.listServiceHistory(item.id),
        client.current.listStatusEvents(item.id),
      ])
      const nextHistory = integrityRollout.featureEnabled ? (nextHistorySource.completions || []).map(entry => ({
        id:entry.occurrence_id, occurrence_id:entry.occurrence_id, service_name:entry.original?.service_name,
        latest_correction_number:Math.max(0, ...(entry.correction_chain || []).map(row => Number(row.revision_number ?? row.number ?? 0))),
        completed_at:entry.effective?.service_performed_on, mileage:entry.effective?.service_mileage,
        hours:entry.effective?.service_hours, cycles:entry.effective?.service_cycles,
        notes:entry.effective?.notes, revisions:entry.correction_chain || [], ...entry,
      })) : nextHistorySource
      if (!loadGate.current.isCurrent(request)) return
      setDefinitions(nextDefinitions)
      setV2DueRows((Array.isArray(nextV2Due) ? nextV2Due : []).map(row => integrityRollout.featureEnabled ? { ...row, next_due_at:row.next_due_date } : row))
      setPlannedRows(Array.isArray(nextPlanned) ? nextPlanned : [])
      setDueViews(Array.isArray(nextDueViews) ? nextDueViews : [])
      setServiceHistory(nextHistory)
      setStatusEvents(nextEvents)
    } catch (next) {
      if (loadGate.current.isCurrent(request)) setError(next?.message || 'Maintenance information could not be loaded.')
    } finally {
      if (loadGate.current.isCurrent(request)) setLoading(false)
    }
  }, [integrityRollout.featureEnabled, integrityRollout.legacyRetired, item?.id])

  useEffect(() => {
    void load()
    return () => loadGate.current.invalidate()
  }, [load])
  useEffect(() => {
    setPresetSetup({ ...emptyPresetSetup(), currentMileage:item?.currentUsage?.miles ?? '', currentHours:item?.currentUsage?.hours ?? '', currentCycles:item?.currentUsage?.cycles ?? '' })
  }, [item?.id])

  const v2Schedules = useMemo(() => definitions.map(definition => ({
    ...definition,
    ...(v2DueRows.find(row => row.definition_id === definition.id) || {}),
  })), [definitions, v2DueRows])
  const occurrences = useMemo(
    () => normalizePlannedOccurrences(plannedRows, dueViews, definitions),
    [plannedRows, dueViews, definitions],
  )
  const v4DueOccurrences = useMemo(() => v2Schedules.map(row => ({
    id:`v4-definition:${row.id}`, definition_id:row.id, planned_occurrence_id:row.planned_occurrence_id || null,
    name:row.name, service_name:row.name, service_action:row.service_action,
    status:'not_completed', due_status:row.due_status,
    due_at:row.next_due_date, due_mileage:row.next_due_mileage,
    due_hours:row.next_due_hours, due_cycles:row.next_due_cycles,
    recurrence_expected:recurringDefinition(row),
  })), [v2Schedules])
  const dueRows = integrityRollout.legacyRetired ? v4DueOccurrences : occurrences
  const dueGroups = useMemo(() => classifyDueOccurrences(dueRows), [dueRows])
  const occurrencesByDefinition = useMemo(() => {
    const result = new Map()
    for (const row of occurrences) {
      const rows = result.get(row.definition_id) || []
      rows.push(row)
      result.set(row.definition_id, rows)
    }
    return result
  }, [occurrences])

  function attemptFor(map, key) {
    let attempt = map.current.get(key)
    if (!attempt) {
      attempt = createMutationAttemptState()
      map.current.set(key, attempt)
    }
    return attempt
  }

  async function mutate(action, after) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      await action()
      await after?.()
    } catch (next) {
      setError(next?.message || 'The maintenance change could not be saved.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  function editDefinition(definition) {
    setEditingId(definition.id)
    setDraft({
      ...emptyDraft(),
      name: definition.name || '',
      description: definition.description || '',
      serviceAction: definition.service_action || 'service',
      miles: definition.normal_interval_miles ?? '',
      hours: definition.normal_interval_hours ?? '',
      cycles: definition.normal_interval_cycles ?? '',
      months: definition.normal_calendar_months ?? '',
    })
  }

  function isPresetDuplicate(preset, rows = definitions) {
    return rows.some(definition => activeDefinitionMatches(definition, preset.name, preset.persistedAction))
  }

  function presetSetupPayload() {
    const setup = { anchor_mode:presetSetup.anchorMode }
    if (presetSetup.anchorMode === 'known') {
      if (presetSetup.lastServiceDate) setup.last_service_performed_on = presetSetup.lastServiceDate
      if (presetSetup.lastServiceMiles !== '') setup.last_service_mileage = Number(presetSetup.lastServiceMiles)
      if (presetSetup.lastServiceHours !== '') setup.last_service_hours = Number(presetSetup.lastServiceHours)
      if (presetSetup.lastServiceCycles !== '') setup.last_service_cycles = Number(presetSetup.lastServiceCycles)
    }
    if (item.measurements.includes('miles') && presetSetup.currentMileage !== '') setup.current_mileage = Number(presetSetup.currentMileage)
    if (item.measurements.includes('hours') && presetSetup.currentHours !== '') setup.current_hours = Number(presetSetup.currentHours)
    if (item.measurements.includes('cycles') && presetSetup.currentCycles !== '') setup.current_cycles = Number(presetSetup.currentCycles)
    return setup
  }

  async function addPresets(presetIds) {
    const requested = MAINTENANCE_PRESETS.filter(preset => presetIds.includes(preset.id))
    if (!requested.length) return
    const setup = presetSetupPayload()
    if (Object.values(setup).some(value => typeof value === 'number' && (!Number.isFinite(value) || value < 0))) {
      setError('Enter valid non-negative maintenance starting readings, or leave them unknown.')
      return
    }
    if (setup.last_service_mileage != null && setup.current_mileage != null && setup.last_service_mileage > setup.current_mileage) {
      setError('Current mileage cannot be below the last service mileage.')
      return
    }
    await mutate(async () => {
      for (const preset of requested) {
        const before = await client.current.listDefinitions(item.id)
        if (isPresetDuplicate(preset, before)) continue
        const values = {
          itemId:item.id, name:preset.name, serviceAction:preset.persistedAction,
          dueSemantics:'whichever_first', activeProfile:item.usage_profile || 'normal', cadenceAnchor:'last_completion',
          intervals:{ miles:item.measurements.includes('miles') && preset.miles != null ? preset.miles : null },
          calendarMonths:preset.months, enabled:true,
        }
        const wire = buildCreateMaintenanceDefinitionV2WirePayload(values)
        const attempt = attemptFor(presetAttempts, preset.id)
        const businessPayload = integrityRollout.featureEnabled ? { itemId:item.id, definition:wire.p_definition, setup } : wire
        const mutationId = mutationIdForPayload(attempt, businessPayload)
        try {
          if (integrityRollout.featureEnabled) await integrityClient.current.setupDefinition(item.id, wire.p_definition, setup, mutationId)
          else await client.current.createDefinition(wire, mutationId)
        } catch (next) {
          const reconciled = await client.current.listDefinitions(item.id)
          if (!isPresetDuplicate(preset, reconciled)) throw next
        }
        const confirmed = await client.current.listDefinitions(item.id)
        if (!isPresetDuplicate(preset, confirmed)) throw new Error(`${preset.name} was not confirmed after saving.`)
        resetMutationAttemptState(attempt)
      }
    }, async () => {
      setSelectedPresets([])
      await load()
      await onChanged?.()
    })
  }

  async function saveDefinition(event) {
    event.preventDefault()
    const cadenceValues = [
      item.measurements.includes('miles') ? draft.miles : '',
      item.measurements.includes('hours') ? draft.hours : '',
      item.measurements.includes('cycles') ? draft.cycles : '',
      draft.months,
    ]
    if (!draft.name.trim() || !cadenceValues.some(value => value !== '' && Number(value) > 0)) {
      setError('Enter a task name and at least one positive mileage, hours, cycles, or month interval.')
      return
    }
    const values = {
      itemId: item.id,
      definitionId: editingId,
      name: draft.name,
      description: draft.description,
      serviceAction: draft.serviceAction,
      activeProfile:item.usage_profile || 'normal',
      intervals: {
        miles:item.measurements.includes('miles') ? draft.miles : null,
        hours:item.measurements.includes('hours') ? draft.hours : null,
        cycles:item.measurements.includes('cycles') ? draft.cycles : null,
      },
      calendarMonths: draft.months,
      enabled: true,
    }
    const wire = editingId
      ? buildUpdateMaintenanceDefinitionV2WirePayload(values)
      : buildCreateMaintenanceDefinitionV2WirePayload(values)
    if (editingId && integrityRollout.featureEnabled) delete wire.p_definition.enabled
    const setup = {
      anchor_mode:draft.lastServiceKnown ? 'known' : 'unknown',
      current_mileage:item.currentUsage?.miles ?? null,
      current_hours:item.currentUsage?.hours ?? null,
      current_cycles:item.currentUsage?.cycles ?? null,
      ...(draft.lastServiceKnown ? {
        last_service_performed_on:draft.lastServiceDate || null,
        last_service_mileage:draft.lastServiceMiles === '' ? null : Number(draft.lastServiceMiles),
        last_service_hours:draft.lastServiceHours === '' ? null : Number(draft.lastServiceHours),
        last_service_cycles:draft.lastServiceCycles === '' ? null : Number(draft.lastServiceCycles),
      } : {}),
    }
    const attempt = editingId ? updateAttempt.current : createAttempt.current
    const businessPayload = integrityRollout.featureEnabled
      ? editingId ? { itemId:item.id, definitionId:editingId, patch:wire.p_definition } : { itemId:item.id, definition:wire.p_definition, setup }
      : wire
    const mutationId = mutationIdForPayload(attempt, businessPayload)
    await mutate(
      async () => {
        const before = await client.current.listDefinitions(item.id)
        try {
          if (integrityRollout.featureEnabled) {
            if (editingId) await integrityClient.current.updateDefinition(editingId, wire.p_definition, mutationId)
            else await integrityClient.current.setupDefinition(item.id, wire.p_definition, setup, mutationId)
          } else if (editingId) await client.current.updateDefinition(wire, mutationId)
          else await client.current.createDefinition(wire, mutationId)
        } catch (next) {
          const reconciled = await client.current.listDefinitions(item.id)
          const saved = editingId
            ? reconciled.some(definition => definition.id === editingId && definitionPatchMatches(definition, wire.p_definition))
            : reconciled.some(definition => !before.some(previous => previous.id === definition.id)
              && activeDefinitionMatches(definition, wire.p_definition.name, wire.p_definition.service_action))
          if (!saved) throw next
        }
        const confirmed = await client.current.listDefinitions(item.id)
        const saved = editingId
          ? confirmed.some(definition => definition.id === editingId && definitionPatchMatches(definition, wire.p_definition))
          : confirmed.some(definition => !before.some(previous => previous.id === definition.id)
            && activeDefinitionMatches(definition, wire.p_definition.name, wire.p_definition.service_action))
        if (!saved) throw new Error('The maintenance schedule was not confirmed after saving.')
        if (editingId) await reminderRuntime.current.cancelSchedule({ itemId:item.id, scheduleId:editingId })
      },
      async () => {
        resetMutationAttemptState(attempt)
        setDraft(emptyDraft())
        setEditingId(null)
        await load()
        await onChanged?.()
      },
    )
  }

  function beginService(target) {
    setServiceTarget(target)
    setServiceDraft({
      ...serviceCompletionDefaults(item, today()),
      currentReadings: { ...item.currentUsage },
      currency: item.purchase_currency || 'USD',
    })
    setError('')
  }

  async function saveService(event) {
    event.preventDefault()
    if (!serviceTarget || !serviceDraft) return
    if (integrityRollout.featureEnabled && integrityRollout.legacyRetired && (serviceTarget.recurrence_expected || recurringDefinition(serviceTarget)) && !serviceTarget.planned_occurrence_id) {
      setError('Refresh maintenance before recording service. A recurring task must have an active planned occurrence.')
      return
    }
    let request
    try {
      const service = buildServicePayload({ occurrence: serviceTarget, ...serviceDraft })
      request = buildServiceExpenseRequest({
        itemId: item.id,
        plannedOccurrenceId: serviceTarget.planned_occurrence_id || null,
        definitionId: serviceTarget.definition_id || serviceTarget.id || null,
        service,
        cost: serviceDraft.cost,
        description: serviceTarget.name || serviceTarget.service_name,
        currency: serviceDraft.currency,
        incurredOn: serviceDraft.actualServiceDate,
        vendor: serviceDraft.providerName,
        mileage: serviceDraft.readings.miles,
        hours: serviceDraft.readings.hours,
        notes: serviceDraft.notes,
      })
    } catch (next) {
      setError(next.message)
      return
    }
    const definitionId = serviceTarget.definition_id || serviceTarget.id
    const completion = {
      service_performed_on: serviceDraft.actualServiceDate,
      service_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      service_mileage: serviceDraft.readings.miles === '' ? null : Number(serviceDraft.readings.miles),
      service_hours: serviceDraft.readings.hours === '' ? null : Number(serviceDraft.readings.hours),
      service_cycles: serviceDraft.readings.cycles === '' ? null : Number(serviceDraft.readings.cycles),
      current_mileage: serviceDraft.currentReadings?.miles === '' ? null : Number(serviceDraft.currentReadings?.miles),
      current_hours: serviceDraft.currentReadings?.hours === '' ? null : Number(serviceDraft.currentReadings?.hours),
      current_cycles: serviceDraft.currentReadings?.cycles === '' ? null : Number(serviceDraft.currentReadings?.cycles),
      notes: serviceDraft.notes || null, parts: request.service.parts, labor:request.service.labor,
      vendor:request.service.vendor, planned_occurrence_id:request.plannedOccurrenceId, expense:request.expense,
    }
    const filteredCompletion = Object.fromEntries(Object.entries(completion).filter(([,value]) => value != null && !Number.isNaN(value)))
    const key = serviceTarget.planned_occurrence_id || `definition:${definitionId}`
    const attempt = attemptFor(serviceAttempts, key)
    const mutationId = mutationIdForPayload(attempt, integrityRollout.featureEnabled ? { definitionId, completion:filteredCompletion } : request)
    await mutate(
      () => integrityRollout.featureEnabled
        ? integrityClient.current.completeDefinition(definitionId, filteredCompletion, mutationId)
        : recordMyStuffServiceWithExpenseV3({ ...request, mutationId }),
      async () => {
        resetMutationAttemptState(attempt)
        await reminderRuntime.current.cancelSchedule({ itemId:item.id, scheduleId:definitionId })
        setServiceTarget(null)
        setServiceDraft(null)
        await load()
        await onChanged?.()
      },
    )
  }

  async function saveStatus(row) {
    const next = statusDrafts[row.planned_occurrence_id] || { status: 'skipped', reason: '' }
    if (!next.reason.trim()) {
      setError('Enter a reason for the occurrence status change.')
      return
    }
    const descriptor = { occurrenceId: row.planned_occurrence_id, status: next.status, reason: next.reason.trim() }
    const attempt = attemptFor(statusAttempts, row.planned_occurrence_id)
    const mutationId = mutationIdForPayload(attempt, descriptor)
    await mutate(
      () => setMyStuffOccurrenceStatusV3(descriptor.occurrenceId, descriptor.status, descriptor.reason, mutationId),
      async () => {
        resetMutationAttemptState(attempt)
        setStatusDrafts(current => ({ ...current, [row.planned_occurrence_id]: { status: 'skipped', reason: '' } }))
        await load()
      },
    )
  }

  function beginCorrection(row) {
    const effective = row.effective || {}
    setCorrectionTarget(row)
    setCorrectionDraft({
      serviceDate:effective.service_performed_on || '', serviceMileage:effective.service_mileage ?? '',
      serviceHours:effective.service_hours ?? '', serviceCycles:effective.service_cycles ?? '',
      currentMileage:effective.current_mileage ?? '', currentHours:effective.current_hours ?? '', currentCycles:effective.current_cycles ?? '',
      notes:effective.notes || '', reason:'',
    })
  }

  async function saveCorrection(event) {
    event.preventDefault()
    if (!correctionTarget || !correctionDraft) return
    const withinWindow = !correctionTarget.historical_locked_from_window_edit && correctionTarget.original?.lock_deadline && Date.now() < new Date(correctionTarget.original.lock_deadline).getTime()
    if (!withinWindow && !correctionDraft.reason.trim()) { setError('Enter a reason for this correction.'); return }
    const numeric = value => value === '' ? null : Number(value)
    const patch = {
      service_performed_on:correctionDraft.serviceDate,
      service_mileage:numeric(correctionDraft.serviceMileage), service_hours:numeric(correctionDraft.serviceHours), service_cycles:numeric(correctionDraft.serviceCycles),
      current_mileage:numeric(correctionDraft.currentMileage), current_hours:numeric(correctionDraft.currentHours), current_cycles:numeric(correctionDraft.currentCycles),
      notes:correctionDraft.notes,
    }
    const descriptor = { occurrenceId:correctionTarget.occurrence_id, patch, reason:correctionDraft.reason }
    const attempt = attemptFor(correctionAttempts, correctionTarget.occurrence_id)
    const mutationId = mutationIdForPayload(attempt, descriptor)
    await mutate(() => integrityClient.current.editCompletion(correctionTarget, patch, correctionDraft.reason, mutationId), async () => {
      resetMutationAttemptState(attempt)
      await reminderRuntime.current.cancelItem(item.id)
      setCorrectionTarget(null); setCorrectionDraft(null)
      await load(); await onChanged?.()
    })
  }

  if (mode === 'history') {
    return <section id="maintenance-history" className="mystuff-card" aria-labelledby="service-history-heading" aria-busy={loading || busy}>
      <div className="mystuff-section-heading"><h2 id="service-history-heading">Service history</h2><button type="button" className="mystuff-link" onClick={() => void load()} disabled={busy}>Refresh</button></div>
      <p className="mystuff-help">Completed service and status events are immutable records. Corrections append revisions without replacing history.</p>
      {error && <p className="field-error" role="alert">{error}</p>}
      <h3>Completed service</h3>
      {serviceHistory.length ? <ul className="mystuff-history">{serviceHistory.map(row => <li key={row.id}>
        <div className="mystuff-history-row"><span><strong>{row.service_name}</strong><small>{String(row.completed_at).slice(0, 10)} · {row.scheduled ? 'Scheduled' : 'Unscheduled'}</small></span><strong>{statusText('completed')}</strong></div>
        <small>{[['mileage', 'miles'], ['hours', 'hours'], ['cycles', 'cycles']].filter(([key]) => row[key] != null).map(([key, label]) => `${Number(row[key]).toLocaleString()} ${label}`).join(' · ') || 'No readings recorded'}</small>
        {row.revisions.map(revision => <div className="mystuff-revision" key={revision.id}><small>Revision {revision.revision_number || revision.number}{(revision.revision_reason || revision.reason) ? ` · ${revision.revision_reason || revision.reason}` : ''}</small>{(revision.notes || revision.snapshot?.notes) && <p>{revision.notes || revision.snapshot?.notes}</p>}</div>)}
        {integrityRollout.featureEnabled&&<button type="button" className="mystuff-link" onClick={()=>beginCorrection(row)} disabled={busy}>{!row.historical_locked_from_window_edit&&row.original?.lock_deadline&&Date.now()<new Date(row.original.lock_deadline).getTime()?'Edit completion':'Add correction'}</button>}
      </li>)}</ul> : <p className="mystuff-help">No service has been recorded.</p>}
      {correctionTarget&&correctionDraft&&<CorrectionForm target={correctionTarget} draft={correctionDraft} setDraft={setCorrectionDraft} onSubmit={saveCorrection} onCancel={()=>{setCorrectionTarget(null);setCorrectionDraft(null)}} busy={busy}/>}
      <h3>Occurrence status events</h3>
      {statusEvents.length ? <ul className="mystuff-history">{statusEvents.map(event => <li key={event.id}><strong>{statusText(event.status)}</strong><small>{String(event.created_at).slice(0, 10)} · {event.source}{event.reason ? ` · ${event.reason}` : ''}</small></li>)}</ul> : <p className="mystuff-help">No status events recorded.</p>}
    </section>
  }

  return <>
    <section id="maintenance-workflows" className="mystuff-card" aria-labelledby="maintenance-heading" aria-busy={loading || busy}>
      <div className="mystuff-section-heading"><h2 id="maintenance-heading">Maintenance</h2><button type="button" className="mystuff-link" onClick={() => void load()} disabled={busy}>Refresh</button></div>
      <div className="mystuff-tabs" role="tablist" aria-label="Maintenance views">
        <button type="button" role="tab" aria-selected={activeTab === 'schedule'} onClick={() => setActiveTab('schedule')}>Schedule</button>
        <button type="button" role="tab" aria-selected={activeTab === 'due'} onClick={() => setActiveTab('due')}>Due Items</button>
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      {loading ? <p className="mystuff-help" role="status">Loading maintenance…</p> : activeTab === 'schedule'
        ? <ScheduleView definitions={integrityRollout.featureEnabled ? v2Schedules : definitions} occurrencesByDefinition={occurrencesByDefinition} busy={busy} editDefinition={editDefinition} beginService={beginService} allowEdit requirePlan={integrityRollout.featureEnabled && integrityRollout.legacyRetired}/>
        : <DueView groups={dueGroups} busy={busy} beginService={beginService} statusDrafts={statusDrafts} setStatusDrafts={setStatusDrafts} saveStatus={saveStatus} allowStatus={!integrityRollout.featureEnabled} requirePlan={integrityRollout.featureEnabled && integrityRollout.legacyRetired}/>
      }
      {serviceTarget && serviceDraft && <ServiceForm item={item} target={serviceTarget} draft={serviceDraft} setDraft={setServiceDraft} onSubmit={saveService} onCancel={() => { setServiceTarget(null); setServiceDraft(null) }} busy={busy}/>}
      {!editingId&&<section aria-label="Common maintenance starting points">
        <h3>Common maintenance</h3><p className="mystuff-help">{MAINTENANCE_PRESET_DISCLAIMER} Presets use whichever comes first, start from the last completion, and remain editable.</p>
        {integrityRollout.featureEnabled&&<fieldset><legend>Preset starting point</legend>
          <p className="mystuff-help">Choose what you know. Unknown values stay unknown and are never replaced with zero, today, or current mileage.</p>
          <div className="mystuff-choices">
            <label><input type="radio" name="preset-anchor" value="known" checked={presetSetup.anchorMode==='known'} onChange={event=>setPresetSetup(current=>({...current,anchorMode:event.target.value}))}/><span>Last service is known</span></label>
            <label><input type="radio" name="preset-anchor" value="unknown" checked={presetSetup.anchorMode==='unknown'} onChange={event=>setPresetSetup(current=>({...current,anchorMode:event.target.value,lastServiceDate:'',lastServiceMiles:'',lastServiceHours:'',lastServiceCycles:''}))}/><span>Last service is unknown</span></label>
            <label><input type="radio" name="preset-anchor" value="never" checked={presetSetup.anchorMode==='never'} onChange={event=>setPresetSetup(current=>({...current,anchorMode:event.target.value,lastServiceDate:'',lastServiceMiles:'',lastServiceHours:'',lastServiceCycles:''}))}/><span>Never serviced</span></label>
          </div>
          {presetSetup.anchorMode==='known'&&<><div className="mystuff-columns"><div className="form-group"><label htmlFor="preset-last-service-date">Last service date (leave blank if unknown)</label><input id="preset-last-service-date" type="date" value={presetSetup.lastServiceDate} onChange={event=>setPresetSetup(current=>({...current,lastServiceDate:event.target.value}))}/></div>{item.measurements.includes('miles')&&<div className="form-group"><label htmlFor="preset-last-service-mileage">Mileage at last service (leave blank if unknown)</label><input id="preset-last-service-mileage" type="number" min="0" step="any" value={presetSetup.lastServiceMiles} onChange={event=>setPresetSetup(current=>({...current,lastServiceMiles:event.target.value}))}/></div>}</div><div className="mystuff-columns">{item.measurements.includes('hours')&&<div className="form-group"><label htmlFor="preset-last-service-hours">Hours at last service (leave blank if unknown)</label><input id="preset-last-service-hours" type="number" min="0" step="any" value={presetSetup.lastServiceHours} onChange={event=>setPresetSetup(current=>({...current,lastServiceHours:event.target.value}))}/></div>}{item.measurements.includes('cycles')&&<div className="form-group"><label htmlFor="preset-last-service-cycles">Cycles at last service (leave blank if unknown)</label><input id="preset-last-service-cycles" type="number" min="0" step="1" value={presetSetup.lastServiceCycles} onChange={event=>setPresetSetup(current=>({...current,lastServiceCycles:event.target.value}))}/></div>}</div></>}
          <div className="mystuff-columns">{item.measurements.includes('miles')&&<div className="form-group"><label htmlFor="preset-current-mileage">Current mileage (leave blank if unknown)</label><input id="preset-current-mileage" type="number" min="0" step="any" value={presetSetup.currentMileage} onChange={event=>setPresetSetup(current=>({...current,currentMileage:event.target.value}))}/></div>}{item.measurements.includes('hours')&&<div className="form-group"><label htmlFor="preset-current-hours">Current hours (leave blank if unknown)</label><input id="preset-current-hours" type="number" min="0" step="any" value={presetSetup.currentHours} onChange={event=>setPresetSetup(current=>({...current,currentHours:event.target.value}))}/></div>}{item.measurements.includes('cycles')&&<div className="form-group"><label htmlFor="preset-current-cycles">Current cycles (leave blank if unknown)</label><input id="preset-current-cycles" type="number" min="0" step="1" value={presetSetup.currentCycles} onChange={event=>setPresetSetup(current=>({...current,currentCycles:event.target.value}))}/></div>}</div>
        </fieldset>}
        <div className="mystuff-history">{MAINTENANCE_PRESETS.map(preset=>{const duplicate=isPresetDuplicate(preset);const selected=selectedPresets.includes(preset.id);return <div className="mystuff-history-row" key={preset.id}>
          <label><input type="checkbox" checked={selected} disabled={busy||duplicate} onChange={event=>setSelectedPresets(current=>event.target.checked?[...current,preset.id]:current.filter(id=>id!==preset.id))}/><span><strong>{preset.name}</strong><small>{preset.catalogAction.replaceAll('_',' ')} · {preset.miles == null ? '' : `${preset.miles.toLocaleString()} miles or `}{preset.months} months{duplicate?' · Added':''}</small></span></label>
          <button type="button" className="btn" disabled={busy||duplicate} onClick={()=>void addPresets([preset.id])}>Add</button>
        </div>})}</div>
        <button type="button" className="btn btn-primary" disabled={busy||selectedPresets.length===0} onClick={()=>void addPresets(selectedPresets)}>Add selected</button>
      </section>}
      <form className="mystuff-detail-form mystuff-maintenance-form" onSubmit={saveDefinition}>
        <h3>{editingId ? 'Edit maintenance task' : 'Add maintenance task'}</h3>
        <label htmlFor="maintenance-name">Task name *</label><input id="maintenance-name" value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}/>
        <label htmlFor="maintenance-description">Description</label><input id="maintenance-description" value={draft.description} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))}/>
        <label htmlFor="maintenance-action">Action</label><select id="maintenance-action" value={draft.serviceAction} onChange={event=>setDraft(current=>({...current,serviceAction:event.target.value}))}><option value="service">Service</option><option value="inspect">Inspect</option><option value="replace">Replace</option></select>
        <div className="mystuff-columns">{item.measurements.includes('miles')&&<MaintenanceNumber label="Every miles" name="miles" value={draft.miles} setDraft={setDraft}/>} {item.measurements.includes('hours')&&<MaintenanceNumber label="Every hours" name="hours" value={draft.hours} setDraft={setDraft}/>}</div>
        <div className="mystuff-columns">{item.measurements.includes('cycles')&&<MaintenanceNumber label="Every cycles" name="cycles" value={draft.cycles} setDraft={setDraft}/>}<MaintenanceNumber label="Every months" name="months" value={draft.months} setDraft={setDraft}/></div>
        {integrityRollout.featureEnabled&&!editingId&&<fieldset><legend>Maintenance starting point</legend><label><input type="checkbox" checked={draft.lastServiceKnown} onChange={event=>setDraft(current=>({...current,lastServiceKnown:event.target.checked}))}/> I know when this service was last completed</label>{draft.lastServiceKnown&&<><p className="mystuff-help">Enter the values you know; leave an individual field blank when it is unknown.</p><div className="mystuff-columns"><div className="form-group"><label htmlFor="maintenance-last-date">Last service date</label><input id="maintenance-last-date" type="date" value={draft.lastServiceDate} onChange={event=>setDraft(current=>({...current,lastServiceDate:event.target.value}))}/></div>{item.measurements.includes('miles')&&<MaintenanceNumber label="Last service mileage" name="lastServiceMiles" value={draft.lastServiceMiles} setDraft={setDraft}/>}</div><div className="mystuff-columns">{item.measurements.includes('hours')&&<MaintenanceNumber label="Last service hours" name="lastServiceHours" value={draft.lastServiceHours} setDraft={setDraft}/>} {item.measurements.includes('cycles')&&<MaintenanceNumber label="Last service cycles" name="lastServiceCycles" value={draft.lastServiceCycles} setDraft={setDraft}/>}</div></>}</fieldset>}
        <div className="mystuff-actions"><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Save schedule' : 'Add schedule'}</button>{editingId && <button type="button" className="btn" onClick={() => { setEditingId(null); setDraft(emptyDraft()) }} disabled={busy}>Cancel</button>}</div>
      </form>
    </section>
    <MaintenanceReminderPanel schedules={v2Schedules} item={item} runtime={reminderRuntime.current}/>
  </>
}

function ScheduleView({ definitions, occurrencesByDefinition, busy, editDefinition, beginService, allowEdit, requirePlan }) {
  if (!definitions.length) return <p className="mystuff-help">No maintenance schedule yet.</p>
  const grouped = new Map()
  for (const definition of definitions) {
    const source = definitionSourceGroup(definition)
    grouped.set(source, [...(grouped.get(source) || []), definition])
  }
  return <div role="tabpanel">{[...grouped].map(([source, sourceDefinitions]) => <section key={source} aria-label={`${source} maintenance`}>
    <h3>{source}</h3><ul className="mystuff-history">{sourceDefinitions.map(definition => {
      const rows = occurrencesByDefinition.get(definition.id) || []
      const recurrenceNeedsPlan = requirePlan && recurringDefinition(definition)
      const completionTarget = { ...definition, definition_id:definition.id, recurrence_expected:recurringDefinition(definition) }
      return <li key={definition.id}>
        <div className="mystuff-history-row"><span><strong>{definition.name}</strong><small>{definition.description || getMaintenanceDefinitionAxes(definition).join(', ') || 'Custom schedule'}</small></span><strong>{definition.enabled === false ? 'Disabled' : `${rows.length} planned`}</strong></div>
        {rows.length > 0 && <ul className="mystuff-subhistory">{rows.map(row => <li key={row.planned_occurrence_id}><span>{statusText(row.due_status || row.status)}</span><small>{dueDetails(row)}</small></li>)}</ul>}
        {recurrenceNeedsPlan&&!definition.planned_occurrence_id&&<p className="mystuff-help" role="status">Refresh after the schedule is rematerialized before recording recurring service.</p>}
        <div className="mystuff-actions">{allowEdit&&<button type="button" className="mystuff-link" onClick={() => editDefinition(definition)} disabled={busy}>Edit schedule</button>}{definition.enabled !== false && <button type="button" className="btn" onClick={() => beginService(completionTarget)} disabled={busy||(recurrenceNeedsPlan&&!definition.planned_occurrence_id)}>Record service</button>}</div>
      </li>
    })}</ul>
  </section>)}</div>
}

function DueView({ groups, busy, beginService, statusDrafts, setStatusDrafts, saveStatus, allowStatus, requirePlan }) {
  const sections = [['Overdue', groups.overdue], ['Due soon', groups.dueSoon], ['Upcoming', groups.upcoming], ['Completed recently', groups.completedRecently]]
  if (!sections.some(([, rows]) => rows.length)) return <p className="mystuff-help">No due items have been planned.</p>
  return <div role="tabpanel">{sections.filter(([, rows]) => rows.length).map(([heading, rows]) => <section className="mystuff-due-group" key={heading} aria-labelledby={`due-${heading.replaceAll(' ', '-').toLowerCase()}`}><h3 id={`due-${heading.replaceAll(' ', '-').toLowerCase()}`}>{heading}</h3><ul className="mystuff-history">{rows.map(row => {
    const rowKey = row.planned_occurrence_id || row.id
    const current = statusDrafts[rowKey] || { status: 'skipped', reason: '' }
    const completed = row.status === 'completed'
    return <li key={rowKey}>
      <div className="mystuff-history-row"><span><strong>{row.name || 'Maintenance task'}</strong><small>{dueDetails(row)}</small></span><strong>{statusText(row.due_status || row.status)}</strong></div>
      {!completed && <>
        <div className="mystuff-actions"><button type="button" className="btn btn-primary" onClick={() => beginService(row)} disabled={busy||(requirePlan&&row.recurrence_expected&&!row.planned_occurrence_id)}>Record service</button></div>
        {requirePlan&&row.recurrence_expected&&!row.planned_occurrence_id&&<p className="mystuff-help" role="status">Refresh after this recurring task has an active planned occurrence.</p>}
        {allowStatus&&<div className="mystuff-status-form">
          <div className="form-group"><label htmlFor={`occurrence-status-${row.planned_occurrence_id}`}>Occurrence status</label><select id={`occurrence-status-${row.planned_occurrence_id}`} value={current.status} onChange={event => setStatusDrafts(value => ({ ...value, [row.planned_occurrence_id]: { ...current, status: event.target.value } }))}>{STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <div className="form-group"><label htmlFor={`occurrence-reason-${row.planned_occurrence_id}`}>Status reason *</label><input id={`occurrence-reason-${row.planned_occurrence_id}`} value={current.reason} onChange={event => setStatusDrafts(value => ({ ...value, [row.planned_occurrence_id]: { ...current, reason: event.target.value } }))}/></div>
          <button type="button" className="btn" onClick={() => void saveStatus(row)} disabled={busy}>Save status</button>
        </div>}
      </>}
    </li>
  })}</ul></section>)}</div>
}

function ServiceForm({ item, target, draft, setDraft, onSubmit, onCancel, busy }) {
  const setReading = (axis, value) => setDraft(current => ({ ...current, readings: { ...current.readings, [axis]: value } }))
  const setCurrentReading = (axis, value) => setDraft(current => ({ ...current, currentReadings: { ...current.currentReadings, [axis]: value } }))
  return <form className="mystuff-detail-form mystuff-service-form" onSubmit={onSubmit}>
    <h3>Record service: {target.name || target.service_name}</h3>
    <div className="mystuff-columns"><div className="form-group"><label htmlFor="service-actual-date">Actual service date *</label><input id="service-actual-date" type="date" value={draft.actualServiceDate} onChange={event => setDraft(current => ({ ...current, actualServiceDate: event.target.value }))}/></div><div className="form-group"><label htmlFor="service-provider-type">Performed by</label><select id="service-provider-type" value={draft.providerType} onChange={event => setDraft(current => ({ ...current, providerType: event.target.value }))}><option value="provider">Service provider</option><option value="diy">DIY / owner</option></select></div></div>
    <div className="mystuff-columns">{item.measurements.map(axis => <div className="form-group" key={axis}><label htmlFor={`service-reading-${axis}`}>{axis === 'miles' ? 'Mileage' : axis} at service</label><input id={`service-reading-${axis}`} type="number" min="0" step={axis === 'cycles' ? '1' : 'any'} value={draft.readings[axis]} onChange={event => setReading(axis, event.target.value)}/></div>)}</div>
    <h4>Current usage after service</h4><div className="mystuff-columns">{item.measurements.map(axis => <div className="form-group" key={axis}><label htmlFor={`service-current-${axis}`}>Current {axis === 'miles' ? 'mileage' : axis}</label><input id={`service-current-${axis}`} type="number" min="0" step={axis === 'cycles' ? '1' : 'any'} value={draft.currentReadings?.[axis] ?? ''} onChange={event => setCurrentReading(axis, event.target.value)}/></div>)}</div>
    <div className="mystuff-columns"><div className="form-group"><label htmlFor="service-provider-name">Provider name</label><input id="service-provider-name" value={draft.providerName} onChange={event => setDraft(current => ({ ...current, providerName: event.target.value }))}/></div><div className="form-group"><label htmlFor="service-parts">Parts and details</label><input id="service-parts" value={draft.parts} onChange={event => setDraft(current => ({ ...current, parts: event.target.value }))}/></div></div>
    <label htmlFor="service-notes">Service notes</label><textarea id="service-notes" value={draft.notes} onChange={event => setDraft(current => ({ ...current, notes: event.target.value }))}/>
    <fieldset><legend>Optional linked expense</legend><div className="mystuff-columns"><div className="form-group"><label htmlFor="service-cost">Cost</label><input id="service-cost" type="number" min="0" step="0.01" value={draft.cost} onChange={event => setDraft(current => ({ ...current, cost: event.target.value }))}/></div><div className="form-group"><label htmlFor="service-currency">Currency</label><input id="service-currency" maxLength="3" value={draft.currency} onChange={event => setDraft(current => ({ ...current, currency: event.target.value }))}/></div></div><p className="mystuff-help">Leave cost blank to record service without creating an expense.</p></fieldset>
    <div className="mystuff-actions"><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save service and linked expense'}</button><button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button></div>
  </form>
}

function CorrectionForm({ target, draft, setDraft, onSubmit, onCancel, busy }) {
  const set = (field, value) => setDraft(current => ({ ...current, [field]:value }))
  const withinWindow = !target.historical_locked_from_window_edit && target.original?.lock_deadline && Date.now() < new Date(target.original.lock_deadline).getTime()
  return <form className="mystuff-detail-form mystuff-service-form" onSubmit={onSubmit}>
    <h3>{withinWindow ? 'Edit completion' : 'Add correction'}</h3>
    <div className="form-group"><label htmlFor="correction-service-date">Service date</label><input id="correction-service-date" type="date" value={draft.serviceDate} onChange={event=>set('serviceDate',event.target.value)} required/></div>
    <div className="mystuff-columns">{[['serviceMileage','Service mileage'],['serviceHours','Service hours'],['serviceCycles','Service cycles']].map(([field,label])=><div className="form-group" key={field}><label htmlFor={`correction-${field}`}>{label}</label><input id={`correction-${field}`} type="number" min="0" step={field==='serviceCycles'?'1':'any'} value={draft[field]} onChange={event=>set(field,event.target.value)}/></div>)}</div>
    <h4>Current usage after correction</h4><div className="mystuff-columns">{[['currentMileage','Current mileage'],['currentHours','Current hours'],['currentCycles','Current cycles']].map(([field,label])=><div className="form-group" key={field}><label htmlFor={`correction-${field}`}>{label}</label><input id={`correction-${field}`} type="number" min="0" step={field==='currentCycles'?'1':'any'} value={draft[field]} onChange={event=>set(field,event.target.value)}/></div>)}</div>
    <div className="form-group"><label htmlFor="correction-notes">Notes</label><textarea id="correction-notes" value={draft.notes} onChange={event=>set('notes',event.target.value)}/></div>
    <div className="form-group"><label htmlFor="correction-reason">{withinWindow?'Edit note (optional)':'Correction reason *'}</label><textarea id="correction-reason" value={draft.reason} onChange={event=>set('reason',event.target.value)} required={!withinWindow}/></div>
    <div className="mystuff-actions"><button className="btn btn-primary" disabled={busy}>{busy?'Saving…':'Save correction'}</button><button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button></div>
  </form>
}

function MaintenanceNumber({ label, name, value, setDraft }) {
  return <div className="form-group"><label htmlFor={`maintenance-${name}`}>{label}</label><input id={`maintenance-${name}`} type="number" min="0" step={name === 'months' || name === 'cycles' ? '1' : 'any'} value={value} onChange={event => setDraft(current => ({ ...current, [name]: event.target.value }))}/></div>
}
