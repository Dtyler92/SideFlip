import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Simple in-memory rate limiter (per warm serverless instance)
const RATE = new Map() // key -> [timestamps]

function rateLimited(key, max, windowMs) {
  const now = Date.now()
  const hits = (RATE.get(key) || []).filter(t => now - t < windowMs)
  hits.push(now)
  RATE.set(key, hits)
  return hits.length > max
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  // ── Auth: a valid Supabase session is required. This endpoint spends
  // Anthropic API credits, so it must never be reachable anonymously. ──
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Unauthorized' })

  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' })

  const rateKey = `user:${user.id}`
  if (rateLimited(rateKey, 15, 60_000)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' })
  }

  const { title, category, expenses, notes } = req.body
  if (!title) return res.status(400).json({ error: 'Missing project info' })

  const workDone = expenses?.length
    ? expenses.map(e => e.description).join(', ')
    : 'none listed'

  const prompt = `Write a Facebook Marketplace listing for this item. Sound natural and honest. Do NOT mention purchase price, parts costs, or reasons for selling.

Item: ${title}
Category: ${category}
Work/parts done: ${workDone}
${notes ? `Seller notes: ${notes}` : ''}

Write just a title line and description. Under 150 words. Describe condition and what's been done to it. Do not include a price — the seller will add that. End with "DM for more info or to schedule pickup."`

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      })
    })

    if (!response.ok) {
      const err = await response.json()
      throw new Error(err.error?.message || 'Claude API error')
    }

    const data = await response.json()
    const listing = data.content?.[0]?.text?.trim()
    if (!listing) throw new Error('No listing generated')
    res.json({ listing })
  } catch (err) {
    console.error('Listing gen error:', err.message)
    res.status(500).json({ error: err.message })
  }
}
