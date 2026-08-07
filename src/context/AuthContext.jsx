import { createContext, useContext, useEffect, useState } from 'react'
import { supabase, onAuthChange, getProfile, getEntitlement, signOut as supabaseSignOut } from '../supabase'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined) // undefined = loading
  const [profile, setProfile] = useState(null)
  const [entitlement, setEntitlement] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Initial session check
    supabase.auth.getSession().then(({ data: { session } }) => {
      const u = session?.user ?? null
      setUser(u)
      if (u) loadProfile(u.id)
      else setLoading(false)
    })

    // Listen for changes
    const { data: { subscription } } = onAuthChange(async (u) => {
      if (u) {
        setUser(u)
        await loadProfile(u.id)
      } else {
        setUser(null)
        setProfile(null)
        setEntitlement(null)
        setLoading(false)
      }
    })
    return () => subscription.unsubscribe()
  }, [])

  async function loadProfile(userId) {
    const [p, serverEntitlement] = await Promise.all([
      getProfile(userId),
      getEntitlement().catch(() => null),
    ])
    setProfile(p)
    setEntitlement(serverEntitlement)
    setLoading(false)
  }

  async function refreshProfile() {
    if (user) await loadProfile(user.id)
  }

  return (
    <AuthContext.Provider value={{ user, profile, entitlement, loading, refreshProfile, signOut: supabaseSignOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
