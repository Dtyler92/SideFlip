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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const token = getBearerToken(req)
    if (!token) return res.status(401).json({ error: 'Please sign in again.' })

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' })
    }

    const { plan, ref, billingConsent } = req.body || {}
    if (billingConsent !== true) {
      return res.status(400).json({ error: 'Recurring billing consent is required.' })
    }
    const prices = {
      monthly: process.env.VITE_STRIPE_MONTHLY_PRICE_ID,
      annual: process.env.VITE_STRIPE_ANNUAL_PRICE_ID,
    }
    const priceId = prices[plan]
    if (!priceId) return res.status(400).json({ error: 'Please select a valid plan.' })

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .maybeSingle()
    if (profileError) throw profileError

    let discounts
    const referralCode = typeof ref === 'string' ? ref.trim().slice(0, 64) : ''
    if (referralCode) {
      try {
        const coupons = await stripe.coupons.list({ limit: 100 })
        const match = coupons.data.find(
          coupon => coupon.name?.toUpperCase() === referralCode.toUpperCase() && coupon.valid
        )
        if (match) discounts = [{ coupon: match.id }]
      } catch (error) {
        console.error('Referral lookup error:', error.message)
      }
    }

    const planDescription = plan === 'annual'
      ? '$99.99 charged annually (equivalent to $8.33 per month)'
      : '$12.99 charged monthly'
    const consentTimestamp = new Date().toISOString()
    const metadata = {
      userId: user.id,
      plan,
      recurringBillingConsent: 'true',
      consentVersion: '2026-07-28',
      consentTimestamp,
      ...(referralCode && { referralCode }),
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      ...(profile?.stripe_customer_id
        ? { customer: profile.stripe_customer_id }
        : { customer_email: user.email }),
      client_reference_id: user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 7,
        metadata,
      },
      allow_promotion_codes: !discounts,
      ...(discounts && { discounts }),
      payment_method_collection: 'always',
      consent_collection: { terms_of_service: 'required' },
      custom_text: {
        submit: {
          message: `By subscribing, you authorize SideFlip to charge ${planDescription} until canceled. Cancel before the trial ends to avoid the first charge. Manage or cancel anytime in SideFlip Settings.`,
        },
      },
      managed_payments: { enabled: false },
      metadata,
      success_url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://sideflip.org'}/?subscribed=true`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://sideflip.org'}/?canceled=true`,
    })

    return res.status(200).json({ url: session.url })
  } catch (error) {
    console.error('Checkout error:', error.message)
    return res.status(500).json({ error: 'Could not start checkout. Please try again.' })
  }
}
