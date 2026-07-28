import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function getBearerToken(req) {
  const authorization = req.headers.authorization || ''
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : null
}

async function resolveCustomerId(user, profile) {
  if (profile?.stripe_customer_id) return profile.stripe_customer_id

  // Recover accounts where the subscription webhook saved incompletely.
  if (profile?.subscription_id) {
    try {
      const subscription = await stripe.subscriptions.retrieve(profile.subscription_id)
      if (subscription?.customer) {
        return typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer.id
      }
    } catch (error) {
      console.error('Could not retrieve Stripe subscription:', error.message)
    }
  }

  // Older checkout records may have the email but no Stripe ID in Supabase.
  // Prefer a subscription carrying this exact Supabase user ID.
  if (user.email) {
    const customers = await stripe.customers.list({ email: user.email, limit: 10 })
    for (const customer of customers.data) {
      const subscriptions = await stripe.subscriptions.list({
        customer: customer.id,
        status: 'all',
        limit: 10,
      })
      if (subscriptions.data.some(sub => sub.metadata?.userId === user.id)) {
        return customer.id
      }
    }

    // If there is only one exact-email customer, it is safe to recover it.
    if (customers.data.length === 1) return customers.data[0].id
  }

  return null
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const token = getBearerToken(req)
    if (!token) return res.status(401).json({ error: 'Please sign in again.' })

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) return res.status(401).json({ error: 'Your session has expired. Please sign in again.' })

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id, subscription_id')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError) throw profileError

    const customerId = await resolveCustomerId(user, profile)
    if (!customerId) {
      return res.status(404).json({
        error: 'No Stripe billing account was found for this login. If you subscribed with another email, contact support.',
      })
    }

    // Repair the missing profile field so future portal requests are immediate.
    if (profile?.stripe_customer_id !== customerId) {
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', user.id)
      if (updateError) console.error('Could not repair Stripe customer ID:', updateError.message)
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: 'https://sideflip.org/settings',
    })

    return res.status(200).json({ url: session.url })
  } catch (error) {
    console.error('Billing portal error:', error.message)
    return res.status(500).json({ error: 'Could not open the billing portal. Please try again.' })
  }
}
