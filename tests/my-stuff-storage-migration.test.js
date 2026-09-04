import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync(
  new URL('../supabase/migrations/20260903190000_add_private_my_stuff_media.sql', import.meta.url),
  'utf8',
)
const contract = readFileSync(
  new URL('../docs/my-stuff-private-media.md', import.meta.url),
  'utf8',
)

const ownerPath = String.raw`\(storage\.foldername\(name\)\)\[1\]\s*=\s*\(select auth\.uid\(\)::text\)`
const boundedPath = String.raw`name\s*~\s*'\^\[0-9a-f\]`

function policy(operation) {
  const match = migration.match(new RegExp(
    `create policy "my_stuff_media_owner_${operation.toLowerCase()}"[\\s\\S]+?;`,
    'i',
  ))
  assert.ok(match, `missing ${operation} policy`)
  return match[0]
}

test('creates a separate private My Stuff bucket with bounded declared types and size', () => {
  assert.match(migration, /insert into storage\.buckets\s*\(id, name, public, file_size_limit, allowed_mime_types\)/i)
  assert.match(migration, /'my-stuff-media',\s*'my-stuff-media',\s*false,\s*15728640/i)

  for (const mime of [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]) assert.ok(migration.includes(`'${mime}'`), `missing allowed MIME type ${mime}`)

  assert.doesNotMatch(migration, /project-photos/i)
  assert.doesNotMatch(migration, /public\s*=\s*true/i)
})

test('migration is repeat-safe by replacing each named policy', () => {
  for (const operation of ['select', 'insert', 'update', 'delete']) {
    assert.match(
      migration,
      new RegExp(`drop\\s+policy\\s+if\\s+exists\\s+"my_stuff_media_owner_${operation}"\\s+on\\s+storage\\.objects\\s*;[\\s\\S]*create\\s+policy\\s+"my_stuff_media_owner_${operation}"`, 'i'),
    )
  }
})

test('owner-only policies enforce a record-scoped bounded object-name grammar', () => {
  for (const operation of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
    const sql = policy(operation)
    assert.match(sql, new RegExp(`for\\s+${operation}`, 'i'))
    assert.match(sql, /to authenticated/i)
    assert.match(sql, /bucket_id\s*=\s*'my-stuff-media'/i)
    assert.match(sql, new RegExp(ownerPath, 'i'))
    assert.match(sql, new RegExp(boundedPath, 'i'))
    assert.match(sql, /\/items\//i)
    assert.match(sql, /before-after/i)
    assert.match(sql, /receipts\|invoices\|documents/i)
  }

  assert.match(policy('INSERT'), /with check/i)
  assert.match(policy('UPDATE'), /using[\s\S]+with check/i)
  assert.match(policy('SELECT'), /\busing\b/i)
  assert.match(policy('DELETE'), /\busing\b/i)
})

test('every operation requires an existing caller-owned item', () => {
  for (const operation of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
    const sql = policy(operation)
    assert.match(sql, /exists\s*\([\s\S]*from\s+public\.my_stuff_items/i)
    assert.match(sql, /my_stuff_items\.id::text\s*=\s*\(storage\.foldername\(name\)\)\[3\]/i)
    assert.match(sql, /my_stuff_items\.user_id\s*=\s*\(select auth\.uid\(\)\)/i)
  }
})

test('migration changes no My Stuff rows and documents private signed-URL access', () => {
  assert.doesNotMatch(migration, /\b(insert\s+into|update|delete\s+from)\s+public\.(projects|expenses|trade_up_goals|goal_ledger|my_stuff_items|my_stuff_schedules|my_stuff_service_logs)\b/i)
  assert.match(migration, /signed URL/i)
  assert.match(migration, /never persist a\s+(?:--\s*)?public URL/i)
})

test('contract defines lifecycle cleanup and retry ownership', () => {
  for (const required of [
    /attachment deletion/i,
    /item deletion/i,
    /metadata(?:-create| creation) failure/i,
    /abandoned upload/i,
    /replacement\/upsert failure/i,
    /account deletion/i,
  ]) assert.match(contract, required)

  assert.match(contract, /idempotent/i)
  assert.match(contract, /retry/i)
  assert.match(contract, /service-role/i)
})

test('contract bounds signed URLs and treats MIME as declared metadata only', () => {
  assert.match(contract, /TTL/i)
  assert.match(contract, /60 seconds/i)
  assert.match(contract, /declared(?: content)? type only/i)
  assert.match(contract, /magic[- ]byte/i)
  assert.match(contract, /before parsing/i)
  assert.match(contract, /never persist/i)
})

test('contract distinguishes the PostgreSQL RLS harness from Storage API behavior', () => {
  assert.match(contract, /protect_delete/i)
  assert.match(contract, /storage\.allow_delete_query/i)
  assert.match(contract, /Storage API/i)
  assert.match(contract, /does not prove/i)
})
