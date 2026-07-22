import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getProjects, getTotalInvested, getProfit, fmt, categoryIcon } from '../store'

export default function Home() {
  const navigate = useNavigate()
  const [tab, setTab] = useState('active')
  const projects = getProjects()

  const active = projects.filter(p => p.status === 'active')
  const sold = projects.filter(p => p.status === 'sold')
  const shown = tab === 'active' ? active : sold

  const totalInvested = active.reduce((s, p) => s + getTotalInvested(p), 0)
  const totalProfit = sold.reduce((s, p) => s + (getProfit(p) || 0), 0)

  return (
    <>
      <div className="page-header">
        <div className="wordmark" style={{ flex: 1 }}>
          <span className="wordmark-side">Side</span>
          <span className="wordmark-flip">Flip</span>
        </div>
        <span style={{ fontSize: 20 }}>📒</span>
      </div>

      <div className="summary-bar">
        <div className="summary-item">
          <div className="summary-label">Active</div>
          <div className="summary-value accent">{active.length}</div>
        </div>
        <div className="summary-item">
          <div className="summary-label">In Projects</div>
          <div className="summary-value accent">{fmt(totalInvested)}</div>
        </div>
        <div className="summary-item">
          <div className="summary-label">Total Profit</div>
          <div className={`summary-value ${totalProfit >= 0 ? 'green' : 'accent'}`}>{fmt(totalProfit)}</div>
        </div>
      </div>

      <div className="page">
        <div className="tabs">
          <button className={`tab ${tab === 'active' ? 'active' : ''}`} onClick={() => setTab('active')}>
            Active ({active.length})
          </button>
          <button className={`tab ${tab === 'sold' ? 'active' : ''}`} onClick={() => setTab('sold')}>
            Sold ({sold.length})
          </button>
        </div>

        {shown.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">{tab === 'active' ? '🔧' : '🏷️'}</div>
            <h3>{tab === 'active' ? 'No active projects' : 'Nothing sold yet'}</h3>
            <p>{tab === 'active' ? 'Tap + to add your first project' : 'Mark a project as sold to see it here'}</p>
          </div>
        ) : (
          shown.map(p => {
            const profit = getProfit(p)
            return (
              <div key={p.id} className={`project-card ${p.status === 'sold' ? 'sold' : ''}`} onClick={() => navigate(`/project/${p.id}`)}>
                {p.photo
                  ? <img src={p.photo} alt={p.title} className="project-img" />
                  : <div className="project-img-placeholder">{categoryIcon(p.category)}</div>
                }
                <div className="project-info">
                  <div className="project-category">{p.category}</div>
                  <div className="project-title">{p.title}</div>
                  <div className="project-meta">
                    <span className="invested">{fmt(getTotalInvested(p))} in</span>
                    {p.status === 'sold' && profit !== null && (
                      <span className={`sold-badge ${profit < 0 ? 'loss' : ''}`}>
                        {profit >= 0 ? '+' : ''}{fmt(profit)}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', paddingRight: 14, color: '#D4CDC1', fontSize: 18 }}>›</div>
              </div>
            )
          })
        )}
      </div>

      <button className="fab" onClick={() => navigate('/new')}>+</button>
    </>
  )
}
