import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migrationPath = new URL('../supabase/migrations/20260906150000_add_airplanes_and_fix_transferred_project_delete.sql', import.meta.url)

test('airplane is accepted by item create, update, and every transfer direction', () => {
  const sql = readFileSync(migrationPath, 'utf8')
  for (const name of [
    'create_my_stuff_item_v2',
    'update_my_stuff_item_v2',
    'transfer_project_to_my_stuff_v2',
    'transfer_project_to_my_stuff_v3',
    'transfer_my_stuff_to_project_v1',
  ]) assert.match(sql, new RegExp(`create or replace function public\\.${name}`))
  assert.ok((sql.match(/'airplane'/g) || []).length >= 5)
})

test('server create boundary enforces required ownership and usage fields for applicable item types', () => {
  const sql = readFileSync(migrationPath, 'utf8')
  assert.match(sql, /'car','truck','motorcycle','boat','airplane','atv','side_by_side','mower','tractor','trailer','generator','rv','equipment','bicycle','exercise'/)
  assert.match(sql, /Usage tracking is required for this item type/)
  assert.match(sql, /Current % is required for every selected usage type/)
  assert.match(sql, /Purchase price is required for this item type/)
})

test('transferred Project deletion preserves immutable provenance IDs while removing only the blocking FKs', () => {
  const sql = readFileSync(migrationPath, 'utf8')
  assert.match(sql, /lock table public\.my_stuff_to_project_transfers, public\.my_stuff_to_project_expense_copies in share mode/)
  assert.match(sql, /drop constraint my_stuff_to_project_transfers_project_id_fkey/)
  assert.match(sql, /drop constraint my_stuff_to_project_expense_copies_project_id_fkey/)
  assert.doesNotMatch(sql, /alter column project_id drop not null/i)
  assert.doesNotMatch(sql, /delete from public\.my_stuff_to_project_transfers/i)
  assert.doesNotMatch(sql, /create or replace function public\.delete_trade_up_project/i)
  assert.match(sql, /my_stuff_to_project_expense_copies_project_expense_id_fkey/)
})
