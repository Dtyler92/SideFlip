export function applePurchaseMayBindToUser(appAccountToken, userId) {
  if (appAccountToken === null || appAccountToken === undefined) return true
  return typeof appAccountToken === 'string' && appAccountToken === userId
}
