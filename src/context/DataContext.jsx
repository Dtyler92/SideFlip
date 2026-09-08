import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { useAuth } from './AuthContext'
import { getProjects, getGoals, migrateLocalData, alreadyMigrated } from '../db'

const DataContext = createContext(null)

export function DataProvider({ children }) {
  const { user } = useAuth()
  const [projects, setProjects] = useState([])
  const [goals, setGoals] = useState([])
  const [loading, setLoading] = useState(true)
  const [migrating, setMigrating] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError('')
    try {
      const [projectData, goalData] = await Promise.all([getProjects(user.id), getGoals(user.id)])
      setProjects(projectData)
      setGoals(goalData)
    } catch (err) {
      console.error('Failed to load projects:', err)
      setError('Your data could not be loaded. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    if (!user) { setProjects([]); setGoals([]); setError(''); setLoading(false); return }

    async function init() {
      setLoading(true)

      // One-time migration from localStorage
      if (!alreadyMigrated()) {
        setMigrating(true)
        try {
          await migrateLocalData(user.id)
        } catch (err) {
          console.error('Migration error:', err)
        }
        setMigrating(false)
      }

      await refresh()
    }

    init()
  }, [user, refresh])

  return (
    <DataContext.Provider value={{ projects, goals, loading, migrating, error, refresh }}>
      {children}
    </DataContext.Provider>
  )
}

export function useData() {
  return useContext(DataContext)
}
