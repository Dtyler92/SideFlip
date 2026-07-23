export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

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
