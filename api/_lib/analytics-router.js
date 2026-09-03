const OPERATIONS_BY_PATH = Object.freeze({
  // Vercel may expose either the original rewrite source or its destination.
  '/api/analytics': 'preference',
  '/api/analytics-worker': 'dispatch',
  '/api/analytics-dispatch': 'dispatch',
  '/api/analytics-preference': 'preference',
  '/api/analytics-readiness': 'readiness',
  '/api/analytics/dispatch': 'dispatch',
  '/api/analytics/preference': 'preference',
  '/api/analytics/readiness': 'readiness',
})

export function createAnalyticsRouter(handlers) {
  return async function analyticsRouter(req, res) {
    // Inspect only the raw, exact path; query, body, and headers are client input.
    const pathname = typeof req.url === 'string' && req.url.startsWith('/')
      ? req.url.split('?', 1)[0]
      : null
    const operation = OPERATIONS_BY_PATH[pathname]
    if (!operation || !Object.hasOwn(handlers, operation)) return res.status(404).json({ error: 'Not found' })
    return handlers[operation](req, res)
  }
}
