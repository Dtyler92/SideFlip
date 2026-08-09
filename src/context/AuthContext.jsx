import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { supabase, onAuthChange, getProfile, getEntitlement, signOut as supabaseSignOut } from '../supabase'
import {
  identifyAnalytics,
  isAnalyticsRuntimeReady,
  reconcileAnalyticsPreference,
  resetAnalytics,
} from '../analytics'
import { transitionReferralScope } from '../pwa'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined) // undefined = loading
  const [profile, setProfile] = useState(null)
  const [entitlement, setEntitlement] = useState(null)
  const [loading, setLoading] = useState(true)
  const [analyticsReady, setAnalyticsReady] = useState(false)
  const analyticsIdentityRef = useRef(undefined)
  const authRequestRef = useRef(0)

  useEffect(() => {
    let active = true

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (active) void handleAuthUser(session?.user ?? null)
    })

    const { data: { subscription } } = onAuthChange(u => {
      if (active) void handleAuthUser(u ?? null)
    })
    return () => {
      active = false
      authRequestRef.current += 1
      subscription.unsubscribe()
    }
  }, [])

  async function handleAuthUser(nextUser) {
    const nextUserId = nextUser?.id ?? null
    const requestId = ++authRequestRef.current

    if (analyticsIdentityRef.current !== nextUserId) {
      // Every user-ID/null boundary starts from a clean PostHog identity and
      // attribution state. Identification happens only after reconciliation.
      setAnalyticsReady(false)
      transitionReferralScope(analyticsIdentityRef.current, nextUserId)
      resetAnalytics()
      analyticsIdentityRef.current = nextUserId
    }

    setUser(nextUser)
    if (!nextUser) {
      setProfile(null)
      setEntitlement(null)
      await reconcileAnalyticsPreference(null)
      if (requestId !== authRequestRef.current || analyticsIdentityRef.current !== null) return
      setAnalyticsReady(isAnalyticsRuntimeReady(null))
      setLoading(false)
      return
    }

    setLoading(true)
    const [nextProfile, serverEntitlement] = await Promise.all([
      getProfile(nextUserId),
      getEntitlement().catch(() => null),
    ])
    if (requestId !== authRequestRef.current || analyticsIdentityRef.current !== nextUserId) return

    setProfile(nextProfile)
    setEntitlement(serverEntitlement)
    const enabled = await reconcileAnalyticsPreference(nextUserId)
    if (requestId !== authRequestRef.current || analyticsIdentityRef.current !== nextUserId) return

    if (enabled) identifyAnalytics(nextUserId, {
      plan: serverEntitlement?.plan || 'free',
      status: nextProfile?.subscription_status || 'none',
      is_pro: Boolean(serverEntitlement?.isPro),
    })
    setAnalyticsReady(isAnalyticsRuntimeReady(nextUserId))
    setLoading(false)
  }

  async function signOut() {
    try {
      return await supabaseSignOut()
    } finally {
      // Also reset when the auth SDK fails to emit (or delays) its null event.
      setAnalyticsReady(false)
      resetAnalytics()
      if (analyticsIdentityRef.current === null) {
        await reconcileAnalyticsPreference(null)
        if (analyticsIdentityRef.current === null) setAnalyticsReady(isAnalyticsRuntimeReady(null))
      }
    }
  }

  async function refreshProfile() {
    if (!user) return
    const [nextProfile, serverEntitlement] = await Promise.all([
      getProfile(user.id),
      getEntitlement().catch(() => null),
    ])
    if (analyticsIdentityRef.current !== user.id) return
    setProfile(nextProfile)
    setEntitlement(serverEntitlement)
  }

  return (
    <AuthContext.Provider value={{ user, profile, entitlement, loading, analyticsReady, refreshProfile, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
