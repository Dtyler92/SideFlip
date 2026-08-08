import { createClient } from '@supabase/supabase-js'
import { APPLE_BUNDLE_ID, verifyAppleSignedData } from './_lib/apple-verifier.js'
import { isSideFlipProProduct } from './_lib/apple-products.js'

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const signedPayload = req.body?.signedPayload
  if (typeof signedPayload !== 'string' || signedPayload.length > 30000) return res.status(400).json({ error: 'Invalid Apple notification.' })
  try {
    const { verifier, decoded: notification } = await verifyAppleSignedData(signedPayload, 'notification')
    const signedTransaction = notification.data?.signedTransactionInfo
    if (!signedTransaction) return res.status(200).json({ received: true, ignored: 'no_transaction' })
    const transaction = await verifier.verifyAndDecodeTransaction(signedTransaction)
    if (transaction.bundleId !== APPLE_BUNDLE_ID || !isSideFlipProProduct(transaction.productId) || !transaction.originalTransactionId || !transaction.transactionId || !transaction.signedDate || !transaction.expiresDate) return res.status(400).json({ error: 'Invalid Apple transaction notification.' })

    const { data: tombstone, error: tombstoneError } = await supabase.from('account_deletion_tombstones').select('user_id').contains('apple_original_transaction_ids', [transaction.originalTransactionId]).maybeSingle()
    if (tombstoneError) throw tombstoneError
    if (tombstone) return res.status(200).json({ received: true, suppressed: 'deleted_account' })

    // Never create an entitlement from a provider webhook: only the authenticated
    // purchase endpoint can establish the transaction-to-SideFlip-user binding.
    const { data: entitlement, error: lookupError } = await supabase.from('user_entitlements').select('id,user_id').eq('source', 'apple').eq('original_transaction_id', transaction.originalTransactionId).maybeSingle()
    if (lookupError) throw lookupError
    if (!entitlement) return res.status(200).json({ received: true, ignored: 'unbound_transaction' })

    const status = transaction.revocationDate ? 'revoked' : transaction.expiresDate > Date.now() ? 'active' : 'expired'
    const { data: applied, error: applyError } = await supabase.rpc('apply_apple_entitlement_event', {
      p_user_id: entitlement.user_id,
      p_original_transaction_id: transaction.originalTransactionId,
      p_transaction_id: transaction.transactionId,
      p_notification_uuid: notification.notificationUUID || null,
      p_provider_signed_at: new Date(transaction.signedDate).toISOString(),
      p_status: status,
      p_product_id: transaction.productId,
      p_starts_at: new Date(transaction.originalPurchaseDate || transaction.purchaseDate || transaction.signedDate).toISOString(),
      p_expires_at: new Date(transaction.expiresDate).toISOString(),
    })
    if (applyError) throw applyError
    return res.status(200).json({ received: true, status, applied: Boolean(applied) })
  } catch (error) {
    console.error('Apple notification verification failed:', error.message)
    return res.status(503).json({ error: 'Apple notification verification failed.' })
  }
}
