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

async function updateProfileFromSubscription(subscription) {
  const userId = subscription?.metadata?.userId
  if (!userId) {
    console.error('Subscription has no Supabase userId metadata:', subscription?.id)
    return false
  }

  const update = {
    id: userId,
    subscription_status: subscription.status,
    subscription_id: subscription.id,
    stripe_customer_id: typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id,
  }
  if (subscription.current_period_end) {
    update.current_period_end = new Date(subscription.current_period_end * 1000).toISOString()
  }

  const { error } = await supabase.from('profiles').upsert(update, { onConflict: 'id' })
  if (error) {
    console.error('Supabase subscription update error:', error)
    return false
  }
  return true
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
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        const userId = session.metadata?.userId || session.client_reference_id
        if (userId) {
          const update = {
            stripe_customer_id: typeof session.customer === 'string'
              ? session.customer
              : session.customer?.id,
          }
          if (typeof session.subscription === 'string') update.subscription_id = session.subscription
          const { error } = await supabase.from('profiles').update(update).eq('id', userId)
          if (error) console.error('Checkout profile update error:', error)
        }
        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object
        await updateProfileFromSubscription(subscription)
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
        const userId = subscription.metadata?.userId
        if (userId) {
          const { error } = await supabase.from('profiles').update({
            subscription_status: 'canceled',
            subscription_id: null,
          }).eq('id', userId)
          if (error) console.error('Supabase cancellation update error:', error)
        }

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
