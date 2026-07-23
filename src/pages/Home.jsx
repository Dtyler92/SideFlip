import { useNavigate } from 'react-router-dom'
import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { signOut } from '../supabase'
import { getTotalInvested, getProfit, fmt, categoryIcon } from '../store'

function AccountMenu({ user, profile }) {
  const [open, setOpen] = useState(false)
  const [portalLoading, setPortalLoading] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  async function handleManageSub() {
    setPortalLoading(true)
    setOpen(false)
    try {
      const res = await fetch('/api/create-portal-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: profile?.stripe_customer_id })
      })
      const { url, error } = await res.json()
      if (error) throw new Error(error)
      window.location.href = url
    } catch (err) {
      alert('Could not open billing portal: ' + err.message)
    } finally {
      setPortalLoading(false)
    }
  }

  const initial = user?.email?.[0]?.toUpperCase() || '?'

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: 36, height: 36, borderRadius: '50%', background: 'var(--accent)',
        color: '#fff', border: 'none', fontFamily: 'var(--font)', fontSize: 15,
        fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center',
        justifyContent: 'center', flexShrink: 0, boxShadow: '0 2px 8px rgba(200,64,47,0.25)'
      }}>
        {portalLoading ? '…' : initial}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 44, right: 0, background: '#fff',
          border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          boxShadow: '0 8px 32px rgba(13,13,11,0.15)', minWidth: 220, zIndex: 200, overflow: 'hidden'
        }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600, marginBottom: 3 }}>Signed in as</div>
            <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600, wordBreak: 'break-all' }}>{user?.email}</div>
          </div>
          <button onClick={handleManageSub} style={menuItem}>
            <span>💳</span> Manage Subscription
          </button>
          <button onClick={() => { setOpen(false); window.location.href = 'mailto:tyler@tourbillionenergy.com' }} style={menuItem}>
            <span>💬</span> Help & Support
          </button>
          <div style={{ height: 1, background: 'var(--border)' }} />
          <button onClick={() => { setOpen(false); signOut() }} style={{ ...menuItem, color: 'var(--accent)' }}>
            <span>🚪</span> Sign Out
          </button>
        </div>
      )}
    </div>
  )
}

const menuItem = {
  width: '100%', display: 'flex', alignItems: 'center', gap: 10,
  padding: '12px 16px', background: 'none', border: 'none',
  fontSize: 14, fontWeight: 500, color: 'var(--body)', cursor: 'pointer',
  fontFamily: 'var(--font)', textAlign: 'left'
}

export default function Home() {
  const navigate = useNavigate()
  const { user, profile } = useAuth()
  const { projects, loading, migrating } = useData()
  const [tab, setTab] = useState('active')
  const [search, setSearch] = useState('')

  const active = projects.filter(p => p.status === 'active')
  const sold = projects.filter(p => p.status === 'sold')
  const all = tab === 'active' ? active : sold
  const shown = search
    ? all.filter(p => p.title.toLowerCase().includes(search.toLowerCase()) || p.category.toLowerCase().includes(search.toLowerCase()))
    : all
  const totalInvested = active.reduce((s, p) => s + getTotalInvested(p), 0)
  const totalProfit = sold.reduce((s, p) => s + (getProfit(p) || 0), 0)

  if (loading || migrating) return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', gap: 12 }}>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 36, letterSpacing: '-0.02em' }}>
        <span style={{ color: 'var(--text)' }}>Side</span><span style={{ color: 'var(--accent)' }}>Flip</span>
      </div>
      {migrating && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Syncing your projects to the cloud…</div>}
    </div>
  )

  return (
    <>
      <div className="page-header">
        <div className="wordmark" style={{ flex: 1 }}>
          <span className="wordmark-side">Side</span>
          <span className="wordmark-flip">Flip</span>
        </div>
        <AccountMenu user={user} profile={profile} />
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
          <button className={`tab ${tab === 'active' ? 'active' : ''}`} onClick={() => setTab('active')}>Active ({active.length})</button>
          <button className={`tab ${tab === 'sold' ? 'active' : ''}`} onClick={() => setTab('sold')}>Sold ({sold.length})</button>
        </div>

        {/* Search */}
        {all.length > 4 && (
          <div style={{ margin: '0 0 16px', position: 'relative' }}>
            <input
              type="text"
              placeholder="Search projects…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ width: '100%', padding: '10px 14px 10px 36px', borderRadius: 10, border: '1px solid var(--border)', background: '#fff', fontSize: 14, fontFamily: 'var(--font)', boxSizing: 'border-box', outline: 'none' }}
            />
            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 15, pointerEvents: 'none' }}>🔍</span>
            {search && (
              <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 16 }}>✕</button>
            )}
          </div>
        )}

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
                      <span className={`sold-badge ${profit < 0 ? 'loss' : ''}`}>{profit >= 0 ? '+' : ''}{fmt(profit)}</span>
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
