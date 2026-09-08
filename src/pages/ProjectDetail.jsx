import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  fmt, categoryIcon, expenseIcon, EXPENSE_CATEGORIES, getExtraFields,
  getProjectPhotoPair, shouldDeleteReplacedProjectPhoto,
} from '../store'
import {
  addExpense, deleteExpense, deleteProject, getProject, linkProjectToGoal,
  transferProjectToMyStuff, undoProjectSale, updateExpense, updateProject,
} from '../db'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { uploadPhoto, deletePhoto } from '../supabase'
import ProjectPhotoSlot from '../components/ProjectPhotoSlot'
import SalesListingGenerator from '../components/SalesListingGenerator'
import ProjectReportPanel from '../components/ProjectReportPanel'
import { ProjectToMyStuffAction } from '../components/ProjectIntegrationActions'
import VinDecodePanel from '../components/VinDecodePanel'
import { captureEvent } from '../analytics'
import { calculateGoalSummary, createMutationId } from '../goals'
import { can } from '../capabilities'
import {
  buildExpenseWrite, centsToAmount, parseMoneyToCents, projectCostCents,
  projectProfitCents, resolveNotesSave,
} from '../projectParity'

const emptyExpense = () => ({ description: '', amount: '', category: 'parts', laborHours: '' })

function InfoRow({ label, value }) {
  if (!value) return null
  return <div className="stat-row"><span className="stat-label">{label}</span><span className="stat-value" style={{ fontSize: 13, fontFamily: 'var(--font)', fontWeight: 600 }}>{value}</span></div>
}

export default function ProjectDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user, profile, entitlement } = useAuth()
  const { goals, projects, refresh: refreshList } = useData()
  const [project, setProject] = useState(null)
  const [loading, setLoading] = useState(true)
  const [uploadingSlot, setUploadingSlot] = useState(null)
  const [showExpense, setShowExpense] = useState(false)
  const [editingExpenseId, setEditingExpenseId] = useState(null)
  const [expense, setExpense] = useState(emptyExpense)
  const [savingExpense, setSavingExpense] = useState(false)
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesVal, setNotesVal] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [showGoalAssignment, setShowGoalAssignment] = useState(false)
  const [goalId, setGoalId] = useState('')
  const [goalFunding, setGoalFunding] = useState('')
  const [goalMutationId, setGoalMutationId] = useState(createMutationId)
  const [savingAction, setSavingAction] = useState(false)
  const [transferMutationId, setTransferMutationId] = useState(createMutationId)
  const activeProjectRef = useRef(id)
  const loadRequestRef = useRef(0)
  const notesSaveRef = useRef(0)
  const notesEditVersionRef = useRef(0)

  async function load() {
    const request = ++loadRequestRef.current
    try {
      const next = await getProject(user.id, id)
      if (request === loadRequestRef.current && activeProjectRef.current === id) setProject(next)
    } catch {
      if (request === loadRequestRef.current && activeProjectRef.current === id) setProject(null)
    } finally {
      if (request === loadRequestRef.current && activeProjectRef.current === id) setLoading(false)
    }
  }

  useEffect(() => {
    activeProjectRef.current = id
    notesSaveRef.current += 1
    notesEditVersionRef.current += 1
    setLoading(true)
    setEditingNotes(false)
    void load()
    return () => { loadRequestRef.current += 1; notesSaveRef.current += 1 }
  }, [id, user.id])

  if (loading) return <div className="page" style={{ paddingTop: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
  if (!project) return <div className="page" style={{ paddingTop: 40 }}><p style={{ color: 'var(--muted)' }}>Project not found.</p></div>

  const fields = getExtraFields(project.category)
  const { beforePhoto, afterPhoto } = getProjectPhotoPair(project)
  const totalInvestedCents = projectCostCents(project)
  const totalInvested = centsToAmount(totalInvestedCents)
  const partsTotal = centsToAmount((project.expenses || []).reduce((sum, item) => sum + (parseMoneyToCents(item.amount) ?? Math.round(Number(item.amount || 0) * 100)), 0))
  const profitCents = projectProfitCents(project)
  const assignedGoal = project.goalId ? goals.find(goal => goal.id === project.goalId) : null
  const activeGoals = goals.filter(goal => goal.status === 'active')
  const selectedGoal = activeGoals.find(goal => goal.id === goalId)
  const selectedGoalSummary = selectedGoal ? calculateGoalSummary(selectedGoal, projects, selectedGoal.ledger) : null
  const isPro = can(profile, entitlement, 'ai_listings')
  const upgrade = () => navigate('/paywall')

  async function handlePhotoChange(slot, event) {
    const file = event.target.files?.[0]
    if (!file) return
    const pair = getProjectPhotoPair(project)
    const previousPhoto = slot === 'before' ? pair.beforePhoto : pair.afterPhoto
    setUploadingSlot(slot)
    let uploadedUrl = null
    try {
      uploadedUrl = await uploadPhoto(user.id, file)
      const updates = slot === 'before'
        ? { photo: uploadedUrl, beforePhoto: uploadedUrl }
        : { afterPhoto: uploadedUrl, ...(pair.beforePhoto ? {} : { photo: uploadedUrl }) }
      const next = await updateProject(user.id, id, updates)
      setProject(next)
      if (previousPhoto && previousPhoto !== uploadedUrl && shouldDeleteReplacedProjectPhoto(project, slot, previousPhoto)) await deletePhoto(previousPhoto)
      await refreshList()
    } catch (error) {
      if (uploadedUrl) await deletePhoto(uploadedUrl).catch(() => {})
      alert('Photo upload failed: ' + error.message)
    } finally { setUploadingSlot(null) }
  }

  function openExpense(item = null) {
    setEditingExpenseId(item?.id || null)
    setExpense(item ? {
      description: item.description || '', amount: String(item.amount ?? ''),
      category: item.category || 'other', laborHours: String(item.laborHours ?? ''),
    } : emptyExpense())
    setShowExpense(true)
  }

  async function handleSaveExpense(event) {
    event.preventDefault()
    let write
    try { write = buildExpenseWrite(expense) } catch (error) { return alert(error.message) }
    setSavingExpense(true)
    try {
      if (editingExpenseId) await updateExpense(user.id, id, editingExpenseId, write)
      else await addExpense(user.id, id, write)
      captureEvent(editingExpenseId ? 'expense_edited' : 'expense_added', { expense_category: write.category, project_category: project.category, source: 'manual' })
      setShowExpense(false)
      setEditingExpenseId(null)
      setExpense(emptyExpense())
      await load()
    } catch (error) { alert('Could not save expense: ' + error.message) }
    finally { setSavingExpense(false) }
  }

  async function handleDeleteExpense(expenseId) {
    if (!confirm('Remove this expense?')) return
    try {
      await deleteExpense(user.id, expenseId)
      captureEvent('expense_deleted', { project_category: project.category, source: 'manual' })
      await load()
    } catch (error) { alert('Could not remove expense: ' + error.message) }
  }

  async function handleDeleteProject() {
    if (!confirm(`Delete "${project.title}"? This cannot be undone.`)) return
    try {
      await deleteProject(user.id, id)
      await refreshList()
      navigate('/')
    } catch (error) { alert('Could not delete project: ' + error.message) }
  }

  function startEditNotes() {
    notesEditVersionRef.current += 1
    setNotesVal(project.notes || '')
    setEditingNotes(true)
  }

  async function saveNotes() {
    const targetProjectId = id
    const savedNotes = notesVal
    const savedEditVersion = notesEditVersionRef.current
    const saveRequest = ++notesSaveRef.current
    setSavingNotes(true)
    try {
      const updated = await updateProject(user.id, targetProjectId, { notes: savedNotes })
      const resolution = resolveNotesSave({
        targetProjectId, currentProjectId: activeProjectRef.current, saveRequest,
        currentSaveRequest: notesSaveRef.current, savedEditVersion,
        currentEditVersion: notesEditVersionRef.current,
      })
      if (resolution.applyProject) setProject(updated)
      if (resolution.replaceDraft) setEditingNotes(false)
      await refreshList()
    } catch (error) {
      if (targetProjectId === activeProjectRef.current) alert('Could not save notes: ' + error.message)
    } finally {
      if (saveRequest === notesSaveRef.current) setSavingNotes(false)
    }
  }

  async function assignGoal(event) {
    event.preventDefault()
    if (!selectedGoal) return alert('Choose an active goal')
    const fundingCents = parseMoneyToCents(goalFunding)
    const purchaseCents = parseMoneyToCents(project.purchasePrice) ?? Math.round(Number(project.purchasePrice || 0) * 100)
    const availableCents = Math.round(Number(selectedGoalSummary?.available || 0) * 100)
    if (fundingCents === null || fundingCents > purchaseCents || fundingCents > availableCents) return alert('Enter goal funds no greater than the purchase price or available goal balance')
    setSavingAction(true)
    try {
      const next = await linkProjectToGoal(user.id, id, goalId, centsToAmount(fundingCents), goalMutationId)
      setProject(next)
      setGoalMutationId(createMutationId())
      setShowGoalAssignment(false)
      await refreshList()
    } catch (error) { alert('Could not assign goal: ' + error.message) }
    finally { setSavingAction(false) }
  }

  async function transferToMyStuff(request) {
    setSavingAction(true)
    try {
      await transferProjectToMyStuff(request.projectId, request.options, request.mutationId)
      setTransferMutationId(createMutationId())
      alert('Transferred to My Stuff. The expense snapshot was imported once; project accounting and attachments were not changed.')
    } catch (error) { alert('Could not transfer project: ' + error.message) }
    finally { setSavingAction(false) }
  }

  async function undoSale() {
    if (!confirm('Undo Sale? This restores the Project to active and reverses its goal outcome.')) return
    setSavingAction(true)
    try {
      await undoProjectSale(id)
      await refreshList()
      await load()
    } catch (error) { alert('Could not undo sale: ' + error.message) }
    finally { setSavingAction(false) }
  }

  async function confirmVinDetails(nextValues) {
    const updated = await updateProject(user.id, id, {
      vin: nextValues.vin,
      vehicleYear: nextValues.vehicleYear,
      vehicleMake: nextValues.vehicleMake,
      vehicleModel: nextValues.vehicleModel,
      engineModel: nextValues.engineModel,
      transmission: nextValues.transmission,
    })
    setProject(updated)
    await refreshList()
  }

  return <>
    <div className="page" style={{ paddingBottom: 0 }}>
      <div className="section-title" style={{ marginTop: 0 }}>Project Photos</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 18 }}>
        <ProjectPhotoSlot label="Before" photo={beforePhoto} uploading={uploadingSlot === 'before'} onFile={event => handlePhotoChange('before', event)} />
        <ProjectPhotoSlot label="After" photo={afterPhoto} uploading={uploadingSlot === 'after'} onFile={event => handlePhotoChange('after', event)} />
      </div>
    </div>

    <div className="page-header" style={{ borderTop: '1px solid var(--border)' }}>
      <button className="back-btn" onClick={() => navigate('/')} style={{ background: '#C8402F', border: 'none', color: '#fff', fontSize: 20, fontWeight: 700, cursor: 'pointer', width: 36, height: 36, borderRadius: '50%', padding: 0 }}>‹</button>
      <h1 className="project-detail-title">{project.title}</h1>
    </div>

    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <span style={{ fontSize: 26 }}>{categoryIcon(project.category)}</span>
        <div><div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', fontWeight: 600 }}>{project.category}</div>{project.status === 'sold' && <span className="sold-badge">SOLD</span>}</div>
      </div>

      {project.goalId && <div className="card"><strong>Assigned to {assignedGoal?.name || 'a Trade-Up Goal'}</strong></div>}

      <div className="card">
        <div className="stat-row"><span className="stat-label">Purchase Price</span><span className="stat-value">{fmt(project.purchasePrice)}</span></div>
        <div className="stat-row"><span className="stat-label">Parts & Costs</span><span className="stat-value">{fmt(partsTotal)}</span></div>
        <div className="stat-row"><span className="stat-label">Total Invested</span><span className="stat-value accent" style={{ fontSize: 22, fontWeight: 700 }}>{fmt(totalInvested)}</span></div>
        {project.status === 'sold' && <>
          <div className="stat-row"><span className="stat-label">Sold For</span><span className="stat-value" style={{ color: 'var(--green)', fontSize: 20, fontWeight: 700 }}>{fmt(project.salePrice)}</span></div>
          <div className="stat-row"><span className="stat-label">{profitCents >= 0 ? 'Profit' : 'Loss'}</span><span className="stat-value" style={{ color: profitCents >= 0 ? 'var(--green)' : 'var(--accent)', fontSize: 20, fontWeight: 700 }}>{profitCents >= 0 ? '+' : ''}{fmt(centsToAmount(profitCents))}</span></div>
        </>}
      </div>

      {(fields.hasModel || fields.hasEngine || fields.hasVin || fields.hasHull) && <>
        <div className="section-title">Details</div>
        <div className="card">
          {fields.hasVin && <InfoRow label="VIN" value={project.vin} />}
          {fields.hasVin && <InfoRow label="Year" value={project.vehicleYear} />}
          {fields.hasVin && <InfoRow label="Make" value={project.vehicleMake} />}
          {fields.hasVin && <InfoRow label="Vehicle model" value={project.vehicleModel} />}
          {fields.hasVin && <InfoRow label="Transmission" value={project.transmission} />}
          {fields.hasHull && <InfoRow label="Hull #" value={project.hullNumber} />}
          {fields.hasModel && <InfoRow label="Model #" value={project.modelNumber} />}
          {fields.hasModel && <InfoRow label="Serial #" value={project.serialNumber} />}
          {fields.hasEngine && <InfoRow label="Engine Model" value={project.engineModel} />}
          {fields.hasEngine && <InfoRow label="Engine Serial" value={project.engineSerial} />}
        </div>
        {fields.hasVin && <section aria-label="VIN Decoder"><VinDecodePanel values={project} onChange={confirmVinDetails} /></section>}
      </>}

      <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between' }}><span>Notes</span>{!editingNotes && <button onClick={startEditNotes} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontWeight: 700 }}>{project.notes ? 'Edit' : '+ Add'}</button>}</div>
      <div className="card">{editingNotes ? <>
        <textarea autoFocus value={notesVal} onChange={event => { notesEditVersionRef.current += 1; setNotesVal(event.target.value) }} placeholder="What's the plan? Condition notes, to-do list..." style={{ minHeight: 100 }} />
        <button className="btn btn-primary" disabled={savingNotes} onClick={saveNotes}>{savingNotes ? 'Saving…' : 'Save Notes'}</button>
        <button className="btn btn-secondary" disabled={savingNotes} onClick={() => setEditingNotes(false)}>Cancel</button>
      </> : <div onClick={startEditNotes} style={{ color: project.notes ? 'var(--body)' : 'var(--muted)', minHeight: 36 }}>{project.notes || 'Tap to add notes...'}</div>}</div>

      <div className="section-title">Expenses ({project.expenses.length})</div>
      <div className="card">{project.expenses.length === 0 ? <div style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>No expenses yet</div> : project.expenses.map(item => <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
        <div className="expense-icon">{expenseIcon(item.category)}</div>
        <div className="expense-desc" style={{ flex: 1 }}><div className="desc">{item.description}</div><div className="cat">{item.category} · {item.laborHours} labor hours</div></div>
        <div className="expense-amount">{fmt(item.amount)}</div>
        <button onClick={() => openExpense(item)} className="btn btn-secondary" style={{ width: 'auto', padding: '6px 8px' }}>Edit Expense</button>
        <button onClick={() => handleDeleteExpense(item.id)} style={{ background: 'none', border: 'none', cursor: 'pointer' }} title="Remove expense">🗑</button>
      </div>)}</div>

      {project.status === 'active' && <>
        <button className="btn btn-secondary" onClick={() => openExpense()}>+ Add Expense</button>
        {!project.goalId && activeGoals.length > 0 && <button className="btn btn-secondary" onClick={() => setShowGoalAssignment(value => !value)}>Assign to Goal</button>}
        {showGoalAssignment && <form className="card" onSubmit={assignGoal}>
          <label>Active goal</label><select value={goalId} onChange={event => { setGoalId(event.target.value); setGoalFunding(''); setGoalMutationId(createMutationId()) }}><option value="">Choose a goal</option>{activeGoals.map(goal => <option key={goal.id} value={goal.id}>{goal.name}</option>)}</select>
          {selectedGoal && <div className="form-group"><label>Use from goal ({fmt(selectedGoalSummary.available)} available)</label><input type="number" min="0" step="0.01" value={goalFunding} onChange={event => setGoalFunding(event.target.value)} /></div>}
          <button className="btn btn-primary" disabled={savingAction || !selectedGoal}>Assign Project</button>
        </form>}
        <button className="btn btn-green" onClick={() => navigate(`/project/${id}/sell`)}>💰 Mark as Sold</button>
      </>}

      {project.status === 'sold' && <button className="btn btn-secondary" disabled={savingAction} onClick={undoSale}>Undo Sale</button>}
      <section aria-label="Sales Listing Generator"><SalesListingGenerator projectId={id} isPro={isPro} onUpgrade={upgrade} /></section>
      <section aria-label="Private PDF Report"><ProjectReportPanel projectId={id} isPro={can(profile, entitlement, 'reports')} onUpgrade={upgrade} /></section>
      <section aria-label="Transfer to My Stuff"><ProjectToMyStuffAction projectId={id} mutationId={transferMutationId} onTransferProject={transferToMyStuff} disabled={savingAction} /></section>
      <button className="btn btn-danger" style={{ marginTop: 24 }} onClick={handleDeleteProject}>Delete Project</button>
    </div>

    {showExpense && <div className="modal-overlay" onClick={() => !savingExpense && setShowExpense(false)}><div className="modal-sheet" onClick={event => event.stopPropagation()}>
      <div className="modal-handle" /><div className="modal-title">{editingExpenseId ? 'Edit Expense' : 'Add Expense'}</div>
      <form onSubmit={handleSaveExpense}>
        <div className="form-group"><label>Category</label><select value={expense.category} onChange={event => setExpense(value => ({ ...value, category: event.target.value }))}>{EXPENSE_CATEGORIES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
        <div className="form-group"><label>Description</label><input autoFocus value={expense.description} onChange={event => setExpense(value => ({ ...value, description: event.target.value }))} /></div>
        <div className="form-group"><label>Amount</label><input type="number" inputMode="decimal" min="0.01" step="0.01" value={expense.amount} onChange={event => setExpense(value => ({ ...value, amount: event.target.value }))} /></div>
        <div className="form-group"><label>Labor hours *</label><input type="number" inputMode="decimal" min="0.01" step="0.01" value={expense.laborHours} onChange={event => setExpense(value => ({ ...value, laborHours: event.target.value }))} /><div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 5 }}>Required. Saved hours round up to the next 0.25 hour.</div></div>
        <button className="btn btn-primary" disabled={savingExpense}>{savingExpense ? 'Saving…' : editingExpenseId ? 'Save Expense' : 'Add Expense'}</button>
        <button type="button" className="btn btn-secondary" disabled={savingExpense} onClick={() => setShowExpense(false)}>Cancel</button>
      </form>
    </div></div>}
  </>
}
