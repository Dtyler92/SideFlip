import { Routes, Route, useLocation, useSearchParams } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { AuthProvider, useAuth } from './context/AuthContext'
import { DataProvider } from './context/DataContext'
import { captureReferral } from './pwa'
import AuthScreen from './pages/AuthScreen'
import Home from './pages/Home'
import NewProject from './pages/NewProject'
import ProjectDetail from './pages/ProjectDetail'
import SellProject from './pages/SellProject'
import Calculator from './pages/Calculator'
import Analytics from './pages/Analytics'
import Settings from './pages/Settings'
import Goals from './pages/Goals'
import PrivacyPolicy from './pages/PrivacyPolicy'
import TermsOfService from './pages/TermsOfService'
import Paywall from './pages/Paywall'
import InstallBanner from './components/InstallBanner'
import BottomNav from './components/BottomNav'
import { captureAttribution, captureEvent } from './analytics'

function analyticsScreen(pathname) {
  if (/^\/project\/[^/]+\/sell$/.test(pathname)) return 'sell_project'
  if (/^\/project\/[^/]+$/.test(pathname)) return 'project_detail'
  return ({ '/': 'home', '/new': 'new_project', '/calculator': 'calculator', '/analytics': 'analytics', '/goals': 'goals', '/settings': 'settings', '/upgrade': 'paywall', '/privacy': 'privacy', '/terms': 'terms' })[pathname] || 'unknown'
}

function AppRoutes() {
  const { user, profile, loading, analyticsReady, refreshProfile } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [polling, setPolling] = useState(false)
  const [showInstall, setShowInstall] = useState(false)
  const location = useLocation()
  const initialUrlRef = useRef(window.location.href)
  const referralCapturedRef = useRef(false)
  const attributionCapturedRef = useRef(false)

  // Attribution must inspect the original URL before referral cleanup. Keeping
  // the initial URL in memory also allows consent reconciliation to finish
  // without persisting raw campaign input.
  useEffect(() => {
    if (loading || referralCapturedRef.current) return
    const attribution = captureAttribution(initialUrlRef.current)
    attributionCapturedRef.current = Object.keys(attribution).length > 0
    captureReferral(initialUrlRef.current, user?.id)
    referralCapturedRef.current = true
  }, [loading, user?.id])

  useEffect(() => {
    if (!analyticsReady || attributionCapturedRef.current) return
    const attribution = captureAttribution(initialUrlRef.current)
    attributionCapturedRef.current = Object.keys(attribution).length > 0
  }, [analyticsReady])

  useEffect(() => {
    if (!analyticsReady) return
    captureEvent('screen_viewed', { screen: analyticsScreen(location.pathname) })
  }, [analyticsReady, location.pathname])

  const checkoutCanceled = searchParams.get('canceled')
  useEffect(() => {
    if (!analyticsReady || !checkoutCanceled) return
    captureEvent('stripe_checkout_cancelled', { provider: 'stripe' })
    setSearchParams({}, { replace: true })
  }, [analyticsReady, checkoutCanceled, setSearchParams])

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
          setShowInstall(true) // prompt install after successful payment
        }
      if (attempts >= 15) { // give up after 30s
        clearInterval(interval)
        setPolling(false)
        setSearchParams({})
      }
    }, 2000)

    return () => clearInterval(interval)
  }, [searchParams.get('subscribed'), user])

  // Public routes — no auth needed
  if (window.location.pathname === '/privacy') return <PrivacyPolicy />
  if (window.location.pathname === '/terms') return <TermsOfService />

  if (loading || polling || (user && !profile)) return (
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

  // Authenticated users always receive the Free core. Individual Pro features
  // are gated by their own capability checks inside those screens.
  return (
    <DataProvider>
      {showInstall && <InstallBanner onDismiss={() => setShowInstall(false)} />}
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/new" element={<NewProject />} />
        <Route path="/project/:id" element={<ProjectDetail />} />
        <Route path="/project/:id/sell" element={<SellProject />} />
        <Route path="/calculator" element={<Calculator />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/goals" element={<Goals />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/upgrade" element={<Paywall trialExpired={false} />} />
      </Routes>
      <BottomNav />
    </DataProvider>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  )
}
