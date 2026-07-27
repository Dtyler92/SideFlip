import { useState } from 'react'

const fmt = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function Calculator() {
  const [invested, setInvested] = useState('')
  const [targetPct, setTargetPct] = useState('50')
  const [fees, setFees] = useState('0')

  const inv = parseFloat(invested) || 0
  const pct = parseFloat(targetPct) || 0
  const feePct = parseFloat(fees) || 0

  const targetProfit = inv * (pct / 100)
  const listPrice = feePct > 0 ? (inv + targetProfit) / (1 - feePct / 100) : inv + targetProfit
  const actualProfit = listPrice * (1 - feePct / 100) - inv
  const roi = inv > 0 ? ((actualProfit / inv) * 100).toFixed(1) : null

  const scenarios = [10, 25, 50, 100].map(p => {
    const profit = inv * (p / 100)
    const price = feePct > 0 ? (inv + profit) / (1 - feePct / 100) : inv + profit
    return { pct: p, price, profit }
  })

  const feePresets = [
    { label: 'None', value: '0' },
    { label: 'FB (0%)', value: '0' },
    { label: 'eBay (13%)', value: '13' },
    { label: 'Craigslist (0%)', value: '0' },
  ]

  return (
    <div style={{ padding: '20px 16px 100px', maxWidth: 600, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, fontWeight: 800, color: 'var(--text)', margin: '0 0 4px' }}>List Price Calculator</h1>
      <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 20px' }}>Find out exactly what to list for to hit your profit goal.</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="form-group">
          <label>Total Invested</label>
          <input type="number" inputMode="decimal" placeholder="0.00" value={invested}
            onChange={e => setInvested(e.target.value)}
            style={{ fontSize: 28, fontWeight: 700, textAlign: 'center' }} />
        </div>

        <div className="form-group" style={{ marginBottom: 8 }}>
          <label>Target Profit %</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            {[10, 25, 50, 100, 150].map(p => (
              <button key={p} type="button"
                onClick={() => setTargetPct(String(p))}
                style={{
                  padding: '6px 14px', borderRadius: 20, border: '1.5px solid',
                  borderColor: targetPct === String(p) ? 'var(--accent)' : 'var(--border)',
                  background: targetPct === String(p) ? 'var(--accent)' : 'var(--surface)',
                  color: targetPct === String(p) ? '#fff' : 'var(--body)',
                  fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font)'
                }}>{p}%</button>
            ))}
          </div>
          <input type="number" inputMode="decimal" placeholder="Custom %" value={targetPct}
            onChange={e => setTargetPct(e.target.value)} />
        </div>

        <div className="form-group">
          <label>Platform Fees %</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            {feePresets.map(({ label, value }) => (
              <button key={label} type="button"
                onClick={() => setFees(value)}
                style={{
                  padding: '6px 12px', borderRadius: 20, border: '1.5px solid',
                  borderColor: fees === value ? 'var(--accent)' : 'var(--border)',
                  background: fees === value ? 'var(--accent)' : 'var(--surface)',
                  color: fees === value ? '#fff' : 'var(--body)',
                  fontWeight: 600, fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font)'
                }}>{label}</button>
            ))}
          </div>
          <input type="number" inputMode="decimal" placeholder="Custom fee %" value={fees}
            onChange={e => setFees(e.target.value)} />
        </div>
      </div>

      {inv > 0 && (
        <div style={{ background: '#1A1917', borderRadius: 16, padding: 20, marginBottom: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 11, color: '#8C8880', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>List At</div>
          <div style={{ fontSize: 48, fontWeight: 800, color: '#fff', letterSpacing: -1, marginBottom: 16 }}>{fmt(listPrice)}</div>
          <div style={{ display: 'flex', justifyContent: 'space-around' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 10, color: '#8C8880', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Your Profit</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#4ade80' }}>{fmt(actualProfit)}</div>
            </div>
            <div style={{ width: 1, background: '#333' }} />
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 10, color: '#8C8880', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>ROI</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#4ade80' }}>{roi}%</div>
            </div>
            <div style={{ width: 1, background: '#333' }} />
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 10, color: '#8C8880', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Invested</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>{fmt(inv)}</div>
            </div>
          </div>
        </div>
      )}

      {inv > 0 && (
        <div className="card">
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Profit Scenarios</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 2fr', gap: 0 }}>
            <div style={th}>Goal</div>
            <div style={th}>List Price</div>
            <div style={{ ...th, textAlign: 'right' }}>Profit</div>
            {scenarios.map(({ pct: p, price, profit }) => (
              <>
                <div key={`g${p}`} style={{ ...td, color: 'var(--accent)', fontWeight: 700 }} onClick={() => setTargetPct(String(p))}>{p}%</div>
                <div key={`p${p}`} style={{ ...td, fontWeight: 700 }} onClick={() => setTargetPct(String(p))}>{fmt(price)}</div>
                <div key={`r${p}`} style={{ ...td, textAlign: 'right', color: 'var(--green)', fontWeight: 600 }} onClick={() => setTargetPct(String(p))}>{fmt(profit)}</div>
              </>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', marginTop: 10 }}>Tap a row to set as your target</div>
        </div>
      )}
    </div>
  )
}

const th = { fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600, padding: '6px 4px 10px', borderBottom: '1px solid var(--border)' }
const td = { fontSize: 14, padding: '12px 4px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }
