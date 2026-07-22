import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  getProject, addExpense, deleteExpense, deleteProject,
  getTotalInvested, fmt, categoryIcon, expenseIcon,
  EXPENSE_CATEGORIES
} from '../store'

export default function ProjectDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [, rerender] = useState(0)
  const refresh = () => rerender(n => n + 1)
  const project = getProject(id)

  const [showAddExpense, setShowAddExpense] = useState(false)
  const [expense, setExpense] = useState({ description: '', amount: '', category: 'parts' })

  if (!project) return <div className="page" style={{paddingTop:40}}><p style={{color:'var(--muted)'}}>Project not found.</p></div>

  const totalInvested = getTotalInvested(project)
  const partsTotal = project.expenses.reduce((s, e) => s + Number(e.amount), 0)

  function handleAddExpense(e) {
    e.preventDefault()
    if (!expense.description.trim() || !expense.amount) return alert('Fill in description and amount')
    addExpense(id, expense)
    setExpense({ description: '', amount: '', category: 'parts' })
    setShowAddExpense(false)
    refresh()
  }

  function handleDeleteExpense(expId) {
    if (!confirm('Remove this expense?')) return
    deleteExpense(id, expId)
    refresh()
  }

  function handleDeleteProject() {
    if (!confirm(`Delete "${project.title}"? This cannot be undone.`)) return
    deleteProject(id)
    navigate('/')
  }

  return (
    <>
      <div className="page-header">
        <button className="back-btn" onClick={() => navigate('/')}>‹</button>
        <h1>{project.title}</h1>
      </div>

      {/* Hero photo */}
      {project.photo && (
        <img src={project.photo} alt={project.title}
          style={{ width: '100%', maxHeight: 220, objectFit: 'cover', borderBottom: '1px solid var(--border)' }} />
      )}

      <div className="page" style={{ paddingTop: 16 }}>

        {/* Category + status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <span style={{ fontSize: 26 }}>{categoryIcon(project.category)}</span>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>{project.category}</div>
            {project.status === 'sold' && <span className="sold-badge">SOLD</span>}
          </div>
        </div>

        {/* Cost summary card */}
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
            <span className="stat-value accent big">{fmt(totalInvested)}</span>
          </div>
          {project.status === 'sold' && (
            <div className="stat-row">
              <span className="stat-label">Sold For</span>
              <span className="stat-value" style={{ color: 'var(--green)', fontFamily: 'var(--font-heading)', fontSize: 22 }}>{fmt(project.salePrice)}</span>
            </div>
          )}
        </div>

        {/* Notes */}
        {project.notes && (
          <div className="card">
            <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 6 }}>Notes</div>
            <div style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--body)' }}>{project.notes}</div>
          </div>
        )}

        {/* Expenses */}
        <div className="section-title">Expenses ({project.expenses.length})</div>
        <div className="card">
          {project.expenses.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--muted)', fontSize: 14 }}>
              No expenses yet
            </div>
          ) : (
            project.expenses.map(e => (
              <div key={e.id} className="expense-row" onClick={() => handleDeleteExpense(e.id)} style={{ cursor: 'pointer' }}>
                <div className="expense-icon">{expenseIcon(e.category)}</div>
                <div className="expense-desc">
                  <div className="desc">{e.description}</div>
                  <div className="cat">{e.category}</div>
                </div>
                <div className="expense-amount">{fmt(e.amount)}</div>
              </div>
            ))
          )}
        </div>
        <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: -8, marginBottom: 20 }}>Tap an expense to remove it</p>

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
                  type="text"
                  placeholder="e.g. Carburetor rebuild kit"
                  value={expense.description}
                  onChange={e => setExpense(x => ({ ...x, description: e.target.value }))}
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label>Amount</label>
                <input
                  type="number"
                  inputMode="decimal"
                  placeholder="0.00"
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
