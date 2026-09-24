import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('PWA exposes the split My Stuff routes and primary navigation destination', async () => {
  const [app, nav, list] = await Promise.all([read('src/App.jsx'), read('src/components/BottomNav.jsx'), read('src/pages/MyStuff.jsx')])
  assert.match(app, /optionalProductPage\('\.\/pages\/MyStuff\.jsx'/)
  assert.match(app, /path="\/my-stuff" element={<MyStuff \/>}/)
  assert.match(app, /path="\/my-stuff\/new" element={<MyStuffCreate \/>}/)
  assert.match(app, /path="\/my-stuff\/:id" element={<MyStuffDetail \/>}/)
  assert.match(nav, /path: '\/my-stuff', label: 'My Stuff'/)
  assert.match(list, /Free includes one My Stuff item/)
})

test('split PWA selects legacy or V4 contracts from the authoritative rollout RPC', async () => {
  const [client, detail, maintenance] = await Promise.all([
    read('src/myStuff/integrityV4Client.js'), read('src/pages/MyStuffDetail.jsx'), read('src/components/MyStuffMaintenancePanel.jsx'),
  ])
  assert.match(client, /get_my_stuff_integrity_rollout_v4/)
  assert.match(client, /record_my_stuff_current_reading_v4/)
  assert.match(client, /setup_my_stuff_maintenance_preset_v4/)
  assert.match(client, /complete_my_stuff_maintenance_v4/)
  assert.match(client, /get_my_stuff_maintenance_report_v4/)
  assert.match(detail, /integrityRollout\.featureEnabled[\s\S]*recordCurrentReading/)
  assert.match(detail, /recordMyStuffReadingV2/)
  assert.match(maintenance, /integrityRollout\.featureEnabled[\s\S]*setupDefinition/)
  assert.match(maintenance, /recordMyStuffServiceWithExpenseV3/)
})

test('mutation retries retain caller-owned IDs while device telemetry remains separate', async () => {
  const [client, detail, maintenance] = await Promise.all([
    read('src/myStuff/integrityV4Client.js'), read('src/pages/MyStuffDetail.jsx'), read('src/components/MyStuffMaintenancePanel.jsx'),
  ])
  assert.match(client, /p_device_now: new Date\(\)\.toISOString\(\)/)
  assert.match(detail, /mutationIdForPayload\(readingAttempt\.current/)
  assert.match(detail, /mutationIdForPayload\(deletionAttempt\.current/)
  assert.match(maintenance, /mutationIdForPayload\(attempt, integrityRollout\.featureEnabled \? \{ definitionId, completion:filteredCompletion \} : request\)/)
  assert.match(maintenance, /mutationIdForPayload\(attempt, descriptor\)/)
})

test('V4 completion and correction keep service and current readings separate on all axes', async () => {
  const panel = await read('src/components/MyStuffMaintenancePanel.jsx')
  for (const field of ['service_mileage','service_hours','service_cycles','current_mileage','current_hours','current_cycles']) assert.match(panel, new RegExp(field))
  for (const label of ['Service cycles','Current mileage','Current hours','Current cycles']) assert.match(panel, new RegExp(label))
  assert.match(panel, /editCompletion/)
})

test('deletion is V4-gated, PDF-first, typed, confirmed, and status-polled', async () => {
  const [client, detail] = await Promise.all([read('src/myStuff/integrityV4Client.js'), read('src/pages/MyStuffDetail.jsx')])
  assert.match(client, /request_my_stuff_deletion_v4/)
  assert.match(client, /get_my_stuff_deletion_status_v4/)
  assert.match(detail, /Print \/ Save PDF/)
  assert.match(detail, /deleteText !== 'DELETE'/)
  assert.match(detail, /Final confirmation/)
  assert.match(detail, /setInterval\(check, 5000\)/)
})

test('VIN confirmation remains an explicit reviewed action and retired research is not offered', async () => {
  const [vin, detail] = await Promise.all([read('src/components/MyStuffVinDecodePanel.jsx'), read('src/pages/MyStuffDetail.jsx')])
  assert.match(vin, /Unconfirmed editable review/)
  assert.match(vin, /Confirm Vehicle/)
  assert.match(vin, /confirmMyStuffVehicleIdentityV3/)
  assert.match(detail, /Manufacturer maintenance research has been retired/)
  assert.doesNotMatch(detail, /<ManufacturerMaintenanceResearch/)
})

test('common presets and real foreground reminders remain in the rich PWA', async () => {
  const [panel, reminders] = await Promise.all([read('src/components/MyStuffMaintenancePanel.jsx'), read('src/myStuff/reminders.js')])
  assert.match(panel, /MAINTENANCE_PRESET_DISCLAIMER/)
  assert.match(panel, /MAINTENANCE_PRESETS\.map/)
  assert.match(reminders, /new NotificationApi/)
  assert.match(reminders, /notifyIfDue/)
})
