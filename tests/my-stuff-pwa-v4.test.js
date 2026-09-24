import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('PWA exposes My Stuff as an authenticated lazy route and primary navigation destination', async () => {
  const [app, nav, page] = await Promise.all([
    read('src/App.jsx'), read('src/components/BottomNav.jsx'), read('src/pages/MyStuff.jsx'),
  ])
  assert.match(app, /lazy\(\(\) => import\('\.\/pages\/MyStuff'\)\)/)
  assert.match(app, /path="\/my-stuff" element={<MyStuff \/>}/)
  assert.match(nav, /path: '\/my-stuff', label: 'My Stuff'/)
  assert.match(page, /Free includes one My Stuff item/)
})

test('PWA adapter remains compatible before and after the V4 owner cutover', async () => {
  const source = await read('src/myStuff.js')
  assert.match(source, /get_my_stuff_integrity_rollout_v4/)
  assert.match(source, /feature_enabled: false/)
  assert.match(source, /record_my_stuff_current_mileage_v4/)
  assert.match(source, /record_my_stuff_reading_v2/)
  assert.match(source, /setup_my_stuff_maintenance_preset_v4/)
  assert.match(source, /create_my_stuff_custom_task_v3/)
  assert.match(source, /complete_my_stuff_maintenance_v4/)
  assert.match(source, /complete_my_stuff_planned_occurrence_v3/)
  assert.match(source, /get_my_stuff_maintenance_report_v4/)
  assert.match(source, /my_stuff_service_occurrences/)
})

test('PWA sends device telemetry separately and uses stable mutation IDs for V4 writes', async () => {
  const [adapter, page] = await Promise.all([read('src/myStuff.js'), read('src/pages/MyStuff.jsx')])
  assert.match(adapter, /p_device_now: new Date\(\)\.toISOString\(\)/)
  assert.match(page, /createMutationId\('my-stuff-reading'\)/)
  assert.match(page, /createMutationId\('my-stuff-task'\)/)
  assert.match(page, /createMutationId\('my-stuff-complete'\)/)
  assert.match(adapter, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/)
})

test('PWA uses the leased deletion saga only after V4 is enabled', async () => {
  const [adapter, page] = await Promise.all([read('src/myStuff.js'), read('src/pages/MyStuff.jsx')])
  assert.match(adapter, /request_my_stuff_deletion_v4/)
  assert.match(adapter, /p_object_type: 'item'/)
  assert.match(page, /deleteText !== 'DELETE'/)
  assert.match(page, /final confirmation/)
  assert.match(page, /Deletion is queued/)
  assert.match(page, /getMyStuffDeletionStatus/)
})

test('My Stuff VIN decoding is authenticated, disclosed, and confirmed through the owner RPC', async () => {
  const [adapter, page] = await Promise.all([read('src/myStuff.js'), read('src/pages/MyStuff.jsx')])
  assert.match(adapter, /Authorization: `Bearer \$\{token\}`/)
  assert.match(adapter, /subjectType: 'my_stuff_item'/)
  assert.match(adapter, /confirm_my_stuff_vehicle_identity_v3/)
  assert.match(page, /National Highway Traffic Safety Administration’s vPIC service/)
  assert.match(page, /Review decoded details before confirming/)
  assert.match(page, /Confirm details/)
  assert.match(page, /decodeMyStuffVin/)
  assert.match(page, /confirmMyStuffVin/)
})

test('maintenance corrections expose service and current readings on every supported axis', async () => {
  const [adapter, page] = await Promise.all([read('src/myStuff.js'), read('src/pages/MyStuff.jsx')])
  for (const field of ['current_mileage', 'current_hours', 'current_cycles']) assert.match(adapter, new RegExp(field))
  for (const label of ['Service cycles', 'Current mileage', 'Current hours', 'Current cycles']) assert.match(page, new RegExp(label))
})

test('reminders send a foreground notification and deletion offers PDF-first export', async () => {
  const page = await read('src/pages/MyStuff.jsx')
  assert.match(page, /new Notification\('SideFlip maintenance reminder'/)
  assert.match(page, /Reminders work while SideFlip is open/)
  assert.match(page, /Print \/ Save PDF/)
  assert.match(page, /reportWindow\.print\(\)/)
})
