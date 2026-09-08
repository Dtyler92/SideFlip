import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { supabase, onAuthChange, getProfile, getEntitlement, signOut as supabaseSignOut } from '../supabase'
import {
  identifyAnalytics,
  isAnalyticsRuntimeReady,
  reconcileAnalyticsPreference,
  resetAnalytics,
} from '../analytics'
import { transitionReferralScope } from '../pwa'
import { CURRENCY_SYMBOLS, formatMoneyForCurrency, normalizeCurrency } from '../currencyModel'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined)
  const [profile, setProfile] = useState(null)
  const [profileStatus, setProfileStatus] = useState('loading')
  const [entitlement, setEntitlement] = useState(null)
  const [entitlementStatus, setEntitlementStatus] = useState('loading')
  const [loading, setLoading] = useState(true)
  const [analyticsReady, setAnalyticsReady] = useState(false)
  const analyticsIdentityRef = useRef(undefined)
  const authRequestRef = useRef(0)
  const userRef = useRef(null)

  useEffect(() => { userRef.current = user }, [user])

  const loadAccount = useCallback(async (nextUser, { initial = false } = {}) => {
    const nextUserId = nextUser?.id
    if (!nextUserId) return null
    if (initial) setProfileStatus('loading')
    setEntitlementStatus('loading')

    const [profileResult, entitlementResult] = await Promise.allSettled([
      getProfile(nextUserId),
      getEntitlement(),
    ])
    if (userRef.current?.id !== nextUserId) return null

    let nextProfile = null
    let serverEntitlement = null
    if (profileResult.status === 'fulfilled' && profileResult.value) {
      nextProfile = profileResult.value
      setProfile(nextProfile)
      setProfileStatus('resolved')
    } else {
      if (initial) setProfile(null)
      setProfileStatus('unavailable')
    }
    if (entitlementResult.status === 'fulfilled' && entitlementResult.value) {
      serverEntitlement = entitlementResult.value
      setEntitlement(serverEntitlement)
      setEntitlementStatus('resolved')
    } else {
      if (initial) setEntitlement(null)
      setEntitlementStatus('unavailable')
    }
    return { profile: nextProfile, entitlement: serverEntitlement }
  }, [])

  useEffect(() => {
    let active = true

    async function handleAuthUser(nextUser) {
      const nextUserId = nextUser?.id ?? null
      const requestId = ++authRequestRef.current

      if (analyticsIdentityRef.current !== nextUserId) {
        setAnalyticsReady(false)
        transitionReferralScope(analyticsIdentityRef.current, nextUserId)
        resetAnalytics()
        analyticsIdentityRef.current = nextUserId
      }

      userRef.current = nextUser
      setUser(nextUser)
      if (!nextUser) {
        setProfile(null)
        setProfileStatus('resolved')
        setEntitlement(null)
        setEntitlementStatus('resolved')
        await reconcileAnalyticsPreference(null)
        if (!active || requestId !== authRequestRef.current || analyticsIdentityRef.current !== null) return
        setAnalyticsReady(isAnalyticsRuntimeReady(null))
        setLoading(false)
        return
      }

      setLoading(true)
      const account = await loadAccount(nextUser, { initial: true })
      if (!active || requestId !== authRequestRef.current || analyticsIdentityRef.current !== nextUserId) return
      const enabled = await reconcileAnalyticsPreference(nextUserId)
      if (!active || requestId !== authRequestRef.current || analyticsIdentityRef.current !== nextUserId) return
      const { profile: nextProfile, entitlement: serverEntitlement } = account || {}
      if (enabled) identifyAnalytics(nextUserId, {
        plan: serverEntitlement?.plan || 'unavailable',
        status: nextProfile?.subscription_status || 'none',
        is_pro: serverEntitlement?.plan === 'pro',
      })
      setAnalyticsReady(isAnalyticsRuntimeReady(nextUserId))
      setLoading(false)
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (active) void handleAuthUser(session?.user ?? null)
    })
    const { data: { subscription } } = onAuthChange(nextUser => {
      if (active) void handleAuthUser(nextUser ?? null)
    })
    return () => {
      active = false
      authRequestRef.current += 1
      subscription.unsubscribe()
    }
  }, [loadAccount])

  const refreshProfile = useCallback(async () => {
    if (!userRef.current) return null
    return loadAccount(userRef.current)
  }, [loadAccount])

  const refreshEntitlement = useCallback(async () => {
    const activeUser = userRef.current
    if (!activeUser) return null
    setEntitlementStatus('loading')
    try {
      const nextEntitlement = await getEntitlement()
      if (!nextEntitlement) throw new Error('Could not resolve your plan.')
      if (userRef.current?.id !== activeUser.id) return null
      setEntitlement(nextEntitlement)
      setEntitlementStatus('resolved')
      return nextEntitlement
    } catch {
      if (userRef.current?.id === activeUser.id) setEntitlementStatus('unavailable')
      return null
    }
  }, [])

  useEffect(() => {
    const refreshWhenActive = () => { if (userRef.current) void refreshEntitlement() }
    const onVisibility = () => { if (document.visibilityState === 'visible') refreshWhenActive() }
    window.addEventListener('focus', refreshWhenActive)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', refreshWhenActive)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refreshEntitlement])

  async function signOut() {
    try {
      return await supabaseSignOut()
    } finally {
      setAnalyticsReady(false)
      resetAnalytics()
      userRef.current = null
      setUser(null)
      setProfile(null)
      setProfileStatus('resolved')
      setEntitlement(null)
      setEntitlementStatus('resolved')
      await reconcileAnalyticsPreference(null)
      setAnalyticsReady(isAnalyticsRuntimeReady(null))
    }
  }

  const currency = normalizeCurrency(profile?.currency)
  const currencySymbol = CURRENCY_SYMBOLS[currency]
  const formatMoney = useCallback(amount => formatMoneyForCurrency(amount, currency), [currency])
  const needsOnboarding = profileStatus === 'resolved' && Boolean(profile && !profile.onboarded)
  const isPro = entitlementStatus === 'resolved' && entitlement?.plan === 'pro'

  return (
    <AuthContext.Provider value={{
      user, profile, profileStatus, entitlement, entitlementStatus, isPro,
      loading, analyticsReady, currency, currencySymbol, formatMoney,
      needsOnboarding, refreshProfile, refreshEntitlement, signOut,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
