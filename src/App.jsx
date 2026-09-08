import { Routes, Route, useLocation, useSearchParams } from 'react-router-dom'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { AuthProvider, useAuth } from './context/AuthContext'
import { DataProvider } from './context/DataContext'
import { captureReferral } from './pwa'
import InstallBanner from './components/InstallBanner'
import BottomNav from './components/BottomNav'
import { captureAttribution, captureEvent } from './analytics'

const AuthScreen = lazy(() => import('./pages/AuthScreen'))
const Home = lazy(() => import('./pages/Home'))
const NewProject = lazy(() => import('./pages/NewProject'))
const ProjectDetail = lazy(() => import('./pages/ProjectDetail'))
const SellProject = lazy(() => import('./pages/SellProject'))
const Calculator = lazy(() => import('./pages/Calculator'))
const Analytics = lazy(() => import('./pages/Analytics'))
const Settings = lazy(() => import('./pages/Settings'))
const Goals = lazy(() => import('./pages/Goals'))
const Onboarding = lazy(() => import('./pages/Onboarding'))
const DeleteAccount = lazy(() => import('./pages/DeleteAccount'))
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'))
const TermsOfService = lazy(() => import('./pages/TermsOfService'))
const Paywall = lazy(() => import('./pages/Paywall'))

// These optional modules are deliberate replacement hooks. Adding
// pages/MyStuff.jsx or pages/Analyze.jsx replaces the placeholder automatically.
const optionalProductPages = import.meta.glob('./pages/{FeaturePlaceholder,MyStuff,Analyze}.jsx')
function optionalProductPage(path, title) {
  const loader = optionalProductPages[path] || (() => import('./pages/FeaturePlaceholder').then(({ default: Placeholder }) => ({
    default: () => <Placeholder title={title} />,
  })))
  return lazy(loader)
}
const MyStuff = optionalProductPage('./pages/MyStuff.jsx', 'My Stuff')
const Analyze = optionalProductPage('./pages/Analyze.jsx', 'Analyze')

function analyticsScreen(pathname) {
  if (/^\/project\/[^/]+\/sell$/.test(pathname)) return 'sell_project'
  if (/^\/project\/[^/]+$/.test(pathname)) return 'project_detail'
  return ({ '/': 'home', '/new': 'new_project', '/calculator': 'calculator', '/analytics': 'analytics', '/my-stuff': 'my_stuff', '/analyze': 'analyze', '/goals': 'goals', '/settings': 'settings', '/delete-account': 'delete_account', '/upgrade': 'paywall', '/privacy': 'privacy', '/terms': 'terms' })[pathname] || 'unknown'
}

function LoadingScreen({ message }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', gap: 16
    }}>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 36, letterSpacing: '-0.02em' }}>
        <span style={{ color: 'var(--text)' }}>Side</span>
        <span style={{ color: 'var(--accent)' }}>Flip</span>
      </div>
      {message && (
        <div style={{ fontSize: 14, color: 'var(--muted)', textAlign: 'center', maxWidth: 260, lineHeight: 1.6 }}>
          {message}
        </div>
      )}
    </div>
  )
}

function AppRoutes() {
  const { user, profile, profileStatus, needsOnboarding, loading, analyticsReady, refreshProfile } = useAuth()
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
  const checkoutSubscribed = searchParams.get('subscribed')
  useEffect(() => {
    if (!analyticsReady || !checkoutCanceled) return
    captureEvent('stripe_checkout_cancelled', { provider: 'stripe' })
    setSearchParams({}, { replace: true })
  }, [analyticsReady, checkoutCanceled, setSearchParams])

  // When Stripe redirects back with ?subscribed=true, poll until webhook fires
  useEffect(() => {
    if (!checkoutSubscribed || !user) return
    setPolling(true)

    let attempts = 0
    let canceled = false
    let timeout
    const finish = (activated = false) => {
      if (canceled) return
      setPolling(false)
      setSearchParams({}, { replace: true })
      if (activated) setShowInstall(true)
    }
    const poll = async () => {
      attempts++
      try {
        const { entitlement: freshEntitlement } = await refreshProfile() || {}
        if (freshEntitlement?.plan === 'pro') {
          finish(true)
          return
        }
      } catch {
        // A webhook or transient request may still complete before the next poll.
      }
      if (attempts >= 15) finish(false)
      else if (!canceled) timeout = setTimeout(poll, 2000)
    }
    timeout = setTimeout(poll, 2000)

    return () => { canceled = true; clearTimeout(timeout) }
  }, [checkoutSubscribed, user, refreshProfile, setSearchParams])

  // Public routes — no auth needed
  if (window.location.pathname === '/privacy') return <Suspense fallback={<LoadingScreen />}><PrivacyPolicy /></Suspense>
  if (window.location.pathname === '/terms') return <Suspense fallback={<LoadingScreen />}><TermsOfService /></Suspense>

  if (loading || polling || (user && profileStatus === 'loading')) {
    return <LoadingScreen message={polling ? 'Activating your account…' : undefined} />
  }

  // Not logged in
  if (!user) return <Suspense fallback={<LoadingScreen />}><AuthScreen /></Suspense>

  if (profileStatus === 'unavailable' || !profile) return (
    <LoadingScreen message="Your account details are temporarily unavailable. Check your connection and reload to try again." />
  )

  if (needsOnboarding) return <Suspense fallback={<LoadingScreen />}><Onboarding /></Suspense>

  // Authenticated users always receive the Free core. Individual Pro features
  // are gated by their own capability checks inside those screens.
  return (
    <DataProvider>
      {showInstall && <InstallBanner onDismiss={() => setShowInstall(false)} />}
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/new" element={<NewProject />} />
          <Route path="/project/:id" element={<ProjectDetail />} />
          <Route path="/project/:id/sell" element={<SellProject />} />
          <Route path="/calculator" element={<Calculator />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/my-stuff" element={<MyStuff />} />
          <Route path="/analyze" element={<Analyze />} />
          <Route path="/goals" element={<Goals />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/delete-account" element={<DeleteAccount />} />
          <Route path="/upgrade" element={<Paywall />} />
        </Routes>
      </Suspense>
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
