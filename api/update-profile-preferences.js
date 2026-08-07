import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const currencies = new Set(['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'MXN', 'JPY', 'INR'])
const languages = new Set(['en', 'es', 'fr', 'de', 'pt', 'ja'])

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Please sign in again.' })

  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) return res.status(401).json({ error: 'Please sign in again.' })

  const { currency, language, onboarded = false } = req.body || {}
  if (!currencies.has(currency) || !languages.has(language) || typeof onboarded !== 'boolean') {
    return res.status(400).json({ error: 'Invalid profile preference.' })
  }

  const { error } = await supabase.from('profiles')
    .update({ currency, language, ...(onboarded ? { onboarded: true } : {}) })
    .eq('id', user.id)
  if (error) {
    console.error('Profile preference update failed:', error.message)
    return res.status(500).json({ error: 'Could not save preferences.' })
  }
  return res.status(200).json({ ok: true })
}
