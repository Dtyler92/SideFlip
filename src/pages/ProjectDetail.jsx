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

  if (!project) return <div className="page"><p style={{padding:40,color:'var(--muted)'}}>Project not found.</p></div>

  const totalInvested = getTotalInvested(project)

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
        <img src={project.photo} alt={project.title} style={{ width: '100%', maxHeight: 220, objectFit: 'cover' }} />
      )}

      <div className="page">
        {/* Status badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <span style={{ fontSize: 28 }}>{categoryIcon(project.category)}</span>
          <div>
            <div style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{project.category}</div>
            {project.status === 'sold' && <span className="sold-badge">SOLD</span>}
          </div>
        </div>

        {/* Cost summary */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>Purchase Price</div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{fmt(project.purchasePrice)}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>Parts & Costs</div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>
                {fmt(project.expenses.reduce((s, e) => s + Number(e.amount), 0))}
              </div>
            </div>
          </div>
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>Total Invested</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--accent)' }}>{fmt(totalInvested)}</div>
          </div>
        </div>

        {/* Notes */}
        {project.notes && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>Notes</div>
            <div style={{ fontSize: 14, lineHeight: 1.5 }}>{project.notes}</div>
          </div>
        )}

        {/* Expenses */}
        <div className="section-title">Expenses ({project.expenses.length})</div>
        <div className="card">
          {project.expenses.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--muted)', fontSize: 14 }}>
              No expenses yet — tap "Add Expense" below
            </div>
          ) : (
            project.expenses.map(e => (
              <div key={e.id} className="expense-row" onClick={() => handleDeleteExpense(e.id)}>
                <div className="expense-icon">{expenseIcon(e.category)}</div>
                <div className="expense-desc">
                  <div className="desc">{e.description}</div>
                  <div className="cat">{e.category}</div>
                </div>
                <div className="expense-amount">−{fmt(e.amount)}</div>
              </div>
            ))
          )}
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: -8, marginBottom: 16 }}>Tap an expense to remove it</p>

        {/* Actions */}
        {project.status === 'active' && (
          <>
            <button className="btn btn-secondary" onClick={() => setShowAddExpense(true)}>+ Add Expense</button>
            <button className="btn btn-green" onClick={() => navigate(`/project/${id}/sell`)}>💰 Mark as Sold</button>
          </>
        )}
        {project.status === 'sold' && (
          <div className="card" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>Sold for</div>
            <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--green)' }}>{fmt(project.salePrice)}</div>
          </div>
        )}

        <button className="btn btn-danger" style={{ marginTop: 24 }} onClick={handleDeleteProject}>🗑 Delete Project</button>
      </div>

      {/* Add Expense Sheet */}
      {showAddExpense && (
        <div className="modal-overlay" onClick={() => setShowAddExpense(false)}>
          <div className="modal-sheet" onClick={e => e.stopPropagation()}>
            <div className="modal-handle" />
            <h2 style={{ marginBottom: 20, fontSize: 18 }}>Add Expense</h2>
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
