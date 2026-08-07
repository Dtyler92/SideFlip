import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import {
  sendWelcomeEmail,
  sendTrialEndingEmail,
  sendCancellationScheduledEmail,
  sendTrialCanceledEmail,
  sendPaymentFailedEmail,
} from './emails.js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export const config = { api: { bodyParser: false } }

async function buffer(readable) {
  const chunks = []
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

async function getCustomerEmail(object) {
  if (object?.customer_email) return object.customer_email
  if (!object?.customer) return null

  try {
    const customer = typeof object.customer === 'string'
      ? await stripe.customers.retrieve(object.customer)
      : object.customer
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

async function updateProfileFromSubscription(subscription, event) {
  const userId = subscription?.metadata?.userId
  if (!userId) {
    console.error('Subscription has no Supabase userId metadata:', subscription?.id)
    return false
  }

  const { error } = await supabase.rpc('apply_stripe_subscription_event', {
    p_event_id: event.id, p_event_type: event.type, p_provider_created_at: new Date(event.created * 1000).toISOString(), p_user_id: userId,
    p_subscription_id: subscription.id, p_customer_id: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id,
    p_status: subscription.status, p_current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
  })
  if (error) {
    console.error('Supabase subscription update error:', error)
    return false
  }
  return true
}

async function isDeletedStripeObject(object) {
  const userId = object?.metadata?.userId || object?.client_reference_id
  const subscriptionId = object?.id?.startsWith?.('sub_') ? object.id : object?.subscription
  const customerId = typeof object?.customer === 'string' ? object.customer : object?.customer?.id
  const checks = []
  if (userId) checks.push(supabase.from('account_deletion_tombstones').select('user_id').eq('user_id', userId).limit(1))
  if (subscriptionId) checks.push(supabase.from('account_deletion_tombstones').select('user_id').contains('stripe_subscription_ids', [subscriptionId]).limit(1))
  if (customerId) checks.push(supabase.from('account_deletion_tombstones').select('user_id').contains('stripe_customer_ids', [customerId]).limit(1))
  const results = await Promise.all(checks)
  return results.some(({ data, error }) => { if (error) throw error; return data?.length })
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  let event
  try {
    const buf = await buffer(req)
    const signature = req.headers['stripe-signature']
    event = stripe.webhooks.constructEvent(buf, signature, process.env.STRIPE_WEBHOOK_SECRET)
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
        // Subscription lifecycle events carry the authoritative status and are
        // the only profile writers; do not let checkout delivery bypass ordering.
        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object
        await updateProfileFromSubscription(subscription, event)
        const email = await getCustomerEmail(subscription)

        if (event.type === 'customer.subscription.created' && email) {
          await sendWelcomeEmail(email, subscriptionDetails(subscription))
            .catch(error => console.error('Welcome email error:', error))
        }

        const cancellationJustScheduled = subscription.cancel_at_period_end
          && event.data.previous_attributes?.cancel_at_period_end === false
        if (cancellationJustScheduled && email) {
          await sendCancellationScheduledEmail(email, subscriptionDetails(subscription))
            .catch(error => console.error('Cancellation email error:', error))
        }
        break
      }

      case 'customer.subscription.trial_will_end': {
        const subscription = event.data.object
        const email = await getCustomerEmail(subscription)
        if (email) {
          await sendTrialEndingEmail(email, subscriptionDetails(subscription))
            .catch(error => console.error('Trial reminder email error:', error))
        }
        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object
        await updateProfileFromSubscription(subscription, event)

        const wasTrialing = subscription.status === 'trialing'
          || (subscription.trial_end && subscription.trial_end > Math.floor(Date.now() / 1000))
        if (wasTrialing) {
          const email = await getCustomerEmail(subscription)
          if (email) {
            await sendTrialCanceledEmail(email)
              .catch(error => console.error('Trial cancellation email error:', error))
          }
        }
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object
        const email = await getCustomerEmail(invoice)
        if (email) {
          await sendPaymentFailedEmail(email)
            .catch(error => console.error('Payment failed email error:', error))
        }
        break
      }
    }
  } catch (error) {
    console.error('Webhook handler error:', error.message)
    return res.status(500).json({ received: true, error: 'Handler failed' })
  }

  return res.status(200).json({ received: true })
}
