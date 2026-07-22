import { useState } from 'react'
import { signIn, signUp } from '../supabase'

export default function AuthScreen() {
  const [mode, setMode] = useState('signup')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [plan, setPlan] = useState('annual')
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
      if (mode === 'signup') {
        const { data, error: err } = await signUp(email, password)
        if (err) throw err

        const priceId = plan === 'annual'
          ? import.meta.env.VITE_STRIPE_ANNUAL_PRICE_ID
          : import.meta.env.VITE_STRIPE_MONTHLY_PRICE_ID

        const userId = data?.user?.id
        const res = await fetch('/api/create-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ priceId, userId, email })
        })
        const { url, error: stripeErr } = await res.json()
        if (stripeErr) throw new Error(stripeErr)
        window.location.href = url

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

      {/* Plan toggle — signup only, no prices */}
      {mode === 'signup' && (
        <div style={{ width: '100%', marginBottom: 24 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', textAlign: 'center', marginBottom: 10 }}>
            Choose your plan — 7-day free trial
          </div>
          <div style={{ display: 'flex', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 3 }}>
            <button
              type="button"
              onClick={() => setPlan('annual')}
              style={{
                flex: 1, padding: '10px', border: 'none', cursor: 'pointer',
                borderRadius: 'calc(var(--radius) - 2px)', fontFamily: 'var(--font)',
                fontSize: 14, fontWeight: 700, transition: 'all 0.15s',
                background: plan === 'annual' ? 'var(--accent)' : 'transparent',
                color: plan === 'annual' ? '#fff' : 'var(--muted)',
                boxShadow: plan === 'annual' ? '0 2px 8px rgba(200,64,47,0.25)' : 'none'
              }}>
              Annual <span style={{ fontSize: 11, fontWeight: 600, opacity: 0.85 }}>· Best Value</span>
            </button>
            <button
              type="button"
              onClick={() => setPlan('monthly')}
              style={{
                flex: 1, padding: '10px', border: 'none', cursor: 'pointer',
                borderRadius: 'calc(var(--radius) - 2px)', fontFamily: 'var(--font)',
                fontSize: 14, fontWeight: 700, transition: 'all 0.15s',
                background: plan === 'monthly' ? '#fff' : 'transparent',
                color: plan === 'monthly' ? 'var(--text)' : 'var(--muted)',
                boxShadow: plan === 'monthly' ? 'var(--shadow)' : 'none'
              }}>
              Monthly
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', marginTop: 8 }}>
            Card required · Cancel before day 7 and you won't be charged
          </div>
        </div>
      )}

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

        <div className="form-group">
          <label>Password</label>
          <input type="password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            placeholder={mode === 'signup' ? 'Choose a password (6+ chars)' : 'Your password'}
            value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
        </div>

        {mode === 'signup' && (
          <div className="form-group">
            <label>Confirm Password</label>
            <input type="password" autoComplete="new-password"
              placeholder="Re-enter your password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)} required />
          </div>
        )}

        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Please wait...' : mode === 'signup' ? 'Start Free Trial' : 'Sign In →'}
        </button>
      </form>

      {/* Toggle */}
      <div style={{ marginTop: 20, fontSize: 14, color: 'var(--muted)', textAlign: 'center' }}>
        {mode === 'signup' ? (
          <>Already have an account?{' '}
            <button onClick={() => { setMode('signin'); setError('') }}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', fontWeight: 700, cursor: 'pointer', fontSize: 14, fontFamily: 'var(--font)' }}>
              Sign in
            </button>
          </>
        ) : (
          <>Don't have an account?{' '}
            <button onClick={() => { setMode('signup'); setError('') }}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', fontWeight: 700, cursor: 'pointer', fontSize: 14, fontFamily: 'var(--font)' }}>
              Start free trial
            </button>
          </>
        )}
      </div>
    </div>
  )
}
