import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { MAINTENANCE_PRESET_DISCLAIMER, MAINTENANCE_PRESETS, presetTaskDraft } from '../maintenance/presets'
import {
  MY_STUFF_TYPES, READING_TYPES, completeMaintenance, correctMaintenanceCompletion, createMaintenanceTask,
  createMutationId, createMyStuffItem, decodeMyStuffVin, confirmMyStuffVin, describeDue, getMaintenanceRollout, getMyStuffDeletionStatus, listMyStuffItems,
  loadMyStuffWorkspace, readingValue, recordMyStuffReading, requestMyStuffItemDeletion,
  requiresUsage,
} from '../myStuff'

const today = () => {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const emptyItem = () => ({ name: '', itemType: 'car', usageType: 'mileage', currentReading: '', purchasePrice: '', modelYear: '', make: '', model: '', notes: '' })
const emptyTask = () => ({ name: '', description: '', action: 'service', intervalMiles: '', intervalHours: '', intervalCycles: '', intervalMonths: '', lastServiceDate: '', lastServiceMileage: '', lastServiceHours: '', lastServiceCycles: '' })
const emptyCompletion = () => ({ serviceDate: today(), mileage: '', hours: '', cycles: '', currentMileage: '', currentHours: '', currentCycles: '', expenseAmount: '', expenseDescription: '', notes: '' })

function friendlyError(error) {
  const message = error?.message || 'Something went wrong.'
  if (/Free accounts can have one/i.test(message)) return 'Free includes one My Stuff item. Upgrade to Pro to add another.'
  if (/FEATURE_DISABLED/i.test(message)) return 'Maintenance safeguards are still finishing rollout. Refresh and try again shortly.'
  return message.replace(/^.*?message[:=]\s*/i, '')
}

function Field({ label, hint, children }) {
  return <div className="form-group"><label>{label}</label>{children}{hint && <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 5 }}>{hint}</div>}</div>
}

function Notice({ type = 'info', children }) {
  const danger = type === 'error'
  return <div role={danger ? 'alert' : 'status'} style={{ background: danger ? '#FFF0ED' : 'var(--accent-soft)', color: danger ? '#9F2417' : 'var(--body)', border: `1px solid ${danger ? '#F1B8AE' : 'rgba(200,64,47,.2)'}`, borderRadius: 10, padding: '10px 12px', fontSize: 13, lineHeight: 1.45, marginBottom: 14 }}>{children}</div>
}

function ReadingSummary({ item }) {
  const dimensions = item.usage_dimensions || []
  if (!dimensions.length) return <span style={{ color: 'var(--muted)' }}>Calendar-based maintenance</span>
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
    {dimensions.map(type => <span key={type} style={readingChip}>{readingValue(item, type) == null ? 'No' : Number(readingValue(item, type)).toLocaleString()} {type}</span>)}
  </div>
}

function ItemCard({ item, onOpen }) {
  const subtitle = [item.model_year, item.make, item.model].filter(Boolean).join(' ') || MY_STUFF_TYPES.find(([value]) => value === item.item_type)?.[1] || 'Item'
  return <button className="card" onClick={onOpen} style={{ width: '100%', border: '1px solid var(--border)', textAlign: 'left', cursor: 'pointer', marginBottom: 10, padding: 16 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
      <div style={{ minWidth: 0 }}><div style={{ fontSize: 17, fontWeight: 800, color: 'var(--text)' }}>{item.name}</div><div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>{subtitle}</div></div>
      <span style={{ color: '#D4CDC1', fontSize: 22 }}>›</span>
    </div>
    <div style={{ marginTop: 12 }}><ReadingSummary item={item} /></div>
  </button>
}

function AddItemForm({ onCancel, onSaved }) {
  const [form, setForm] = useState(emptyItem)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const required = requiresUsage(form.itemType)
  const mutationId = useMemo(() => createMutationId('my-stuff-create'), [form])

  useEffect(() => {
    if (required && !form.usageType) setForm(current => ({ ...current, usageType: 'mileage' }))
  }, [required, form.usageType])

  async function submit(event) {
    event.preventDefault()
    setError('')
    if (!form.name.trim()) return setError('Enter a name for this item.')
    if (required && (!form.usageType || form.currentReading === '' || form.purchasePrice === '')) return setError('Choose usage tracking and enter the current reading and purchase price.')
    setSaving(true)
    try { await createMyStuffItem(form, mutationId); await onSaved() } catch (err) { setError(friendlyError(err)) } finally { setSaving(false) }
  }

  return <form onSubmit={submit} className="card" style={{ marginBottom: 18 }}>
    <h2 style={formTitle}>Add to My Stuff</h2>
    {error && <Notice type="error">{error}</Notice>}
    <Field label="Name"><input autoFocus value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. 2018 Ford F-150" maxLength={200} /></Field>
    <Field label="Item type"><select value={form.itemType} onChange={e => setForm({ ...form, itemType: e.target.value })}>{MY_STUFF_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
    <Field label="Usage tracking" hint={required ? 'Required for this item type.' : 'Optional.'}><select value={form.usageType} onChange={e => setForm({ ...form, usageType: e.target.value, currentReading: e.target.value ? form.currentReading : '' })}><option value="">Calendar only</option>{READING_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
    {form.usageType && <Field label={`Current ${form.usageType}`}><input type="number" inputMode="decimal" min="0" step="0.1" value={form.currentReading} onChange={e => setForm({ ...form, currentReading: e.target.value })} required={required} /></Field>}
    <Field label={`Purchase price${required ? '' : ' (optional)'}`}><input type="number" inputMode="decimal" min="0" step="0.01" value={form.purchasePrice} onChange={e => setForm({ ...form, purchasePrice: e.target.value })} required={required} /></Field>
    <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 10 }}><Field label="Year"><input type="number" inputMode="numeric" min="1800" max="2200" value={form.modelYear} onChange={e => setForm({ ...form, modelYear: e.target.value })} /></Field><Field label="Make"><input value={form.make} onChange={e => setForm({ ...form, make: e.target.value })} /></Field></div>
    <Field label="Model"><input value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} /></Field>
    <Field label="Notes (optional)"><textarea rows="3" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></Field>
    <div style={actions}><button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Add Item'}</button></div>
  </form>
}

function ReadingForm({ item, v4Enabled, onSaved, onCancel }) {
  const dimensions = item.usage_dimensions || []
  const [type, setType] = useState(dimensions[0] || 'mileage')
  const [value, setValue] = useState(readingValue(item, dimensions[0] || 'mileage') ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const mutationId = useMemo(() => createMutationId('my-stuff-reading'), [type, value])
  async function submit(event) {
    event.preventDefault(); setError(''); setSaving(true)
    try { await recordMyStuffReading(item, type, value, v4Enabled, mutationId); await onSaved() } catch (err) { setError(friendlyError(err)) } finally { setSaving(false) }
  }
  return <form className="card" onSubmit={submit} style={{ marginBottom: 14 }}><h3 style={formTitle}>Update Usage</h3>{error && <Notice type="error">{error}</Notice>}<Field label="Reading type"><select value={type} onChange={e => { setType(e.target.value); setValue(readingValue(item, e.target.value) ?? '') }}>{READING_TYPES.filter(([value]) => dimensions.includes(value)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label={`Current ${type}`}><input autoFocus type="number" inputMode="decimal" min="0" step="0.1" value={value} onChange={e => setValue(e.target.value)} required /></Field><div style={actions}><button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Reading'}</button></div></form>
}

function TaskForm({ item, v4Enabled, initialDraft, onSaved, onCancel }) {
  const [form, setForm] = useState(() => initialDraft ? ({ ...emptyTask(), ...initialDraft }) : ({ ...emptyTask(), currentMileage: readingValue(item, 'mileage') ?? '' }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const mutationId = useMemo(() => createMutationId('my-stuff-task'), [form])
  async function submit(event) {
    event.preventDefault(); setError('')
    if (!form.name.trim()) return setError('Enter a task name.')
    if (![form.intervalMiles, form.intervalHours, form.intervalCycles, form.intervalMonths].some(value => value !== '')) return setError('Enter at least one mileage, hours, cycles, or calendar interval.')
    setSaving(true)
    try { await createMaintenanceTask(item, form, v4Enabled, mutationId); await onSaved() } catch (err) { setError(friendlyError(err)) } finally { setSaving(false) }
  }
  return <form className="card" onSubmit={submit} style={{ marginBottom: 14 }}><h3 style={formTitle}>Add Maintenance Task</h3>{error && <Notice type="error">{error}</Notice>}<Field label="Task name"><input autoFocus value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Change engine oil" required maxLength={200} /></Field><Field label="Action"><select value={form.action} onChange={e => setForm({ ...form, action: e.target.value })}>{['service','inspect','check','adjust','replace','repair','lubricate','clean','other'].map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></Field><div style={twoColumns}>{(item.usage_dimensions || []).includes('mileage') && <Field label="Every miles"><input type="number" inputMode="numeric" min="1" value={form.intervalMiles} onChange={e => setForm({ ...form, intervalMiles: e.target.value })} /></Field>}<Field label="Every months"><input type="number" inputMode="numeric" min="1" value={form.intervalMonths} onChange={e => setForm({ ...form, intervalMonths: e.target.value })} /></Field>{(item.usage_dimensions || []).includes('hours') && <Field label="Every hours"><input type="number" inputMode="decimal" min="1" value={form.intervalHours} onChange={e => setForm({ ...form, intervalHours: e.target.value })} /></Field>}{(item.usage_dimensions || []).includes('cycles') && <Field label="Every cycles"><input type="number" inputMode="numeric" min="1" value={form.intervalCycles} onChange={e => setForm({ ...form, intervalCycles: e.target.value })} /></Field>}</div>{v4Enabled && <><div style={subhead}>Last service baseline (optional)</div><Field label="Last serviced on"><input type="date" max={today()} value={form.lastServiceDate} onChange={e => setForm({ ...form, lastServiceDate: e.target.value })} /></Field><div style={twoColumns}>{(item.usage_dimensions || []).includes('mileage') && <Field label="Last service mileage"><input type="number" inputMode="decimal" min="0" value={form.lastServiceMileage} onChange={e => setForm({ ...form, lastServiceMileage: e.target.value })} /></Field>}{(item.usage_dimensions || []).includes('hours') && <Field label="Last service hours"><input type="number" inputMode="decimal" min="0" value={form.lastServiceHours} onChange={e => setForm({ ...form, lastServiceHours: e.target.value })} /></Field>}{(item.usage_dimensions || []).includes('cycles') && <Field label="Last service cycles"><input type="number" inputMode="numeric" min="0" value={form.lastServiceCycles} onChange={e => setForm({ ...form, lastServiceCycles: e.target.value })} /></Field>}</div>{(item.usage_dimensions || []).includes('mileage') && <Field label="Confirm current mileage"><input type="number" inputMode="decimal" min="0" value={form.currentMileage} onChange={e => setForm({ ...form, currentMileage: e.target.value })} required /></Field>}</>}<Field label="Description (optional)"><textarea rows="2" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></Field><div style={actions}><button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Add Task'}</button></div></form>
}

function CompletionForm({ item, definition, v4Enabled, onSaved, onCancel }) {
  const [form, setForm] = useState(() => ({
    ...emptyCompletion(),
    mileage: readingValue(item, 'mileage') ?? '', currentMileage: readingValue(item, 'mileage') ?? '',
    hours: readingValue(item, 'hours') ?? '', currentHours: readingValue(item, 'hours') ?? '',
    cycles: readingValue(item, 'cycles') ?? '', currentCycles: readingValue(item, 'cycles') ?? '',
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const mutationId = useMemo(() => createMutationId('my-stuff-complete'), [form])
  async function submit(event) {
    event.preventDefault(); setError('')
    for (const [service, current, prior, label] of [
      [form.mileage, form.currentMileage, readingValue(item, 'mileage'), 'mileage'],
      [form.hours, form.currentHours, readingValue(item, 'hours'), 'hours'],
      [form.cycles, form.currentCycles, readingValue(item, 'cycles'), 'cycles'],
    ]) {
      if (service !== '' && current !== '' && Number(service) > Number(current)) return setError(`Service ${label} cannot exceed current ${label}.`)
      if (current !== '' && prior != null && Number(current) < Number(prior)) return setError(`Current ${label} cannot move backwards.`)
    }
    setSaving(true)
    try { await completeMaintenance(item, definition, form, v4Enabled, mutationId); await onSaved() } catch (err) { setError(friendlyError(err)) } finally { setSaving(false) }
  }
  const dimensions = item.usage_dimensions || []
  return <form className="card" onSubmit={submit} style={{ marginBottom: 14, border: '1px solid rgba(49,122,77,.28)' }}><h3 style={formTitle}>Complete {definition.name}</h3>{error && <Notice type="error">{error}</Notice>}<Field label="Service date"><input type="date" max={today()} value={form.serviceDate} onChange={e => setForm({ ...form, serviceDate: e.target.value })} required /></Field>{dimensions.includes('mileage') && <Field label="Mileage at service"><input type="number" inputMode="decimal" min="0" value={form.mileage} onChange={e => setForm({ ...form, mileage: e.target.value })} /></Field>}{dimensions.includes('hours') && <Field label="Hours at service"><input type="number" inputMode="decimal" min="0" value={form.hours} onChange={e => setForm({ ...form, hours: e.target.value })} /></Field>}{dimensions.includes('cycles') && <Field label="Cycles at service"><input type="number" inputMode="numeric" min="0" value={form.cycles} onChange={e => setForm({ ...form, cycles: e.target.value })} /></Field>}{v4Enabled && <><div style={subhead}>Current usage after service</div>{dimensions.includes('mileage') && <Field label="Current mileage"><input type="number" inputMode="decimal" min="0" value={form.currentMileage} onChange={e => setForm({ ...form, currentMileage: e.target.value })} /></Field>}{dimensions.includes('hours') && <Field label="Current hours"><input type="number" inputMode="decimal" min="0" value={form.currentHours} onChange={e => setForm({ ...form, currentHours: e.target.value })} /></Field>}{dimensions.includes('cycles') && <Field label="Current cycles"><input type="number" inputMode="numeric" min="0" value={form.currentCycles} onChange={e => setForm({ ...form, currentCycles: e.target.value })} /></Field>}</>}<div style={subhead}>Optional expense</div><div style={twoColumns}><Field label="Amount"><input type="number" inputMode="decimal" min="0.01" step="0.01" value={form.expenseAmount} onChange={e => setForm({ ...form, expenseAmount: e.target.value })} /></Field><Field label="Description"><input value={form.expenseDescription} onChange={e => setForm({ ...form, expenseDescription: e.target.value })} placeholder={definition.name} /></Field></div><Field label="Notes (optional)"><textarea rows="3" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></Field><div style={actions}><button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Mark Complete'}</button></div></form>
}

function CorrectionForm({ entry, onSaved, onCancel }) {
  const windowEdit = !entry.historical_locked_from_window_edit && entry.original?.lock_deadline && Date.now() < new Date(entry.original.lock_deadline).getTime()
  const [form, setForm] = useState({
    serviceDate: entry.service_performed_on || today(), mileage: entry.service_mileage ?? '',
    hours: entry.service_hours ?? '', cycles: entry.service_cycles ?? '',
    currentMileage: entry.current_mileage ?? '', currentHours: entry.current_hours ?? '', currentCycles: entry.current_cycles ?? '',
    notes: entry.notes || '', reason: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const mutationId = useMemo(() => createMutationId('my-stuff-correction'), [form])
  async function submit(event) {
    event.preventDefault(); setError('')
    if (!windowEdit && !form.reason.trim()) return setError('Enter why this correction is needed.')
    setSaving(true)
    try { await correctMaintenanceCompletion(entry, form, mutationId); await onSaved() } catch (err) { setError(friendlyError(err)) } finally { setSaving(false) }
  }
  return <form className="card" onSubmit={submit} style={{ marginBottom: 14 }}><h3 style={formTitle}>{windowEdit ? 'Edit record' : 'Add correction'}</h3>{error && <Notice type="error">{error}</Notice>}<Field label="Service date"><input type="date" max={today()} value={form.serviceDate} onChange={e => setForm({ ...form, serviceDate: e.target.value })} required /></Field><div style={twoColumns}><Field label="Service mileage"><input type="number" inputMode="decimal" min="0" value={form.mileage} onChange={e => setForm({ ...form, mileage: e.target.value })} /></Field><Field label="Service hours"><input type="number" inputMode="decimal" min="0" value={form.hours} onChange={e => setForm({ ...form, hours: e.target.value })} /></Field><Field label="Service cycles"><input type="number" inputMode="numeric" min="0" value={form.cycles} onChange={e => setForm({ ...form, cycles: e.target.value })} /></Field></div><div style={subhead}>Current usage after correction</div><div style={twoColumns}><Field label="Current mileage"><input type="number" inputMode="decimal" min="0" value={form.currentMileage} onChange={e => setForm({ ...form, currentMileage: e.target.value })} /></Field><Field label="Current hours"><input type="number" inputMode="decimal" min="0" value={form.currentHours} onChange={e => setForm({ ...form, currentHours: e.target.value })} /></Field><Field label="Current cycles"><input type="number" inputMode="numeric" min="0" value={form.currentCycles} onChange={e => setForm({ ...form, currentCycles: e.target.value })} /></Field></div><Field label="Notes"><textarea rows="3" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></Field><Field label={windowEdit ? 'Edit note (optional)' : 'Reason for correction'}><textarea rows="2" value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} required={!windowEdit} maxLength={2000} /></Field><div style={actions}><button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Correction'}</button></div></form>
}

const VIN_ITEM_TYPES = new Set(['car', 'truck', 'motorcycle', 'rv'])

function VinPanel({ item, onSaved }) {
  const [vin, setVin] = useState(item.vin || '')
  const [preview, setPreview] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const mutationId = useMemo(() => createMutationId('my-stuff-vin'), [vin, preview])
  if (!VIN_ITEM_TYPES.has(item.item_type)) return null
  async function decode(event) {
    event.preventDefault(); setError(''); setPreview(null)
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin.trim().toUpperCase())) return setError('Enter a valid 17-character VIN.')
    setSaving(true)
    try { setPreview(await decodeMyStuffVin(item.id, vin)) } catch (err) { setError(friendlyError(err)) } finally { setSaving(false) }
  }
  async function confirm() {
    if (!preview) return
    setSaving(true); setError('')
    try { await confirmMyStuffVin(item.id, vin, preview.vehicle, mutationId); await onSaved() } catch (err) { setError(friendlyError(err)) } finally { setSaving(false) }
  }
  const vehicle = preview?.vehicle
  return <form className="card" onSubmit={decode} style={{ marginBottom: 16 }}><h2 style={sectionTitle}>{item.vin_confirmed_at ? 'Vehicle identity' : 'Decode VIN'}</h2>{error && <Notice type="error">{error}</Notice>}<p style={muted}>VIN decoding uses the U.S. National Highway Traffic Safety Administration’s vPIC service. Review decoded details before confirming; you can enter year, make, and model manually when creating an item.</p><Field label="VIN"><input value={vin} onChange={e => { setVin(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17)); setPreview(null) }} autoCapitalize="characters" autoComplete="off" /></Field>{vehicle && <div style={{ background: 'var(--surface)', borderRadius: 10, padding: 12, marginBottom: 12 }}><strong>{[vehicle.modelYear, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ')}</strong>{vehicle.engineModel && <div style={{ ...muted, marginTop: 4 }}>Engine: {vehicle.engineModel}</div>}{preview.warnings?.length > 0 && <div style={{ ...muted, marginTop: 6 }}>NHTSA returned {preview.warnings.length} warning{preview.warnings.length === 1 ? '' : 's'}; review before confirming.</div>}</div>}{vehicle ? <div style={actions}><button type="submit" className="btn btn-secondary" disabled={saving}>Decode again</button><button type="button" className="btn btn-primary" disabled={saving} onClick={confirm}>{saving ? 'Saving…' : 'Confirm details'}</button></div> : <button className="btn btn-secondary" disabled={saving}>{saving ? 'Decoding…' : 'Decode VIN'}</button>}</form>
}

function ItemDetail({ item, v4Enabled, onBack, onRefresh, onDeleted }) {
  const [workspace, setWorkspace] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [panel, setPanel] = useState('')
  const [completion, setCompletion] = useState(null)
  const [correction, setCorrection] = useState(null)
  const [presetDraft, setPresetDraft] = useState(null)
  const [deleteText, setDeleteText] = useState('')
  const [reminderStatus, setReminderStatus] = useState('')
  const deletionMutationId = useMemo(() => createMutationId('my-stuff-delete'), [item.id])

  const reload = useCallback(async () => { setLoading(true); setError(''); try { setWorkspace(await loadMyStuffWorkspace(item.id, v4Enabled)) } catch (err) { setError(friendlyError(err)) } finally { setLoading(false) } }, [item.id, v4Enabled])
  useEffect(() => { reload() }, [reload])
  async function saved() { setPanel(''); setCompletion(null); setCorrection(null); setPresetDraft(null); await onRefresh(); await reload() }
  function printReport() {
    if (!workspace?.report) return
    const reportWindow = window.open('', '_blank')
    if (!reportWindow) return setError('Allow pop-ups to print or save the maintenance report as a PDF.')
    reportWindow.opener = null
    reportWindow.document.title = `${item.name} maintenance report`
    const heading = reportWindow.document.createElement('h1'); heading.textContent = `${item.name} maintenance report`
    const disclaimer = reportWindow.document.createElement('p'); disclaimer.textContent = workspace.report.owner_report_disclaimer || 'Owner-reported SideFlip records.'
    const content = reportWindow.document.createElement('pre'); content.textContent = JSON.stringify(workspace.report, null, 2); content.style.whiteSpace = 'pre-wrap'
    reportWindow.document.body.append(heading, disclaimer, content)
    reportWindow.setTimeout(() => reportWindow.print(), 100)
  }
  async function remove() {
    if (!v4Enabled || deleteText !== 'DELETE' || !window.confirm(`Permanently delete ${item.name}? This is the final confirmation.`)) return
    try { const result = await requestMyStuffItemDeletion(item.id, deletionMutationId); onDeleted(result) } catch (err) { setError(friendlyError(err)) }
  }
  async function enableReminders() {
    if (!('Notification' in window)) return setReminderStatus('Notifications are unavailable in this browser.')
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return setReminderStatus('Notifications were not enabled. Your due list remains available here.')
    const due = (workspace?.definitions || []).filter(definition => ['overdue', 'due_now'].includes(definition.state?.due_status))
    try {
      if (due.length) new Notification('SideFlip maintenance reminder', { body: due.length === 1 ? `${due[0].name} is due.` : `${due.length} maintenance tasks are due or overdue.` })
      setReminderStatus(due.length ? 'A foreground reminder was sent. Reminders work while SideFlip is open.' : 'Reminders are enabled while SideFlip is open; nothing is currently due.')
    } catch { setReminderStatus('Permission is enabled, but this browser cannot show a foreground reminder.') }
  }

  return <><div className="page-header"><button className="back-btn" onClick={onBack} style={backButton}>‹</button><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 19, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</div><div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>My Stuff</div></div></div><div className="page" style={{ paddingBottom: 115 }}>{error && <Notice type="error">{error}</Notice>}<div className="card" style={{ marginBottom: 14 }}><ReadingSummary item={item} />{(item.usage_dimensions || []).length > 0 && <button className="btn btn-secondary" style={{ marginTop: 12 }} onClick={() => setPanel(panel === 'reading' ? '' : 'reading')}>Update usage</button>}</div>{!item.vin_confirmed_at && <VinPanel item={item} onSaved={saved} />}{panel === 'reading' && <ReadingForm item={item} v4Enabled={v4Enabled} onSaved={saved} onCancel={() => setPanel('')} />}{panel === 'task' && <TaskForm item={item} v4Enabled={v4Enabled} onSaved={saved} onCancel={() => setPanel('')} />}{panel === 'presets' && <div className="card" style={{ marginBottom: 14 }}><h3 style={formTitle}>Common maintenance</h3><p style={muted}>{MAINTENANCE_PRESET_DISCLAIMER}</p>{MAINTENANCE_PRESETS.map(preset => { const duplicate = workspace?.definitions?.some(definition => definition.name.trim().toLowerCase() === preset.name.toLowerCase() && definition.service_action === preset.persistedAction); return <button key={preset.id} className="btn btn-secondary" disabled={duplicate} style={{ width: '100%', marginBottom: 8, textAlign: 'left' }} onClick={() => { setPresetDraft(presetTaskDraft(preset, item)); setPanel('preset-edit') }}>{preset.name}{duplicate ? ' · Added' : ''}</button> })}<button className="btn btn-secondary" onClick={() => setPanel('')}>Cancel</button></div>}{panel === 'preset-edit' && presetDraft && <TaskForm item={item} v4Enabled={v4Enabled} initialDraft={presetDraft} onSaved={saved} onCancel={() => { setPanel('presets'); setPresetDraft(null) }} />}{completion && <CompletionForm item={item} definition={completion} v4Enabled={v4Enabled} onSaved={saved} onCancel={() => setCompletion(null)} />}{correction && <CorrectionForm entry={correction} onSaved={saved} onCancel={() => setCorrection(null)} />}<section className="card" style={{ marginBottom: 16 }}><div style={sectionHeader}><h2 style={sectionTitle}>Reminders</h2><button className="btn btn-secondary" style={{ padding: '8px 9px', margin: 0 }} onClick={enableReminders}>Enable reminders</button></div>{(workspace?.definitions || []).filter(definition => ['overdue', 'due_now'].includes(definition.state?.due_status)).map(definition => <div key={definition.id} style={{ fontSize: 13, marginTop: 8 }}><strong>{definition.name}</strong> · {describeDue(definition.state)}</div>)}{!(workspace?.definitions || []).some(definition => ['overdue', 'due_now'].includes(definition.state?.due_status)) && <div style={muted}>Nothing is currently due or overdue.</div>}{reminderStatus && <div style={{ ...muted, marginTop: 8 }}>{reminderStatus}</div>}</section><section><div style={sectionHeader}><h2 style={sectionTitle}>Maintenance</h2><div style={{ display: 'flex', gap: 6 }}>{v4Enabled && <button className="btn btn-secondary" style={{ padding: '8px 9px', margin: 0 }} onClick={() => setPanel(panel === 'presets' ? '' : 'presets')}>Common</button>}<button className="btn btn-secondary" style={{ padding: '8px 9px', margin: 0 }} onClick={() => setPanel(panel === 'task' ? '' : 'task')}>+ Task</button></div></div>{loading ? <div style={muted}>Loading maintenance…</div> : workspace?.definitions.length ? workspace.definitions.map(definition => { const status = definition.state?.due_status || 'upcoming'; return <div className="card" key={definition.id} style={{ marginBottom: 10 }}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}><div><div style={{ fontWeight: 800 }}>{definition.name}</div><div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{describeDue(definition.state)}</div></div><span style={statusStyle(status)}>{status.replaceAll('_', ' ')}</span></div><button className="btn btn-primary" style={{ marginTop: 13 }} onClick={() => setCompletion(definition)}>Complete</button></div> }) : <div className="empty" style={{ padding: '22px 16px' }}><div className="empty-icon">🛠️</div><h3>No maintenance tasks yet</h3><p>Add an interval to track what is due next.</p></div>}</section><section style={{ marginTop: 24 }}><h2 style={sectionTitle}>Service History</h2><div style={{ ...muted, marginBottom: 10 }}>Owner-reported SideFlip records.</div>{workspace?.history?.length ? workspace.history.map(entry => <div className="card" key={entry.id || entry.occurrence_id} style={{ marginBottom: 9 }}><div style={{ fontWeight: 700 }}>{entry.service_name || 'Maintenance service'}</div><div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 3 }}>{entry.service_performed_on ? new Date(`${entry.service_performed_on}T12:00:00`).toLocaleDateString() : new Date(entry.completed_at || entry.received_at).toLocaleDateString()}{entry.service_mileage ?? entry.mileage ? ` · ${Number(entry.service_mileage ?? entry.mileage).toLocaleString()} mi` : ''}</div>{entry.notes && <div style={{ fontSize: 13, marginTop: 8 }}>{entry.notes}</div>}{v4Enabled && <button className="btn btn-secondary" style={{ marginTop: 10 }} onClick={() => setCorrection(entry)}>{!entry.historical_locked_from_window_edit && entry.original?.lock_deadline && Date.now() < new Date(entry.original.lock_deadline).getTime() ? 'Edit record' : 'Add correction'}</button>}</div>) : <div style={muted}>No completed maintenance yet.</div>}</section>{item.vin_confirmed_at && <VinPanel item={item} onSaved={saved} />}{v4Enabled && <section style={{ marginTop: 26 }}><div style={sectionHeader}><h2 style={sectionTitle}>Integrity & deletion</h2>{workspace?.report && <button className="btn btn-secondary" onClick={printReport}>Print / Save PDF</button>}</div>{panel === 'delete' ? <div className="card"><p style={muted}>Print or save your maintenance report as a PDF first if you want a copy. Type DELETE, then review the final confirmation.</p><Field label="Type DELETE"><input value={deleteText} onChange={e => setDeleteText(e.target.value)} autoCapitalize="characters" /></Field><div style={actions}><button className="btn btn-secondary" onClick={() => { setPanel(''); setDeleteText('') }}>Cancel</button><button className="btn btn-primary" disabled={deleteText !== 'DELETE'} onClick={remove}>Review deletion</button></div></div> : <button onClick={() => setPanel('delete')} style={{ width: '100%', background: 'none', border: 'none', color: 'var(--accent)', padding: 12, fontFamily: 'var(--font)', fontWeight: 700 }}>Delete Item</button>}</section>}</div></>
}

export default function MyStuff() {
  const { user } = useAuth()
  const [items, setItems] = useState([])
  const [rollout, setRollout] = useState({ feature_enabled: false })
  const [selectedId, setSelectedId] = useState(null)
  const [adding, setAdding] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pendingDeletion, setPendingDeletion] = useState(null)

  const selected = useMemo(() => items.find(item => item.id === selectedId), [items, selectedId])
  const refresh = useCallback(async () => { if (!user?.id) return; const data = await listMyStuffItems(user.id); setItems(data); return data }, [user?.id])
  useEffect(() => { let active = true; Promise.all([getMaintenanceRollout(), listMyStuffItems(user.id)]).then(([nextRollout, nextItems]) => { if (!active) return; setRollout(nextRollout); setItems(nextItems) }).catch(err => active && setError(friendlyError(err))).finally(() => active && setLoading(false)); return () => { active = false } }, [user.id])
  useEffect(() => { const onVisible = () => { if (document.visibilityState === 'visible') getMaintenanceRollout().then(setRollout).catch(err => setError(friendlyError(err))) }; document.addEventListener('visibilitychange', onVisible); return () => document.removeEventListener('visibilitychange', onVisible) }, [])
  useEffect(() => {
    if (!pendingDeletion) return undefined
    let active = true
    const check = async () => {
      try {
        const status = await getMyStuffDeletionStatus(pendingDeletion)
        if (!active) return
        if (status.status === 'complete') { setNotice('Item deletion completed.'); setPendingDeletion(null); await refresh() }
        else setNotice(status.status === 'failed' ? 'Deletion is waiting for an automatic retry.' : 'Deletion is queued. SideFlip will confirm here when cleanup is complete.')
      } catch (err) { if (active) setError(friendlyError(err)) }
    }
    check(); const timer = setInterval(check, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [pendingDeletion, refresh])

  async function itemSaved() { const next = await refresh(); setAdding(false); if (next?.[0]) setSelectedId(next[0].id) }
  function deletionRequested(result) { setNotice('Deletion is queued. SideFlip will confirm here when cleanup is complete.'); setPendingDeletion(result?.id || null); setSelectedId(null) }

  if (selected) return <ItemDetail item={selected} v4Enabled={Boolean(rollout.feature_enabled)} onBack={() => setSelectedId(null)} onRefresh={refresh} onDeleted={deletionRequested} />
  return <><div className="page-header"><div className="wordmark" style={{ flex: 1 }}><span className="wordmark-side">My </span><span className="wordmark-flip">Stuff</span></div><button className="btn btn-primary" style={{ width: 'auto', padding: '9px 13px', margin: 0 }} onClick={() => setAdding(value => !value)}>{adding ? 'Close' : '+ Add'}</button></div><div className="page" style={{ paddingBottom: 115 }}>{error && <Notice type="error">{error}</Notice>}{notice && <Notice>{notice}</Notice>}{adding && <AddItemForm onCancel={() => setAdding(false)} onSaved={itemSaved} />}{loading ? <div style={muted}>Loading your items…</div> : items.length ? items.map(item => <ItemCard item={item} key={item.id} onOpen={() => { setNotice(''); setSelectedId(item.id) }} />) : !adding && <div className="empty"><div className="empty-icon">🧰</div><h3>Keep track of what you own</h3><p>Add an item to track usage, service intervals, and maintenance history.</p><button className="btn btn-primary" style={{ marginTop: 14 }} onClick={() => setAdding(true)}>Add Your First Item</button></div>}<div style={{ ...muted, marginTop: 22, lineHeight: 1.5 }}>Free includes one My Stuff item. SideFlip Pro unlocks additional items.</div></div></>
}

const formTitle = { fontSize: 18, margin: '0 0 15px' }
const actions = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 8 }
const twoColumns = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }
const subhead = { fontSize: 11, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '18px 0 10px' }
const sectionHeader = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }
const sectionTitle = { fontSize: 17, margin: 0 }
const muted = { color: 'var(--muted)', fontSize: 13 }
const readingChip = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 999, padding: '5px 9px', fontSize: 12, fontWeight: 700, color: 'var(--body)' }
const backButton = { background: '#C8402F', border: 'none', color: '#fff', fontSize: 20, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: '50%', padding: 0, marginRight: 12 }
function statusStyle(status) { const urgent = status === 'overdue' || status === 'due_now'; return { flexShrink: 0, alignSelf: 'flex-start', borderRadius: 999, padding: '4px 8px', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', background: urgent ? '#FFF0ED' : status === 'due_soon' ? '#FFF6DF' : '#EEF7F1', color: urgent ? '#A12C1E' : status === 'due_soon' ? '#8A6210' : '#317A4D' } }
