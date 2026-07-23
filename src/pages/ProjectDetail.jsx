import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  getTotalInvested, fmt, categoryIcon, expenseIcon,
  EXPENSE_CATEGORIES, getExtraFields
} from '../store'
import { getProject, updateProject, addExpense, deleteExpense, deleteProject } from '../db'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { uploadPhoto, deletePhoto } from '../supabase'

function PhotoPicker({ photo, onFile, uploading }) {
  return (
    <div style={{ position: 'relative' }}>
      {photo
        ? <img src={photo} alt="project" style={{ width: '100%', maxHeight: 220, objectFit: 'cover', borderBottom: '1px solid var(--border)', display: 'block' }} />
        : <div style={{ width: '100%', height: 140, background: 'var(--surface)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 6, color: 'var(--muted)', fontSize: 13 }}>
            <span style={{ fontSize: 28 }}>📷</span>
            <span>{uploading ? 'Uploading…' : 'Tap to add a photo'}</span>
          </div>
      }
      {/* Edit overlay button */}
      <label style={{
        position: 'absolute', bottom: 10, right: 12,
        background: 'rgba(13,13,11,0.62)', color: '#fff',
        borderRadius: 8, padding: '5px 12px', fontSize: 12, fontWeight: 600,
        cursor: 'pointer', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', gap: 5
      }}>
        {uploading ? '⏳ Uploading…' : `✏️ ${photo ? 'Change' : 'Add Photo'}`}
        <input type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
      </label>
    </div>
  )
}

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
  const { user } = useAuth()
  const { refresh: refreshList } = useData()
  const [project, setProject] = useState(null)
  const [loading, setLoading] = useState(true)
  const [photoUploading, setPhotoUploading] = useState(false)
  const [showAddExpense, setShowAddExpense] = useState(false)
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesVal, setNotesVal] = useState('')
  const [expense, setExpense] = useState({ description: '', amount: '', category: 'parts' })

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
  const totalInvested = getTotalInvested(project)
  const partsTotal = project.expenses.reduce((s, e) => s + Number(e.amount), 0)

  async function handlePhotoChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setPhotoUploading(true)
    try {
      if (project.photo) await deletePhoto(project.photo)
      const url = await uploadPhoto(user.id, file)
      await updateProject(user.id, id, { photo: url })
      load()
    } catch (err) {
      alert('Photo upload failed: ' + err.message)
    } finally {
      setPhotoUploading(false)
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


  return (
    <>
      {/* Photo with edit overlay */}
      <PhotoPicker photo={project.photo} onFile={handlePhotoChange} uploading={photoUploading} />

      <div className="page-header" style={{ borderTop: '1px solid var(--border)' }}>
        <button className="back-btn" onClick={() => navigate('/')}>‹</button>
        <h1>{p.title}</h1>
      </div>

      <div className="page">

        {/* Category + status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <span style={{ fontSize: 26 }}>{categoryIcon(p.category)}</span>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>{p.category}</div>
            {p.status === 'sold' && <span className="sold-badge">SOLD</span>}
          </div>
        </div>

        {/* Cost summary */}
        <div className="card">
          <div className="stat-row">
            <span className="stat-label">Purchase Price</span>
            <span className="stat-value">{fmt(p.purchasePrice)}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Parts & Costs</span>
            <span className="stat-value">{fmt(partsTotal)}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Total Invested</span>
            <span className="stat-value accent" style={{ fontSize: 22, fontWeight: 700 }}>{fmt(totalInvested)}</span>
          </div>
          {p.status === 'sold' && (
            <div className="stat-row">
              <span className="stat-label">Sold For</span>
              <span className="stat-value" style={{ color: 'var(--green)', fontSize: 20, fontWeight: 700 }}>{fmt(p.salePrice)}</span>
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
