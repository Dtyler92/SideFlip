import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { priceId, userId, email } = req.body

  if (!priceId || !userId || !email) {
    return res.status(400).json({ error: 'Missing required fields' })
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 7,
        metadata: { userId }
      },
      allow_promotion_codes: true,
      payment_method_collection: 'always',
      managed_payments: { enabled: false },
      metadata: { userId },
      success_url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://sideflip.org'}/?subscribed=true`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://sideflip.org'}/?canceled=true`,
    })

    res.json({ url: session.url })
  } catch (err) {
    console.error('Stripe error:', err)
    res.status(500).json({ error: err.message })
  }
}
