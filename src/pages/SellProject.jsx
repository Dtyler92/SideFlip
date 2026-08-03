import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getTotalInvested, fmt } from '../store'
import { getProject, recordProjectSale } from '../db'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'

export default function SellProject() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { refresh } = useData()
  const [project, setProject] = useState(null)
  const [salePrice, setSalePrice] = useState('')
  const [disposition, setDisposition] = useState('keep')
  const [keepAmount, setKeepAmount] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getProject(user.id, id).then(setProject).catch(() => setProject(null))
  }, [id])

  if (!project) return null

  const totalInvested = getTotalInvested(project)
  const preview = salePrice ? Number(salePrice) - totalInvested : null
  const previewROI = salePrice && totalInvested
    ? (((Number(salePrice) - totalInvested) / totalInvested) * 100).toFixed(1)
    : null

  async function handleSell(e) {
    e.preventDefault()
    if (!salePrice || Number(salePrice) < 0) return alert('Enter a valid sale price')
    const sale = Number(salePrice)
    if (!Number.isFinite(sale)) return alert('Enter a valid sale price')
    if (project.goalId && disposition === 'split' && keepAmount.trim() === '') return alert('Enter the amount to keep toward the goal')
    const amountKept = !project.goalId ? 0 : disposition === 'keep' ? sale : disposition === 'take' ? 0 : Number(keepAmount)
    if (project.goalId && disposition === 'split' && (!Number.isFinite(amountKept) || amountKept < 0 || amountKept > sale)) return alert('Enter an amount between zero and the sale price')
    setSaving(true)
    try {
      await recordProjectSale(user.id, project, sale, amountKept)
      await refresh()
      navigate(`/project/${id}`)
    } catch (err) {
      alert('Failed to save: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="page-header">
        <button className="back-btn" onClick={() => navigate(-1)}>‹</button>
        <h1>Mark as Sold</h1>
      </div>

      <div className="page">
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 6 }}>Project</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>{project.title}</div>
          <div className="stat-row" style={{ paddingTop: 0 }}>
            <span className="stat-label">Total Invested</span>
            <span className="stat-value accent">{fmt(totalInvested)}</span>
          </div>
        </div>

        <form onSubmit={handleSell}>
          <div className="form-group">
            <label>Sale Price</label>
            <input
              type="number" inputMode="decimal" placeholder="0.00"
              value={salePrice} onChange={e => setSalePrice(e.target.value)}
              autoFocus
              style={{ fontSize: 32, fontWeight: 700, textAlign: 'center', padding: '20px', fontFamily: 'var(--font-heading)', letterSpacing: '-0.02em' }}
            />
          </div>

          {salePrice && preview !== null && (
            <div className="profit-result">
              <div className="label">{preview >= 0 ? 'Profit' : 'Loss'}</div>
              <div className={`amount ${preview >= 0 ? 'profit' : 'loss'}`}>
                {preview >= 0 ? '+' : ''}{fmt(preview)}
              </div>
              {previewROI && (
                <div className="roi">{preview >= 0 ? '📈' : '📉'} {previewROI}% ROI</div>
              )}
            </div>
          )}

          {project.goalId && salePrice && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 5 }}>What should happen to the proceeds?</div>
              <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>Tracking only — SideFlip does not hold or transfer this money.</div>
              <select value={disposition} onChange={e => setDisposition(e.target.value)}>
                <option value="keep">Keep all toward the goal</option>
                <option value="take">Take all out for personal use</option>
                <option value="split">Split the proceeds</option>
              </select>
              {disposition === 'split' && (
                <div className="form-group" style={{ marginTop: 12, marginBottom: 0 }}>
                  <label>Amount to keep toward the goal</label>
                  <input type="number" inputMode="decimal" min="0" max={salePrice} step="0.01" placeholder="0.00" value={keepAmount} onChange={e => setKeepAmount(e.target.value)} />
                </div>
              )}
            </div>
          )}

          <button type="submit" className="btn btn-green" disabled={saving}>{saving ? 'Saving…' : 'Confirm Sale →'}</button>
          <button type="button" className="btn btn-secondary" onClick={() => navigate(-1)}>Cancel</button>
        </form>
      </div>
    </>
  )
}
