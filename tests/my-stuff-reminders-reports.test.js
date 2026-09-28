import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  classifyMaintenanceReminder,
  createBrowserMaintenanceReminderRuntime,
  dueStateLabel,
  visibleMaintenanceReminders,
} from '../src/myStuff/reminders.js'
import {
  REPORT_DISCLAIMER,
  createReportDataClient,
  createReportRequestGate,
  renderCanonicalReportHtml,
} from '../src/myStuff/reports.js'

const UUID = '123e4567-e89b-42d3-a456-426614174000'
const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  headers: { get: name => name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(JSON.stringify(body))) : null },
  text: async () => JSON.stringify(body),
})

test('calendar and meter reminders classify due and overdue without timezone drift', () => {
  const now = new Date(2026, 8, 8, 23, 30)
  assert.equal(classifyMaintenanceReminder({ tracking_type: 'calendar', next_due_at: '2026-09-08T00:00:00Z' }, {}, now), 'due')
  assert.equal(classifyMaintenanceReminder({ tracking_type: 'calendar', next_due_at: '2026-09-07' }, {}, now), 'overdue')
  assert.equal(classifyMaintenanceReminder({ tracking_type: 'mileage', next_due_value: 12000 }, { currentUsage: { miles: 12000 } }, now), 'due')
  assert.equal(classifyMaintenanceReminder({ tracking_type: 'hours', next_due_value: 250 }, { current_hours: 251 }, now), 'overdue')
  assert.equal(classifyMaintenanceReminder({ tracking_type: 'mileage', next_due_value: 12000 }, { currentUsage: { miles: 11999 } }, now), 'upcoming')
  assert.equal(classifyMaintenanceReminder({ due_status: 'due_now', next_due_mileage: 12000 }, { measurements: ['miles'], currentUsage: { miles: 12000 } }, now), 'due')
  assert.equal(classifyMaintenanceReminder({ due_status: 'overdue', next_due_hours: 250 }, { measurements: ['hours'], currentUsage: { hours: 251 } }, now), 'overdue')
  assert.equal(classifyMaintenanceReminder({ due_status: 'overdue', next_due_hours: 250 }, { measurements: [], currentUsage: {} }, now), 'unknown')
  assert.equal(classifyMaintenanceReminder({ tracking_type: 'cycles', next_due_value: 10 }, { currentUsage:{ cycles:11 } }, now), 'overdue')
  assert.equal(classifyMaintenanceReminder({ due_semantics:'whichever_first', normal_interval_miles:5000, normal_calendar_months:6, next_due_mileage:null, next_due_date:'2026-09-08' }, { measurements:['miles'], currentUsage:{ miles:1000 } }, now), 'due')
  assert.equal(classifyMaintenanceReminder({ due_semantics:'all', normal_interval_miles:5000, normal_calendar_months:6, next_due_mileage:null, next_due_date:'2026-09-08' }, { measurements:['miles'], currentUsage:{ miles:1000 } }, now), 'unknown')
  assert.equal(classifyMaintenanceReminder({ due_semantics:'all', normal_interval_cycles:10, normal_calendar_months:6, next_due_cycles:20, next_due_date:'2026-09-08' }, { measurements:['cycles'], currentUsage:{ cycles:20 } }, now), 'due')
  assert.equal(classifyMaintenanceReminder({ due_semantics:'all', normal_interval_cycles:10, normal_calendar_months:6, next_due_cycles:20, next_due_date:'2026-09-07' }, { measurements:['cycles'], currentUsage:{ cycles:20 } }, now), 'due')
  assert.equal(classifyMaintenanceReminder({ due_semantics:'all', configuredAxes:['miles','calendar'], tracking_type:'mileage', next_due_mileage:12000, next_due_date:null }, { currentUsage:{ miles:12000 } }, now), 'unknown')
  assert.equal(dueStateLabel('due'), 'Due now')
})

test('visible reminders fail closed and prioritize overdue work', () => {
  const rows = [
    { id: 'future', enabled: true, tracking_type: 'calendar', next_due_at: '2026-09-10' },
    { id: 'due', enabled: true, tracking_type: 'calendar', next_due_at: '2026-09-08' },
    { id: 'old', enabled: true, tracking_type: 'calendar', next_due_at: '2026-09-01' },
    { id: 'deleted', enabled: true, deleted_at: '2026-09-01', tracking_type: 'calendar', next_due_at: '2026-09-01' },
  ]
  assert.deepEqual(visibleMaintenanceReminders(rows, {}, new Date(2026, 8, 8)).map(row => [row.id, row.dueState]), [['old', 'overdue'], ['due', 'due']])
})

test('browser alerts require explicit opt-in, use item-scoped opaque identities, and cancel on mutations', async () => {
  const values = new Map()
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  const notifications = []
  function NotificationApi(title, options) { const notice = { title, options, closed:false, close(){ this.closed = true } }; notifications.push(notice); return notice }
  NotificationApi.permission = 'default'
  NotificationApi.requestPermission = async () => { NotificationApi.permission = 'granted'; return 'granted' }
  const runtime = createBrowserMaintenanceReminderRuntime({ NotificationApi, storage })
  const schedule = { id: 'private-schedule-id', item_id:'private-item-id', enabled: true, tracking_type: 'calendar', next_due_at: '2026-09-08' }
  const item = { id:'private-item-id', name:'Secret truck', vin:'SECRET' }

  assert.equal((await runtime.notifyIfDue({ schedule, now: new Date(2026, 8, 8) })).status, 'consent-required')
  assert.equal(notifications.length, 0)
  assert.deepEqual(await runtime.requestPermission(), { status: 'granted' })
  assert.equal((await runtime.notifyIfDue({ schedule, item, now: new Date(2026, 8, 8) })).status, 'notified')
  assert.equal(notifications[0].title, 'Maintenance reminder')
  assert.equal(notifications[0].options.body, 'A maintenance task is due in My Stuff.')
  assert.match(notifications[0].options.tag, /^sideflip-maintenance-reminder-[0-9a-f]+$/)
  assert.equal(JSON.stringify(notifications).includes('private-schedule-id'), false)
  assert.equal((await runtime.notifyIfDue({ schedule, now: new Date(2026, 8, 8) })).status, 'already-notified')
  assert.equal((await runtime.cancelSchedule({ itemId:item.id, scheduleId:schedule.id })).status, 'cancelled')
  assert.equal(notifications[0].closed, true)
  assert.equal((await runtime.notifyIfDue({ schedule, item, now: new Date(2026, 8, 8) })).status, 'notified')
  assert.equal((await runtime.cancelItem(item.id)).status, 'cancelled')
  assert.equal(notifications[1].closed, true)
})

test('cancelling a reminder invalidates notification work still awaiting its digest', async () => {
  const values = new Map([['sideflip_maintenance_reminders_opt_in_v1', 'granted']])
  const storage = { getItem:key => values.get(key) ?? null, setItem:(key,value) => values.set(key,value), removeItem:key => values.delete(key) }
  const notifications = []
  function NotificationApi(title, options) { notifications.push({ title, options }) }
  NotificationApi.permission = 'granted'
  let release
  const pending = new Promise(resolve => { release = resolve })
  const cryptoApi = { subtle:{ digest:async () => { await pending; return new Uint8Array(32).buffer } } }
  const runtime = createBrowserMaintenanceReminderRuntime({ NotificationApi, storage, cryptoApi })
  const schedule = { id:'schedule-1', item_id:'item-1', tracking_type:'calendar', next_due_at:'2026-09-08' }
  const notify = runtime.notifyIfDue({ schedule, item:{ id:'item-1' }, now:new Date(2026, 8, 8) })
  const cancel = runtime.cancelSchedule({ itemId:'item-1', scheduleId:'schedule-1' })
  release()
  assert.equal((await notify).status, 'cancelled')
  assert.equal((await cancel).status, 'cancelled')
  assert.equal(notifications.length, 0)
})

test('report client sends explicit private defaults and validates canonical response', async () => {
  const calls = []
  const body = { schemaVersion: 1, subjectType: 'my_stuff_item', subjectId: UUID, disclaimer: 'Private', report: { title: '<Excavator>', nested: { notes: '<script>x</script>' } } }
  const client = createReportDataClient({
    auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) },
    fetchImpl: async (...args) => { calls.push(args); return response(body) },
  })
  assert.deepEqual(await client.load({ subjectType: 'my_stuff_item', subjectId: UUID, options: { includeIdentifiers: true } }), body)
  const request = JSON.parse(calls[0][1].body)
  assert.deepEqual(request, {
    subjectType: 'my_stuff_item', subjectId: UUID, disclaimer: REPORT_DISCLAIMER,
    includeIdentifiers: true, includeDetailedCosts: false, includePhotos: false, includeDocuments: false,
  })
  assert.equal(calls[0][0], '/api/report-data')
})

test('report client fails closed on auth, malformed IDs, oversized and invalid canonical data', async () => {
  const noAuth = createReportDataClient({ auth: { getSession: async () => ({ data: { session: null } }) }, fetchImpl: async () => { throw new Error('must not run') } })
  await assert.rejects(noAuth.load({ subjectType: 'project', subjectId: UUID }), error => error.code === 'AUTH_REQUIRED')
  await assert.rejects(noAuth.load({ subjectType: 'project', subjectId: 'not-an-id' }), error => error.code === 'SUBJECT_ID_INVALID')

  const auth = { getSession: async () => ({ data: { session: { access_token: 'token' } } }) }
  const invalid = createReportDataClient({ auth, fetchImpl: async () => response({ schemaVersion: 1, subjectType: 'project', subjectId: UUID, disclaimer: 'ok', report: [] }) })
  await assert.rejects(invalid.load({ subjectType: 'project', subjectId: UUID }), error => error.code === 'INVALID_RESPONSE')
  const oversized = createReportDataClient({ auth, maxResponseBytes: 10, fetchImpl: async () => response({ value: 'too large' }) })
  await assert.rejects(oversized.load({ subjectType: 'project', subjectId: UUID }), error => error.code === 'INVALID_RESPONSE')
})

test('canonical report HTML escapes private values and includes report date and disclosure', () => {
  const html = renderCanonicalReportHtml({ subjectType: 'my_stuff_item', disclaimer: 'Verify <details>', report: { name: '<Excavator>', notes: '<script>x</script>', history: [{ task: 'Oil & filter' }] } }, { generatedAt: '2026-09-08T12:00:00Z' })
  assert.match(html, /SideFlip My Stuff Report/)
  assert.match(html, /Report date: September 8, 2026/)
  assert.match(html, /&lt;Excavator&gt;/)
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>x<\/script>/)
})

test('request gate invalidates superseded report work and reusable panels remain integration-ready', () => {
  const gate = createReportRequestGate()
  const first = gate.begin('project')
  const second = gate.begin('my_stuff_item')
  assert.equal(first.controller.signal.aborted, true)
  assert.equal(gate.isCurrent(first), false)
  assert.equal(gate.isCurrent(second), true)
  assert.equal(gate.isCurrent(second, 'different-subject-or-options'), false)
  assert.equal(gate.finish(second), true)

  const reportPanel = readFileSync(new URL('../src/components/PrivateReportPanel.jsx', import.meta.url), 'utf8')
  const projectReportPanel = readFileSync(new URL('../src/components/ProjectReportPanel.jsx', import.meta.url), 'utf8')
  const reminderPanel = readFileSync(new URL('../src/components/MaintenanceReminderPanel.jsx', import.meta.url), 'utf8')
  assert.match(reportPanel, /subjectType/)
  assert.match(reportPanel, /function toggleOption[\s\S]*gate\.current\.invalidate\(\)/)
  assert.match(reportPanel, /useEffect\([\s\S]*gate\.current\.invalidate\(\)[\s\S]*setHtml\(''\)[\s\S]*\[subjectType, subjectId\]/)
  assert.match(projectReportPanel, /PrivateReportPanel/)
  assert.match(projectReportPanel, /REPORT_SUBJECT_TYPES\.project/)
  assert.match(reportPanel, /aria-expanded/)
  assert.match(reminderPanel, /No background notification guarantee/)
})
