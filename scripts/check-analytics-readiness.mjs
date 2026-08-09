const url = process.env.ANALYTICS_READINESS_URL
const secret = process.env.ANALYTICS_READINESS_SECRET
if (!url || !secret) {
  console.error('ANALYTICS_READINESS_URL and ANALYTICS_READINESS_SECRET are required')
  process.exit(2)
}
const response = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } })
let body = {}
try { body = await response.json() } catch { /* status is authoritative */ }
if (!response.ok || body.ready !== true || body.migration !== '20260809020000') {
  console.error(`Analytics backend is not migration-ready (${response.status})`)
  process.exit(1)
}
console.log('Analytics migration 20260809020000 readiness passed')
