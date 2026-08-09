export function stripeInvoicePaymentType(billingReason) {
  if (billingReason === 'subscription_create') return 'initial'
  if (billingReason === 'subscription_cycle') return 'renewal'
  return null
}
