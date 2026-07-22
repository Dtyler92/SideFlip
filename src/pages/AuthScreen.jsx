import { useState } from 'react'
import { signIn, signUp } from '../supabase'
import { MONTHLY_PRICE, ANNUAL_PRICE, ANNUAL_MONTHLY_EQUIV, SAVINGS_PCT } from '../billing'

export default function AuthScreen() {
  const [mode, setMode] = useState('signup')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [plan, setPlan] = useState('annual')
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
        const { data, error: err } = await signUp(email, password)
        if (err) throw err

        // Send straight to Stripe checkout
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
      <div style={{ marginBottom: 32, textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 42, letterSpacing: '-0.02em', lineHeight: 1 }}>
          <span style={{ color: 'var(--text)' }}>Side</span>
          <span style={{ color: 'var(--accent)' }}>Flip</span>
        </div>
        <div style={{ fontSize: 14, color: 'var(--muted)', marginTop: 6 }}>Track every flip. Know your profit.</div>
      </div>

      {/* Plan selector — only on signup */}
      {mode === 'signup' && (
        <div style={{ width: '100%', marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', textAlign: 'center', marginBottom: 10 }}>
            Choose your plan — 7-day free trial
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {/* Annual */}
            <div onClick={() => setPlan('annual')} style={{
              background: plan === 'annual' ? 'var(--accent)' : '#fff',
              border: `2px solid ${plan === 'annual' ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 'var(--radius)', padding: '14px 12px', cursor: 'pointer',
              textAlign: 'center', position: 'relative', overflow: 'hidden',
              boxShadow: plan === 'annual' ? '0 4px 16px rgba(200,64,47,0.3)' : 'var(--shadow)',
              transition: 'all 0.15s'
            }}>
              <div style={{ position: 'absolute', top: 7, right: -16, background: plan === 'annual' ? '#fff' : 'var(--accent)', color: plan === 'annual' ? 'var(--accent)' : '#fff', fontSize: 9, fontWeight: 800, padding: '2px 22px', transform: 'rotate(35deg)', letterSpacing: '0.04em' }}>BEST</div>
              <div style={{ fontSize: 11, color: plan === 'annual' ? 'rgba(255,255,255,0.8)' : 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Annual</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: plan === 'annual' ? '#fff' : 'var(--text)', fontFamily: 'var(--font-heading)', margin: '4px 0 2px' }}>${ANNUAL_PRICE}</div>
              <div style={{ fontSize: 11, color: plan === 'annual' ? 'rgba(255,255,255,0.75)' : 'var(--muted)' }}>${ANNUAL_MONTHLY_EQUIV}/mo · Save {SAVINGS_PCT}%</div>
            </div>
            {/* Monthly */}
            <div onClick={() => setPlan('monthly')} style={{
              background: plan === 'monthly' ? 'var(--surface)' : '#fff',
              border: `2px solid ${plan === 'monthly' ? 'var(--border-strong)' : 'var(--border)'}`,
              borderRadius: 'var(--radius)', padding: '14px 12px', cursor: 'pointer',
              textAlign: 'center', boxShadow: 'var(--shadow)', transition: 'all 0.15s'
            }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Monthly</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', fontFamily: 'var(--font-heading)', margin: '4px 0 2px' }}>${MONTHLY_PRICE}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>per month</div>
            </div>
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
        {success && (
          <div style={{ background: 'var(--green-soft)', border: '1px solid rgba(45,106,79,0.25)', borderRadius: 10, padding: '12px 14px', marginBottom: 16, fontSize: 14, color: 'var(--green)' }}>
            {success}
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

        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading
            ? 'Please wait...'
            : mode === 'signup'
              ? 'Start Free Trial →'
              : 'Sign In →'}
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
