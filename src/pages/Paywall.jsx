import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { signOut } from '../supabase'
import { MONTHLY_PRICE, ANNUAL_PRICE, ANNUAL_MONTHLY_EQUIV, SAVINGS_PCT, TRIAL_DAYS } from '../billing'

export default function Paywall({ trialExpired }) {
  const { user } = useAuth()
  const [selected, setSelected] = useState('annual')
  const [loading, setLoading] = useState(false)

  async function handleSubscribe() {
    setLoading(true)
    // Stripe checkout — will wire up once we have price IDs
    const priceId = selected === 'annual'
      ? import.meta.env.VITE_STRIPE_ANNUAL_PRICE_ID
      : import.meta.env.VITE_STRIPE_MONTHLY_PRICE_ID

    try {
      const res = await fetch('/api/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId, userId: user.id, email: user.email })
      })
      const { url } = await res.json()
      window.location.href = url
    } catch (err) {
      alert('Something went wrong. Please try again.')
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
      padding: '32px 20px',
      maxWidth: 480,
      margin: '0 auto'
    }}>
      {/* Logo */}
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 36, letterSpacing: '-0.02em', marginBottom: 8 }}>
        <span style={{ color: 'var(--text)' }}>Side</span>
        <span style={{ color: 'var(--accent)' }}>Flip</span>
      </div>

      <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', marginBottom: 8, textAlign: 'center' }}>
        {trialExpired ? 'Your free trial has ended' : `${TRIAL_DAYS}-Day Free Trial`}
      </div>
      <div style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 32, textAlign: 'center', lineHeight: 1.6 }}>
        {trialExpired
          ? 'Subscribe to keep tracking your flips and accessing your data.'
          : 'Choose a plan to continue after your trial. Cancel anytime.'}
      </div>

      {/* Plan selector */}
      <div style={{ width: '100%', marginBottom: 24 }}>
        {/* Annual — highlighted */}
        <div
          onClick={() => setSelected('annual')}
          style={{
            background: selected === 'annual' ? 'var(--accent)' : '#fff',
            border: `2px solid ${selected === 'annual' ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 'var(--radius)',
            padding: '18px 16px',
            cursor: 'pointer',
            marginBottom: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            boxShadow: selected === 'annual' ? '0 4px 16px rgba(200,64,47,0.3)' : 'var(--shadow)',
            transition: 'all 0.15s',
            position: 'relative',
            overflow: 'hidden'
          }}
        >
          <div style={{ position: 'absolute', top: 8, right: -16, background: selected === 'annual' ? '#fff' : 'var(--accent)', color: selected === 'annual' ? 'var(--accent)' : '#fff', fontSize: 10, fontWeight: 800, padding: '2px 24px', transform: 'rotate(35deg)', letterSpacing: '0.04em' }}>
            BEST VALUE
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: selected === 'annual' ? '#fff' : 'var(--text)' }}>Annual Plan</div>
            <div style={{ fontSize: 13, color: selected === 'annual' ? 'rgba(255,255,255,0.8)' : 'var(--muted)', marginTop: 2 }}>
              Save {SAVINGS_PCT}% vs monthly · Auto-renews yearly
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: selected === 'annual' ? '#fff' : 'var(--text)', fontFamily: 'var(--font-heading)' }}>${ANNUAL_PRICE}</div>
            <div style={{ fontSize: 12, color: selected === 'annual' ? 'rgba(255,255,255,0.75)' : 'var(--muted)' }}>${ANNUAL_MONTHLY_EQUIV}/mo</div>
          </div>
        </div>

        {/* Monthly */}
        <div
          onClick={() => setSelected('monthly')}
          style={{
            background: selected === 'monthly' ? 'var(--surface)' : '#fff',
            border: `2px solid ${selected === 'monthly' ? 'var(--border-strong)' : 'var(--border)'}`,
            borderRadius: 'var(--radius)',
            padding: '18px 16px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            boxShadow: 'var(--shadow)',
            transition: 'all 0.15s'
          }}
        >
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>Monthly Plan</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>Flexible · Cancel anytime</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--text)', fontFamily: 'var(--font-heading)' }}>${MONTHLY_PRICE}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>per month</div>
          </div>
        </div>
      </div>

      {/* Features list */}
      <div style={{ width: '100%', marginBottom: 24 }}>
        {[
          'Unlimited projects',
          'Track all expenses & profit',
          'Photo uploads',
          'VIN, serial & engine tracking',
          'Notes on every project',
          'Lifetime profit dashboard',
        ].map(f => (
          <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border)', fontSize: 14, color: 'var(--body)' }}>
            <span style={{ color: 'var(--green)', fontWeight: 700 }}>✓</span> {f}
          </div>
        ))}
      </div>

      <button
        className="btn btn-primary"
        onClick={handleSubscribe}
        disabled={loading}
        style={{ marginBottom: 12 }}
      >
        {loading ? 'Redirecting...' : `Start with ${selected === 'annual' ? 'Annual' : 'Monthly'} Plan →`}
      </button>

      <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', marginBottom: 20 }}>
        Secure payment via Stripe · Cancel anytime
      </div>

      <button
        onClick={signOut}
        style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font)' }}
      >
        Sign out
      </button>
    </div>
  )
}
