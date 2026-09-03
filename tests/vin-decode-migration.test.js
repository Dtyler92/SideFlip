import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync(new URL('../supabase/migrations/20260903203000_add_vin_decode_cache_and_rate_limits.sql', import.meta.url), 'utf8')

test('VIN migration is additive, durable, and stores no raw VIN', () => {
  assert.match(migration, /create table public\.vin_decode_cache/i)
  assert.match(migration, /primary key \(hmac_key_version, vin_hmac\)/i)
  assert.match(migration, /decoded_fields jsonb not null/i)
  assert.match(migration, /vin_decode_cache_warning_codes/i)
  assert.match(migration, /vin_decode_cache_no_vin_field check \(not \(decoded_fields \?\| array\['vin','rawVin','normalizedVin'\]\)\)/i)
  assert.doesNotMatch(migration, /\braw_vin\b|\bvin text\b/i)
  assert.match(migration, /create table public\.vin_decode_rate_limits/i)
  assert.match(migration, /user_id uuid primary key references auth\.users\(id\) on delete cascade/i)
  assert.match(migration, /create index vin_decode_rate_limits_updated_at_user_id_idx on public\.vin_decode_rate_limits\(updated_at, user_id\)/i)
  assert.match(migration, /pg_advisory_xact_lock/i)
  assert.match(migration, /request_count = request_count \+ 1/i)
})

test('rate limit counts atomically and returns bounded retry guidance', () => {
  assert.match(migration, /create function public\.claim_vin_decode_request/i)
  assert.match(migration, /p_limit integer/i)
  assert.match(migration, /p_window_seconds integer/i)
  assert.match(migration, /rate_limited/i)
  assert.match(migration, /retry_after_seconds/i)
  assert.match(migration, /extract\(epoch from/i)
  assert.match(migration, /p_limit is null/i)
  assert.match(migration, /p_window_seconds is null/i)
})

test('database cache payload contract allowlists fields and validates exact JSON types and numeric bounds', () => {
  assert.match(migration, /vin_decode_cache_fields_contract check/i)
  assert.match(migration, /decoded_fields - array\[[^\]]*'modelYear'[^\]]*'transmissionStyle'[^\]]*\]::text\[\] = '\{\}'::jsonb/is)
  for (const field of ['modelYear', 'engineCylinders', 'displacementLiters']) {
    assert.match(migration, new RegExp(`jsonb_typeof\\(decoded_fields->'${field}'\\) = 'number'`, 'i'))
  }
  assert.match(migration, /modelYear[^;]+between 1881 and 2200/is)
  assert.match(migration, /engineCylinders[^;]+between 1 and 32/is)
  assert.match(migration, /displacementLiters[^;]+between 0\.1 and 30/is)
  assert.match(migration, /revoke all on function public\.is_valid_vin_decoded_fields\(jsonb\) from public, anon, authenticated/i)
})

test('cache writes never overwrite an existing successful decode', () => {
  assert.match(migration, /create function public\.store_vin_decode_cache/i)
  assert.match(migration, /on conflict \(hmac_key_version, vin_hmac\) do nothing/i)
  assert.doesNotMatch(migration, /on conflict[^;]+do update/is)
  assert.match(migration, /delete from public\.vin_decode_cache\s+where hmac_key_version = p_hmac_key_version[\s\S]+expires_at <= clock_timestamp\(\)/i)
})

test('bounded service-only cleanup covers expiry, invalid-entry quarantine, and limiter retention', () => {
  assert.match(migration, /create function public\.cleanup_vin_decode_state/i)
  assert.match(migration, /p_batch_limit integer/i)
  assert.match(migration, /p_invalid_hmac_key_version integer/i)
  assert.match(migration, /p_invalid_vin_hmac text/i)
  assert.match(migration, /updated_at < clock_timestamp\(\) - interval '7 days'/i)
  assert.match(migration, /limit p_batch_limit/i)
  assert.match(migration, /grant execute on function public\.cleanup_vin_decode_state[^;]+to service_role/i)
  assert.doesNotMatch(migration, /grant execute on function public\.cleanup_vin_decode_state[^;]+to (anon|authenticated)/i)
})

test('cache, limiter tables, and RPCs are service-role only', () => {
  for (const table of ['vin_decode_cache', 'vin_decode_rate_limits']) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, 'i'))
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, 'i'))
  }
  assert.match(migration, /grant select on table public\.vin_decode_cache to service_role/i)
  for (const signature of [
    'claim_vin_decode_request\\(uuid, integer, integer\\)',
    'store_vin_decode_cache\\(integer, text, jsonb, text\\[\\], timestamptz\\)',
    'cleanup_vin_decode_state\\(integer, integer, text\\)',
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${signature} from public, anon, authenticated`, 'i'))
    assert.match(migration, new RegExp(`grant execute on function public\\.${signature} to service_role`, 'i'))
  }
  assert.doesNotMatch(migration, /grant\s+(select|insert|update|delete|execute)[^;]+to\s+(anon|authenticated)/i)
})

test('VIN route source defines only the new secret name and has no AI/provider enrichment', () => {
  const route = readFileSync(new URL('../api/decode-vin.js', import.meta.url), 'utf8')
  assert.match(route, /VIN_CACHE_HMAC_SECRET/)
  assert.doesNotMatch(route, /ANTHROPIC|OPENAI|GEMINI|generate-listing|artificial intelligence/i)
  assert.doesNotMatch(route, /console\.(log|info|debug)\([^)]*vin/i)
  assert.doesNotMatch(route, /from\(SUBJECT_TABLES\[[^\]]+\]\)[\s\S]{0,200}\.update\(/i)
})
