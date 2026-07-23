import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { useAuth } from './AuthContext'
import { getProjects, migrateLocalData, alreadyMigrated } from '../db'

const DataContext = createContext(null)

export function DataProvider({ children }) {
  const { user } = useAuth()
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [migrating, setMigrating] = useState(false)

  const refresh = useCallback(async () => {
    if (!user) return
    try {
      const data = await getProjects(user.id)
      setProjects(data)
    } catch (err) {
      console.error('Failed to load projects:', err)
    }
  }, [user])

  useEffect(() => {
    if (!user) { setProjects([]); setLoading(false); return }

    async function init() {
      setLoading(true)

      // One-time migration from localStorage
      if (!alreadyMigrated()) {
        setMigrating(true)
        try {
          const count = await migrateLocalData(user.id)
          if (count > 0) console.log(`Migrated ${count} projects from local storage`)
        } catch (err) {
          console.error('Migration error:', err)
        }
        setMigrating(false)
      }

      await refresh()
      setLoading(false)
    }

    init()
  }, [user])

  return (
    <DataContext.Provider value={{ projects, loading, migrating, refresh }}>
      {children}
    </DataContext.Provider>
  )
}

export function useData() {
  return useContext(DataContext)
}
