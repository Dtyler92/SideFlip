#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { runMyStuffDeletionWorker } from '../api/_lib/my-stuff-deletion-worker.js'

const { VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MAINTENANCE_DELETION_WORKER_ID } = process.env
if (!VITE_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !MAINTENANCE_DELETION_WORKER_ID) {
  console.error('Missing VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or MAINTENANCE_DELETION_WORKER_ID')
  process.exitCode = 1
} else {
  const supabase = createClient(VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  try {
    const result = await runMyStuffDeletionWorker({ supabase, workerId: MAINTENANCE_DELETION_WORKER_ID })
    console.log(JSON.stringify({ claimed: result.claimed, completed: result.results.filter(row => row.status === 'complete').length,
      failed: result.results.filter(row => row.status !== 'complete').length }))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'DELETION_WORKER_ERROR')
    process.exitCode = 1
  }
}
