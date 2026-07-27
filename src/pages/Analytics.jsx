import { useData } from '../context/DataContext'
import { getTotalInvested, getProfit, fmt, categoryIcon } from '../store'

const GREEN = 'var(--green)'
const ACCENT = 'var(--accent)'

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ flex: 1, background: '#fff', borderRadius: 14, padding: 16, boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: color || 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

export default function Analytics() {
  const { projects, loading } = useData()

  if (loading) return (
    <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
  )

  const sold = projects.filter(p => p.status === 'sold')
  const active = projects.filter(p => p.status === 'active')

  const totalProfit = sold.reduce((s, p) => s + (getProfit(p) || 0), 0)
  const totalRevenue = sold.reduce((s, p) => s + (Number(p.sale_price) || 0), 0)
  const totalInvestedSold = sold.reduce((s, p) => s + getTotalInvested(p), 0)
  const totalInvestedActive = active.reduce((s, p) => s + getTotalInvested(p), 0)
  const avgProfit = sold.length > 0 ? totalProfit / sold.length : 0
  const winRate = sold.length > 0 ? (sold.filter(p => (getProfit(p) || 0) > 0).length / sold.length * 100).toFixed(0) : 0
  const roi = totalInvestedSold > 0 ? ((totalProfit / totalInvestedSold) * 100).toFixed(1) : null

  // Days to sell
  const withDays = sold.filter(p => p.created_at && p.sold_at).map(p => ({
    ...p,
    days: Math.round((new Date(p.sold_at) - new Date(p.created_at)) / (1000 * 60 * 60 * 24))
  }))
  const avgDays = withDays.length > 0 ? Math.round(withDays.reduce((s, p) => s + p.days, 0) / withDays.length) : null

  // Category breakdown
  const byCat = {}
  sold.forEach(p => {
    const cat = p.category || 'other'
    if (!byCat[cat]) byCat[cat] = { count: 0, profit: 0 }
    byCat[cat].count++
    byCat[cat].profit += getProfit(p) || 0
  })
  const catEntries = Object.entries(byCat).sort((a, b) => b[1].profit - a[1].profit)

  // Best flip
  const bestFlip = sold.length > 0 ? sold.reduce((best, p) => {
    return (getProfit(p) || 0) > (getProfit(best) || 0) ? p : best
  }, sold[0]) : null

  return (
    <div style={{ padding: '20px 16px 100px', maxWidth: 600, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, fontWeight: 800, color: 'var(--text)', margin: '0 0 4px' }}>Analytics</h1>
      <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 20px' }}>Your flipping performance at a glance.</p>

      {projects.length === 0 ? (
        <div style={{ textAlign: 'center', paddingTop: 60 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📊</div>
          <h3 style={{ color: 'var(--text)', marginBottom: 8 }}>No data yet</h3>
          <p style={{ color: 'var(--muted)' }}>Add some projects and mark them sold to see your stats.</p>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Overview</div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <StatCard label="Total Flips" value={sold.length} sub={`${active.length} active`} />
            <StatCard label="Total Profit" value={fmt(totalProfit)} color={totalProfit >= 0 ? GREEN : ACCENT} sub={roi ? `${roi}% ROI` : null} />
          </div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <StatCard label="Win Rate" value={`${winRate}%`} color={GREEN} sub={`${sold.filter(p => (getProfit(p)||0) > 0).length} of ${sold.length} sold`} />
            <StatCard label="Capital Active" value={fmt(totalInvestedActive)} sub={`across ${active.length} projects`} />
          </div>
          {avgDays !== null && (
            <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
              <StatCard label="Avg Days to Sell" value={`${avgDays}d`} />
              <StatCard label="Fastest Sell" value={withDays.length > 0 ? `${Math.min(...withDays.map(p => p.days))}d` : '—'} />
            </div>
          )}

          {/* Summary list */}
          {projects.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '8px 0 10px' }}>Summary</div>
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="stat-row">
                  <span className="stat-label">Total Projects</span>
                  <span className="stat-value">{projects.length}</span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">Active Projects</span>
                  <span className="stat-value">{active.length}</span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">Sold Projects</span>
                  <span className="stat-value">{sold.length}</span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">Capital Deployed</span>
                  <span className="stat-value" style={{ color: 'var(--accent)', fontWeight: 700 }}>{fmt(totalInvestedActive)}</span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">Total Profit</span>
                  <span className="stat-value" style={{ color: totalProfit >= 0 ? GREEN : ACCENT, fontWeight: 700 }}>{totalProfit >= 0 ? '+' : ''}{fmt(totalProfit)}</span>
                </div>
                {sold.length > 0 && (
                  <div className="stat-row" style={{ borderBottom: 'none' }}>
                    <span className="stat-label">Return on Investment</span>
                    <span className="stat-value" style={{ color: GREEN, fontWeight: 700 }}>{roi}%</span>
                  </div>
                )}
              </div>
            </>
          )}

          {catEntries.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '20px 0 10px' }}>By Category</div>
              <div className="card" style={{ marginBottom: 16 }}>
                {catEntries.map(([cat, data]) => {
                  const pct = totalProfit > 0 ? Math.max((data.profit / totalProfit) * 100, 2) : 2
                  return (
                    <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                      <span style={{ fontSize: 20, width: 28 }}>{categoryIcon(cat)}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ fontSize: 14, fontWeight: 600, textTransform: 'capitalize' }}>{cat} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({data.count})</span></span>
                          <span style={{ fontSize: 14, fontWeight: 700, color: data.profit >= 0 ? GREEN : ACCENT }}>{fmt(data.profit)}</span>
                        </div>
                        <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ height: 4, width: `${pct}%`, background: data.profit >= 0 ? '#2D7A4F' : 'var(--accent)', borderRadius: 2 }} />
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {bestFlip && (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '4px 0 10px' }}>Best Flip</div>
              <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                <span style={{ fontSize: 32 }}>{categoryIcon(bestFlip.category)}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 3 }}>{bestFlip.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>Bought {fmt(bestFlip.purchase_price)} · Sold {fmt(bestFlip.sale_price)}</div>
                </div>
                <div style={{ fontSize: 18, fontWeight: 800, color: GREEN }}>+{fmt(getProfit(bestFlip))}</div>
              </div>
            </>
          )}

          {sold.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '4px 0 10px' }}>Recent Sales</div>
              <div className="card" style={{ marginBottom: 16 }}>
                {sold.slice(0, 5).map(p => {
                  const profit = getProfit(p)
                  return (
                    <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ fontSize: 20, width: 28 }}>{categoryIcon(p.category)}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>{p.title}</div>
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{fmt(getTotalInvested(p))} in · {fmt(p.sale_price)} sold</div>
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: profit >= 0 ? GREEN : ACCENT }}>{profit >= 0 ? '+' : ''}{fmt(profit)}</div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
