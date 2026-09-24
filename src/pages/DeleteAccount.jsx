import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabase'
import { clearSideFlipBrowserData } from '../accountCleanup'
import { resetAnalytics } from '../analytics'

const BILLING_NOTICE = 'Deleting SideFlip data does not cancel subscriptions. Cancel any subscription through its original billing provider, including Apple, Google Play, or the SideFlip web billing portal.'

export default function DeleteAccount() {
  const navigate = useNavigate()
  const { signOut } = useAuth()
  const [confirmation, setConfirmation] = useState('')
  const [phase, setPhase] = useState('ready')
  const [message, setMessage] = useState('')
  const [serverDeleted, setServerDeleted] = useState(false)

  async function cleanupBrowser() {
    setPhase('cleaning')
    setMessage('Removing SideFlip data from this browser…')
    try {
      resetAnalytics()
      await clearSideFlipBrowserData()
      try { await signOut() } catch { /* The server account may already be gone. */ }
      setPhase('complete')
      setMessage('Your SideFlip account and browser-local app data have been deleted.')
    } catch {
      setPhase('cleanup-failed')
      setMessage('Your account was deleted, but some SideFlip data could not be removed from this browser. Retry cleanup or clear site data in your browser settings.')
    }
  }

  async function deleteAccount() {
    if (confirmation !== 'DELETE') {
      setMessage('Enter DELETE exactly in the confirmation field.')
      return
    }
    if (!window.confirm(`Permanently delete your SideFlip account and data? ${BILLING_NOTICE}`)) return

    setPhase('deleting')
    setMessage('Deleting your account, projects, photos, receipts, goals, and app data…')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Please sign in again before deleting your account.')
      const response = await fetch('/api/delete-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ confirmation: 'DELETE' }),
      })
      const body = await response.json().catch(() => ({}))
      if (response.status === 202 && body.deleting) {
        setPhase('pending')
        setMessage('Account deletion is still in progress. Wait a moment, then retry.')
        return
      }
      if (!response.ok || !body.deleted) throw new Error(body.error || 'Could not delete your account. Please try again.')
      setServerDeleted(true)
      await cleanupBrowser()
    } catch (error) {
      setPhase('failed')
      setMessage(error.message || 'Could not delete your account. Please try again.')
    }
  }

  const busy = phase === 'deleting' || phase === 'cleaning'
  const canDelete = confirmation === 'DELETE' && !busy && !serverDeleted

  return (
    <main style={{ padding: '28px 20px 80px', maxWidth: 600, margin: '0 auto' }}>
      <button type="button" onClick={() => navigate('/settings')} style={backStyle}>‹ Back to Settings</button>
      <h1 style={{ fontSize: 28 }}>Delete Account</h1>
      <p style={{ color: '#B3261E', fontWeight: 800 }}>This action is permanent.</p>
      <p style={copyStyle}>Deleting your account removes your SideFlip profile, projects, project photos, receipts, expenses, Trade-Up Goals, and app data. This cannot be undone.</p>
      <p style={copyStyle}>{BILLING_NOTICE}</p>
      <label htmlFor="delete-confirmation" style={{ display: 'block', fontWeight: 700, margin: '24px 0 8px' }}>Type DELETE to confirm</label>
      <input id="delete-confirmation" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy || serverDeleted} autoComplete="off" placeholder="DELETE" />
      <button className="btn" type="button" disabled={!canDelete} onClick={deleteAccount} style={{ marginTop: 16, background: '#B3261E', color: '#fff', opacity: canDelete ? 1 : 0.45 }}>
        {phase === 'deleting' ? 'Deleting Account…' : 'Permanently Delete Account'}
      </button>
      {message && <div role={phase.includes('failed') ? 'alert' : 'status'} className="card" style={{ marginTop: 16, lineHeight: 1.5 }}>{message}</div>}
      {(phase === 'failed' || phase === 'pending') && <button className="btn btn-secondary" type="button" onClick={deleteAccount} disabled={busy}>Retry Account Deletion</button>}
      {phase === 'cleanup-failed' && <button className="btn btn-secondary" type="button" onClick={cleanupBrowser}>Retry Browser Cleanup</button>}
      {phase === 'complete' && <a className="btn btn-secondary" href="/" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>Return to Sign In</a>}
    </main>
  )
}

const backStyle = { border: 0, background: 'none', color: 'var(--accent)', fontSize: 15, fontWeight: 700, cursor: 'pointer', padding: '8px 0' }
const copyStyle = { color: 'var(--body)', lineHeight: 1.55 }
