import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // service role for server-side writes
)

export const config = { api: { bodyParser: false } }

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const sig = req.headers['stripe-signature']
  const rawBody = await getRawBody(req)

  let event
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`)
  }

  const userId = event.data.object?.metadata?.userId

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object
      if (userId) {
        await supabase.from('profiles').upsert({
          id: userId,
          subscription_status: sub.status,
          subscription_id: sub.id,
          current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        }, { onConflict: 'id' })
      }
      break
    }
    case 'customer.subscription.deleted': {
      if (userId) {
        await supabase.from('profiles').upsert({
          id: userId,
          subscription_status: 'canceled',
          subscription_id: null,
        }, { onConflict: 'id' })
      }
      break
    }
  }

  res.json({ received: true })
}
