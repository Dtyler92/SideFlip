import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabase'
import { CURRENCIES } from '../currencyModel'
import { captureEvent } from '../analytics'

const LANGUAGES = [
  { code: 'en', label: '🇺🇸 English' },
  { code: 'es', label: '🇪🇸 Español' },
  { code: 'fr', label: '🇫🇷 Français' },
  { code: 'de', label: '🇩🇪 Deutsch' },
  { code: 'pt', label: '🇧🇷 Português' },
  { code: 'ja', label: '🇯🇵 日本語' },
]

export default function Onboarding() {
  const { signOut, refreshProfile } = useAuth()
  const [currency, setCurrency] = useState('USD')
  const [language, setLanguage] = useState('en')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { captureEvent('onboarding_started', { source: 'web' }) }, [])

  async function handleSave() {
    setSaving(true)
    setError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Please sign in again.')
      const response = await fetch('/api/update-profile-preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ currency, language, onboarded: true }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not save preferences.')
      captureEvent('onboarding_completed', { source: 'web' })
      await refreshProfile()
    } catch (saveError) {
      setError(saveError.message || 'Could not save preferences.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main style={{ minHeight: '100vh', padding: '48px 20px', maxWidth: 600, margin: '0 auto' }}>
      <div className="wordmark" style={{ textAlign: 'center', fontSize: 42, marginBottom: 24 }}>
        <span className="wordmark-side">Side</span><span className="wordmark-flip">Flip</span>
      </div>
      <h1 style={{ textAlign: 'center', fontSize: 24 }}>Welcome! Let&apos;s set up your account.</h1>
      <p style={{ textAlign: 'center', color: 'var(--muted)', marginBottom: 28 }}>You can change these anytime in Settings.</p>
      {error && <div role="alert" className="card" style={{ color: '#B42318', marginBottom: 16 }}>{error}</div>}
      <div style={sectionLabel}>Currency</div>
      <div style={gridStyle}>
        {CURRENCIES.map(item => <Choice key={item.code} active={currency === item.code} onClick={() => setCurrency(item.code)}>{item.symbol} · {item.code}<small>{item.label}</small></Choice>)}
      </div>
      <div style={sectionLabel}>Language</div>
      <div style={gridStyle}>
        {LANGUAGES.map(item => <Choice key={item.code} active={language === item.code} onClick={() => setLanguage(item.code)}>{item.label}</Choice>)}
      </div>
      <button className="btn btn-primary" type="button" disabled={saving} onClick={handleSave}>{saving ? 'Saving…' : 'Get Started'}</button>
      <button type="button" disabled={saving} onClick={signOut} style={linkStyle}>← Back to Sign In</button>
    </main>
  )
}

function Choice({ active, onClick, children }) {
  return <button type="button" onClick={onClick} style={{ borderRadius: 12, border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border)'}`, background: active ? 'var(--accent-soft)' : '#fff', padding: 12, color: active ? 'var(--accent)' : 'var(--text)', fontWeight: 700, cursor: 'pointer' }}>{children}</button>
}
const gridStyle = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginBottom: 24 }
const sectionLabel = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }
const linkStyle = { display: 'block', margin: '12px auto', border: 0, background: 'none', color: 'var(--accent)', fontWeight: 700, cursor: 'pointer' }
