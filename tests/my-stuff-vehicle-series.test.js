import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migrationUrl = new URL('../supabase/migrations/20260916163000_persist_my_stuff_vehicle_series.sql', import.meta.url)
const sql = () => readFileSync(migrationUrl, 'utf8')

function functionBody(source, name, schema = '(?:public|private)') {
  const match = source.match(new RegExp(`create or replace function ${schema}\\.${name}\\([^]*?(?=\\ncreate or replace function |\\nrevoke |\\ncommit;)`, 'i'))
  assert.ok(match, `${name} exists`)
  return match[0]
}

test('additive migration stores bounded vehicle series without exposing the RPC', () => {
  const source = sql()
  assert.match(source, /alter table public\.my_stuff_items\s+add column if not exists series text/i)
  assert.match(source, /length\(coalesce\(series,''\)\) <= 200/i)
  assert.doesNotMatch(source, /drop\s+(table|column|function)/i)
  assert.match(source, /revoke all on function public\.confirm_my_stuff_vehicle_identity_v3\(uuid,jsonb,text\) from public,anon/i)
  assert.match(source, /grant execute on function public\.confirm_my_stuff_vehicle_identity_v3\(uuid,jsonb,text\) to authenticated/i)
})

test('series and engine are persisted, fingerprinted, and invalidate stale confirmation', () => {
  const source = sql()
  const confirm = functionBody(source, 'confirm_my_stuff_vehicle_identity_v3', 'public')
  const fingerprint = functionBody(source, 'my_stuff_vehicle_identity_fingerprint_v3', 'private')
  const invalidate = functionBody(source, 'invalidate_my_stuff_vehicle_confirmation_v3', 'public')
  assert.match(confirm, /'series','trim','engine','engine_model'/i)
  assert.match(confirm, /series=nullif\(trim\(coalesce\(v_identity->>'series',''\)\),''\)/i)
  assert.match(confirm, /engine=nullif\(trim\(coalesce\(v_identity->>'engine',''\)\),''\)/i)
  assert.match(fingerprint, /'series',p_item\.series/i)
  assert.match(invalidate, /new\.series[\s\S]+old\.series/i)
})

test('atomic confirmation persists canonical VIN and hashes only the canonical request', () => {
  const confirm = functionBody(sql(), 'confirm_my_stuff_vehicle_identity_v3', 'public')
  assert.match(confirm, /'vin','model_year'/i)
  assert.match(confirm, /select vin into v_existing_vin[^;]+for update/i)
  assert.match(confirm, /v_vin:=upper\(regexp_replace\(coalesce\(nullif\(p_identity->>'vin',''\),v_existing_vin,''\),'\[ -\]','',\s*'g'\)\)/i)
  assert.match(confirm, /v_vin !~ '\^\[A-HJ-NPR-Z0-9\]\{17\}\$'/i)
  assert.match(confirm, /v_identity:=jsonb_set\(p_identity,'\{vin\}',to_jsonb\(v_vin\),true\)/i)
  assert.match(confirm, /jsonb_build_object\('item',p_item_id,'identity',v_identity\)/i)
  assert.match(confirm, /update public\.my_stuff_items set\s+vin=v_vin/i)
  assert.doesNotMatch(confirm, /jsonb_build_object\('item',p_item_id,'vin',v_vin/i)
})

test('ordinary V2 item patch accepts and clears series and all typed identity fields', () => {
  const update = functionBody(sql(), 'update_my_stuff_item_v2', 'public')
  assert.match(update, /'model','series','trim'/i)
  assert.match(update, /'engine_model','engine_displacement_liters','engine_cylinders'/i)
  assert.match(update, /series=case[\s\S]+not in \('car','truck','motorcycle','atv','side_by_side','trailer','rv'\) then null[\s\S]+p_patch\?'series'/i)
  assert.match(update, /vin=case[\s\S]+not in \('car','truck','motorcycle','atv','side_by_side','trailer','rv'\) then null[\s\S]+p_patch\?'vin'/i)
  assert.match(update, /vehicle_market=case when p_patch\?'vehicle_market'/i)
  assert.match(update, /where id=p_item_id and user_id=v_user/i)
})

test('confirmation remains owner-scoped, idempotent, and bounded', () => {
  const confirm = functionBody(sql(), 'confirm_my_stuff_vehicle_identity_v3', 'public')
  assert.match(confirm, /auth\.uid\(\)/i)
  assert.match(confirm, /where id=p_item_id and user_id=v_user for update/i)
  assert.match(confirm, /Idempotency key reused with different request/i)
  assert.match(confirm, /pg_column_size\(p_identity\)>32768/i)
  assert.match(confirm, /length\(coalesce\(p_identity->>'series',''\)\)>200/i)
})
