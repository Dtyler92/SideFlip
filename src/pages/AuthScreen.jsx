import { useState } from 'react'
import { signIn, signUp, resetPassword } from '../supabase'

export default function AuthScreen() {
  const [mode, setMode] = useState('signup') // signup | signin | forgot
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    if (mode === 'signup' && password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    if (mode === 'signup' && password.length < 6) {
      setError('Password must be at least 6 characters')
      return
    }
    setLoading(true)
    try {
      if (mode === 'forgot') {
        const { error: err } = await resetPassword(email)
        if (err) throw err
        setError('')
        alert(`Password reset email sent to ${email}. Check your inbox!`)
        setMode('signin')
        setLoading(false)
        return
      }

      if (mode === 'signup') {
        const { data, error: err } = await signUp(email, password)
        if (err) throw err

        // Supabase may require email confirmation before it issues a session.
        // Either way, Free accounts never enter checkout during signup.
        if (!data?.session) {
          alert(`Check ${email} to confirm your account, then sign in to start using SideFlip Free.`)
          setMode('signin')
          setLoading(false)
        }

      } else {
        const { error: err } = await signIn(email, password)
        if (err) throw err
      }
    } catch (err) {
      setError(err.message || 'Something went wrong')
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--bg)', display: 'flex',
      flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '24px 20px', maxWidth: 480, margin: '0 auto'
    }}>
      {/* Logo */}
      <div style={{ marginBottom: 36, textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 48, letterSpacing: '-0.02em', lineHeight: 1 }}>
          <span style={{ color: 'var(--text)' }}>Side</span>
          <span style={{ color: 'var(--accent)' }}>Flip</span>
        </div>
        <div style={{ fontSize: 14, color: 'var(--muted)', marginTop: 8 }}>Track every flip. Know your profit.</div>
      </div>

      <div style={{ width: '100%', marginBottom: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 14, lineHeight: 1.5 }}>
        Create your free account to track projects, expenses, profit, and one Trade-Up Goal. No card required.
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} style={{ width: '100%' }}>
        {error && (
          <div style={{ background: 'var(--accent-soft)', border: '1px solid rgba(200,64,47,0.25)', borderRadius: 10, padding: '12px 14px', marginBottom: 16, fontSize: 14, color: 'var(--accent)' }}>
            {error}
          </div>
        )}

        <div className="form-group">
          <label>Email</label>
          <input type="email" inputMode="email" autoComplete="email"
            placeholder="you@example.com" value={email}
            onChange={e => setEmail(e.target.value)} required />
        </div>

        {mode !== 'forgot' && (
          <div className="form-group">
            <label>Password</label>
            <input type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              placeholder={mode === 'signup' ? 'Choose a password (6+ chars)' : 'Your password'}
              value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
          </div>
        )}

        {mode === 'signup' && (
          <div className="form-group">
            <label>Confirm Password</label>
            <input type="password" autoComplete="new-password"
              placeholder="Re-enter your password"
              value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required />
          </div>
        )}

        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Please wait...' : mode === 'signup' ? 'Create Free Account' : mode === 'forgot' ? 'Send Reset Email' : 'Sign In →'}
        </button>
      </form>

      {/* Toggle */}
      <div style={{ marginTop: 20, fontSize: 14, color: 'var(--muted)', textAlign: 'center' }}>
        {mode === 'signup' ? (
          <>Already have an account?{' '}
            <button onClick={() => { setMode('signin'); setError('') }}
              style={linkStyle}>Sign in</button>
          </>
        ) : mode === 'forgot' ? (
          <>
            <button onClick={() => { setMode('signin'); setError('') }}
              style={linkStyle}>← Back to sign in</button>
          </>
        ) : (
          <>
            <button onClick={() => { setMode('forgot'); setError('') }}
              style={{ ...linkStyle, color: 'var(--muted)', fontWeight: 500 }}>Forgot password?</button>
            <span style={{ margin: '0 10px' }}>·</span>
            Don't have an account?{' '}
            <button onClick={() => { setMode('signup'); setError('') }}
              style={linkStyle}>Create a free account</button>
          </>
        )}
      </div>
      <div style={{ marginTop: 32, fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
        <a href="/privacy" style={{ color: 'var(--muted)' }}>Privacy Policy</a>
        {' · '}
        <a href="/terms" style={{ color: 'var(--muted)' }}>Terms of Service</a>
        {' · '}
        <a href="/support" style={{ color: 'var(--muted)' }}>Support</a>
      </div>
    </div>
  )
}

const linkStyle = {
  background: 'none', border: 'none', color: 'var(--accent)',
  fontWeight: 700, cursor: 'pointer', fontSize: 14, fontFamily: 'var(--font)'
}
