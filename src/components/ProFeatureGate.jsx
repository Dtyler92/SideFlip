import { useNavigate } from 'react-router-dom'

export default function ProFeatureGate({ title, description, features = [] }) {
  const navigate = useNavigate()
  return (
    <div className="page" style={{ paddingTop: 36, paddingBottom: 110 }}>
      <div className="card" style={{ textAlign: 'center', padding: '30px 22px', marginBottom: features.length ? 16 : 0 }}>
        <div style={{ fontSize: 34, marginBottom: 12 }}>✦</div>
        <div style={{ fontSize: 11, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800, marginBottom: 8 }}>
          SideFlip Pro
        </div>
        <h1 style={{ fontSize: 23, margin: '0 0 9px', color: 'var(--text)' }}>{title}</h1>
        <p style={{ color: 'var(--muted)', lineHeight: 1.55, margin: '0 0 18px' }}>{description}</p>
        <button className="btn btn-primary" type="button" onClick={() => navigate('/upgrade')}>Upgrade to SideFlip Pro</button>
      </div>

      {features.length > 0 && (
        <div className="card" aria-label="SideFlip Pro feature preview">
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800, marginBottom: 10 }}>Included with Pro</div>
          {features.map(feature => (
            <div key={feature.title} style={{ display: 'flex', gap: 10, padding: '12px 0', borderTop: '1px solid var(--border)' }}>
              <span aria-hidden="true" style={{ fontSize: 18, lineHeight: 1.2 }}>🔒</span>
              <div>
                <div style={{ color: 'var(--text)', fontSize: 14, fontWeight: 800, marginBottom: 3 }}>{feature.title}{feature.comingSoon ? ' · Coming Soon' : ''}</div>
                <div style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.45 }}>{feature.description}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
