import { useNavigate, useLocation } from 'react-router-dom'

const TABS = [
  { path: '/', label: 'Projects', emoji: '🔧' },
  { path: '/goals', label: 'Goals', emoji: '🎯' },
  { path: '/calculator', label: 'Calculator', emoji: '🧮' },
  { path: '/analytics', label: 'Analytics', emoji: '📊' },
  { path: '/settings', label: 'Settings', emoji: '⚙️' },
]

export default function BottomNav() {
  const navigate = useNavigate()
  const { pathname } = useLocation()

  return (
    <nav style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 100,
      background: '#fff', borderTop: '1px solid var(--border)',
      display: 'flex', paddingBottom: 'env(safe-area-inset-bottom)',
    }}>
      {TABS.map(tab => {
        const active = pathname === tab.path
        return (
          <button
            key={tab.path}
            onClick={() => navigate(tab.path)}
            style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', padding: '8px 4px', border: 'none',
              background: 'none', cursor: 'pointer', gap: 2,
              opacity: active ? 1 : 0.45,
            }}
          >
            <span style={{ fontSize: active ? 22 : 20 }}>{tab.emoji}</span>
            <span style={{
              fontSize: 10, fontWeight: active ? 700 : 500,
              color: active ? 'var(--accent)' : 'var(--muted)',
              fontFamily: 'var(--font)'
            }}>{tab.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
