import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import { sendWelcomeEmail, sendPaymentFailedEmail } from './emails.js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Tell Vercel to give us the raw body as a Buffer
export const config = { api: { bodyParser: false } }

async function buffer(readable) {
  const chunks = []
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  let event
  try {
    const buf = await buffer(req)
    const sig = req.headers['stripe-signature']
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error('Webhook signature error:', err.message)
    return res.status(400).send(`Webhook error: ${err.message}`)
  }

  const sub = event.data.object
  const userId = sub?.metadata?.userId

  console.log('Webhook event:', event.type, 'userId:', userId, 'subId:', sub?.id)

  if (!userId) {
    console.error('No userId in metadata')
    return res.status(200).json({ received: true, warning: 'no userId' })
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const { error } = await supabase.from('profiles').upsert({
          id: userId,
          subscription_status: sub.status,
          subscription_id: sub.id,
          current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        }, { onConflict: 'id' })
        if (error) console.error('Supabase upsert error:', error)
        else {
          console.log('Profile updated:', userId, sub.status)
          // Send welcome email on first activation
          if (event.type === 'customer.subscription.created' && sub.customer_email) {
            await sendWelcomeEmail(sub.customer_email).catch(e => console.error('Welcome email error:', e))
          }
        }
        break
      }
      case 'customer.subscription.deleted': {
        const { error } = await supabase.from('profiles').upsert({
          id: userId,
          subscription_status: 'canceled',
          subscription_id: null,
        }, { onConflict: 'id' })
        if (error) console.error('Supabase delete error:', error)
        break
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object
        if (invoice.customer_email) {
          await sendPaymentFailedEmail(invoice.customer_email).catch(e => console.error('Payment failed email error:', e))
        }
        break
      }
    }
  } catch (err) {
    console.error('Handler error:', err.message)
  }

  res.status(200).json({ received: true })
}
