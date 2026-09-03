import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync(new URL('../supabase/migrations/20260903173000_add_ai_generation_rate_limits.sql', import.meta.url), 'utf8')

test('AI generation limiter uses an atomic per-user database lease and rolling count', () => {
  assert.match(migration, /create table if not exists public\.ai_generation_rate_limits/i)
  assert.match(migration, /pg_advisory_xact_lock/i)
  assert.match(migration, /request_count = request_count \+ 1/i)
  assert.match(migration, /in_flight_until/i)
  assert.match(migration, /claim_token uuid/i)
  assert.match(migration, /and claim_token = p_claim_token/i)
  assert.match(migration, /create or replace function public\.renew_ai_generation_request/i)
  assert.match(migration, /p_lease_seconds \* interval '1 second'/i)
})

test('limiter storage and RPCs are service-role only', () => {
  assert.match(migration, /enable row level security/i)
  assert.match(migration, /revoke all on table public\.ai_generation_rate_limits from public, anon, authenticated/i)
  assert.match(migration, /revoke all on function public\.claim_ai_generation_request[^;]+from public, anon, authenticated/is)
  assert.match(migration, /revoke all on function public\.renew_ai_generation_request[^;]+from public, anon, authenticated/is)
  assert.match(migration, /revoke all on function public\.release_ai_generation_request[^;]+from public, anon, authenticated/is)
  assert.match(migration, /grant execute on function public\.claim_ai_generation_request[^;]+to service_role/is)
  assert.match(migration, /grant execute on function public\.renew_ai_generation_request[^;]+to service_role/is)
  assert.match(migration, /grant execute on function public\.release_ai_generation_request[^;]+to service_role/is)
  assert.doesNotMatch(migration, /grant\s+(select|insert|update|delete|execute)[^;]+to\s+(anon|authenticated)/i)
})
