import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync(new URL('../supabase/migrations/20260908194500_raise_global_maintenance_research_budget.sql', import.meta.url), 'utf8')

test('global research budget rises to $100 without raising individual exposure', () => {
  assert.match(migration, /global_monthly_budget_cents between per_job_budget_cents and 10000/i)
  assert.match(migration, /global_monthly_budget_cents=10000/i)
  assert.doesNotMatch(migration, /monthly_user_budget_cents\s*=/i)
  assert.doesNotMatch(migration, /per_job_budget_cents\s*=/i)
  assert.doesNotMatch(migration, /daily_user_job_cap\s*=/i)
  assert.doesNotMatch(migration, /monthly_user_job_cap\s*=/i)
  assert.doesNotMatch(migration, /drop\s+index/i)
  assert.doesNotMatch(migration, /cron\./i)
})
