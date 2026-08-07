import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const PHOTO_BUCKET = 'project-photos'

async function removeUserPhotos(userId) {
  // Current uploads are flat under `${userId}/`; paginate so no account retains
  // photos merely because it has more than one storage page.
  let offset = 0
  for (;;) {
    const { data, error } = await supabase.storage.from(PHOTO_BUCKET).list(userId, { limit: 1000, offset })
    if (error) throw error
    const items = (data || []).filter(item => item.name && item.name !== '.emptyFolderPlaceholder')
    if (!items.length) return
    const { error: removeError } = await supabase.storage.from(PHOTO_BUCKET).remove(items.map(item => `${userId}/${item.name}`))
    if (removeError) throw removeError
    if (items.length < 1000) return
    // Deletion shifts later rows into the first page, so keep offset at zero.
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token || req.body?.confirmation !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm account deletion.' })
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) return res.status(401).json({ error: 'Please sign in again.' })

  const leaseId = randomUUID()
  let authDeleted = false
  try {
    const { data: existing, error: existingError } = await supabase.from('account_deletion_tombstones').select('status').eq('user_id', user.id).maybeSingle()
    if (existingError) throw existingError
    if (existing?.status === 'completed') return res.status(410).json({ error: 'This account has already been deleted.' })

    const { data: entitlements, error: entitlementError } = await supabase.from('user_entitlements').select('source,original_transaction_id,provider_subscription_id,provider_customer_id').eq('user_id', user.id)
    if (entitlementError) throw entitlementError
    const { data: profile, error: profileError } = await supabase.from('profiles').select('subscription_id,stripe_customer_id').eq('id', user.id).maybeSingle()
    if (profileError) throw profileError
    const appleIds = (entitlements || []).filter(row => row.source === 'apple' && row.original_transaction_id).map(row => row.original_transaction_id)
    const stripeSubscriptionIds = [...(entitlements || []).filter(row => row.source === 'stripe' && row.provider_subscription_id).map(row => row.provider_subscription_id), profile?.subscription_id].filter(Boolean)
    const stripeCustomerIds = [...(entitlements || []).filter(row => row.source === 'stripe' && row.provider_customer_id).map(row => row.provider_customer_id), profile?.stripe_customer_id].filter(Boolean)

    const { data: tombstone, error: tombstoneError } = await supabase.rpc('begin_account_deletion', {
      p_user_id: user.id,
      p_lease_id: leaseId,
      p_apple_original_transaction_ids: [...new Set(appleIds)],
      p_stripe_subscription_ids: [...new Set(stripeSubscriptionIds)],
      p_stripe_customer_ids: [...new Set(stripeCustomerIds)],
    })
    if (tombstoneError) throw tombstoneError
    if (tombstone?.status === 'completed') return res.status(200).json({ deleted: true, alreadyDeleted: true })
    if (tombstone?.deletion_lease_id !== leaseId) return res.status(202).json({ deleting: true })

    const { data: lease, error: leaseError } = await supabase.from('account_deletion_tombstones').select('deletion_lease_id,deletion_lease_expires_at,status').eq('user_id', user.id).maybeSingle()
    if (leaseError) throw leaseError
    if (lease?.deletion_lease_id !== leaseId || lease?.status !== 'processing' || new Date(lease.deletion_lease_expires_at) <= new Date()) return res.status(202).json({ deleting: true })
    await removeUserPhotos(user.id)
    const { data: storageClaim, error: storageStatusError } = await supabase.from('account_deletion_tombstones').update({ provider_cleanup_status: { storage: 'complete', auth: 'pending' } }).eq('user_id', user.id).eq('deletion_lease_id', leaseId).eq('status', 'processing').gt('deletion_lease_expires_at', new Date().toISOString()).select('user_id').maybeSingle()
    if (storageStatusError) throw storageStatusError
    if (!storageClaim) return res.status(202).json({ deleting: true })
    const { data: authClaim, error: authClaimError } = await supabase.from('account_deletion_tombstones').update({ status: 'auth_deleting', provider_cleanup_status: { storage: 'complete', auth: 'deleting' } }).eq('user_id', user.id).eq('deletion_lease_id', leaseId).eq('status', 'processing').gt('deletion_lease_expires_at', new Date().toISOString()).select('user_id').maybeSingle()
    if (authClaimError) throw authClaimError
    if (!authClaim) return res.status(202).json({ deleting: true })
    const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id)
    if (deleteError) throw deleteError
    authDeleted = true
    // The tombstone has no auth.users FK, so it survives the Auth deletion and cascades.
    const { error: completionError } = await supabase.from('account_deletion_tombstones').update({ status: 'completed', completed_at: new Date().toISOString(), provider_cleanup_status: { storage: 'complete', auth: 'complete' } }).eq('user_id', user.id).eq('deletion_lease_id', leaseId)
    if (completionError) throw completionError
    return res.status(200).json({ deleted: true })
  } catch (error) {
    console.error('Account deletion failed:', error.message)
    // Never overwrite terminal/provider-suppression state after Auth deletion.
    // After auth_deleting is claimed, an Auth API timeout/outcome is ambiguous:
    // preserve the fence for privileged reconciliation rather than permitting a retry.
    if (!authDeleted) await supabase.from('account_deletion_tombstones').update({ status: 'failed', last_error_code: 'deletion_failed' }).eq('user_id', user.id).eq('deletion_lease_id', leaseId).eq('status', 'processing').catch(() => {})
    return res.status(authDeleted ? 200 : 503).json(authDeleted ? { deleted: true, reconciliationPending: true } : { error: 'Could not delete your account. Please try again.' })
  }
}
