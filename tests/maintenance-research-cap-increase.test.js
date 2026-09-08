import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync(new URL('../supabase/migrations/20260908193500_raise_maintenance_research_job_caps.sql', import.meta.url), 'utf8')

test('maintenance research onboarding caps rise without weakening spend or concurrency safeguards', () => {
  assert.match(migration, /daily_user_job_cap between 1 and 15/i)
  assert.match(migration, /monthly_user_job_cap between 1 and 50/i)
  assert.match(migration, /daily_user_job_cap=15/i)
  assert.match(migration, /monthly_user_job_cap=50/i)
  assert.doesNotMatch(migration, /global_monthly_budget_cents\s*=/i)
  assert.doesNotMatch(migration, /per_job_budget_cents\s*=/i)
  assert.doesNotMatch(migration, /drop\s+index/i)
  assert.doesNotMatch(migration, /cron\./i)
})
