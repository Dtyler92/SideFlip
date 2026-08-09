import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ready: false, error: 'Method not allowed' })
  const secret = process.env.ANALYTICS_READINESS_SECRET || process.env.CRON_SECRET
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ ready: false })
  const { data, error } = await supabase.rpc('analytics_backend_readiness')
  if (error || data !== true) {
    console.error('Analytics migration readiness failed:', error?.message || 'unexpected result')
    return res.status(503).json({ ready: false, migration: '20260809020000' })
  }
  return res.status(200).json({ ready: true, migration: '20260809020000' })
}
