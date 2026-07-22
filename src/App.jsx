import { Routes, Route } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { isSubscribed } from './billing'
import AuthScreen from './pages/AuthScreen'
import Paywall from './pages/Paywall'
import Home from './pages/Home'
import NewProject from './pages/NewProject'
import ProjectDetail from './pages/ProjectDetail'
import SellProject from './pages/SellProject'

function AppRoutes() {
  const { user, profile, loading } = useAuth()

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 32, letterSpacing: '-0.02em' }}>
        <span style={{ color: 'var(--text)' }}>Side</span>
        <span style={{ color: 'var(--accent)' }}>Flip</span>
      </div>
    </div>
  )

  // Not logged in
  if (!user) return <AuthScreen />

  // Logged in but no active subscription — always show paywall
  if (!profile || !isSubscribed(profile)) return <Paywall trialExpired={true} />

  // Full access
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
