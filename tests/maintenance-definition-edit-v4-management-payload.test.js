import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const execFileAsync = promisify(execFile)

test('definition-edit Management payload atomically applies only the new hash-pinned migration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sideflip-v4-definition-edit-'))
  const output = path.join(directory, 'payload.json')
  try {
    await execFileAsync('python3', ['scripts/build-maintenance-definition-edit-v4-management-payload.py', '--output', output])
    assert.equal((await stat(output)).mode & 0o777, 0o600)
    const query = JSON.parse(await readFile(output, 'utf8')).query
    const migration = await readFile('supabase/migrations/20260924130000_add_maintenance_definition_edit_v4.sql', 'utf8')
    const documented = await readFile('docs/maintenance-integrity-v4-wire-contract.md', 'utf8')
    const digest = createHash('sha256').update(migration).digest('hex')
    assert.match(documented, new RegExp(digest))
    assert.match(query, /current_user<>'postgres'/)
    assert.match(query, /REMOTE_MIGRATION_LEDGER_HEAD_MISMATCH/)
    assert.match(query, /CONCURRENT_DATABASE_RELEASE_ACTIVITY_DETECTED/)
    assert.match(query, /pg_try_advisory_xact_lock/)
    assert.doesNotMatch(query, /pg_try_advisory_lock\(|select pg_advisory_lock\(|pg_advisory_unlock/)
    assert.ok(query.indexOf('begin;') < query.indexOf('pg_try_advisory_xact_lock'))
    assert.match(query, /set local lock_timeout/)
    assert.match(query, /set local statement_timeout/)
    assert.match(query, /assert_my_stuff_test_clock_empty_v4/)
    assert.match(query, /PHASE1_NOT_INSTALLED_AND_DISABLED/)
    assert.match(query, /version='20260924120000'|is distinct from '20260924120000'/)
    assert.match(query, /values \('20260924130000','add_maintenance_definition_edit_v4'/)
    assert.match(query, /update_my_stuff_maintenance_definition_v4/)
    assert.match(query, /get_my_stuff_maintenance_state_v4/)
    assert.match(query, /setup_my_stuff_maintenance_preset_v4/)
    assert.match(query, /get_my_stuff_maintenance_integrity_export_v4/)
    assert.match(query, /PHASE1_STATE_RPC_MISSING/)
    assert.match(query, /state_returns_planned_occurrence/)
    assert.match(query, /baseline_anchor_mode_present/)
    assert.match(query, /export_function_present/)
    assert.match(query, /feature_enabled=false and legacy_retired=false/)
    assert.match(query, /has_function_privilege\('authenticated'/)
    assert.match(query, /has_function_privilege\('anon'/)
    assert.match(query, /has_function_privilege\('service_role'/)
    assert.match(query, /state_authenticated_execute/)
    assert.match(query, /state_anon_execute/)
    assert.match(query, /state_service_role_execute/)
    assert.equal((query.match(/insert into supabase_migrations\.schema_migrations/g) || []).length, 1)
    assert.equal((query.match(/create function public\.update_my_stuff_maintenance_definition_v4/g) || []).length, 2) // executable body + ledger text
    assert.doesNotMatch(query, /20260924120000_maintenance_integrity_v4|create table private\.my_stuff_integrity_rollout_v4/)
    const transaction = query.slice(query.indexOf('begin;'), query.indexOf('commit;') + 'commit;'.length)
    assert.match(transaction, /create function public\.update_my_stuff_maintenance_definition_v4/)
    assert.match(transaction, /insert into supabase_migrations\.schema_migrations/)
  } finally {
    await rm(directory, { recursive:true, force:true })
  }
})
