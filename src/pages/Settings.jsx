import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabase'
import { isAnalyticsEnabled, setAnalyticsEnabled } from '../analytics'
import { CURRENCIES } from '../currencyModel'

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt', label: 'Português' },
  { code: 'ja', label: '日本語' },
]

export default function Settings() {
  const { user, profile, signOut, refreshProfile } = useAuth()
  const [currency, setCurrency] = useState(profile?.currency || 'USD')
  const [language, setLanguage] = useState(profile?.language || 'en')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [portalLoading, setPortalLoading] = useState(false)
  const [portalMessage, setPortalMessage] = useState('')
  const [analyticsEnabled, setAnalyticsPreference] = useState(isAnalyticsEnabled(user?.id))
  const [analyticsSaving, setAnalyticsSaving] = useState(false)
  const [analyticsError, setAnalyticsError] = useState('')

  async function handleAnalyticsPreference(enabled) {
    setAnalyticsSaving(true)
    setAnalyticsError('')
    // Disabling updates locally before this promise resolves; enabling remains
    // off until the API confirms the authenticated profile update.
    const result = await setAnalyticsEnabled(enabled, user?.id)
    setAnalyticsPreference(result.enabled)
    if (!result.ok) setAnalyticsError(result.error || 'Could not save analytics preference. Please try again.')
    setAnalyticsSaving(false)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Please sign in again.')
      const response = await fetch('/api/update-profile-preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ currency, language, onboarded: Boolean(profile?.onboarded) }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not save preferences.')
      await refreshProfile()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (error) {
      alert('Error saving: ' + error.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleManageSub() {
    setPortalMessage('')
    setPortalLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Please sign in again.')

      const res = await fetch('/api/create-portal-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
      })
      const { url, error } = await res.json()
      if (res.status === 404) {
        setPortalMessage(error || 'No web subscription was found for this login.')
        return
      }
      if (!res.ok || error) throw new Error(error || 'Could not open the billing portal.')
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

      <div style={sectionLabel}>Language</div>
      <select value={language} onChange={event => setLanguage(event.target.value)} style={{ width: '100%', marginBottom: 24 }}>
        {LANGUAGES.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}
      </select>

      <button className="btn btn-primary" onClick={handleSave} disabled={saving} style={{ marginBottom: 12 }}>
        {saving ? 'Saving…' : saved ? '✓ Saved!' : 'Save Changes'}
      </button>

      <div style={sectionLabel}>Web Subscription</div>
      <div className="card" style={{ marginBottom: 20 }}>
        {profile?.stripe_customer_id || profile?.subscription_id ? (
          <>
            <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 13 }}>
              Manage or cancel the SideFlip web subscription linked to this account.
            </p>
            <button className="btn btn-secondary" onClick={handleManageSub} disabled={portalLoading}>
              {portalLoading ? 'Loading…' : 'Manage Web Subscription'}
            </button>
          </>
        ) : (
          <>
            <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 13 }}>
              No active web subscription is linked to this account. SideFlip Free remains available.
            </p>
            <a className="btn btn-secondary" href="/pricing" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
              View Pro Plans
            </a>
            <button className="btn btn-secondary" onClick={handleManageSub} disabled={portalLoading} style={{ marginTop: 10 }}>
              {portalLoading ? 'Checking…' : 'Already subscribed on web? Find Web Subscription'}
            </button>
            {portalMessage && <p role="status" style={{ margin: '10px 0 0', color: 'var(--muted)', fontSize: 12 }}>{portalMessage}</p>}
          </>
        )}
      </div>

      <div style={sectionLabel}>Privacy</div>
      <label className="card" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 20, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={analyticsEnabled}
          disabled={analyticsSaving}
          onChange={event => handleAnalyticsPreference(event.target.checked)}
          style={{ marginTop: 3 }}
        />
        <span>
          <strong style={{ display: 'block', fontSize: 14 }}>Share usage analytics</strong>
          <span style={{ display: 'block', color: 'var(--muted)', fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>
            Help improve SideFlip by sharing a stable pseudonymous account ID, feature and screen usage, campaign/referral attribution, and subscription plan, status, amount, and currency. We never collect project text, photos, or project financials; card, billing, or payment-provider identifiers; or session recordings.
          </span>
          {analyticsSaving && <span style={{ display: 'block', color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>Saving analytics preference…</span>}
          {analyticsError && <span role="alert" style={{ display: 'block', color: '#B42318', fontSize: 12, marginTop: 6 }}>{analyticsError}</span>}
        </span>
      </label>

      <div style={sectionLabel}>Account Data</div>
      <div className="card" style={{ marginBottom: 20 }}>
        <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 }}>
          Permanently delete your account and SideFlip data. Subscription cancellation is handled separately by the original billing provider.
        </p>
        <a className="btn btn-secondary" href="/delete-account" style={{ display: 'block', textAlign: 'center', textDecoration: 'none', color: '#B3261E' }}>
          Delete Account
        </a>
      </div>

      <button className="btn btn-secondary" onClick={() => { if (confirm('Sign out?')) signOut() }} style={{ marginBottom: 24 }}>
        🚪 Sign Out
      </button>

      <div style={{ textAlign: 'center', marginTop: 8 }}>
        <a href="/terms" style={{ color: 'var(--muted)', fontSize: 12 }}>Terms of Service</a>
        <span style={{ color: 'var(--muted)', margin: '0 8px', fontSize: 12 }}>·</span>
        <a href="/support" style={{ color: 'var(--muted)', fontSize: 12 }}>Support</a>
        <span style={{ color: 'var(--muted)', margin: '0 8px', fontSize: 12 }}>·</span>
        <a href="/pricing" style={{ color: 'var(--muted)', fontSize: 12 }}>Plans</a>
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
