import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase.js'
import { createMyStuffMaintenanceClient } from '../myStuff/maintenanceClient.js'
import { canCompleteMaintenanceDefinition, getMaintenanceDefinitionAxes } from '../myStuff/maintenanceModel.js'
import { buildCreateMaintenanceDefinitionV2WirePayload, buildRecordServiceOccurrenceV2WirePayload, buildUpdateMaintenanceDefinitionV2WirePayload } from '../myStuff/payloads.js'
import { createMutationAttemptState, mutationIdForPayload, resetMutationAttemptState } from '../myStuff/mutation.js'
import MaintenanceReminderPanel from './MaintenanceReminderPanel.jsx'

const emptyDraft = () => ({ name: '', description: '', miles: '', hours: '', cycles: '', months: '' })
const dueText = status => ({ overdue: 'Overdue', due_now: 'Due now', due_soon: 'Due soon', upcoming: 'Upcoming' }[status] || 'Not calculated')

export default function MyStuffMaintenancePanel({ item, onChanged }) {
  const client = useRef(createMyStuffMaintenanceClient(supabase))
  const createAttempt = useRef(createMutationAttemptState())
  const updateAttempt = useRef(createMutationAttemptState())
  const completionAttempts = useRef(new Map())
  const [definitions, setDefinitions] = useState([])
  const [dueRows, setDueRows] = useState([])
  const [draft, setDraft] = useState(emptyDraft)
  const [editingId, setEditingId] = useState(null)
  const [notes, setNotes] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!item?.id) return
    setError('')
    try {
      const [nextDefinitions, nextDue] = await Promise.all([
        client.current.listDefinitions(item.id),
        client.current.getDueState(item.id),
      ])
      setDefinitions(nextDefinitions)
      setDueRows(nextDue)
    } catch (next) {
      setError(next?.message || 'Maintenance schedules could not be loaded.')
    }
  }, [item?.id])

  useEffect(() => { void load() }, [load])

  const mergedSchedules = definitions.map(definition => ({
    ...definition,
    ...(dueRows.find(row => row.definition_id === definition.id) || {}),
  }))

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
    if (busy) return
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
    setBusy(true)
    setError('')
    try {
      if (editingId) await client.current.updateDefinition(wire, mutationId)
      else await client.current.createDefinition(wire, mutationId)
      resetMutationAttemptState(attempt)
      setDraft(emptyDraft())
      setEditingId(null)
      await load()
      await onChanged?.()
    } catch (next) {
      setError(next?.message || 'The maintenance schedule could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  async function complete(definition) {
    if (busy) return
    if (!canCompleteMaintenanceDefinition(definition, item)) {
      setError('Record the required usage reading before completing this maintenance task.')
      return
    }
    let attempt = completionAttempts.current.get(definition.id)
    if (!attempt) {
      attempt = createMutationAttemptState()
      completionAttempts.current.set(definition.id, attempt)
    }
    const axes = getMaintenanceDefinitionAxes(definition)
    const wire = buildRecordServiceOccurrenceV2WirePayload({
      itemId: item.id,
      definitionId: definition.id,
      completedAt: new Date().toISOString(),
      configuredAxes: axes,
      readings: item.currentUsage || {},
      notes: notes[definition.id] || '',
    })
    const mutationId = mutationIdForPayload(attempt, wire)
    setBusy(true)
    setError('')
    try {
      await client.current.recordServiceOccurrence(wire, mutationId)
      resetMutationAttemptState(attempt)
      setNotes(current => ({ ...current, [definition.id]: '' }))
      await load()
      await onChanged?.()
    } catch (next) {
      setError(next?.message || 'Maintenance completion could not be recorded.')
    } finally {
      setBusy(false)
    }
  }

  return <>
    <section className="mystuff-card" aria-labelledby="maintenance-heading">
      <div className="mystuff-section-heading"><h2 id="maintenance-heading">Maintenance schedule</h2><button type="button" className="mystuff-link" onClick={() => void load()} disabled={busy}>Refresh</button></div>
      {error && <p className="field-error" role="alert">{error}</p>}
      {mergedSchedules.length ? <ul className="mystuff-history">{mergedSchedules.map(definition => <li key={definition.id}>
        <div className="mystuff-history-row"><span><strong>{definition.name}</strong><small>{definition.description || getMaintenanceDefinitionAxes(definition).join(', ')}</small></span><strong>{dueText(definition.due_status)}</strong></div>
        <label htmlFor={`maintenance-note-${definition.id}`}>Completion notes</label>
        <input id={`maintenance-note-${definition.id}`} value={notes[definition.id] || ''} onChange={event => setNotes(current => ({ ...current, [definition.id]: event.target.value }))} />
        <div className="mystuff-actions"><button type="button" className="mystuff-link" onClick={() => editDefinition(definition)} disabled={busy}>Edit schedule</button><button type="button" className="btn btn-primary" onClick={() => void complete(definition)} disabled={busy || !canCompleteMaintenanceDefinition(definition, item)}>Mark complete</button></div>
      </li>)}</ul> : <p className="mystuff-help">No maintenance schedule yet.</p>}
      <form className="mystuff-detail-form" onSubmit={saveDefinition}>
        <h3>{editingId ? 'Edit maintenance task' : 'Add maintenance task'}</h3>
        <label htmlFor="maintenance-name">Task name *</label><input id="maintenance-name" value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} />
        <label htmlFor="maintenance-description">Description</label><input id="maintenance-description" value={draft.description} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} />
        <div className="mystuff-columns"><MaintenanceNumber label="Every miles" name="miles" value={draft.miles} setDraft={setDraft}/><MaintenanceNumber label="Every hours" name="hours" value={draft.hours} setDraft={setDraft}/></div>
        <div className="mystuff-columns"><MaintenanceNumber label="Every cycles" name="cycles" value={draft.cycles} setDraft={setDraft}/><MaintenanceNumber label="Every months" name="months" value={draft.months} setDraft={setDraft}/></div>
        <div className="mystuff-actions"><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Save schedule' : 'Add schedule'}</button>{editingId && <button type="button" className="btn" onClick={() => { setEditingId(null); setDraft(emptyDraft()) }} disabled={busy}>Cancel</button>}</div>
      </form>
    </section>
    <MaintenanceReminderPanel schedules={mergedSchedules} item={item}/>
  </>
}

function MaintenanceNumber({ label, name, value, setDraft }) {
  return <div className="form-group"><label htmlFor={`maintenance-${name}`}>{label}</label><input id={`maintenance-${name}`} type="number" min="0" step={name === 'months' || name === 'cycles' ? '1' : 'any'} value={value} onChange={event => setDraft(current => ({ ...current, [name]: event.target.value }))}/></div>
}
