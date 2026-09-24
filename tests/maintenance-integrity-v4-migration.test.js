import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const additiveUrl = new URL('../supabase/migrations/20260924120000_maintenance_integrity_v4.sql', import.meta.url)
const blockedUrl = new URL('../docs/maintenance-integrity-v4-enforcement.sql.template', import.meta.url)
const contractUrl = new URL('../docs/maintenance-integrity-v4-wire-contract.md', import.meta.url)
const runnerUrl = new URL('./sql/run-maintenance-integrity-v4-local.sh', import.meta.url)
const additive = () => readFileSync(additiveUrl, 'utf8')
const legacyEntrypoints = ['record_my_stuff_service_occurrence_v2','record_my_stuff_service_with_expense_v3','complete_my_stuff_planned_occurrence_v3','revise_my_stuff_service_occurrence_v2','revise_my_stuff_service_expense_v3','set_my_stuff_item_archived_v2']

test('Phase 1 is state-preserving, additive, and has no activation path', () => {
  const text = additive()
  assert.match(text, /feature_enabled boolean not null default false/i)
  assert.doesNotMatch(text, /activate_my_stuff_integrity_v4|grant execute[^;]+activation/i)
  assert.doesNotMatch(text, /update public\.my_stuff_items[\s\S]{0,100}archived_at\s*=\s*null/i)
  assert.doesNotMatch(text, /update public\.my_stuff_maintenance_definitions\s+\w*\s*set\s+enabled/i)
  assert.doesNotMatch(text, /create or replace function public\.prevent_my_stuff/i)
  assert.doesNotMatch(text, /trigger[\s\S]{0,120}on storage\.objects/i)
  assert.doesNotMatch(text, /alter column integrity_version set default|lifecycle_state text not null default/i)
  for (const name of legacyEntrypoints) assert.doesNotMatch(text, new RegExp(`revoke[^;]+${name}`, 'i'))
})

test('replay hash excludes device telemetry and lookup precedes clock validation', () => {
  const text = additive()
  const bodies = [...text.matchAll(/create function (?:public|private)\.(record_my_stuff_current_mileage_v4|record_my_stuff_current_reading_v4|setup_my_stuff_maintenance_preset_v4|complete_my_stuff_maintenance_v4|append_my_stuff_completion_correction_v4)[\s\S]*?end \$\$;/gi)].map(match => match[0])
  assert.equal(bodies.length, 5)
  for (const body of bodies) {
    const hash = body.match(/h:=encode\(digest\(([\s\S]*?)::text,'sha256'\)/i)?.[1]
    assert.ok(hash)
    assert.doesNotMatch(hash, /device_now/i)
    assert.ok(body.indexOf('select request_hash') < body.indexOf('assert_my_stuff_device_clock_v4'))
  }
})

test('completion stores a stable business date and preserves V3 planned recurrence', () => {
  const text = additive()
  assert.match(text, /add column service_performed_on date/i)
  assert.match(text, /add column service_timezone text/i)
  assert.match(text, /performed::timestamp at time zone service_tz/i)
  assert.match(text, /insert into public\.my_stuff_occurrence_status_events/i)
  assert.match(text, /perform public\.materialize_my_stuff_next_occurrence_v3\(d\.id\)/i)
})

test('deletion uses fenced leases and never directly manipulates Storage metadata', () => {
  const text = additive()
  for (const token of ['lease_worker_id','lease_token','lease_deadline','attempt_count','claim_my_stuff_deletions_v4','ack_my_stuff_deletion_storage_v4','finalize_my_stuff_deletion_v4','STALE_DELETION_LEASE']) assert.match(text, new RegExp(token, 'i'))
  assert.match(text, /for update skip locked limit p_batch_size/i)
  assert.doesNotMatch(text, /(?:select|insert|update|delete)\s+[\s\S]{0,30}storage\.objects/i)
  assert.match(text, /my_stuff_service_history set definition_id=null/i)
})

test('future cutover is blocked, owner-only, and cannot use service-role attestation', () => {
  assert.ok(existsSync(blockedUrl))
  const text = readFileSync(blockedUrl, 'utf8')
  assert.match(text, /DATABASE_OWNER_REQUIRED/i)
  assert.match(text, /CUTOVER_TEMPLATE_BLOCKED_EXACT_RELEASE_EVIDENCE_REQUIRED/i)
  assert.doesNotMatch(text, /grant execute[\s\S]{0,120}service_role/i)
  assert.doesNotMatch(text, /p_web_ready|p_ios_ready|p_android_ready/i)
})

test('full-stack runner executes real private-media and privilege-hardening migrations', () => {
  const text = readFileSync(runnerUrl, 'utf8')
  assert.match(text, /20260903190000_add_private_my_stuff_media\.sql/)
  assert.match(text, /20260907040000_harden_legacy_public_privileges\.sql/)
  assert.doesNotMatch(text, /private-media.*stub|privilege-hardening.*stub/i)
})

test('clock, corrections, multi-axis expense, report, and rollout docs remain covered', () => {
  const sql = additive()
  for (const token of ['>300','p_expected_revision','p_expected_snapshot_hash','REVISION_CONFLICT','service_hours','service_cycles','create_my_stuff_expense_v3_trusted','owner_report_disclaimer','snapshot_sha256','integrity_status']) assert.match(sql, new RegExp(token, 'i'))
  const docs = readFileSync(contractUrl, 'utf8')
  for (const token of ['Phase 1','deletion worker','database owner','exact PWA','not currently enforceable','five minutes']) assert.match(docs, new RegExp(token, 'i'))
})
