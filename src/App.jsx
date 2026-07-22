import { Routes, Route, useSearchParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { AuthProvider, useAuth } from './context/AuthContext'
import { isSubscribed } from './billing'
import AuthScreen from './pages/AuthScreen'
import Paywall from './pages/Paywall'
import Home from './pages/Home'
import NewProject from './pages/NewProject'
import ProjectDetail from './pages/ProjectDetail'
import SellProject from './pages/SellProject'

function AppRoutes() {
  const { user, profile, loading, refreshProfile } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [polling, setPolling] = useState(false)

  // When Stripe redirects back with ?subscribed=true, poll until webhook fires
  useEffect(() => {
    if (!searchParams.get('subscribed') || !user) return
    setPolling(true)

    let attempts = 0
    const interval = setInterval(async () => {
      attempts++
      await refreshProfile()
      const fresh = await import('./supabase').then(m => m.getProfile(user.id))
      if (fresh?.subscription_status === 'active' || fresh?.subscription_status === 'trialing') {
        clearInterval(interval)
        setPolling(false)
        setSearchParams({})
      }
      if (attempts >= 15) { // give up after 30s
        clearInterval(interval)
        setPolling(false)
        setSearchParams({})
      }
    }, 2000)

    return () => clearInterval(interval)
  }, [searchParams.get('subscribed'), user])

  if (loading || polling) return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', gap: 16
    }}>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 36, letterSpacing: '-0.02em' }}>
        <span style={{ color: 'var(--text)' }}>Side</span>
        <span style={{ color: 'var(--accent)' }}>Flip</span>
      </div>
      {polling && (
        <div style={{ fontSize: 14, color: 'var(--muted)', textAlign: 'center', maxWidth: 260, lineHeight: 1.6 }}>
          Activating your account…
        </div>
      )}
    </div>
  )

  // Not logged in
  if (!user) return <AuthScreen />

  // Logged in but no active subscription — hard gate
  if (!profile || !isSubscribed(profile)) return <Paywall trialExpired={true} />

  // Full access — subscribed
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/new" element={<NewProject />} />
      <Route path="/project/:id" element={<ProjectDetail />} />
      <Route path="/project/:id/sell" element={<SellProject />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  )
}
