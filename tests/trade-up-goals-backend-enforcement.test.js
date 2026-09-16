import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migrationPath = '../supabase/migrations/20260916120000_authoritative_trade_up_goal_enforcement.sql'
const migration = () => readFileSync(new URL(migrationPath, import.meta.url), 'utf8')

test('authoritative goal migration exposes the iOS update contract and retained-goal guard', () => {
  const sql = migration()
  assert.match(sql, /create or replace function public\.assert_trade_up_goal_mutable\(/i)
  assert.match(sql, /order by g\.created_at, g\.id/i)
  assert.match(sql, /public\.user_has_verified_pro_entitlement\(v_user_id\)/i)
  assert.match(sql, /create or replace function public\.update_trade_up_goal\(\s*p_goal_id uuid,\s*p_status text,\s*p_target_amount numeric,\s*p_mutation_id text/is)
  assert.match(sql, /Goal is not fully funded/i)
})

test('every goal accounting RPC invokes the authoritative retained-goal guard', () => {
  const sql = migration()
  for (const rpc of [
    'adjust_trade_up_goal',
    'create_trade_up_project',
    'link_trade_up_project',
    'record_trade_up_sale',
    'record_trade_up_direct_trade',
    'undo_goal_project_outcome',
    'delete_trade_up_goal',
    'delete_trade_up_project',
  ]) {
    const body = sql.match(new RegExp(`create or replace function public\\.${rpc}\\([\\s\\S]*?\\$\\$;`, 'i'))?.[0]
    assert.ok(body, `${rpc} must be replaced by the authoritative migration`)
    assert.match(body, /assert_trade_up_goal_mutable\(/i, `${rpc} must enforce retained-goal access`)
  }
})

test('mutation retries and browser grants preserve the guarded legacy contract', () => {
  const sql = migration()
  const adjust = sql.match(/create or replace function public\.adjust_trade_up_goal\([\s\S]*?\$\$;/i)?.[0] || ''
  const update = sql.match(/create or replace function public\.update_trade_up_goal\([\s\S]*?\$\$;/i)?.[0] || ''
  assert.match(adjust, /Conflicting retry for adjustment/i)
  assert.match(update, /Conflicting retry for goal update/i)
  assert.match(sql, /grant update on table public\.trade_up_goals to authenticated/i)
  assert.match(sql, /guard_direct_trade_up_goal_updates/i)
  assert.match(sql, /revoke all on function public\.assert_trade_up_goal_mutable\(uuid,boolean\) from public, anon, authenticated/i)
  assert.match(sql, /revoke all on function public\.update_trade_up_goal\(uuid,text,numeric,text\) from public, anon/i)
  assert.match(sql, /grant execute on function public\.update_trade_up_goal\(uuid,text,numeric,text\) to authenticated/i)
  assert.match(sql, /guard_trade_up_expense_mutations/i)
  assert.match(sql, /expenses_amount_finite[\s\S]*not valid/i)
})
