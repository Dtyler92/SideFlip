const ACCESS_STATUSES = new Set(['active', 'grace_period'])
const ISO_UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function isCanonicalInstant(value) {
  return typeof value === 'string'
    && ISO_UTC_MILLISECONDS.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value
}

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
  if (![expiresAt, providerSignedAt, verifiedAt].every(isCanonicalInstant)) return false

  const { data, error } = await supabase.rpc('reconcile_verified_apple_entitlement', {
    p_user_id: userId,
    p_original_transaction_id: originalTransactionId,
    p_transaction_id: transactionId,
    p_provider_signed_at: providerSignedAt,
    p_status: status,
    p_expires_at: expiresAt,
    p_verified_at: verifiedAt,
  })
  if (error) throw error
  return data === true
}
