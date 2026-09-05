import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migrationUrl = new URL('../supabase/migrations/20260905120000_add_my_stuff_expenses_research_v3.sql', import.meta.url)
const transferFixUrl = new URL('../supabase/migrations/20260905190000_fix_v3_project_transfer_purchase_date.sql', import.meta.url)
const projectTransmissionUrl = new URL('../supabase/migrations/20260905200000_add_project_transmission.sql', import.meta.url)
const projectTransmissionValidationUrl = new URL('../supabase/migrations/20260905201000_validate_project_transmission.sql', import.meta.url)
const itemToProjectUrl = new URL('../supabase/migrations/20260905202000_transfer_my_stuff_to_project.sql', import.meta.url)

function migration() { return readFileSync(migrationUrl, 'utf8') }
function transferFix() { return readFileSync(transferFixUrl, 'utf8') }
function projectTransmission() { return readFileSync(projectTransmissionUrl, 'utf8') }
function projectTransmissionValidation() { return readFileSync(projectTransmissionValidationUrl, 'utf8') }
function itemToProject() { return readFileSync(itemToProjectUrl, 'utf8') }

function functionBody(sql, name, schema = 'public') {
  const starts = [`create function ${schema}.${name}(`, `create or replace function ${schema}.${name}(`]
    .map(value => sql.indexOf(value)).filter(value => value >= 0)
  assert.ok(starts.length, `${name} exists`)
  const start = Math.min(...starts)
  const nextFunctions = ['\ncreate function public.','\ncreate function private.','\ncreate or replace function public.','\ncreate or replace function private.']
    .map(value => sql.indexOf(value,start + 1)).filter(value => value >= 0)
  return sql.slice(start,nextFunctions.length ? Math.min(...nextFunctions) : sql.length)
}

test('V3 migration is additive and preserves V1/V2 RPC implementations', () => {
  const sql = migration()
  assert.doesNotMatch(sql, /drop\s+(table|column|function)|alter\s+column[^;]+type/i)
  assert.match(sql, /alter table public\.my_stuff_items/i)
  for (const legacy of ['create_my_stuff_item', 'create_my_stuff_item_v2', 'transfer_project_to_my_stuff_v2']) {
    assert.doesNotMatch(sql, new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${legacy}\\(`, 'i'))
  }
})

test('V3 installs vehicle, expenses, planning, attachments, and research state', () => {
  const sql = migration()
  for (const column of ['engine_displacement_liters','engine_cylinders','vehicle_type','body_style','plant_name','plant_country','vehicle_market','vin_confirmed_at','vin_confirmation_fingerprint','vin_decoder_source','vin_decoder_version']) {
    assert.match(sql, new RegExp(`add column ${column}\\b`, 'i'))
  }
  for (const table of ['my_stuff_expenses','my_stuff_expense_revisions','my_stuff_expense_audit','my_stuff_definition_versions','my_stuff_planned_occurrences','my_stuff_occurrence_status_events','my_stuff_attachments','my_stuff_research_jobs','my_stuff_research_attempts','my_stuff_research_evidence','my_stuff_research_candidates','my_stuff_research_approvals','my_stuff_research_apply_records','my_stuff_research_budget_ledger','my_stuff_research_dead_letters']) {
    assert.match(sql, new RegExp(`create table (?:public|private)\\.${table}\\b`, 'i'), table)
  }
})

test('expense identities, immutable revisions, atomic service costs, and transfer dedupe are explicit', () => {
  const sql = migration()
  assert.match(sql, /source_type text not null check \(source_type in \('manual','project_transfer','service'\)\)/i)
  assert.match(sql, /unique[^\n]+source_project_expense_id/i)
  assert.match(sql, /unique[^\n]+linked_occurrence_id/i)
  for (const rpc of ['create_my_stuff_expense_v3','revise_my_stuff_expense_v3','void_my_stuff_expense_v3','get_my_stuff_expenses_v3','get_my_stuff_financial_summary_v3','record_my_stuff_service_with_expense_v3','revise_my_stuff_service_expense_v3','transfer_project_to_my_stuff_v3']) {
    const body = functionBody(sql, rpc)
    assert.match(body, /auth\.uid\(\)/i)
    assert.match(body, /security definer set search_path=public/i)
  }
  assert.match(functionBody(sql, 'create_my_stuff_expense_v3_trusted', 'private'), /digest\([^;]+sha256/i)
  assert.match(functionBody(sql, 'create_my_stuff_expense_v3'), /'manual',null,null,null/i)
  const transfer = functionBody(sql, 'transfer_project_to_my_stuff_v3')
  assert.doesNotMatch(transfer, /to_jsonb\s*\(\s*(?:p|e|project|expense)\s*\)/i)
  assert.doesNotMatch(transfer, /transfer_project_to_my_stuff_v2\s*\(/i)
  assert.match(transfer, /insert into public\.my_stuff_items\s*\(/i)
  assert.match(transfer, /insert into public\.my_stuff_project_transfers\s*\(/i)
  assert.doesNotMatch(transfer, /\bp\.purchase_date\b|\bv_project\.purchase_date\b/i)
  assert.match(transfer, /values\(v_user,trim\(v_project\.title\),v_category,null,/i)
  const service = functionBody(sql, 'record_my_stuff_service_with_expense_v3')
  assert.match(service, /materialize_my_stuff_next_occurrence_v3\s*\(\s*p_definition_id\s*\)/i)
  const voidExpense = functionBody(sql, 'void_my_stuff_expense_v3')
  assert.match(voidExpense, /length\s*\(\s*p_reason\s*\)\s*>\s*1000/i)
  assert.match(sql, /my_stuff_expense_audit[\s\S]+length\s*\(\s*coalesce\s*\(\s*reason\s*,\s*''\s*\)\s*\)\s*<=\s*1000/i)
  assert.match(sql, /prevent_my_stuff_v3_immutable_update/i)
})

test('planning supports append-only versions, canonical next occurrences, and status events', () => {
  const sql = migration()
  assert.match(sql, /status text not null check \(status in \('not_completed','completed','not_applicable','skipped','history_unknown'\)\)/i)
  assert.match(sql, /unique \(definition_id, occurrence_key\)/i)
  for (const rpc of ['create_my_stuff_custom_task_v3','version_my_stuff_task_v3','list_my_stuff_schedule_groups_v3','get_my_stuff_due_views_v3','transition_my_stuff_occurrence_status_v3','complete_my_stuff_planned_occurrence_v3']) {
    assert.match(sql, new RegExp(`create function public\\.${rpc}\\(`, 'i'))
  }
  assert.match(functionBody(sql, 'transition_my_stuff_occurrence_status_v3'), /insert into public\.my_stuff_occurrence_status_events/i)
  assert.match(functionBody(sql, 'complete_my_stuff_planned_occurrence_v3'), /record_my_stuff_service_with_expense_v3/i)
})

test('VIN confirmation is canonical and attachment operations remain disabled', () => {
  const sql = migration()
  const confirm = functionBody(sql, 'confirm_my_stuff_vehicle_identity_v3')
  assert.match(confirm, /digest\([^;]+sha256/i)
  assert.match(confirm, /vin_confirmed_at=clock_timestamp\(\)/i)
  assert.match(sql, /invalidate_my_stuff_vehicle_confirmation_v3/i)
  assert.match(sql, /my-stuff-media/i)
  assert.match(sql, /check\s*\(\s*num_nonnulls\(expense_revision_id,service_revision_id\)=1\s*\)/i)
  assert.doesNotMatch(sql, /grant execute on function[^;]*(reserve|finalize)_my_stuff_attachment_v3/is)
  assert.doesNotMatch(sql, /public_url/i)
})

test('research state is installed but enqueue and provider execution remain disabled', () => {
  const sql = migration()
  const enqueue = functionBody(sql, 'enqueue_my_stuff_research_v3')
  assert.match(enqueue, /RESEARCH_PROVIDER_DISABLED/i)
  assert.match(sql, /queued[^;]+running[^;]+awaiting_review[^;]+approved[^;]+applied/is)
  assert.doesNotMatch(sql, /grant execute on function private\.(?:lease|settle)_my_stuff_research_job_v3[^;]+to service_role/is)
  assert.doesNotMatch(sql, /grant execute on function[^;]*enqueue_my_stuff_research_v3/is)
  for (const table of ['my_stuff_research_jobs','my_stuff_research_attempts','my_stuff_research_evidence','my_stuff_research_candidates','my_stuff_research_approvals','my_stuff_research_apply_records','my_stuff_research_budget_ledger','my_stuff_research_dead_letters']) {
    assert.match(sql, new RegExp(`revoke all on table private\\.${table} from public,anon,authenticated`, 'i'))
  }
})

test('Production transfer correction replaces only the V3 RPC without inventing an acquisition date', () => {
  const sql = transferFix()
  assert.match(sql, /to_regprocedure\('public\.transfer_project_to_my_stuff_v3\(uuid,jsonb,text\)'\)/i)
  assert.match(sql, /create or replace function public\.transfer_project_to_my_stuff_v3\(/i)
  assert.doesNotMatch(sql, /\bp\.purchase_date\b|\bv_project\.purchase_date\b|transfer_project_to_my_stuff_v2\s*\(/i)
  assert.match(sql, /values\(v_user,trim\(v_project\.title\),v_category,null,/i)
  assert.doesNotMatch(sql, /to_jsonb\s*\(\s*(?:p|e|project|expense)\s*\)/i)
  assert.match(sql, /revoke all on function public\.transfer_project_to_my_stuff_v3\(uuid,jsonb,text\) from public,anon/i)
  assert.match(sql, /grant execute on function public\.transfer_project_to_my_stuff_v3\(uuid,jsonb,text\) to authenticated/i)
})

test('Project transmission is additive, bounded, and transferred through the final V3 RPC', () => {
  const sql = projectTransmission()
  assert.match(sql, /alter table public\.projects add column if not exists transmission text/i)
  assert.match(sql, /check\s*\(length\(coalesce\(transmission,''\)\)\s*<=\s*200\)/i)
  assert.doesNotMatch(sql, /validate constraint/i)
  assert.match(projectTransmissionValidation(), /^begin;[\s\S]*alter table public\.projects validate constraint projects_transmission_length;[\s\S]*commit;\s*$/i)
  assert.doesNotMatch(sql, /drop constraint/i)
  assert.match(sql, /create or replace function public\.transfer_project_to_my_stuff_v3\(/i)
  assert.match(sql, /\bp\.transmission\b/i)
  assert.match(sql, /insert into public\.my_stuff_items\s*\([^;]*\btransmission\b/i)
  assert.match(sql, /nullif\(trim\(coalesce\(v_project\.transmission,''\)\),''\)/i)
  assert.match(sql, /'transmission',v_project\.transmission/i)
  assert.match(sql, /array\[[^;]*'transmission'/i)
  assert.doesNotMatch(sql, /\bp\.purchase_date\b|\bv_project\.purchase_date\b|transfer_project_to_my_stuff_v2\s*\(/i)
  assert.match(sql, /revoke all on function public\.transfer_project_to_my_stuff_v3\(uuid,jsonb,text\) from public,anon/i)
  assert.match(sql, /grant execute on function public\.transfer_project_to_my_stuff_v3\(uuid,jsonb,text\) to authenticated/i)
})

test('My Stuff to Project transfer is atomic, idempotent, allowlisted, and preserves cost structure', () => {
  const sql = itemToProject()
  assert.match(sql, /create table if not exists public\.my_stuff_to_project_transfers/i)
  assert.match(sql, /create table if not exists public\.my_stuff_to_project_expense_copies/i)
  assert.doesNotMatch(sql, /alter table public\.expenses|source_my_stuff_item_id|source_my_stuff_expense_id/i)
  assert.match(sql, /references public\.projects\(id\) on delete no action deferrable initially deferred/i)
  assert.match(sql, /project_expense_id uuid references public\.expenses\(id\) on delete set null/i)
  assert.doesNotMatch(sql, /before update or delete on public\.my_stuff_to_project_/i)
  assert.match(sql, /guard_my_stuff_expense_after_archive/i)
  assert.match(sql, /set local lock_timeout/i)
  assert.match(sql, /set local statement_timeout/i)
  assert.match(sql, /enforce_free_active_project_limit/i)
  assert.match(sql, />=\s*6/i)
  assert.match(sql, /pg_advisory_xact_lock/i)
  assert.match(sql, /unique\s*\(\s*user_id\s*,\s*item_id\s*\)/i)
  assert.match(sql, /create or replace function public\.transfer_my_stuff_to_project_v1\(p_item_id uuid,p_mutation_id text\)/i)
  const transfer = functionBody(sql, 'transfer_my_stuff_to_project_v1')
  assert.match(transfer, /auth\.uid\(\)/i)
  assert.match(transfer, /security definer set search_path=public,extensions/i)
  assert.match(transfer, /v_item\.item_type in \([^)]*'side_by_side'[^)]*'trailer'[^)]*'rv'[^)]*'boat'/i)
  assert.doesNotMatch(transfer, /to_jsonb\s*\(\s*(?:i|e|item|expense)\s*\)/i)
  assert.match(transfer, /insert into public\.projects\s*\(/i)
  assert.match(transfer, /v_item\.purchase_price/i)
  assert.match(transfer, /coalesce\(v_item\.purchase_currency,'USD'\) is distinct from 'USD'/i)
  assert.match(transfer, /round\(v_item\.purchase_price,2\)/i)
  assert.match(transfer, /round\(r\.amount,2\)/i)
  assert.match(transfer, /hashtextextended\(v_user::text\|\|':transfer-mutation:'\|\|trim\(p_mutation_id\),0\)/i)
  assert.match(transfer, /hashtextextended\(v_user::text\|\|':item:'\|\|p_item_id::text,0\)/i)
  assert.match(transfer, /if v_project is not null then raise exception 'Item was already moved to Projects'; end if/i)
  assert.doesNotMatch(transfer, /if v_project is not null then return v_project/i)
  assert.match(transfer, /case when v_item\.item_type in \([^)]*'rv'[^)]*\) then v_item\.vin else null end/i)
  assert.match(transfer, /insert into public\.expenses\s*\(/i)
  assert.match(transfer, /insert into public\.my_stuff_to_project_expense_copies/i)
  assert.match(transfer, /where e\.voided_at is null/i)
  assert.match(transfer, /order by r\.revision_number desc/i)
  assert.match(transfer, /update public\.my_stuff_items set archived_at=coalesce\(archived_at,clock_timestamp\(\)\)/i)
  assert.match(sql, /revoke all on function public\.transfer_my_stuff_to_project_v1\(uuid,text\) from public,anon/i)
  assert.match(sql, /grant execute on function public\.transfer_my_stuff_to_project_v1\(uuid,text\) to authenticated/i)
  assert.doesNotMatch(sql, /expense_snapshot/i)
})
