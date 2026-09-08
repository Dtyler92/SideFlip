import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { getPlan } from '../capabilities.js'
import MyStuffMaintenancePanel from '../components/MyStuffMaintenancePanel.jsx'
import MyStuffVinDecodePanel from '../components/MyStuffVinDecodePanel.jsx'
import ManufacturerMaintenanceResearch from '../components/ManufacturerMaintenanceResearch.jsx'
import PrivateReportPanel from '../components/PrivateReportPanel.jsx'
import {
  createMyStuffExpenseV3,
  deleteMyStuffItem,
  getMyStuffExpensesV3,
  getMyStuffFinancialSummaryV3,
  getMyStuffItemV2,
  recordMyStuffReadingV2,
  reviseMyStuffExpenseV3,
  reviseMyStuffServiceExpenseV3,
  setMyStuffItemArchivedV2,
  transferMyStuffToProjectV1,
  updateMyStuffItemV2,
  voidMyStuffExpenseV3,
} from '../myStuff/api.js'
import { ITEM_TYPE_OPTIONS, getItemCategoryContract, selectItemType, supportsVinDecoder, validateItemDraft } from '../myStuff/itemModel.js'
import { buildRecordMyStuffReadingV2WirePayload, buildUpdateMyStuffItemV2WirePayload } from '../myStuff/payloads.js'
import { buildExpenseDraft, EXPENSE_CATEGORIES, expenseRevision, reviseExpenseByLinkage } from '../myStuff/v3Model.js'
import { createMutationAttemptState, mutationIdForPayload, resetMutationAttemptState } from '../myStuff/mutation.js'
import './myStuff.css'

const AXES = [['miles', 'Miles'], ['hours', 'Hours'], ['cycles', 'Cycles']]
const today = () => new Date().toISOString().slice(0, 10)
const emptyExpense = () => ({ description: '', category: 'maintenance', customCategory: '', amount: '', currency: 'USD', incurredOn: today(), vendor: '', notes: '' })

function itemToDraft(item) {
  return {
    itemId: item.id,
    name: item.name || '', itemType: item.itemType, category: item.category,
    year: item.model_year ?? '', make: item.make || '', model: item.model || '', trim: item.trim || '',
    modelNumber: item.model_number || '', serialNumber: item.serial_number || '', vin: item.vin || '',
    engine: item.engine || '', transmission: item.transmission || '', drivetrain: item.drivetrain || '', fuelType: item.fuel_power_type || '',
    acquiredOn: item.acquired_on || '', manufacturedOn: item.manufactured_on || '', inServiceOn: item.in_service_on || '',
    purchasePrice: item.purchase_price ?? '', purchaseCurrency: item.purchase_currency || 'USD', purchaseVendor: item.purchase_vendor || '',
    usageProfile: item.usage_profile || 'normal', measurements: item.measurements || [], notes: item.notes || '',
  }
}

export default function MyStuffDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user, profile, entitlement } = useAuth()
  const [item, setItem] = useState(null)
  const [readings, setReadings] = useState([])
  const [expenses, setExpenses] = useState([])
  const [summary, setSummary] = useState(null)
  const [edit, setEdit] = useState(null)
  const [editing, setEditing] = useState(false)
  const [errors, setErrors] = useState({})
  const [reading, setReading] = useState({ type: 'miles', value: '', recordedOn: today() })
  const [expense, setExpense] = useState(emptyExpense)
  const [editingExpenseId, setEditingExpenseId] = useState(null)
  const [revisionReason, setRevisionReason] = useState('')
  const [detailView, setDetailView] = useState('maintenance')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const itemAttempt = useRef(createMutationAttemptState())
  const readingAttempt = useRef(createMutationAttemptState())
  const expenseAttempt = useRef(createMutationAttemptState())
  const archiveAttempt = useRef(createMutationAttemptState())
  const transferAttempt = useRef(createMutationAttemptState())
  const vinPersistAttempt = useRef(createMutationAttemptState())
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    if (!user?.id || !id) return
    setError('')
    try {
      const [core, expenseRows, financial] = await Promise.all([
        getMyStuffItemV2(user.id, id),
        getMyStuffExpensesV3(id),
        getMyStuffFinancialSummaryV3(id),
      ])
      setItem(core.item)
      setReadings(core.readings)
      setExpenses(expenseRows)
      setSummary(financial)
      setEdit(itemToDraft(core.item))
      setReading(current => ({ ...current, type: core.item.measurements.includes(current.type) ? current.type : (core.item.measurements[0] || 'miles') }))
    } catch (next) {
      setError(next.message || 'Could not load this item.')
    } finally {
      setLoading(false)
    }
  }, [id, user?.id])

  useEffect(() => { void load() }, [load])

  async function run(action, after) {
    if (inFlight.current) return
    inFlight.current = true
    setSaving(true)
    setError('')
    try {
      await action()
      await after?.()
    } catch (next) {
      setError(next.message || 'The change could not be saved.')
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  function setEditValue(name, value) {
    setErrors({})
    setEdit(current => ({ ...current, [name]: value }))
  }

  function chooseType(value) {
    setErrors({})
    setEdit(current => selectItemType(current, value))
  }

  function toggleMeasurement(axis) {
    setEdit(current => ({ ...current, measurements: current.measurements.includes(axis) ? current.measurements.filter(value => value !== axis) : [...current.measurements, axis] }))
  }

  async function persistVehicleIdentity(snapshot) {
    const next = { ...edit, ...snapshot }
    const wire = buildUpdateMyStuffItemV2WirePayload(next)
    const mutationId = mutationIdForPayload(vinPersistAttempt.current, wire)
    await updateMyStuffItemV2(wire, mutationId)
    resetMutationAttemptState(vinPersistAttempt.current)
    setEdit(next)
  }

  async function saveItem(event) {
    event.preventDefault()
    const validation = validateItemDraft(edit)
    setErrors(validation.errors)
    if (!validation.ok) return
    const wire = buildUpdateMyStuffItemV2WirePayload(edit)
    const mutationId = mutationIdForPayload(itemAttempt.current, wire)
    await run(() => updateMyStuffItemV2(wire, mutationId), async () => {
      resetMutationAttemptState(itemAttempt.current)
      setEditing(false)
      await load()
    })
  }

  async function saveReading(event) {
    event.preventDefault()
    const value = Number(reading.value)
    if (!item.measurements.includes(reading.type) || !Number.isFinite(value) || value < 0 || (reading.type === 'cycles' && !Number.isInteger(value))) {
      setError('Enter a valid non-negative reading for a tracked measurement.')
      return
    }
    const wire = buildRecordMyStuffReadingV2WirePayload({ itemId: id, readingType: reading.type, value, recordedAt: `${reading.recordedOn}T12:00:00.000Z` })
    const mutationId = mutationIdForPayload(readingAttempt.current, wire)
    await run(() => recordMyStuffReadingV2(wire, mutationId), async () => {
      resetMutationAttemptState(readingAttempt.current)
      setReading(current => ({ ...current, value: '', recordedOn: today() }))
      await load()
    })
  }

  async function saveExpense(event) {
    event.preventDefault()
    let draft
    try { draft = buildExpenseDraft(expense) } catch (next) { setError(next.message); return }
    const descriptor = { expenseId: editingExpenseId, draft, revisionReason }
    const mutationId = mutationIdForPayload(expenseAttempt.current, descriptor)
    if (editingExpenseId && !revisionReason.trim()) { setError('A revision reason is required.'); return }
    const editingRow = editingExpenseId ? expenses.find(row => row.id === editingExpenseId) : null
    if (editingExpenseId && !editingRow) { setError('The expense could not be found. Refresh and try again.'); return }
    await run(
      () => editingRow
        ? reviseExpenseByLinkage({
            row: editingRow,
            patch: draft,
            reason: revisionReason.trim(),
            mutationId,
            reviseExpense: reviseMyStuffExpenseV3,
            reviseServiceExpense: reviseMyStuffServiceExpenseV3,
          })
        : createMyStuffExpenseV3(id, draft, mutationId),
      async () => {
        resetMutationAttemptState(expenseAttempt.current)
        setExpense(emptyExpense())
        setEditingExpenseId(null)
        setRevisionReason('')
        await load()
      },
    )
  }

  function beginExpenseEdit(row) {
    const value = expenseRevision(row)
    setEditingExpenseId(row.id)
    setRevisionReason('')
    setExpense({
      description: value.description || '', category: value.category || 'other', customCategory: value.custom_category || '',
      amount: value.amount ?? '', currency: value.currency || 'USD', incurredOn: value.incurred_on || today(),
      vendor: value.vendor || '', notes: value.notes || '',
    })
  }

  async function voidExpense(row) {
    const reason = window.prompt('Why is this expense being voided?')?.trim()
    if (!reason) return
    const descriptor = { expenseId: row.id, reason, action: 'void' }
    const mutationId = mutationIdForPayload(expenseAttempt.current, descriptor)
    await run(() => voidMyStuffExpenseV3(row.id, reason, mutationId), async () => {
      resetMutationAttemptState(expenseAttempt.current)
      await load()
    })
  }

  async function toggleArchive() {
    const archived = !item.archived_at
    if (!window.confirm(archived ? 'Archive this item and retain its history?' : 'Restore this item?')) return
    const values = { itemId: id, archived, reason: archived ? 'Archived manually' : null }
    const mutationId = mutationIdForPayload(archiveAttempt.current, values)
    await run(() => setMyStuffItemArchivedV2({ ...values, mutationId }), async () => {
      resetMutationAttemptState(archiveAttempt.current)
      await load()
    })
  }

  async function removeItem() {
    if (!window.confirm('Permanently delete this item and its history? This cannot be undone.')) return
    await run(() => deleteMyStuffItem(user.id, id), () => navigate('/my-stuff', { replace: true }))
  }

  async function transferAndOpenProject() {
    if (!window.confirm('Move this item to a new selling Project? Its My Stuff history will be retained and archived.')) return
    const descriptor = { itemId: id }
    const mutationId = mutationIdForPayload(transferAttempt.current, descriptor)
    await run(async () => {
      const projectId = await transferMyStuffToProjectV1(id, mutationId)
      resetMutationAttemptState(transferAttempt.current)
      navigate(`/project/${projectId}`, { replace: true })
    })
  }

  if (loading) return <main className="mystuff-shell" aria-busy="true"><p>Loading item…</p></main>
  if (!item) return <main className="mystuff-shell"><div className="mystuff-error" role="alert">{error || 'Item not found.'}</div><button type="button" className="btn" onClick={() => navigate('/my-stuff')}>Back to My Stuff</button></main>

  const allowedAxes = getItemCategoryContract(edit?.category)?.measurements || []
  const money = value => value == null ? '—' : `${item.purchase_currency || 'USD'} ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const isPro = getPlan(profile, entitlement) === 'pro'

  return <main className="mystuff-shell" aria-labelledby="item-heading">
    <header className="mystuff-page-header"><button className="back-btn" type="button" onClick={() => navigate('/my-stuff')} aria-label="Back to My Stuff">‹</button><div><h1 id="item-heading">{item.name}</h1><p className="mystuff-help">{item.itemType.replaceAll('_', ' ')}{item.archived_at ? ' · Archived' : ''}</p></div><button type="button" className="mystuff-link" onClick={() => void load()} disabled={saving}>Refresh</button></header>
    {error && <div className="mystuff-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss error">Dismiss</button></div>}

    <section className="mystuff-detail-grid" aria-label="Item summary">
      <article className="mystuff-card"><div className="mystuff-section-heading"><h2>Item details</h2><button type="button" className="mystuff-link" onClick={() => setEditing(value => !value)}>{editing ? 'Cancel' : 'Edit'}</button></div>
        {editing ? <form className="mystuff-detail-form" onSubmit={saveItem} noValidate>
          <Field label="Item name *" name="name" value={edit.name} onChange={setEditValue} error={errors.name}/>
          <div className="form-group"><label htmlFor="detail-item-type">Specific item type *</label><select id="detail-item-type" value={edit.itemType} onChange={event => chooseType(event.target.value)} aria-describedby={errors.itemType || errors.category ? 'detail-type-error' : undefined}>{ITEM_TYPE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{(errors.itemType || errors.category) && <p id="detail-type-error" className="field-error">{errors.itemType || errors.category}</p>}</div>
          <div className="mystuff-columns"><Field label="Model year" name="year" type="number" value={edit.year} onChange={setEditValue} error={errors.year}/><Field label="Make" name="make" value={edit.make} onChange={setEditValue}/></div>
          <div className="mystuff-columns"><Field label="Model" name="model" value={edit.model} onChange={setEditValue}/><Field label="Trim / version" name="trim" value={edit.trim} onChange={setEditValue}/></div>
          <div className="mystuff-columns"><Field label="Model number" name="modelNumber" value={edit.modelNumber} onChange={setEditValue}/><Field label="Serial number" name="serialNumber" value={edit.serialNumber} onChange={setEditValue}/></div>
          <Field label="VIN" name="vin" value={edit.vin} onChange={setEditValue}/><Field label="Engine / power system" name="engine" value={edit.engine} onChange={setEditValue}/>
          <div className="mystuff-columns"><Field label="Transmission" name="transmission" value={edit.transmission} onChange={setEditValue}/><Field label="Drivetrain" name="drivetrain" value={edit.drivetrain} onChange={setEditValue}/></div>
          <Field label="Fuel / power type" name="fuelType" value={edit.fuelType} onChange={setEditValue}/>
          <div className="mystuff-columns"><Field label="Acquired on" name="acquiredOn" type="date" value={edit.acquiredOn} onChange={setEditValue} error={errors.acquiredOn}/><Field label="Purchase price" name="purchasePrice" type="number" min="0" step="0.01" value={edit.purchasePrice} onChange={setEditValue} error={errors.purchasePrice}/></div>
          <div className="mystuff-columns"><Field label="Currency" name="purchaseCurrency" value={edit.purchaseCurrency} onChange={setEditValue} maxLength="3"/><Field label="Purchased from" name="purchaseVendor" value={edit.purchaseVendor} onChange={setEditValue}/></div>
          <fieldset><legend>Usage measurements</legend><div className="mystuff-choices">{AXES.filter(([axis]) => allowedAxes.includes(axis)).map(([axis, label]) => <label key={axis}><input type="checkbox" checked={edit.measurements.includes(axis)} onChange={() => toggleMeasurement(axis)}/><span>{label}</span></label>)}</div>{errors.measurements && <p className="field-error">{errors.measurements}</p>}</fieldset>
          <Field label="Notes" name="notes" value={edit.notes} onChange={setEditValue} textarea/>
          <button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save item details'}</button>
        </form> : <Description item={item} money={money}/>}
      </article>

      <article className="mystuff-card"><h2>Current usage</h2><div className="mystuff-stat-grid">{item.measurements.map(axis => <div className="mystuff-stat" key={axis}><small>{axis === 'miles' ? 'Mileage' : axis}</small><strong>{item.currentUsage[axis] == null ? 'Not set' : Number(item.currentUsage[axis]).toLocaleString()}</strong></div>)}</div>
        {item.measurements.length ? <form className="mystuff-inline-form" onSubmit={saveReading}><div className="form-group"><label htmlFor="reading-type">Measurement</label><select id="reading-type" value={reading.type} onChange={event => setReading(current => ({ ...current, type: event.target.value }))}>{item.measurements.map(axis => <option key={axis} value={axis}>{axis}</option>)}</select></div><Field label="Reading *" name="value" type="number" min="0" step={reading.type === 'cycles' ? '1' : 'any'} value={reading.value} onChange={(_, value) => setReading(current => ({ ...current, value }))}/><Field label="Recorded on *" name="recordedOn" type="date" value={reading.recordedOn} onChange={(_, value) => setReading(current => ({ ...current, recordedOn: value }))}/><button className="btn btn-primary" disabled={saving}>Record reading</button></form> : <p className="mystuff-help">Edit the item to enable a measurement.</p>}
        <h3>Reading history</h3>{readings.length ? <ul className="mystuff-history">{readings.map(value => <li key={value.id}><strong>{Number(value.reading_value).toLocaleString()} {value.reading_type}</strong><small>{String(value.recorded_at).slice(0, 10)} · {value.source}</small></li>)}</ul> : <p className="mystuff-help">No readings recorded yet.</p>}
      </article>
    </section>

    {supportsVinDecoder(item.itemType) && <>
      <MyStuffVinDecodePanel itemId={id} values={edit} onChange={setEdit} persistIdentity={persistVehicleIdentity} onIdentityConfirmed={load} operationLock={inFlight} disabled={saving}/>
      <ManufacturerMaintenanceResearch item={item} confirmedFingerprint={item.vin_confirmation_fingerprint} isPro={isPro} onUpgrade={() => navigate('/paywall')} onApplied={load}/>
    </>}
    <nav className="mystuff-tabs mystuff-primary-tabs" aria-label="Item record views">
      {['maintenance', 'expenses', 'history'].map(view => <button type="button" key={view} aria-current={detailView === view ? 'page' : undefined} onClick={() => setDetailView(view)}>{view[0].toUpperCase() + view.slice(1)}</button>)}
    </nav>
    {detailView === 'maintenance' && <MyStuffMaintenancePanel item={item} onChanged={load}/>}
    {detailView === 'history' && <MyStuffMaintenancePanel item={item} onChanged={load} mode="history"/>}
    <PrivateReportPanel subjectType="my_stuff_item" subjectId={id} isPro={isPro} onUpgrade={() => navigate('/paywall')}/>

    {detailView === 'expenses' && <section className="mystuff-card" aria-labelledby="financial-heading"><div className="mystuff-section-heading"><h2 id="financial-heading">Expenses</h2><span className="mystuff-help">Total invested: {money(summary?.total_invested)}</span></div>
      <div className="mystuff-stat-grid"><div className="mystuff-stat"><small>Purchase</small><strong>{money(summary?.purchase_price)}</strong></div><div className="mystuff-stat"><small>Expenses</small><strong>{money(summary?.expense_total)}</strong></div><div className="mystuff-stat"><small>Maintenance & repair</small><strong>{money(summary?.maintenance_repair_subtotal)}</strong></div><div className="mystuff-stat"><small>Upgrades</small><strong>{money(summary?.upgrades_subtotal)}</strong></div></div>
      <form className="mystuff-expense-form" onSubmit={saveExpense}><h3>{editingExpenseId ? 'Revise expense' : 'Add expense'}</h3><Field label="Description *" name="description" value={expense.description} onChange={(name, value) => setExpense(current => ({ ...current, [name]: value }))}/><div className="mystuff-columns"><div className="form-group"><label htmlFor="expense-category">Category *</label><select id="expense-category" value={expense.category} onChange={event => setExpense(current => ({ ...current, category: event.target.value }))}>{EXPENSE_CATEGORIES.map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></div><Field label="Amount *" name="amount" type="number" min="0" step="0.01" value={expense.amount} onChange={(name, value) => setExpense(current => ({ ...current, [name]: value }))}/></div>{expense.category === 'other' && <Field label="Custom category *" name="customCategory" value={expense.customCategory} onChange={(name, value) => setExpense(current => ({ ...current, [name]: value }))}/>}<div className="mystuff-columns"><Field label="Currency *" name="currency" value={expense.currency} maxLength="3" onChange={(name, value) => setExpense(current => ({ ...current, [name]: value }))}/><Field label="Incurred on *" name="incurredOn" type="date" value={expense.incurredOn} onChange={(name, value) => setExpense(current => ({ ...current, [name]: value }))}/></div><Field label="Vendor" name="vendor" value={expense.vendor} onChange={(name, value) => setExpense(current => ({ ...current, [name]: value }))}/><Field label="Notes" name="notes" value={expense.notes} textarea onChange={(name, value) => setExpense(current => ({ ...current, [name]: value }))}/>{editingExpenseId && <Field label="Revision reason *" name="revisionReason" value={revisionReason} onChange={(_, value) => setRevisionReason(value)}/>}<div className="mystuff-actions"><button className="btn btn-primary" disabled={saving}>{editingExpenseId ? 'Save revision' : 'Add expense'}</button>{editingExpenseId && <button type="button" className="btn" onClick={() => { setEditingExpenseId(null); setRevisionReason(''); setExpense(emptyExpense()) }}>Cancel</button>}</div></form>
      {expenses.length ? <ul className="mystuff-history">{expenses.map(row => { const value = expenseRevision(row); return <li key={row.id}><div className="mystuff-history-row"><span><strong>{value.description}</strong><small>{value.incurred_on} · {value.category}{row.voided_at ? ' · Voided' : ''}</small></span><strong>{money(value.amount)}</strong></div>{!row.voided_at && <div className="mystuff-actions"><button type="button" className="mystuff-link" onClick={() => beginExpenseEdit(row)}>Revise</button><button type="button" className="mystuff-danger-link" onClick={() => void voidExpense(row)}>Void</button></div>}</li> })}</ul> : <p className="mystuff-help">No expenses recorded yet.</p>}
    </section>}

    <section className="mystuff-card" aria-labelledby="item-actions"><h2 id="item-actions">Item actions</h2><p className="mystuff-help">Attachments are not available in My Stuff yet.</p><div className="mystuff-actions"><button type="button" className="btn" onClick={toggleArchive} disabled={saving}>{item.archived_at ? 'Restore item' : 'Archive item'}</button>{!item.archived_at && <button type="button" className="btn" onClick={transferAndOpenProject} disabled={saving}>Move to Projects</button>}<button type="button" className="btn mystuff-danger" onClick={removeItem} disabled={saving}>Delete permanently</button></div></section>
  </main>
}

function Description({ item, money }) {
  const values = [['Model year', item.model_year], ['Make', item.make], ['Model', item.model], ['Trim / version', item.trim], ['Model number', item.model_number], ['Serial number', item.serial_number], ['VIN', item.vin], ['Engine / power system', item.engine], ['Transmission', item.transmission], ['Drivetrain', item.drivetrain], ['Fuel / power type', item.fuel_power_type], ['Acquired on', item.acquired_on], ['Purchase price', money(item.purchase_price)], ['Purchased from', item.purchase_vendor]]
  return <dl className="mystuff-description">{values.filter(([, value]) => value != null && value !== '').map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}

function Field({ label, name, value, onChange, error, textarea = false, ...props }) {
  const id = `detail-${name}`
  const control = textarea
    ? <textarea id={id} value={value} onChange={event => onChange(name, event.target.value)} aria-describedby={error ? `${id}-error` : undefined} {...props}/>
    : <input id={id} value={value} onChange={event => onChange(name, event.target.value)} aria-describedby={error ? `${id}-error` : undefined} {...props}/>
  return <div className="form-group"><label htmlFor={id}>{label}</label>{control}{error && <p id={`${id}-error`} className="field-error">{error}</p>}</div>
}
