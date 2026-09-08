import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabase.js'
import {
  getMyStuffDueViewsV3,
  listMyStuffScheduleGroupsV3,
  recordMyStuffServiceWithExpenseV3,
  setMyStuffOccurrenceStatusV3,
} from '../myStuff/api.js'
import { createMyStuffMaintenanceClient } from '../myStuff/maintenanceClient.js'
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

const emptyDraft = () => ({ name: '', description: '', miles: '', hours: '', cycles: '', months: '' })
const today = () => new Date().toISOString().slice(0, 10)
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

export default function MyStuffMaintenancePanel({ item, onChanged, mode = 'maintenance' }) {
  const client = useRef(createMyStuffMaintenanceClient(supabase))
  const createAttempt = useRef(createMutationAttemptState())
  const updateAttempt = useRef(createMutationAttemptState())
  const serviceAttempts = useRef(new Map())
  const statusAttempts = useRef(new Map())
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
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    if (!item?.id) return
    setError('')
    try {
      const [nextDefinitions, nextV2Due, nextPlanned, nextDueViews, nextHistory, nextEvents] = await Promise.all([
        client.current.listDefinitions(item.id),
        client.current.getDueState(item.id),
        listMyStuffScheduleGroupsV3(item.id),
        getMyStuffDueViewsV3(item.id),
        client.current.listServiceHistory(item.id),
        client.current.listStatusEvents(item.id),
      ])
      setDefinitions(nextDefinitions)
      setV2DueRows(nextV2Due)
      setPlannedRows(Array.isArray(nextPlanned) ? nextPlanned : [])
      setDueViews(Array.isArray(nextDueViews) ? nextDueViews : [])
      setServiceHistory(nextHistory)
      setStatusEvents(nextEvents)
    } catch (next) {
      setError(next?.message || 'Maintenance information could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [item?.id])

  useEffect(() => { void load() }, [load])

  const v2Schedules = useMemo(() => definitions.map(definition => ({
    ...definition,
    ...(v2DueRows.find(row => row.definition_id === definition.id) || {}),
  })), [definitions, v2DueRows])
  const occurrences = useMemo(
    () => normalizePlannedOccurrences(plannedRows, dueViews, definitions),
    [plannedRows, dueViews, definitions],
  )
  const dueGroups = useMemo(() => classifyDueOccurrences(occurrences), [occurrences])
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
      name: definition.name || '',
      description: definition.description || '',
      miles: definition.normal_interval_miles ?? '',
      hours: definition.normal_interval_hours ?? '',
      cycles: definition.normal_interval_cycles ?? '',
      months: definition.normal_calendar_months ?? '',
    })
  }

  async function saveDefinition(event) {
    event.preventDefault()
    const cadenceValues = [draft.miles, draft.hours, draft.cycles, draft.months]
    if (!draft.name.trim() || !cadenceValues.some(value => value !== '' && Number(value) > 0)) {
      setError('Enter a task name and at least one positive mileage, hours, cycles, or month interval.')
      return
    }
    const values = {
      itemId: item.id,
      definitionId: editingId,
      name: draft.name,
      description: draft.description,
      intervals: { miles: draft.miles, hours: draft.hours, cycles: draft.cycles },
      calendarMonths: draft.months,
      enabled: true,
    }
    const wire = editingId
      ? buildUpdateMaintenanceDefinitionV2WirePayload(values)
      : buildCreateMaintenanceDefinitionV2WirePayload(values)
    const attempt = editingId ? updateAttempt.current : createAttempt.current
    const mutationId = mutationIdForPayload(attempt, wire)
    await mutate(
      () => editingId ? client.current.updateDefinition(wire, mutationId) : client.current.createDefinition(wire, mutationId),
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
      currency: item.purchase_currency || 'USD',
    })
    setError('')
  }

  async function saveService(event) {
    event.preventDefault()
    if (!serviceTarget || !serviceDraft) return
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
    const key = serviceTarget.planned_occurrence_id || `definition:${serviceTarget.definition_id || serviceTarget.id}`
    const attempt = attemptFor(serviceAttempts, key)
    const mutationId = mutationIdForPayload(attempt, request)
    await mutate(
      () => recordMyStuffServiceWithExpenseV3({ ...request, mutationId }),
      async () => {
        resetMutationAttemptState(attempt)
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

  if (mode === 'history') {
    return <section id="maintenance-history" className="mystuff-card" aria-labelledby="service-history-heading" aria-busy={loading || busy}>
      <div className="mystuff-section-heading"><h2 id="service-history-heading">Service history</h2><button type="button" className="mystuff-link" onClick={() => void load()} disabled={busy}>Refresh</button></div>
      <p className="mystuff-help">Completed service and status events are immutable records. Corrections append revisions without replacing history.</p>
      {error && <p className="field-error" role="alert">{error}</p>}
      <h3>Completed service</h3>
      {serviceHistory.length ? <ul className="mystuff-history">{serviceHistory.map(row => <li key={row.id}>
        <div className="mystuff-history-row"><span><strong>{row.service_name}</strong><small>{String(row.completed_at).slice(0, 10)} · {row.scheduled ? 'Scheduled' : 'Unscheduled'}</small></span><strong>{statusText('completed')}</strong></div>
        <small>{[['mileage', 'miles'], ['hours', 'hours'], ['cycles', 'cycles']].filter(([key]) => row[key] != null).map(([key, label]) => `${Number(row[key]).toLocaleString()} ${label}`).join(' · ') || 'No readings recorded'}</small>
        {row.revisions.map(revision => <div className="mystuff-revision" key={revision.id}><small>Revision {revision.revision_number}{revision.revision_reason ? ` · ${revision.revision_reason}` : ''}</small>{revision.notes && <p>{revision.notes}</p>}</div>)}
      </li>)}</ul> : <p className="mystuff-help">No service has been recorded.</p>}
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
        ? <ScheduleView definitions={definitions} occurrencesByDefinition={occurrencesByDefinition} busy={busy} editDefinition={editDefinition} beginService={beginService}/>
        : <DueView groups={dueGroups} busy={busy} beginService={beginService} statusDrafts={statusDrafts} setStatusDrafts={setStatusDrafts} saveStatus={saveStatus}/>
      }
      {serviceTarget && serviceDraft && <ServiceForm item={item} target={serviceTarget} draft={serviceDraft} setDraft={setServiceDraft} onSubmit={saveService} onCancel={() => { setServiceTarget(null); setServiceDraft(null) }} busy={busy}/>}
      <form className="mystuff-detail-form mystuff-maintenance-form" onSubmit={saveDefinition}>
        <h3>{editingId ? 'Edit maintenance task' : 'Add maintenance task'}</h3>
        <label htmlFor="maintenance-name">Task name *</label><input id="maintenance-name" value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}/>
        <label htmlFor="maintenance-description">Description</label><input id="maintenance-description" value={draft.description} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))}/>
        <div className="mystuff-columns"><MaintenanceNumber label="Every miles" name="miles" value={draft.miles} setDraft={setDraft}/><MaintenanceNumber label="Every hours" name="hours" value={draft.hours} setDraft={setDraft}/></div>
        <div className="mystuff-columns"><MaintenanceNumber label="Every cycles" name="cycles" value={draft.cycles} setDraft={setDraft}/><MaintenanceNumber label="Every months" name="months" value={draft.months} setDraft={setDraft}/></div>
        <div className="mystuff-actions"><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Save schedule' : 'Add schedule'}</button>{editingId && <button type="button" className="btn" onClick={() => { setEditingId(null); setDraft(emptyDraft()) }} disabled={busy}>Cancel</button>}</div>
      </form>
    </section>
    <MaintenanceReminderPanel schedules={v2Schedules} item={item}/>
  </>
}

function ScheduleView({ definitions, occurrencesByDefinition, busy, editDefinition, beginService }) {
  if (!definitions.length) return <p className="mystuff-help">No maintenance schedule yet.</p>
  return <div role="tabpanel"><ul className="mystuff-history">{definitions.map(definition => {
    const rows = occurrencesByDefinition.get(definition.id) || []
    return <li key={definition.id}>
      <div className="mystuff-history-row"><span><strong>{definition.name}</strong><small>{definition.description || getMaintenanceDefinitionAxes(definition).join(', ') || 'Custom schedule'}</small></span><strong>{definition.enabled === false ? 'Disabled' : `${rows.length} planned`}</strong></div>
      {rows.length > 0 && <ul className="mystuff-subhistory">{rows.map(row => <li key={row.planned_occurrence_id}><span>{statusText(row.due_status || row.status)}</span><small>{dueDetails(row)}</small></li>)}</ul>}
      <div className="mystuff-actions"><button type="button" className="mystuff-link" onClick={() => editDefinition(definition)} disabled={busy}>Edit schedule</button>{definition.enabled !== false && <button type="button" className="btn" onClick={() => beginService({ ...definition, definition_id: definition.id })} disabled={busy}>Record service</button>}</div>
    </li>
  })}</ul></div>
}

function DueView({ groups, busy, beginService, statusDrafts, setStatusDrafts, saveStatus }) {
  const sections = [['Overdue', groups.overdue], ['Due soon', groups.dueSoon], ['Upcoming', groups.upcoming], ['Completed recently', groups.completedRecently]]
  if (!sections.some(([, rows]) => rows.length)) return <p className="mystuff-help">No due items have been planned.</p>
  return <div role="tabpanel">{sections.filter(([, rows]) => rows.length).map(([heading, rows]) => <section className="mystuff-due-group" key={heading} aria-labelledby={`due-${heading.replaceAll(' ', '-').toLowerCase()}`}><h3 id={`due-${heading.replaceAll(' ', '-').toLowerCase()}`}>{heading}</h3><ul className="mystuff-history">{rows.map(row => {
    const current = statusDrafts[row.planned_occurrence_id] || { status: 'skipped', reason: '' }
    const completed = row.status === 'completed'
    return <li key={row.planned_occurrence_id}>
      <div className="mystuff-history-row"><span><strong>{row.name || 'Maintenance task'}</strong><small>{dueDetails(row)}</small></span><strong>{statusText(row.due_status || row.status)}</strong></div>
      {!completed && <>
        <div className="mystuff-actions"><button type="button" className="btn btn-primary" onClick={() => beginService(row)} disabled={busy}>Record service</button></div>
        <div className="mystuff-status-form">
          <div className="form-group"><label htmlFor={`occurrence-status-${row.planned_occurrence_id}`}>Occurrence status</label><select id={`occurrence-status-${row.planned_occurrence_id}`} value={current.status} onChange={event => setStatusDrafts(value => ({ ...value, [row.planned_occurrence_id]: { ...current, status: event.target.value } }))}>{STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <div className="form-group"><label htmlFor={`occurrence-reason-${row.planned_occurrence_id}`}>Status reason *</label><input id={`occurrence-reason-${row.planned_occurrence_id}`} value={current.reason} onChange={event => setStatusDrafts(value => ({ ...value, [row.planned_occurrence_id]: { ...current, reason: event.target.value } }))}/></div>
          <button type="button" className="btn" onClick={() => void saveStatus(row)} disabled={busy}>Save status</button>
        </div>
      </>}
    </li>
  })}</ul></section>)}</div>
}

function ServiceForm({ item, target, draft, setDraft, onSubmit, onCancel, busy }) {
  const setReading = (axis, value) => setDraft(current => ({ ...current, readings: { ...current.readings, [axis]: value } }))
  return <form className="mystuff-detail-form mystuff-service-form" onSubmit={onSubmit}>
    <h3>Record service: {target.name || target.service_name}</h3>
    <div className="mystuff-columns"><div className="form-group"><label htmlFor="service-actual-date">Actual service date *</label><input id="service-actual-date" type="date" value={draft.actualServiceDate} onChange={event => setDraft(current => ({ ...current, actualServiceDate: event.target.value }))}/></div><div className="form-group"><label htmlFor="service-provider-type">Performed by</label><select id="service-provider-type" value={draft.providerType} onChange={event => setDraft(current => ({ ...current, providerType: event.target.value }))}><option value="provider">Service provider</option><option value="diy">DIY / owner</option></select></div></div>
    <div className="mystuff-columns">{item.measurements.map(axis => <div className="form-group" key={axis}><label htmlFor={`service-reading-${axis}`}>{axis === 'miles' ? 'Mileage' : axis} at service</label><input id={`service-reading-${axis}`} type="number" min="0" step={axis === 'cycles' ? '1' : 'any'} value={draft.readings[axis]} onChange={event => setReading(axis, event.target.value)}/></div>)}</div>
    <div className="mystuff-columns"><div className="form-group"><label htmlFor="service-provider-name">Provider name</label><input id="service-provider-name" value={draft.providerName} onChange={event => setDraft(current => ({ ...current, providerName: event.target.value }))}/></div><div className="form-group"><label htmlFor="service-parts">Parts and details</label><input id="service-parts" value={draft.parts} onChange={event => setDraft(current => ({ ...current, parts: event.target.value }))}/></div></div>
    <label htmlFor="service-notes">Service notes</label><textarea id="service-notes" value={draft.notes} onChange={event => setDraft(current => ({ ...current, notes: event.target.value }))}/>
    <fieldset><legend>Optional linked expense</legend><div className="mystuff-columns"><div className="form-group"><label htmlFor="service-cost">Cost</label><input id="service-cost" type="number" min="0" step="0.01" value={draft.cost} onChange={event => setDraft(current => ({ ...current, cost: event.target.value }))}/></div><div className="form-group"><label htmlFor="service-currency">Currency</label><input id="service-currency" maxLength="3" value={draft.currency} onChange={event => setDraft(current => ({ ...current, currency: event.target.value }))}/></div></div><p className="mystuff-help">Leave cost blank to record service without creating an expense.</p></fieldset>
    <div className="mystuff-actions"><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save service and linked expense'}</button><button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button></div>
  </form>
}

function MaintenanceNumber({ label, name, value, setDraft }) {
  return <div className="form-group"><label htmlFor={`maintenance-${name}`}>{label}</label><input id={`maintenance-${name}`} type="number" min="0" step={name === 'months' || name === 'cycles' ? '1' : 'any'} value={value} onChange={event => setDraft(current => ({ ...current, [name]: event.target.value }))}/></div>
}
