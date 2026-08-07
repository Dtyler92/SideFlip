import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  getTotalInvested, fmt, categoryIcon, expenseIcon,
  EXPENSE_CATEGORIES, getExtraFields, getProjectPhotoPair, shouldDeleteReplacedProjectPhoto
} from '../store'
import { getProject, updateProject, addExpense, importReceiptExpenses, deleteExpense, deleteProject } from '../db'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { uploadPhoto, deletePhoto, supabase } from '../supabase'
import { can } from '../capabilities'
import { createMutationId } from '../goals'
import ProjectPhotoSlot from '../components/ProjectPhotoSlot'

function InfoRow({ label, value }) {
  if (!value) return null
  return (
    <div className="stat-row">
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={{ fontSize: 13, fontFamily: 'var(--font)', fontWeight: 600 }}>{value}</span>
    </div>
  )
}

export default function ProjectDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user, profile, entitlement } = useAuth()
  const { goals, refresh: refreshList } = useData()
  const [project, setProject] = useState(null)
  const [loading, setLoading] = useState(true)
  const [uploadingSlot, setUploadingSlot] = useState(null)
  const [showAddExpense, setShowAddExpense] = useState(false)
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesVal, setNotesVal] = useState('')
  const [expense, setExpense] = useState({ description: '', amount: '', category: 'parts' })
  const [receiptItems, setReceiptItems] = useState([])
  const [receiptImportId, setReceiptImportId] = useState(null)
  const [scanningReceipt, setScanningReceipt] = useState(false)

  async function load() {
    try {
      const p = await getProject(user.id, id)
      setProject(p)
    } catch { setProject(null) }
    setLoading(false)
  }

  useEffect(() => { load() }, [id])

  if (loading) return <div className="page" style={{ paddingTop: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
  if (!project) return <div className="page" style={{ paddingTop: 40 }}><p style={{ color: 'var(--muted)' }}>Project not found.</p></div>

  const fields = getExtraFields(project.category)
  const { beforePhoto, afterPhoto } = getProjectPhotoPair(project)
  const totalInvested = getTotalInvested(project)
  const partsTotal = project.expenses.reduce((s, e) => s + Number(e.amount), 0)
  const assignedGoal = project.goalId ? goals.find(goal => goal.id === project.goalId) : null
  const assignedGoalName = assignedGoal?.title?.replace(/\s+goal$/i, '')

  async function handlePhotoChange(slot, e) {
    const file = e.target.files?.[0]
    if (!file) return
    const { beforePhoto, afterPhoto } = getProjectPhotoPair(project)
    const previousPhoto = slot === 'before' ? beforePhoto : afterPhoto
    setUploadingSlot(slot)
    let uploadedUrl = null
    try {
      uploadedUrl = await uploadPhoto(user.id, file)
      const updates = slot === 'before'
        ? { photo: uploadedUrl, beforePhoto: uploadedUrl }
        : {
            afterPhoto: uploadedUrl,
            ...(beforePhoto ? {} : { photo: uploadedUrl }),
          }
      await updateProject(user.id, id, updates)
      if (previousPhoto && previousPhoto !== uploadedUrl && shouldDeleteReplacedProjectPhoto(project, slot, previousPhoto)) await deletePhoto(previousPhoto)
      await refreshList()
      load()
    } catch (err) {
      if (uploadedUrl) await deletePhoto(uploadedUrl).catch(() => {})
      alert('Photo upload failed: ' + err.message)
    } finally {
      setUploadingSlot(null)
    }
  }

  async function handleAddExpense(e) {
    e.preventDefault()
    if (!expense.description.trim() || !expense.amount) return alert('Fill in description and amount')
    await addExpense(user.id, id, expense)
    setExpense({ description: '', amount: '', category: 'parts' })
    setShowAddExpense(false)
    load()
  }

  async function handleDeleteExpense(expId) {
    if (!confirm('Remove this expense?')) return
    await deleteExpense(user.id, expId)
    load()
  }

  async function handleDeleteProject() {
    if (!confirm(`Delete "${project.title}"? This cannot be undone.`)) return
    await deleteProject(user.id, id)
    await refreshList()
    navigate('/')
  }

  function startEditNotes() {
    setNotesVal(project.notes || '')
    setEditingNotes(true)
  }

  async function saveNotes() {
    await updateProject(user.id, id, { notes: notesVal })
    setEditingNotes(false)
    load()
  }

  async function scanReceipt(file) {
    if (!can(profile, entitlement, 'receipt_scanning')) return alert('Receipt scanning is available with SideFlip Pro.')
    if (!file) return
    setScanningReceipt(true)
    try {
      const imageDataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file) })
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch('/api/scan-receipt', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` }, body: JSON.stringify({ imageDataUrl }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not scan receipt.')
      setReceiptItems((data.items || []).map(item => ({ ...item, selected: true })))
      setReceiptImportId(createMutationId())
      if (!(data.items || []).length) alert('No line items found. Try a clearer receipt or add expenses manually.')
    } catch (error) { alert(error.message || 'Could not scan receipt.') } finally { setScanningReceipt(false) }
  }

  async function addReceiptItems() {
    const selected = receiptItems.filter(item => item.selected)
    if (!selected.length) return alert('Select at least one item to add.')
    try {
      await importReceiptExpenses(id, selected, receiptImportId || createMutationId())
      setReceiptItems([])
      setReceiptImportId(null)
      load()
    } catch (error) { alert('Could not add receipt items: ' + error.message) }
  }

  return (
    <>
      <div className="page" style={{ paddingBottom: 0 }}>
        <div className="section-title" style={{ marginTop: 0 }}>Project Photos</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 18 }}>
          <ProjectPhotoSlot label="Before" photo={beforePhoto} uploading={uploadingSlot === 'before'} onFile={e => handlePhotoChange('before', e)} />
          <ProjectPhotoSlot label="After" photo={afterPhoto} uploading={uploadingSlot === 'after'} onFile={e => handlePhotoChange('after', e)} />
        </div>
      </div>

      <div className="page-header" style={{ borderTop: '1px solid var(--border)' }}>
        <button className="back-btn" onClick={() => navigate('/')}
          style={{ background: '#C8402F', border: 'none', color: '#fff', fontSize: 20, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font)', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: '50%', padding: 0, boxShadow: '0 2px 8px rgba(200,64,47,0.3)' }}>
          ‹
        </button>
        <h1 className="project-detail-title">{project.title}</h1>
      </div>

      <div className="page">

        {/* Category + status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <span style={{ fontSize: 26 }}>{categoryIcon(project.category)}</span>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>{project.category}</div>
            {project.status === 'sold' && <span className="sold-badge">SOLD</span>}
          </div>
        </div>

        {project.goalId && (
          <div style={{ background: 'var(--accent-soft)', border: '1px solid rgba(200,64,47,0.22)', borderRadius: 11, padding: '11px 13px', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flexShrink: 0 }}>◎</span>
            <div>
              <div style={{ color: 'var(--muted)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>Trade-Up Goal</div>
              <div style={{ color: 'var(--text)', fontSize: 14, fontWeight: 700 }}>{assignedGoalName ? `Assigned to ${assignedGoalName} Goal` : 'Assigned to a Trade-Up Goal'}</div>
            </div>
          </div>
        )}

        {/* Cost summary */}
        <div className="card">
          <div className="stat-row">
            <span className="stat-label">Purchase Price</span>
            <span className="stat-value">{fmt(project.purchasePrice)}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Parts & Costs</span>
            <span className="stat-value">{fmt(partsTotal)}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Total Invested</span>
            <span className="stat-value accent" style={{ fontSize: 22, fontWeight: 700 }}>{fmt(totalInvested)}</span>
          </div>
          {project.status === 'sold' && (
            <div className="stat-row">
              <span className="stat-label">Sold For</span>
              <span className="stat-value" style={{ color: 'var(--green)', fontSize: 20, fontWeight: 700 }}>{fmt(project.salePrice)}</span>
            </div>
          )}
        </div>

        {/* Identifiers card */}
        {(fields.hasModel || fields.hasEngine || fields.hasVin || fields.hasHull) && (
          <>
            <div className="section-title">Details</div>
            <div className="card">
              {fields.hasVin && <InfoRow label="VIN" value={project.vin} />}
              {fields.hasHull && <InfoRow label="Hull #" value={project.hullNumber} />}
              {fields.hasModel && <InfoRow label="Model #" value={project.modelNumber} />}
              {fields.hasModel && <InfoRow label="Serial #" value={project.serialNumber} />}
              {fields.hasEngine && <InfoRow label="Engine Model" value={project.engineModel} />}
              {fields.hasEngine && <InfoRow label="Engine Serial" value={project.engineSerial} />}
              {!project.vin && !project.hullNumber && !project.modelNumber && !project.serialNumber && !project.engineModel && !project.engineSerial && (
                <div style={{ fontSize: 13, color: 'var(--muted)', padding: '8px 0' }}>No identifiers recorded yet.</div>
              )}
            </div>
          </>
        )}

        {/* Notes */}
        <div className="section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Notes</span>
          {!editingNotes && (
            <button onClick={startEditNotes} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {project.notes ? 'Edit' : '+ Add'}
            </button>
          )}
        </div>
        <div className="card">
          {editingNotes ? (
            <>
              <textarea autoFocus value={notesVal} onChange={e => setNotesVal(e.target.value)}
                placeholder="What's the plan? Condition notes, to-do list..."
                style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none', fontSize: 14, lineHeight: 1.6, color: 'var(--body)', fontFamily: 'var(--font)', resize: 'none', minHeight: 100 }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="btn btn-primary" style={{ flex: 1, padding: '10px' }} onClick={saveNotes}>Save</button>
                <button className="btn btn-secondary" style={{ flex: 1, padding: '10px' }} onClick={() => setEditingNotes(false)}>Cancel</button>
              </div>
            </>
          ) : (
            <div onClick={startEditNotes} style={{ fontSize: 14, lineHeight: 1.6, color: project.notes ? 'var(--body)' : 'var(--muted)', cursor: 'pointer', minHeight: 36 }}>
              {project.notes || 'Tap to add notes...'}
            </div>
          )}
        </div>

        {/* Expenses */}
        <div className="section-title">Expenses ({project.expenses.length})</div>
        <div className="card">
          {project.expenses.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--muted)', fontSize: 14 }}>No expenses yet</div>
          ) : (
            project.expenses.map(e => (
              <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <div className="expense-icon">{expenseIcon(e.category)}</div>
                <div className="expense-desc" style={{ flex: 1 }}>
                  <div className="desc">{e.description}</div>
                  <div className="cat">{e.category}</div>
                </div>
                <div className="expense-amount">{fmt(e.amount)}</div>
                <button
                  onClick={() => handleDeleteExpense(e.id)}
                  style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 18, cursor: 'pointer', padding: '4px 6px', lineHeight: 1 }}
                  title="Remove expense"
                >🗑</button>
              </div>
            ))
          )}
        </div>

        {/* Actions */}
        {project.status === 'active' && (
          <>
            <button className="btn btn-secondary" onClick={() => setShowAddExpense(true)}>+ Add Expense</button>
            <button className="btn btn-green" onClick={() => navigate(`/project/${id}/sell`)}>💰 Mark as Sold</button>
          </>
        )}

        <button className="btn btn-danger" style={{ marginTop: 24 }} onClick={handleDeleteProject}>Delete Project</button>
      </div>

      {/* Add Expense Sheet */}
      {showAddExpense && (
        <div className="modal-overlay" onClick={() => setShowAddExpense(false)}>
          <div className="modal-sheet" onClick={e => e.stopPropagation()}>
            <div className="modal-handle" />
            <div className="modal-title">Add Expense</div>
            <div style={{ marginBottom: 16, padding: 12, borderRadius: 10, background: 'var(--surface)' }}>
              <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 5 }}>✨ Scan receipt with AI · Pro</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 9 }}>Upload a receipt or screenshot. Review selected items before they are added; the image is not saved.</div>
              <label className="btn btn-secondary" style={{ display: 'block', textAlign: 'center', cursor: 'pointer' }}>
                {scanningReceipt ? 'Reading receipt…' : 'Upload Receipt'}
                <input type="file" accept="image/jpeg,image/png,image/webp" hidden disabled={scanningReceipt} onChange={event => scanReceipt(event.target.files?.[0])} />
              </label>
              {receiptItems.length > 0 && <div style={{ marginTop: 10 }}>
                {receiptItems.map((item, index) => <label key={`${item.description}-${index}`} style={{ display: 'flex', gap: 8, padding: '7px 0', fontSize: 13 }}><input type="checkbox" checked={item.selected} onChange={() => setReceiptItems(items => items.map((entry, i) => i === index ? { ...entry, selected: !entry.selected } : entry))} /><span style={{ flex: 1 }}>{item.description}</span><strong>{fmt(item.amount)}</strong></label>)}
                <button type="button" className="btn btn-primary" onClick={addReceiptItems}>Add Selected Items</button>
              </div>}
            </div>
            <form onSubmit={handleAddExpense}>
              <div className="form-group">
                <label>Category</label>
                <select value={expense.category} onChange={e => setExpense(x => ({ ...x, category: e.target.value }))}>
                  {EXPENSE_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Description</label>
                <input
                  type="text" placeholder="e.g. Carburetor rebuild kit"
                  value={expense.description}
                  onChange={e => setExpense(x => ({ ...x, description: e.target.value }))}
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label>Amount</label>
                <input
                  type="number" inputMode="decimal" placeholder="0.00"
                  value={expense.amount}
                  onChange={e => setExpense(x => ({ ...x, amount: e.target.value }))}
                />
              </div>
              <button type="submit" className="btn btn-primary">Add Expense</button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowAddExpense(false)}>Cancel</button>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
