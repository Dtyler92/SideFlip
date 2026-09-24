import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration=readFileSync(new URL('../supabase/migrations/20260909133000_enforce_my_stuff_downgrade_access.sql',import.meta.url),'utf8')
const client=readFileSync(new URL('../src/myStuff/client.js',import.meta.url),'utf8')

test('downgrade migration uses the authoritative entitlement helper and deterministic oldest item',()=>{
  assert.match(migration,/user_has_verified_pro_entitlement\(p_user_id\)/)
  assert.match(migration,/order by oldest\.created_at asc,oldest\.id asc/)
  assert.match(migration,/MY_STUFF_ITEM_LOCKED_PRO_REQUIRED/)
  assert.doesNotMatch(migration,/profiles[^\n]*(plan|subscription)/i)
})

test('summary RPC keeps locked cards visible without exposing full detail columns',()=>{
  const summary=migration.match(/create function public\.list_my_stuff_items_v4\([\s\S]*?\n\)\nlanguage/)
  assert.ok(summary)
  for(const field of ['id uuid','name text','item_type text','acquired_on date','usage_dimensions text\\[\\]','effective_current_mileage numeric','created_at timestamptz','is_locked boolean']) assert.match(summary[0],new RegExp(field))
  for(const forbidden of ['vin text','notes text','serial_number text','purchase_price numeric']) assert.doesNotMatch(summary[0],new RegExp(forbidden))
  assert.match(migration,/not private\.my_stuff_item_is_accessible_v1[^\n]*as is_locked/)
  assert.match(client,/rpc\('list_my_stuff_items_v4'/)
  assert.doesNotMatch(client,/from\('my_stuff_items'\)\.select\('\*'\).*listItems/)
})

test('direct item and child-detail policies require retained-item access',()=>{
  for(const policy of ['my_stuff_items_owner_select','my_stuff_items_owner_update','my_stuff_items_owner_delete','my_stuff_schedules_owner_delete']){
    assert.match(migration,new RegExp(`create policy ${policy}[\\s\\S]{0,260}can_access_my_stuff_item_v1`))
  }
  const childPolicies=(migration.match(/create policy my_stuff_[^\n]+_owner_select/g)||[]).length
  assert.ok(childPolicies>=16,`expected at least 16 owner SELECT policies, found ${childPolicies}`)
})

test('security-definer maintenance reads and mutations cannot bypass downgrade access',()=>{
  for(const rpc of ['get_my_stuff_due_state_v2','get_my_stuff_due_views_v3','get_my_stuff_expenses_v3','get_my_stuff_financial_summary_v3','list_my_stuff_schedule_groups_v3']){
    assert.match(migration,new RegExp(`function public\\.${rpc}[\\s\\S]{0,700}assert_my_stuff_item_access_v1`))
  }
  const guards=(migration.match(/create trigger my_stuff_locked_access_guard/g)||[]).length
  assert.equal(guards,18)
  assert.match(migration,/mark_my_stuff_transfer_transaction_v1/)
  assert.match(migration,/create table private\.my_stuff_transfer_context_v1/)
  assert.match(migration,/pg_backend_pid\(\),pg_current_xact_id\(\),v_auth_user,new\.item_id/)
  assert.doesNotMatch(migration,/set_config|current_setting/)
})

test('migration preserves trusted service operation and removes browser grants from private internals',()=>{
  assert.match(migration,/Trusted service\/background operations have no end-user auth\.uid/)
  assert.match(migration,/if v_auth_user is not null then/)
  assert.match(migration,/revoke all on function private\.[^;]+ from public,anon,authenticated/g)
  assert.match(migration,/grant execute on function public\.list_my_stuff_items_v4\(boolean,boolean\) to authenticated,service_role/)
})
