import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('My Stuff core pages are all reachable from authenticated routing', () => {
  const app = source('src/App.jsx')
  assert.match(app, /import\('\.\/pages\/MyStuffCreate'\)/)
  assert.match(app, /import\('\.\/pages\/MyStuffDetail'\)/)
  assert.match(app, /<Route path="\/my-stuff\/new" element=\{<MyStuffCreate \/>\}/)
  assert.match(app, /<Route path="\/my-stuff\/:id" element=\{<MyStuffDetail \/>\}/)
  assert.match(app, /\/my-stuff\/new.*my_stuff_create/)
  assert.match(app, /\/my-stuff\/[^/]+.*my_stuff_detail/)
})

test('My Stuff detail reaches Android maintenance, VIN, research, reminder, and report workflows', () => {
  const detail = source('src/pages/MyStuffDetail.jsx')
  for (const hook of ['MyStuffVinDecodePanel', 'ManufacturerMaintenanceResearch', 'MyStuffMaintenancePanel', 'PrivateReportPanel']) {
    assert.match(detail, new RegExp(hook), `${hook} must be rendered from My Stuff detail`)
  }
  const maintenance = source('src/components/MyStuffMaintenancePanel.jsx')
  assert.match(maintenance, /createDefinition/)
  assert.match(maintenance, /updateDefinition/)
  assert.match(maintenance, /recordServiceOccurrence/)
  assert.match(maintenance, /MaintenanceReminderPanel/)
})

test('project goal pickers exclude goals locked after a Free downgrade', () => {
  for (const page of ['src/pages/NewProject.jsx', 'src/pages/ProjectDetail.jsx']) {
    const code = source(page)
    assert.match(code, /accessibleActiveGoalsAfterProLoss/)
    assert.match(code, /getPlan\(profile, entitlement\)/)
  }
})
