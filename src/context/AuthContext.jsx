import { createContext, useContext, useEffect, useState } from 'react'
import { supabase, onAuthChange, getProfile } from '../supabase'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined) // undefined = loading
  const [profile, setProfile] = useState(null)
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
      setUser(u)
      if (u) await loadProfile(u.id)
      else { setProfile(null); setLoading(false) }
    })
    return () => subscription.unsubscribe()
  }, [])

  async function loadProfile(userId) {
    const p = await getProfile(userId)
    setProfile(p)
    setLoading(false)
  }

  async function refreshProfile() {
    if (user) {
      const p = await getProfile(user.id)
      setProfile(p)
    }
  }

  return (
    <AuthContext.Provider value={{ user, profile, loading, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
