import { createClient } from '@supabase/supabase-js'
import { resolveServerEntitlement } from './_lib/entitlements.js'

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

function sendResolvedPlan(res, profile, entitlements) {
  return res.status(200).json({
    ...resolveServerEntitlement(profile, entitlements),
    resolved_at: new Date().toISOString(),
  })
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, max-age=0, must-revalidate')
  res.setHeader('CDN-Cache-Control', 'no-store')
  res.setHeader('Vary', 'Authorization')
  if (req.method !== 'GET') return res.status(405).end()
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Sign in to view your plan.' })

  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' })

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('subscription_id, subscription_status')
    .eq('id', user.id)
    .maybeSingle()
  if (profileError) return res.status(500).json({ error: 'Could not resolve your plan.' })

  const { data: entitlements, error: entitlementError } = await supabase
    .from('user_entitlements')
    .select('source, status, expires_at, last_verified_at')
    .eq('user_id', user.id)
  if (entitlementError) {
    console.error('Entitlement lookup error:', entitlementError.message)
    return sendResolvedPlan(res, profile, [])
  }

  return sendResolvedPlan(res, profile, entitlements)
}
