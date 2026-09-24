import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

test('Phase 1 Management API payload is hash-pinned, owner-only, and records only Phase 1', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sideflip-v4-payload-'))
  const output = path.join(directory, 'payload.json')
  try {
    await execFileAsync('python3', ['scripts/build-maintenance-integrity-v4-management-payload.py', '--output', output])
    const mode = (await stat(output)).mode & 0o777
    assert.equal(mode, 0o600)
    const payload = JSON.parse(await readFile(output, 'utf8'))
    const query = payload.query
    assert.match(query, /current_user<>'postgres'/)
    assert.match(query, /REMOTE_MIGRATION_LEDGER_HEAD_MISMATCH/)
    assert.match(query, /CONCURRENT_DATABASE_RELEASE_ACTIVITY_DETECTED/)
    assert.match(query, /version='20260924120000'/)
    assert.match(query, /feature_enabled=false and legacy_retired=false/)
    assert.match(query, /PRODUCTION_TEST_CLOCK_NOT_EMPTY/)
    assert.match(query, /storage'.*c\.relname='objects'/s)
    assert.equal((query.match(/insert into supabase_migrations\.schema_migrations/g) || []).length, 1)
    assert.doesNotMatch(query, /CUTOVER_TEMPLATE_BLOCKED/)
    assert.doesNotMatch(query, /20260924130000/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
