import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sql = readFileSync(new URL('../supabase/migrations/20260907040000_harden_legacy_public_privileges.sql', import.meta.url), 'utf8')
const normalized = sql.replace(/\s+/g, ' ').toLowerCase()

test('legacy trigger function keeps its deployed body while gaining a fixed search path and no browser execute grants', () => {
  assert.match(normalized, /to_regprocedure\('public\.handle_new_user\(\)'\) is not null/)
  assert.match(normalized, /alter function public\.handle_new_user\(\) set search_path ?= ?public/)
  assert.doesNotMatch(normalized, /create or replace function public\.handle_new_user/)
  assert.match(normalized, /revoke all on function public\.handle_new_user\(\) from public, anon, authenticated/)
})

test('browser roles cannot truncate, reference, or install triggers on public tables', () => {
  assert.match(normalized, /revoke truncate, references, trigger on all tables in schema public from public, anon, authenticated/)
  assert.match(normalized, /alter default privileges in schema public revoke truncate, references, trigger on tables from public, anon, authenticated/)
})

test('anonymous callers lose every leaked legacy function execution grant', () => {
  for (const signature of [
    'adjust_trade_up_goal(uuid,text,numeric,text,text)',
    'create_trade_up_project(text,text,numeric,text,text,text,text,text,text,text,text,integer,text,text,uuid,numeric,numeric,text)',
    'delete_trade_up_goal(uuid)',
    'delete_trade_up_project(uuid)',
    'record_trade_up_direct_trade(uuid,text,text,numeric,text,numeric,numeric,numeric,text,text)',
    'record_trade_up_sale(uuid,numeric,numeric)',
    'undo_goal_project_outcome(uuid)',
  ]) {
    assert.match(normalized, new RegExp(`revoke execute on function public\\.${signature.replace(/[()]/g, '\\$&')} from public, anon`))
  }
})

test('SQL harness reapplies the migration after removing the dashboard-only legacy function', () => {
  const runner = readFileSync(new URL('./sql/run-security-cleanup-local.sh', import.meta.url), 'utf8')
  assert.match(runner, /drop function public\.handle_new_user\(\)/)
  assert.equal((runner.match(/20260907040000_harden_legacy_public_privileges\.sql/g) || []).length, 2)
})
