import { createClient } from '@supabase/supabase-js'
import { verifyAppleSignedData } from './_lib/apple-verifier.js'
import { APPLE_BUNDLE_ID, isSideFlipProProduct } from './_lib/apple-products.js'
import { createAppleServerApiClient } from './_lib/apple-server-api.js'
import { currentAppleSubscription } from './_lib/apple-current-subscription.js'
import { applePurchaseMayBindToUser } from './_lib/apple-account-binding.js'
import { reconcileVerifiedAppleExpiration } from './_lib/apple-entitlement-reconciliation.js'

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token || typeof req.body?.signedTransaction !== 'string' || req.body.signedTransaction.length > 20000) return res.status(400).json({ error: 'Invalid purchase verification request.' })
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) return res.status(401).json({ error: 'Please sign in again.' })
  try {
    const { verifier: appleVerifier, decoded: transaction, environmentName: verifiedEnvironment } = await verifyAppleSignedData(req.body.signedTransaction)
    const bindingChecks = {
      bundleMatches: transaction.bundleId === APPLE_BUNDLE_ID,
      productAllowed: isSideFlipProProduct(transaction.productId),
      originalTransactionIdPresent: Boolean(transaction.originalTransactionId),
      transactionIdPresent: Boolean(transaction.transactionId),
      signedDatePresent: Boolean(transaction.signedDate),
      expiresDatePresent: Boolean(transaction.expiresDate),
      appAccountTokenState: transaction.appAccountToken === null || transaction.appAccountToken === undefined
        ? 'missing'
        : applePurchaseMayBindToUser(transaction.appAccountToken, user.id) ? 'matching' : 'mismatch',
    }
    const transactionIsComplete = bindingChecks.bundleMatches && bindingChecks.productAllowed && bindingChecks.originalTransactionIdPresent && bindingChecks.transactionIdPresent && bindingChecks.signedDatePresent && bindingChecks.expiresDatePresent
    if (!transactionIsComplete || bindingChecks.appAccountTokenState === 'mismatch') {
      console.warn('Apple purchase binding rejected:', bindingChecks)
      return res.status(400).json({ error: 'This Apple purchase cannot be used for this SideFlip account.' })
    }
    const current = await currentAppleSubscription({ apiClient: createAppleServerApiClient(verifiedEnvironment), verifier: appleVerifier, transactionId: transaction.transactionId, expectedOriginalTransactionId: transaction.originalTransactionId })
    const currentTransaction = current.transaction
    const now = Date.now()
    const status = current.status
    const startsAt = new Date(currentTransaction.originalPurchaseDate || currentTransaction.purchaseDate || now).toISOString()
    const expiresAt = new Date(current.effectiveExpiresDate).toISOString()
    const providerSignedAt = new Date(currentTransaction.signedDate).toISOString()
    const { data: applied, error: writeError } = await supabase.rpc('apply_apple_entitlement_event', {
      p_user_id: user.id,
      p_original_transaction_id: transaction.originalTransactionId,
      p_transaction_id: currentTransaction.transactionId,
      p_notification_uuid: null,
      p_provider_signed_at: providerSignedAt,
      p_status: status,
      p_product_id: currentTransaction.productId,
      p_starts_at: startsAt,
      p_expires_at: expiresAt,
    })
    if (writeError) {
      if (writeError.code === 'P0001') return res.status(409).json({ error: 'This Apple subscription is already linked to another SideFlip account.' })
      throw writeError
    }
    const reconciled = !applied && await reconcileVerifiedAppleExpiration({
      supabase,
      userId: user.id,
      originalTransactionId: transaction.originalTransactionId,
      transactionId: currentTransaction.transactionId,
      status,
      expiresAt,
      providerSignedAt,
    })
    return res.status(200).json({ entitlement: { verified: true, status, expiresAt }, applied: Boolean(applied || reconciled) })
  } catch (error) {
    console.error('Apple purchase verification failed:', error.message)
    return res.status(503).json({ error: 'Could not verify this Apple purchase. Please try Restore Purchases.' })
  }
}
