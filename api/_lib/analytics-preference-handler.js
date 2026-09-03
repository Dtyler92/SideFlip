export function createAnalyticsPreferenceHandler(supabase) {
  return async function analyticsPreferenceHandler(req, res) {
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' })
    if (req.method === 'POST' && typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Invalid analytics preference' })
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (!token) return res.status(401).json({ error: 'Please sign in again' })
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) return res.status(401).json({ error: 'Please sign in again' })
    if (req.method === 'GET') {
      const { data, error } = await supabase.from('profiles').select('analytics_opt_out').eq('id', user.id).maybeSingle()
      if (error) return res.status(503).json({ error: 'Could not load analytics preference' })
      return res.status(200).json({ enabled: !data?.analytics_opt_out })
    }
    const { data, error } = await supabase
      .from('profiles')
      .update({ analytics_opt_out: !req.body.enabled })
      .eq('id', user.id)
      .select('analytics_opt_out')
      .maybeSingle()
    if (error) {
      console.error('Analytics preference update failed:', error.message)
      return res.status(503).json({ error: 'Could not save analytics preference' })
    }
    if (!data || data.analytics_opt_out !== !req.body.enabled) {
      return res.status(503).json({ error: 'Could not confirm analytics preference' })
    }
    return res.status(200).json({ saved: true, enabled: !data.analytics_opt_out })
  }
}
