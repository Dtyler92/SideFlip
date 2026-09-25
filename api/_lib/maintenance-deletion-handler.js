import { timingSafeEqual } from 'node:crypto'
import { runMyStuffDeletionWorker } from './my-stuff-deletion-worker.js'

function safeEqual(left, right) {
  const a = Buffer.from(left || '')
  const b = Buffer.from(right || '')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function createMaintenanceDeletionHandler(supabase, options = {}) {
  const runWorker = options.runWorker || runMyStuffDeletionWorker
  const cronSecrets = options.cronSecret != null
    ? [options.cronSecret]
    : [process.env.MAINTENANCE_DELETION_CRON_SECRET, process.env.CRON_SECRET].filter(Boolean)
  const deploymentIdentity = options.deploymentIdentity
    ?? process.env.VERCEL_DEPLOYMENT_ID
    ?? process.env.VERCEL_URL
    ?? 'production'

  return async function maintenanceDeletionHandler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    if (!cronSecrets.length || !cronSecrets.some(secret => safeEqual(req.headers?.authorization, `Bearer ${secret}`))) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    try {
      const result = await runWorker({
        supabase,
        workerId: `vercel:${String(deploymentIdentity).slice(0, 120)}`,
        batchSize: 10,
        leaseSeconds: 55,
        pageSize: 100,
        removeBatchSize: 100,
        maxDeletePasses: 12,
        maxObjectsPerClaim: 1000,
        maxTraversalDepth: 12,
        maxListRequests: 250,
      })
      return res.status(200).json({
        claimed: result.claimed,
        completed: result.results.filter(row => row.status === 'complete').length,
        failed: result.results.filter(row => row.status !== 'complete').length,
      })
    } catch {
      return res.status(503).json({ error: 'Maintenance deletion worker unavailable' })
    }
  }
}
