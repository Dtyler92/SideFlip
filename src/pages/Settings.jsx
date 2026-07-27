import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabase'

const CURRENCIES = [
  { code: 'USD', symbol: '$', label: 'US Dollar' },
  { code: 'CAD', symbol: 'CA$', label: 'Canadian Dollar' },
  { code: 'GBP', symbol: '£', label: 'British Pound' },
  { code: 'EUR', symbol: '€', label: 'Euro' },
  { code: 'AUD', symbol: 'A$', label: 'Australian Dollar' },
  { code: 'MXN', symbol: 'MX$', label: 'Mexican Peso' },
  { code: 'JPY', symbol: '¥', label: 'Japanese Yen' },
  { code: 'INR', symbol: '₹', label: 'Indian Rupee' },
]

export default function Settings() {
  const { user, profile, signOut, refreshProfile } = useAuth()
  const [currency, setCurrency] = useState(profile?.currency || 'USD')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [portalLoading, setPortalLoading] = useState(false)

  async function handleSave() {
    setSaving(true)
    const { error } = await supabase.from('profiles').update({ currency }).eq('id', user.id)
    setSaving(false)
    if (error) return alert('Error saving: ' + error.message)
    await refreshProfile()
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleManageSub() {
    setPortalLoading(true)
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

  return (
    <div style={{ padding: '20px 16px 100px', maxWidth: 600, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, fontWeight: 800, color: 'var(--text)', margin: '0 0 20px' }}>Settings</h1>

      {/* Account */}
      <div style={sectionLabel}>Account</div>
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text)' }}>{user?.email}</div>
      </div>

      {/* Currency */}
      <div style={sectionLabel}>Currency</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 24 }}>
        {CURRENCIES.map(c => (
          <button key={c.code} type="button" onClick={() => setCurrency(c.code)} style={{
            width: 'calc(50% - 5px)', borderRadius: 12, border: '1.5px solid',
            borderColor: currency === c.code ? 'var(--accent)' : 'var(--border)',
            background: currency === c.code ? 'var(--accent-soft)' : '#fff',
            padding: 12, cursor: 'pointer', textAlign: 'center', fontFamily: 'var(--font)'
          }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: currency === c.code ? 'var(--accent)' : 'var(--text)' }}>{c.symbol}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: currency === c.code ? 'var(--accent)' : 'var(--text)' }}>{c.code}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>{c.label}</div>
          </button>
        ))}
      </div>

      <button className="btn btn-primary" onClick={handleSave} disabled={saving} style={{ marginBottom: 12 }}>
        {saving ? 'Saving…' : saved ? '✓ Saved!' : 'Save Changes'}
      </button>

      <button className="btn btn-secondary" onClick={handleManageSub} disabled={portalLoading} style={{ marginBottom: 12 }}>
        {portalLoading ? 'Loading…' : '💳 Manage Subscription'}
      </button>

      <button className="btn btn-secondary" onClick={() => { if (confirm('Sign out?')) signOut() }} style={{ marginBottom: 24 }}>
        🚪 Sign Out
      </button>

      <div style={{ textAlign: 'center', marginTop: 8 }}>
        <a href="/terms" style={{ color: 'var(--muted)', fontSize: 12 }}>Terms of Service</a>
        <span style={{ color: 'var(--muted)', margin: '0 8px', fontSize: 12 }}>·</span>
        <a href="/privacy" style={{ color: 'var(--muted)', fontSize: 12 }}>Privacy Policy</a>
      </div>
      <div style={{ textAlign: 'center', marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>SideFlip v1.0</div>
    </div>
  )
}

const sectionLabel = {
  fontSize: 11, fontWeight: 700, color: 'var(--muted)',
  textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10
}
