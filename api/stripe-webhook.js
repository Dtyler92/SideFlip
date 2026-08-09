import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import {
  sendWelcomeEmail,
  sendTrialEndingEmail,
  sendCancellationScheduledEmail,
  sendTrialCanceledEmail,
  sendPaymentFailedEmail,
} from './emails.js'
import { normalizeBillingInterval } from './_lib/analytics.js'
import { stripeInvoicePaymentType } from './_lib/stripe-analytics.js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

export const config = { api: { bodyParser: false } }

async function buffer(readable) {
  const chunks = []
  for await (const chunk of readable) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks)
}

async function getCustomerEmail(object) {
  if (object?.customer_email) return object.customer_email
  if (!object?.customer) return null
  try {
    const customer = typeof object.customer === 'string' ? await stripe.customers.retrieve(object.customer) : object.customer
    return customer && !customer.deleted ? customer.email : null
  } catch (error) {
    console.error('Customer email lookup error:', error.message)
    return null
  }
}

function subscriptionDetails(subscription) {
  const price = subscription?.items?.data?.[0]?.price
  return {
    unitAmount: price?.unit_amount,
    currency: price?.currency || 'usd',
    interval: price?.recurring?.interval,
    trialEnd: subscription?.trial_end,
    accessEnd: subscription?.current_period_end || subscription?.trial_end,
  }
}

function stripeObjectId(value) {
  return typeof value === 'string' ? value : value?.id || null
}

function subscriptionIdForInvoice(invoice) {
  return stripeObjectId(invoice?.subscription)
    || stripeObjectId(invoice?.parent?.subscription_details?.subscription)
}

function churnDetails(subscription) {
  const wasTrial = Boolean(subscription?.trial_start || subscription?.trial_end)
  if (subscription?.status !== 'canceled') return { wasTrial, churnType: null }
  if (wasTrial && subscription?.trial_end && subscription?.ended_at && subscription.ended_at <= subscription.trial_end) {
    return { wasTrial, churnType: 'trial_canceled' }
  }
  return { wasTrial, churnType: subscription?.cancel_at_period_end ? 'scheduled' : 'immediate' }
}

async function updateProfileFromSubscription(subscription, event) {
  const userId = subscription?.metadata?.userId
  if (!userId) {
    console.error('Subscription has no Supabase userId metadata:', subscription?.id)
    return false
  }
  const price = subscription?.items?.data?.[0]?.price
  const cancellationJustScheduled = subscription.cancel_at_period_end === true
    && event.data.previous_attributes?.cancel_at_period_end === false
  const { wasTrial, churnType } = churnDetails(subscription)
  const { data: applied, error } = await supabase.rpc('apply_stripe_subscription_event_v2', {
    p_event_id: event.id,
    p_event_type: event.type,
    p_provider_created_at: new Date(event.created * 1000).toISOString(),
    p_user_id: userId,
    p_subscription_id: subscription.id,
    p_customer_id: stripeObjectId(subscription.customer),
    p_status: subscription.status,
    p_current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
    p_cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    p_cancellation_just_scheduled: cancellationJustScheduled,
    p_was_trial: wasTrial,
    p_churn_type: churnType,
    p_plan: subscription.metadata?.plan || null,
    p_billing_interval: price?.recurring?.interval || null,
  })
  if (error) throw error
  return Boolean(applied)
}

async function analyticsContextForInvoice(invoice) {
  const directUserId = invoice?.metadata?.userId || invoice?.parent?.subscription_details?.metadata?.userId
  const subscriptionId = subscriptionIdForInvoice(invoice)
  if (!subscriptionId) return directUserId ? { userId: directUserId } : null
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId)
    const price = subscription?.items?.data?.[0]?.price
    const userId = directUserId || subscription?.metadata?.userId
    return userId ? {
      userId,
      plan: subscription.metadata?.plan,
      billingInterval: normalizeBillingInterval(price?.recurring?.interval),
    } : null
  } catch {
    return directUserId ? { userId: directUserId } : null
  }
}

async function isDeletedStripeObject(object) {
  const userId = object?.metadata?.userId || object?.client_reference_id
  const subscriptionId = object?.id?.startsWith?.('sub_') ? object.id : stripeObjectId(object?.subscription)
  const customerId = stripeObjectId(object?.customer)
  const checks = []
  if (userId) checks.push(supabase.from('account_deletion_tombstones').select('user_id').eq('user_id', userId).limit(1))
  if (subscriptionId) checks.push(supabase.from('account_deletion_tombstones').select('user_id').contains('stripe_subscription_ids', [subscriptionId]).limit(1))
  if (customerId) checks.push(supabase.from('account_deletion_tombstones').select('user_id').contains('stripe_customer_ids', [customerId]).limit(1))
  const results = await Promise.all(checks)
  return results.some(({ data, error }) => { if (error) throw error; return data?.length })
}

async function enqueueStripeProviderEvent(event, distinctId, eventName, properties = {}) {
  const object = event.data.object
  const { data: applied, error } = await supabase.rpc('apply_stripe_analytics_event', {
    p_event_id: event.id,
    p_event_type: event.type,
    p_provider_created_at: new Date(event.created * 1000).toISOString(),
    p_user_id: distinctId,
    p_subscription_id: object?.id?.startsWith?.('sub_') ? object.id : subscriptionIdForInvoice(object) || stripeObjectId(object?.subscription),
    p_customer_id: stripeObjectId(object?.customer),
    p_event_name: eventName,
    p_properties: properties,
  })
  if (error) throw error
  return Boolean(applied)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  let event
  try {
    const buf = await buffer(req)
    event = stripe.webhooks.constructEvent(buf, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)
  } catch (error) {
    console.error('Webhook signature error:', error.message)
    return res.status(400).send(`Webhook error: ${error.message}`)
  }

  console.log('Webhook event:', event.type, 'eventId:', event.id)
  try {
    if (await isDeletedStripeObject(event.data.object)) {
      console.log('Suppressed Stripe event for deleted SideFlip account:', event.id)
      return res.status(200).json({ received: true, suppressed: true })
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        const userId = session.metadata?.userId || session.client_reference_id
        if (userId) await enqueueStripeProviderEvent(event, userId, 'checkout_completed', {
          plan: session.metadata?.plan,
          status: session.payment_status,
        })
        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object
        const updated = await updateProfileFromSubscription(subscription, event)
        if (!updated) break
        const email = await getCustomerEmail(subscription)
        if (event.type === 'customer.subscription.created' && email) {
          await sendWelcomeEmail(email, subscriptionDetails(subscription)).catch(error => console.error('Welcome email error:', error))
        }
        const cancellationJustScheduled = subscription.cancel_at_period_end === true
          && event.data.previous_attributes?.cancel_at_period_end === false
        if (cancellationJustScheduled && email) {
          await sendCancellationScheduledEmail(email, subscriptionDetails(subscription)).catch(error => console.error('Cancellation email error:', error))
        }
        break
      }

      case 'customer.subscription.trial_will_end': {
        const subscription = event.data.object
        const accepted = subscription.metadata?.userId && await enqueueStripeProviderEvent(event, subscription.metadata.userId, 'subscription_trial_ending', {
          plan: subscription.metadata.plan,
          status: subscription.status,
          billing_interval: normalizeBillingInterval(subscription.items?.data?.[0]?.price?.recurring?.interval),
        })
        const email = await getCustomerEmail(subscription)
        if (accepted && email) await sendTrialEndingEmail(email, subscriptionDetails(subscription)).catch(error => console.error('Trial reminder email error:', error))
        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object
        const updated = await updateProfileFromSubscription(subscription, event)
        if (updated) {
          const wasTrialing = subscription.status === 'trialing'
            || (subscription.trial_end && subscription.trial_end > Math.floor(Date.now() / 1000))
          if (wasTrialing) {
            const email = await getCustomerEmail(subscription)
            if (email) await sendTrialCanceledEmail(email).catch(error => console.error('Trial cancellation email error:', error))
          }
        }
        break
      }

      case 'invoice.paid': {
        const invoice = event.data.object
        if (Number(invoice.amount_paid) <= 0) break
        const paymentType = stripeInvoicePaymentType(invoice.billing_reason)
        // Prorations, manual invoices, subscription updates, and threshold
        // invoices are deliberately excluded from initial/renewal conversion.
        if (!paymentType) break
        const context = await analyticsContextForInvoice(invoice)
        if (context?.userId) await enqueueStripeProviderEvent(event, context.userId, 'subscription_payment_succeeded', {
          plan: context.plan,
          billing_interval: context.billingInterval,
          status: 'paid',
          currency: invoice.currency,
          amount_minor: invoice.amount_paid,
          payment_type: paymentType,
        })
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object
        const context = await analyticsContextForInvoice(invoice)
        const accepted = context?.userId && await enqueueStripeProviderEvent(event, context.userId, 'subscription_payment_failed', {
          plan: context.plan,
          billing_interval: context.billingInterval,
          status: 'payment_failed',
        })
        const email = await getCustomerEmail(invoice)
        if (accepted && email) await sendPaymentFailedEmail(email).catch(error => console.error('Payment failed email error:', error))
        break
      }
    }

  } catch (error) {
    console.error('Webhook handler error:', error.message)
    return res.status(500).json({ received: true, error: 'Handler failed' })
  }

  return res.status(200).json({ received: true })
}
