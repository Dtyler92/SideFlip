import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getProject, updateProject, getTotalInvested, getProfit, getROI, fmt } from '../store'

export default function SellProject() {
  const { id } = useParams()
  const navigate = useNavigate()
  const project = getProject(id)
  const [salePrice, setSalePrice] = useState('')

  if (!project) return null

  const totalInvested = getTotalInvested(project)
  const preview = salePrice ? Number(salePrice) - totalInvested : null
  const previewROI = salePrice && totalInvested ? (((Number(salePrice) - totalInvested) / totalInvested) * 100).toFixed(1) : null

  function handleSell(e) {
    e.preventDefault()
    if (!salePrice || Number(salePrice) < 0) return alert('Enter a valid sale price')
    updateProject(id, {
      status: 'sold',
      salePrice: Number(salePrice),
      soldAt: new Date().toISOString()
    })
    navigate(`/project/${id}`)
  }

  return (
    <>
      <div className="page-header">
        <button className="back-btn" onClick={() => navigate(-1)}>‹</button>
        <h1>Mark as Sold</h1>
      </div>

      <div className="page">
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 4 }}>Project</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{project.title}</div>
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>Total invested</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>{fmt(totalInvested)}</div>
          </div>
        </div>

        <form onSubmit={handleSell}>
          <div className="form-group">
            <label>Sale Price</label>
            <input
              type="number"
              inputMode="decimal"
              placeholder="0.00"
              value={salePrice}
              onChange={e => setSalePrice(e.target.value)}
              autoFocus
              style={{ fontSize: 28, fontWeight: 700, textAlign: 'center', padding: '18px' }}
            />
          </div>

          {salePrice && (
            <div className="profit-result">
              <div className="label">{preview >= 0 ? '🎉 Profit' : '📉 Loss'}</div>
              <div className={`amount ${preview >= 0 ? 'profit' : 'loss'}`}>
                {preview >= 0 ? '+' : ''}{fmt(preview)}
              </div>
              {previewROI && (
                <div className="roi">{previewROI}% ROI</div>
              )}
            </div>
          )}

          <button type="submit" className="btn btn-green" style={{ marginTop: 8 }}>
            💰 Confirm Sale
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => navigate(-1)}>
            Cancel
          </button>
        </form>
      </div>
    </>
  )
}
