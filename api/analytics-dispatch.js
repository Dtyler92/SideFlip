import { createClient } from '@supabase/supabase-js'
import {
  dispatchAnalyticsOutbox,
  dispatchAnalyticsDeletionQueue,
  reconcileAuthDeleting,
} from './_lib/analytics.js'

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const OUTBOX_BATCH = 25
const DELETION_BATCH = 5
const MAX_OUTBOX_BATCHES = 6
const MAX_DELETION_BATCHES = 2

export const config = { maxDuration: 60 }

function mergeTotals(total, result) {
  for (const [key, value] of Object.entries(result || {})) {
    if (typeof value === 'number') total[key] = (total[key] || 0) + value
    else if (value != null) total[key] = value
  }
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' })
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  // Leave margin for Vercel response serialization and cancellation. Captures
  // and deletions are intentionally serialized; SQL separately delays erasure
  // beyond the five-minute maximum capture claim lease.
  const deadline = Date.now() + 50_000
  const outbox = { batches: 0 }
  const deletions = { batches: 0 }
  try {
    for (let batch = 0; batch < MAX_OUTBOX_BATCHES && Date.now() < deadline; batch += 1) {
      const result = await dispatchAnalyticsOutbox(supabase, OUTBOX_BATCH)
      mergeTotals(outbox, result)
      outbox.batches += 1
      if (!result.claimed || result.claimed < OUTBOX_BATCH) break
    }

    const { data: repaired, error: repairError } = await supabase.rpc('repair_analytics_deletion_queue', { p_limit: 25 })
    if (repairError) throw repairError

    const authReconciliation = Date.now() < deadline
      ? await reconcileAuthDeleting(supabase, 5)
      : { completed: 0, failed: 0, claimed: 0, skipped: 'deadline' }

    for (let batch = 0; batch < MAX_DELETION_BATCHES && Date.now() < deadline; batch += 1) {
      const result = await dispatchAnalyticsDeletionQueue(supabase, DELETION_BATCH)
      mergeTotals(deletions, result)
      deletions.batches += 1
      if (!result.claimed || result.claimed < DELETION_BATCH) break
    }

    const { data: backlog, error: backlogError } = await supabase.rpc('analytics_queue_backlog')
    if (backlogError) throw backlogError
    return res.status(200).json({
      outbox,
      deletions,
      authReconciliation,
      repairedDeletionRequests: repaired || 0,
      backlog,
      deadlineReached: Date.now() >= deadline,
    })
  } catch (error) {
    console.error('Analytics outbox job failed:', error.message)
    return res.status(500).json({ error: 'Analytics outbox job failed' })
  }
}
