import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync(new URL('../supabase/migrations/20260903220000_add_my_stuff_v2.sql', import.meta.url), 'utf8')
const legacy = readFileSync(new URL('../supabase/migrations/20260824190000_add_my_stuff.sql', import.meta.url), 'utf8')

test('My Stuff V2 is additive and preserves the installed-client RPC contract', () => {
  assert.match(migration, /alter table public\.my_stuff_items/i)
  assert.doesNotMatch(migration, /drop\s+(table|column|function)|alter\s+column[^;]+type/i)
  for (const signature of [
    'create_my_stuff_item(text,text,date,text,numeric,numeric,text)',
    'create_my_stuff_schedule(uuid,text,text,numeric,timestamptz,numeric,text)',
    'complete_my_stuff_maintenance(uuid,timestamptz,numeric,numeric,text,text)',
  ]) assert.doesNotMatch(migration, new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${signature.replace(/[()]/g, '\\$&')}`, 'i'))
  assert.match(legacy, /create function public\.create_my_stuff_item\(/i)
})

test('V2 defines readings, maintenance definitions, immutable occurrences, revisions, and audits', () => {
  for (const table of [
    'my_stuff_readings',
    'my_stuff_maintenance_definitions',
    'my_stuff_service_occurrences',
    'my_stuff_service_occurrence_revisions',
    'my_stuff_service_audit',
    'my_stuff_project_transfers',
  ]) assert.match(migration, new RegExp(`create table public\\.${table}\\b`, 'i'))
  assert.match(migration, /reading_type[^;]+mileage[^;]+hours[^;]+cycles/is)
  assert.match(migration, /corrects_reading_id/i)
  assert.match(migration, /calendar_months/i)
  assert.match(migration, /whichever_first/i)
  assert.match(migration, /normal[^;]+severe/is)
  assert.match(migration, /asset_origin[^;]+last_completion/is)
  assert.match(migration, /first_interval_miles/i)
  assert.match(migration, /parts jsonb/i)
  assert.match(migration, /labor jsonb/i)
  assert.match(migration, /warranty jsonb/i)
  assert.match(migration, /attachment_metadata jsonb/i)
})

test('V2 security and transfer contract are explicit', () => {
  assert.match(migration, /create function public\.transfer_project_to_my_stuff_v2\(/i)
  assert.match(migration, /create function public\.set_my_stuff_item_archived_v2\(/i)
  assert.match(migration, /pg_advisory_xact_lock/i)
  assert.match(migration, /user_has_verified_pro_entitlement/i)
  assert.match(migration, /create table public\.my_stuff_project_transfers[\s\S]+project_id uuid not null/i)
  assert.doesNotMatch(migration, /insert\s+into\s+public\.(goal_ledger|trade_up_goals|expenses)/i)
  assert.doesNotMatch(migration, /create\s+policy[^;]*(storage\.|storage\.objects|bucket)/i)
  assert.match(migration, /security definer\s+set search_path\s*=\s*public/is)
  assert.match(migration, /revoke all on table[^;]+from public\s*,\s*anon\s*,\s*authenticated/is)
  assert.match(migration, /on delete cascade/i)
})

test('V2 reading corrections cannot be authorized by a caller-settable GUC', () => {
  assert.doesNotMatch(migration, /current_setting\s*\(\s*['"]sideflip\./i)
  assert.doesNotMatch(migration, /set_config\s*\(\s*['"]sideflip\./i)
  assert.match(migration, /effective_current_mileage/i)
  assert.match(migration, /effective_current_hours/i)
  assert.match(migration, /effective_current_cycles/i)
})

test('V2 item patching handles an explicit complete key set', () => {
  for (const field of [
    'model_number', 'engine_model', 'serial_number', 'engine_serial', 'vin',
    'hull_number', 'registration_number', 'usage_dimensions', 'manufactured_on',
    'in_service_on',
  ]) assert.match(migration, new RegExp(`${field}=case when p_patch\\?'${field}'`, 'i'))
  assert.match(migration, /Unsupported item field/i)
})

test('V2 maintenance definition patching fails closed on unknown keys', () => {
  const start = migration.indexOf('create function public.update_my_stuff_maintenance_definition_v2(')
  const end = migration.indexOf('\ncreate function public.', start + 1)
  assert.ok(start >= 0, 'maintenance definition update body found')
  const body = migration.slice(start, end < 0 ? migration.length : end)
  assert.match(body, /jsonb_object_keys\(p_definition\)/i)
  assert.match(body, /Unsupported maintenance definition field:/i)
  assert.match(body, /'enabled'/i)
})

test('public V2 provenance is caller-proof and trusted writes use a private service path', () => {
  for (const rpc of [
    'create_my_stuff_maintenance_definition_v2',
    'update_my_stuff_maintenance_definition_v2',
    'record_my_stuff_service_occurrence_v2',
    'revise_my_stuff_service_occurrence_v2',
  ]) {
    const start = migration.indexOf(`create function public.${rpc}(`)
    const end = migration.indexOf('\ncreate function ', start + 1)
    assert.ok(start >= 0, `${rpc} body found`)
    const body = migration.slice(start, end < 0 ? migration.length : end)
    assert.match(body, /Provenance fields cannot be supplied/i)
  }
  assert.match(migration, /create schema if not exists private/i)
  assert.match(migration, /create function private\.create_my_stuff_maintenance_definition_v2_trusted\(/i)
  assert.match(migration, /create function private\.record_my_stuff_service_occurrence_v2_trusted\(/i)
  assert.match(migration, /revoke all on schema private from public,anon,authenticated/i)
  assert.match(migration, /grant execute on function private\.[^;]+to service_role/is)
  assert.match(migration, /'provenance_type'\s*,\s*'manual'/i)
  assert.match(migration, /'source_class'\s*,\s*'user'/i)
  assert.match(migration, /'provenance_type'\s*,\s*'project_expense_snapshot'\s*,\s*'provenance'\s*,\s*v_expense/i)
})

test('due-state applies as-of, all/whichever-first, and cadence-anchor semantics', () => {
  const start = migration.indexOf('create function public.get_my_stuff_due_state_v2(')
  const end = migration.indexOf('\ncreate function public.', start + 1)
  assert.ok(start >= 0, 'due-state body found')
  const body = migration.slice(start, end < 0 ? migration.length : end)
  assert.match(body, /completed_at\s*<=\s*p_as_of/i)
  assert.match(body, /recorded_at\s*<=\s*p_as_of/i)
  assert.doesNotMatch(body, /recorded_at\s*<=\s*p_as_of[^\n]+effective_current_/i)
  assert.doesNotMatch(body, /recorded_at\s*<=\s*p_as_of[^\n]+current_(mileage|hours|cycles)/i)
  assert.match(body, /due_semantics/i)
  assert.match(body, /cadence_anchor/i)
  assert.match(body, /isfinite\s*\(\s*p_as_of\s*\)/i)
  assert.match(body, /1900-01-01/i)
  assert.match(body, /2200-01-01/i)
  assert.match(body, /Due-state as-of is outside the supported range/i)
})

test('revision and archive RPCs validate bounded mutation IDs', () => {
  for (const rpc of ['revise_my_stuff_service_occurrence_v2', 'set_my_stuff_item_archived_v2']) {
    const start = migration.indexOf(`create function public.${rpc}(`)
    const end = migration.indexOf('\ncreate function public.', start + 1)
    assert.ok(start >= 0, `${rpc} body found`)
    const body = migration.slice(start, end < 0 ? migration.length : end)
    assert.match(body, /nullif\(trim\(p_mutation_id\),''\) is null or length\(p_mutation_id\)>200/i)
  }
})
