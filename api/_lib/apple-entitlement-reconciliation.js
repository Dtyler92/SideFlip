const ACCESS_STATUSES = new Set(['active', 'grace_period'])
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export async function reconcileVerifiedAppleExpiration({
  supabase,
  userId,
  originalTransactionId,
  transactionId,
  status,
  expiresAt,
  providerSignedAt,
  verifiedAt = new Date().toISOString(),
}) {
  if (!ACCESS_STATUSES.has(status)) return false
  if (![userId, originalTransactionId, transactionId].every(value => typeof value === 'string' && value.length > 0)) return false
  if (![expiresAt, providerSignedAt, verifiedAt].every(value => typeof value === 'string' && CANONICAL_UTC_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)))) return false

  const { data, error } = await supabase
    .from('user_entitlements')
    .update({ expires_at: expiresAt, last_verified_at: verifiedAt })
    .eq('source', 'apple')
    .eq('user_id', userId)
    .eq('original_transaction_id', originalTransactionId)
    .eq('apple_latest_transaction_id', transactionId)
    .eq('apple_latest_signed_at', providerSignedAt)
    .eq('status', status)
    .lt('expires_at', expiresAt)
    .select('id')
  if (error) throw error
  return Boolean(data?.length)
}
