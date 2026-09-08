import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createMyStuffV3Client } from '../src/myStuff/client.js'
import {
  buildFinancialSummary,
  buildServiceExpenseRequest,
  buildServicePayload,
  classifyDueOccurrences,
  linkedOccurrenceId,
  normalizePlannedOccurrences,
  reviseExpenseByLinkage,
} from '../src/myStuff/v3Model.js'

function rpcDatabase() {
  const calls = []
  return {
    calls,
    database: {
      async rpc(name, payload) {
        calls.push({ name, payload })
        return { data: name === 'get_my_stuff_due_views_v3' ? [] : { ok: true }, error: null }
      },
    },
  }
}

test('V3 maintenance client uses the authoritative RPC names and signatures', async () => {
  const { calls, database } = rpcDatabase()
  const client = createMyStuffV3Client(database)
  await client.listScheduleGroups('item-1')
  await client.getDueViews('item-1', '2026-09-08T12:00:00.000Z')
  await client.recordServiceWithExpense({
    itemId: 'item-1', plannedOccurrenceId: 'plan-1', definitionId: 'definition-1',
    service: { service_name: 'Oil change' }, expense: { amount: 42.35 }, mutationId: 'service-mutation',
  })
  await client.reviseServiceExpense({
    occurrenceId: 'occurrence-1', expenseId: 'expense-1', servicePatch: {},
    expensePatch: { amount: 45.1 }, reason: 'Corrected receipt', mutationId: 'revision-mutation',
  })
  await client.transitionOccurrenceStatus('plan-1', 'skipped', 'Owner skipped it', 'status-mutation')

  assert.deepEqual(calls, [
    { name: 'list_my_stuff_schedule_groups_v3', payload: { p_item_id: 'item-1' } },
    { name: 'get_my_stuff_due_views_v3', payload: { p_item_id: 'item-1', p_as_of: '2026-09-08T12:00:00.000Z' } },
    { name: 'record_my_stuff_service_with_expense_v3', payload: {
      p_item_id: 'item-1', p_planned_occurrence_id: 'plan-1', p_definition_id: 'definition-1',
      p_service: { service_name: 'Oil change' }, p_expense: { amount: 42.35 }, p_mutation_id: 'service-mutation',
    } },
    { name: 'revise_my_stuff_service_expense_v3', payload: {
      p_occurrence_id: 'occurrence-1', p_expense_id: 'expense-1', p_service_patch: {},
      p_expense_patch: { amount: 45.1 }, p_reason: 'Corrected receipt', p_mutation_id: 'revision-mutation',
    } },
    { name: 'transition_my_stuff_occurrence_status_v3', payload: {
      p_occurrence_id: 'plan-1', p_status: 'skipped', p_reason: 'Owner skipped it', p_mutation_id: 'status-mutation',
    } },
  ])
})

test('planned schedule and due RPC rows normalize into Android-equivalent due groups', () => {
  const definitions = [
    { id: 'd-mile', name: 'Oil change', normal_interval_miles: 5000 },
    { id: 'd-time', name: 'Annual inspection', normal_calendar_months: 12 },
  ]
  const schedule = [
    { id: 'p1', definition_id: 'd-mile', status: 'not_completed', due_at: '2026-09-01' },
    { id: 'p2', definition_id: 'd-time', status: 'completed', due_at: '2026-08-20' },
  ]
  const due = [
    { occurrence: schedule[0], view: 'overdue' },
    { occurrence: schedule[1], view: 'completed_recently' },
  ]
  const normalized = normalizePlannedOccurrences(schedule, due, definitions)
  assert.deepEqual(normalized.map(row => [row.planned_occurrence_id, row.name, row.due_status]), [
    ['p1', 'Oil change', 'overdue'], ['p2', 'Annual inspection', 'completed_recently'],
  ])
  const groups = classifyDueOccurrences(normalized)
  assert.deepEqual(groups.overdue.map(row => row.planned_occurrence_id), ['p1'])
  assert.deepEqual(groups.completedRecently.map(row => row.planned_occurrence_id), ['p2'])
})

test('service completion preserves actual details and optional linked expense', () => {
  const service = buildServicePayload({
    occurrence: { name: 'Oil change', service_category: 'maintenance', service_action: 'replace' },
    actualServiceDate: '2026-09-08', readings: { miles: '12000', hours: '', cycles: '3' },
    providerType: 'provider', providerName: 'Honest Auto', parts: 'Filter; 5 qt oil', notes: 'Used synthetic',
  })
  assert.deepEqual(service, {
    service_name: 'Oil change', service_category: 'maintenance', service_action: 'replace',
    completed_at: '2026-09-08T12:00:00.000Z', mileage: 12000, cycles: 3,
    parts: [{ description: 'Filter; 5 qt oil' }], labor: [],
    vendor: { type: 'provider', name: 'Honest Auto' }, warranty: {}, notes: 'Used synthetic',
  })
  assert.deepEqual(buildServiceExpenseRequest({
    itemId: 'item-1', plannedOccurrenceId: 'plan-1', definitionId: 'definition-1', service,
    cost: '42.35', currency: 'usd', incurredOn: '2026-09-08', vendor: 'Honest Auto',
    mileage: '12000', notes: 'Used synthetic', description: 'Oil change',
  }), {
    itemId: 'item-1', plannedOccurrenceId: 'plan-1', definitionId: 'definition-1', service,
    expense: {
      description: 'Oil change', category: 'maintenance', custom_category: null, amount: 42.35,
      currency: 'USD', incurred_on: '2026-09-08', vendor: 'Honest Auto', mileage: 12000,
      hours: null, notes: 'Used synthetic',
    },
  })
})

test('linked service expenses revise atomically and ordinary expenses use the standalone RPC', async () => {
  const calls = []
  const handlers = {
    reviseExpense: async (...args) => calls.push(['ordinary', ...args]),
    reviseServiceExpense: async payload => calls.push(['linked', payload]),
  }
  const patch = { amount: 19.99 }
  assert.equal(linkedOccurrenceId({ linked_occurrence_id: 'occ-1' }), 'occ-1')
  await reviseExpenseByLinkage({ row: { id: 'expense-1', linked_occurrence_id: 'occ-1' }, patch, reason: 'Receipt', mutationId: 'm1', ...handlers })
  await reviseExpenseByLinkage({ row: { id: 'expense-2' }, patch, reason: 'Typo', mutationId: 'm2', ...handlers })
  assert.deepEqual(calls, [
    ['linked', { occurrenceId: 'occ-1', expenseId: 'expense-1', servicePatch: {}, expensePatch: patch, reason: 'Receipt', mutationId: 'm1' }],
    ['ordinary', 'expense-2', patch, 'Typo', 'm2'],
  ])
})

test('local financial fallback adds decimal money in integer cents', () => {
  const summary = buildFinancialSummary({ purchasePrice: 0.1, expenses: [
    { id: 'e1', latest_revision: { amount: 0.2, category: 'maintenance' } },
    { id: 'e2', latest_revision: { amount: 10.015, category: 'upgrade' } },
  ] })
  assert.equal(summary.purchasePrice, 0.1)
  assert.equal(summary.expenseSubtotal, 10.22)
  assert.equal(summary.totalInvested, 10.32)
  assert.equal(summary.maintenanceRepairSubtotal, 0.2)
  assert.equal(summary.upgradesSubtotal, 10.02)
})

test('My Stuff detail exposes Schedule, Due Items, occurrence status, service details, and history', () => {
  const panel = fs.readFileSync(new URL('../src/components/MyStuffMaintenancePanel.jsx', import.meta.url), 'utf8')
  const detail = fs.readFileSync(new URL('../src/pages/MyStuffDetail.jsx', import.meta.url), 'utf8')
  for (const text of ['Schedule', 'Due Items', 'Not applicable', 'History unknown', 'Actual service date', 'Save service and linked expense', 'Service history']) {
    assert.match(panel, new RegExp(text, 'i'))
  }
  assert.match(detail, /reviseExpenseByLinkage/)
  assert.match(detail, /reviseMyStuffServiceExpenseV3/)
})
