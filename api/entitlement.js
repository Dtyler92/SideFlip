import { createClient } from '@supabase/supabase-js'
import { loadServerEntitlementState } from './_lib/entitlements.js'

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

export function createEntitlementHandler({ client = supabase } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).end()
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (!token) return res.status(401).json({ error: 'Sign in to view your plan.' })

    const { data: { user }, error: authError } = await client.auth.getUser(token)
    if (authError || !user) return res.status(401).json({ error: 'Unauthorized' })

    const tombstoneResult = await client.from('account_deletion_tombstones').select('status').eq('user_id', user.id).maybeSingle()
    if (tombstoneResult.error) return res.status(503).json({ error: 'Could not resolve your plan.' })
    if (tombstoneResult.data) return res.status(410).json({ error: 'This account is being deleted.' })

    const entitlementState = await loadServerEntitlementState(client, user.id)
    if (entitlementState.error) return res.status(503).json({ error: 'Could not resolve your plan.' })
    return res.json(entitlementState.entitlement)
  }
}

export default createEntitlementHandler()
