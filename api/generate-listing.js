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
Work/parts: ${expenseList}
Total invested: $${Number(totalInvested).toFixed(2)}
${notes ? `Seller notes: ${notes}` : ''}
${salePrice ? `Asking price: $${salePrice}` : ''}

Write a complete listing with a title line and description. Keep under 180 words. Suggest a fair asking price if none provided. End with "DM for more info or to schedule pickup."`

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 450,
        temperature: 0.7,
      })
    })

    if (!response.ok) {
      const err = await response.json()
      throw new Error(err.error?.message || 'OpenAI error')
    }

    const data = await response.json()
    const listing = data.choices?.[0]?.message?.content?.trim()
    res.json({ listing })
  } catch (err) {
    console.error('Listing gen error:', err.message)
    res.status(500).json({ error: err.message })
  }
}
