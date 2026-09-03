import { createClient } from '@supabase/supabase-js'
import { resolveServerEntitlement } from './_lib/entitlements.js'

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end()
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Sign in to view your plan.' })

  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' })

  const [modeResult, profileResult, entitlementResult] = await Promise.all([
    supabase.rpc('stripe_entitlement_read_mode'),
    supabase.from('profiles').select('subscription_id, subscription_status').eq('id', user.id).maybeSingle(),
    supabase.from('user_entitlements').select('source, status, expires_at, last_verified_at').eq('user_id', user.id),
  ])
  const stripeCanonicalCutoverComplete = !modeResult.error && modeResult.data === 'canonical'
  const result = resolveServerEntitlement(
    profileResult.error ? null : profileResult.data,
    entitlementResult.error ? [] : entitlementResult.data,
    Date.now(),
    { stripeCanonicalCutoverComplete },
  )
  if (entitlementResult.error && result.plan !== 'pro') {
    console.error('Entitlement lookup error:', entitlementResult.error.message)
    return res.status(500).json({ error: 'Could not resolve your plan.' })
  }
  if (profileResult.error && !stripeCanonicalCutoverComplete && result.plan !== 'pro') {
    return res.status(500).json({ error: 'Could not resolve your plan.' })
  }

  return res.json(result)
}
