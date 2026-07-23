export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { title, category, purchasePrice, expenses, totalInvested, notes, salePrice } = req.body
  if (!title) return res.status(400).json({ error: 'Missing project info' })

  const expenseList = expenses?.length
    ? expenses.map(e => `${e.description}: $${e.amount}`).join(', ')
    : 'none'

  const prompt = `Write a Facebook Marketplace listing for this item. Make it sound natural, honest, and appealing to local buyers. Be specific about condition and what's been fixed.

Item: ${title}
Category: ${category}
Paid: $${purchasePrice}
Work/parts done: ${expenseList}
Total invested: $${Number(totalInvested).toFixed(2)}
${notes ? `Seller notes: ${notes}` : ''}
${salePrice ? `Asking price: $${salePrice}` : ''}

Write a complete listing with a bold title line and description. Keep under 180 words. Suggest a fair asking price if none provided. End with "DM for more info or to schedule pickup."`

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
        max_tokens: 512,
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
