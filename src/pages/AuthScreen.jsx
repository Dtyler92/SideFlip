import { useState } from 'react'
import { signIn, signUp } from '../supabase'

export default function AuthScreen() {
  const [mode, setMode] = useState('signin') // signin | signup
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSuccess('')
    setLoading(true)

    try {
      if (mode === 'signup') {
        const { error: err } = await signUp(email, password)
        if (err) throw err
        setSuccess('Check your email to confirm your account, then sign in!')
        setMode('signin')
      } else {
        const { error: err } = await signIn(email, password)
        if (err) throw err
        // AuthContext will pick up the session change automatically
      }
    } catch (err) {
      setError(err.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px 20px',
      maxWidth: 480,
      margin: '0 auto'
    }}>
      {/* Logo */}
      <div style={{ marginBottom: 40, textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 42, letterSpacing: '-0.02em', lineHeight: 1 }}>
          <span style={{ color: 'var(--text)' }}>Side</span>
          <span style={{ color: 'var(--accent)' }}>Flip</span>
        </div>
        <div style={{ fontSize: 14, color: 'var(--muted)', marginTop: 6 }}>Track every flip. Know your profit.</div>
      </div>

      {/* Trial callout */}
      {mode === 'signup' && (
        <div style={{
          width: '100%',
          background: 'var(--accent-soft)',
          border: '1px solid rgba(200,64,47,0.2)',
          borderRadius: 'var(--radius)',
          padding: '12px 16px',
          marginBottom: 20,
          textAlign: 'center'
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent)' }}>🎉 Start your 7-day free trial</div>
          <div style={{ fontSize: 13, color: 'var(--body)', marginTop: 2 }}>No credit card required to get started</div>
        </div>
      )}

      {/* Form */}
      <form onSubmit={handleSubmit} style={{ width: '100%' }}>
        {error && (
          <div style={{ background: 'var(--accent-soft)', border: '1px solid rgba(200,64,47,0.25)', borderRadius: 10, padding: '12px 14px', marginBottom: 16, fontSize: 14, color: 'var(--accent)' }}>
            {error}
          </div>
        )}
        {success && (
          <div style={{ background: 'var(--green-soft)', border: '1px solid rgba(45,106,79,0.25)', borderRadius: 10, padding: '12px 14px', marginBottom: 16, fontSize: 14, color: 'var(--green)' }}>
            {success}
          </div>
        )}

        <div className="form-group">
          <label>Email</label>
          <input
            type="email" inputMode="email" autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="form-group">
          <label>Password</label>
          <input
            type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            placeholder={mode === 'signup' ? 'Choose a password (6+ chars)' : 'Your password'}
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            minLength={6}
          />
        </div>

        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Please wait...' : mode === 'signup' ? 'Create Account — Free Trial →' : 'Sign In →'}
        </button>
      </form>

      {/* Toggle */}
      <div style={{ marginTop: 20, fontSize: 14, color: 'var(--muted)', textAlign: 'center' }}>
        {mode === 'signin' ? (
          <>Don't have an account?{' '}
            <button onClick={() => { setMode('signup'); setError(''); setSuccess('') }}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', fontWeight: 700, cursor: 'pointer', fontSize: 14, fontFamily: 'var(--font)' }}>
              Sign up free
            </button>
          </>
        ) : (
          <>Already have an account?{' '}
            <button onClick={() => { setMode('signin'); setError(''); setSuccess('') }}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', fontWeight: 700, cursor: 'pointer', fontSize: 14, fontFamily: 'var(--font)' }}>
              Sign in
            </button>
          </>
        )}
      </div>

      {/* Pricing preview */}
      <div style={{ marginTop: 40, width: '100%' }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, textAlign: 'center', marginBottom: 12 }}>
          After your free trial
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '14px 12px', textAlign: 'center', boxShadow: '0 1px 4px rgba(13,13,11,0.06)' }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Monthly</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--text)', margin: '6px 0 2px', fontFamily: 'var(--font-heading)' }}>$5.99</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>per month</div>
          </div>
          <div style={{ background: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 'var(--radius)', padding: '14px 12px', textAlign: 'center', position: 'relative', overflow: 'hidden', boxShadow: '0 2px 12px rgba(200,64,47,0.3)' }}>
            <div style={{ position: 'absolute', top: 7, right: -18, background: '#fff', color: 'var(--accent)', fontSize: 10, fontWeight: 800, padding: '2px 24px', transform: 'rotate(35deg)', letterSpacing: '0.04em' }}>BEST</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.8)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Annual</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: '#fff', margin: '6px 0 2px', fontFamily: 'var(--font-heading)' }}>$39</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)' }}>$3.25/mo · Save 46%</div>
          </div>
        </div>
      </div>
    </div>
  )
}
