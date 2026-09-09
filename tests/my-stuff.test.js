import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import {
  ITEM_TYPE_OPTIONS, deriveItemCategory, getItemCategoryContract,
  requiresUsageAndPurchase, selectItemType, toggleItemMeasurementDraft, validateItemDraft,
} from '../src/myStuff/itemModel.js'
import { adaptItemDraftToSql, adaptItemPatchToSql, adaptSqlItem } from '../src/myStuff/adapters.js'
import {
  buildCreateMyStuffItemV2WirePayload, buildUpdateMyStuffItemV2WirePayload,
  buildRecordMyStuffReadingV2WirePayload,
} from '../src/myStuff/payloads.js'
import { canCreateMyStuffItem, createMutationAttemptState, mutationIdForPayload, resetMutationAttemptState } from '../src/myStuff/mutation.js'
import { excludeTransferredItems } from '../src/myStuff/transferVisibility.js'
import { buildExpenseDraft, normalizeExpenseRows } from '../src/myStuff/v3Model.js'
import { createMyStuffClient, createMyStuffV3Client } from '../src/myStuff/client.js'

const EXACT_TYPES = ['car','truck','motorcycle','boat','airplane','atv','side_by_side','mower','tractor','trailer','generator','rv','equipment','bicycle','watch','electronics','gaming','tool','exercise','instrument','furniture','house','other']
const source = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
const migrationSql = () => {
  const directory = new URL('../supabase/migrations/', import.meta.url)
  return readdirSync(directory).filter(name => name.endsWith('.sql')).sort().map(name => readFileSync(new URL(name, directory), 'utf8')).join('\n')
}

test('exact 23 item types derive their backend category contract', () => {
  assert.deepEqual(ITEM_TYPE_OPTIONS.map(value => value.value), EXACT_TYPES)
  assert.equal(ITEM_TYPE_OPTIONS.length, 23)
  for (const itemType of EXACT_TYPES) {
    const draft = selectItemType({ name:'Owned item', measurements:[] }, itemType)
    assert.equal(draft.category, deriveItemCategory(itemType))
    assert.equal(adaptItemDraftToSql(draft).item_type, itemType)
    assert.equal(adaptSqlItem({ item_type:itemType }).category, draft.category)
    assert.ok(getItemCategoryContract(draft.category))
  }
})

test('ownership validation requires identity, usage and purchase fields by exact type', () => {
  const truck = selectItemType({ name:'Truck', measurements:[] }, 'truck')
  assert.equal(requiresUsageAndPurchase('truck'), true)
  const missing = validateItemDraft(truck, { requireOwnershipFields:true })
  assert.match(missing.errors.measurements, /at least one/i)
  assert.match(missing.errors.purchasePrice, /required/i)
  assert.equal(validateItemDraft({ ...truck, measurements:['miles'], currentUsage:{miles:0}, purchasePrice:'12500.25', acquiredOn:'2026-09-01' }, { requireOwnershipFields:true }).ok, true)
  const furniture = selectItemType({ name:'Desk', measurements:['hours'], currentUsage:{hours:2} }, 'furniture')
  assert.deepEqual(furniture.measurements, ['hours'])
  const removed = toggleItemMeasurementDraft(furniture, 'hours')
  assert.deepEqual(removed.currentUsage, {})
})

test('leaving a VIN-capable type clears hidden automotive identity', () => {
  const vinIdentity = {
    vin:'1HGCM82633A004352', trim:'EX', series:'Accord', manufacturer:'Honda',
    vehicleType:'Passenger Car', bodyStyle:'Sedan', plantName:'Marysville',
    plantCountry:'United States', vehicleMarket:'US', engineModel:'J30A4',
    engineDisplacementLiters:3, engineCylinders:6, transmission:'Automatic',
    drivetrain:'FWD',
  }
  const next = selectItemType({ ...vinIdentity, itemType:'motorcycle', category:'motorcycle', measurements:['miles'] }, 'boat')
  for (const field of Object.keys(vinIdentity)) assert.equal(next[field], '', `${field} should be cleared`)
  assert.equal(next.itemType, 'boat')
  assert.equal(next.category, 'boat')
})

test('adapters preserve rich identity, ownership, acquisition and purchase fields while patches exclude readings', () => {
  const values = { name:' Truck ', itemType:'truck', category:'vehicle', year:'2021', make:' Ford ', model:'F-150', trim:'XLT', modelNumber:' M1 ', serialNumber:' S1 ', vin:'VIN', engine:'V6', transmission:'Auto', drivetrain:'4WD', fuelType:'Gas', acquiredOn:'2026-09-01', manufacturedOn:'2021-01-01', inServiceOn:'2021-02-01', purchasePrice:'25000.50', purchaseCurrency:'usd', purchaseVendor:'Dealer', usageProfile:'severe', measurements:['miles','hours'], currentUsage:{miles:12000,hours:50}, notes:' kept ' }
  const row = adaptItemDraftToSql(values)
  assert.equal(row.model_year, 2021)
  assert.equal(row.purchase_price, 25000.5)
  assert.equal(row.purchase_currency, 'USD')
  assert.equal(row.current_mileage, 12000)
  assert.equal(row.origin_hours, 50)
  const patch = adaptItemPatchToSql(values)
  assert.equal(patch.current_mileage, undefined)
  assert.equal(patch.name, 'Truck')
})

test('stable mutation IDs survive equivalent retry payloads and reset after success', () => {
  const state = createMutationAttemptState()
  let sequence = 0
  const generate = () => `mutation-${++sequence}`
  const first = buildCreateMyStuffItemV2WirePayload({ name:' Truck ', itemType:'truck', category:'vehicle' })
  const reordered = { p_item:{ category:'vehicle', item_type:'truck', name:'Truck' } }
  assert.equal(mutationIdForPayload(state, first, generate), 'mutation-1')
  assert.equal(mutationIdForPayload(state, reordered, generate), 'mutation-1')
  assert.equal(mutationIdForPayload(state, buildCreateMyStuffItemV2WirePayload({ name:'Other', itemType:'truck', category:'vehicle' }), generate), 'mutation-2')
  resetMutationAttemptState(state)
  assert.equal(mutationIdForPayload(state, first, generate), 'mutation-3')
})

test('V2 wire payloads use exact RPC names and canonical SQL fields', async () => {
  const calls=[]
  const database={rpc:async(name,payload)=>{calls.push({name,payload});return {data:'result',error:null}}}
  const api=createMyStuffClient(database)
  const createPayload=buildCreateMyStuffItemV2WirePayload({name:'Truck',itemType:'truck',category:'vehicle'})
  const updatePayload=buildUpdateMyStuffItemV2WirePayload({itemId:'item-1',name:'Truck'})
  const readingPayload=buildRecordMyStuffReadingV2WirePayload({itemId:'item-1',readingType:'miles',value:12,recordedAt:'2026-09-01T12:00:00.000Z'})
  await api.createItemV2(createPayload,'m1'); await api.updateItemV2(updatePayload,'m2'); await api.setArchivedV2({itemId:'item-1',archived:true,reason:'Stored',mutationId:'m3'}); await api.recordReadingV2(readingPayload,'m4')
  assert.deepEqual(calls, [
    {name:'create_my_stuff_item_v2',payload:{...createPayload,p_mutation_id:'m1'}},
    {name:'update_my_stuff_item_v2',payload:{...updatePayload,p_mutation_id:'m2'}},
    {name:'set_my_stuff_item_archived_v2',payload:{p_item_id:'item-1',p_archived:true,p_reason:'Stored',p_mutation_id:'m3'}},
    {name:'record_my_stuff_reading_v2',payload:{...readingPayload,p_mutation_id:'m4'}},
  ])
})

test('My Stuff list uses the server summary contract and preserves downgrade/filter state', async () => {
  const calls=[]
  const database={rpc:async(name,payload)=>{
    calls.push({name,payload})
    return {data:[{id:'newer',name:'Truck',item_type:'truck',is_locked:true}],error:null}
  }}
  const items=await createMyStuffClient(database).listItems('user-1',{includeArchived:false,excludeTransferred:true})
  assert.deepEqual(calls,[{name:'list_my_stuff_items_v4',payload:{p_include_archived:false,p_exclude_transferred:true}}])
  assert.equal(items[0].isLocked,true)
  assert.equal(items[0].itemType,'truck')
})

test('V3 expense and both transfer wrappers use exact RPC contracts', async () => {
  const calls=[]
  const api=createMyStuffV3Client({rpc:async(name,payload)=>{calls.push({name,payload});return {data:name==='get_my_stuff_expenses_v3'?[]:{ok:true},error:null}}})
  await api.createExpense('item-1',{amount:12},'m1'); await api.reviseExpense('expense-1',{amount:13},'Correction','m2'); await api.voidExpense('expense-1','Duplicate','m3'); await api.getExpenses('item-1'); await api.getFinancialSummary('item-1'); await api.transferProject('project-1',{currentMileage:100,serviceExpenseIds:['e1']},'m4'); await api.transferItemToProject('item-1','m5')
  assert.deepEqual(calls, [
    {name:'create_my_stuff_expense_v3',payload:{p_item_id:'item-1',p_expense:{amount:12},p_mutation_id:'m1'}},
    {name:'revise_my_stuff_expense_v3',payload:{p_expense_id:'expense-1',p_patch:{amount:13},p_reason:'Correction',p_mutation_id:'m2'}},
    {name:'void_my_stuff_expense_v3',payload:{p_expense_id:'expense-1',p_reason:'Duplicate',p_mutation_id:'m3'}},
    {name:'get_my_stuff_expenses_v3',payload:{p_item_id:'item-1'}},
    {name:'get_my_stuff_financial_summary_v3',payload:{p_item_id:'item-1'}},
    {name:'transfer_project_to_my_stuff_v3',payload:{p_project_id:'project-1',p_options:{current_mileage:100,service_expense_ids:['e1']},p_mutation_id:'m4'}},
    {name:'transfer_my_stuff_to_project_v1',payload:{p_item_id:'item-1',p_mutation_id:'m5'}},
  ])
})

test('client RPC names and argument order match repository migrations', () => {
  const sql = migrationSql()
  const signatures = [
    'create_my_stuff_item_v2\\(p_item jsonb,p_mutation_id text\\)',
    'update_my_stuff_item_v2\\(p_item_id uuid,p_patch jsonb,p_mutation_id text\\)',
    'set_my_stuff_item_archived_v2\\(p_item_id uuid,p_archived boolean,p_reason text,p_mutation_id text\\)',
    'record_my_stuff_reading_v2\\(p_item_id uuid,p_reading_type text,p_value numeric,p_recorded_at timestamptz,p_corrects_reading_id uuid,p_correction_reason text,p_metadata jsonb,p_mutation_id text\\)',
    'create_my_stuff_expense_v3\\(p_item_id uuid,p_expense jsonb,p_mutation_id text\\)',
    'revise_my_stuff_expense_v3\\(p_expense_id uuid,p_patch jsonb,p_reason text,p_mutation_id text\\)',
    'void_my_stuff_expense_v3\\(p_expense_id uuid,p_reason text,p_mutation_id text\\)',
    'get_my_stuff_expenses_v3\\(p_item_id uuid\\)',
    'get_my_stuff_financial_summary_v3\\(p_item_id uuid\\)',
    'transfer_project_to_my_stuff_v3\\(p_project_id uuid,p_options jsonb,p_mutation_id text\\)',
    'transfer_my_stuff_to_project_v1\\(p_item_id uuid,p_mutation_id text\\)',
  ]
  for (const signature of signatures) assert.match(sql, new RegExp(`function\\s+public\\.${signature}`, 'i'))
})

test('expense drafts validate and normalized revisions retain IDs', () => {
  assert.deepEqual(buildExpenseDraft({description:'Oil',category:'maintenance',amount:'45.50',currency:'usd',incurredOn:'2026-09-01'}), {description:'Oil',category:'maintenance',custom_category:null,amount:45.5,currency:'USD',incurred_on:'2026-09-01',vendor:null,mileage:null,hours:null,notes:null})
  assert.equal(normalizeExpenseRows([{expense_id:'e1',revision_id:'r1',amount:10}])[0].id,'e1')
  assert.throws(()=>buildExpenseDraft({description:'Bad',category:'other',amount:1,incurredOn:'2026-09-01'}),/Custom category/)
})

test('Free presentation gates creation and transferred visibility helper preserves manual archives', () => {
  assert.equal(canCreateMyStuffItem({isPro:false,itemCount:0}),true)
  assert.equal(canCreateMyStuffItem({isPro:false,itemCount:1}),false)
  const existing=[{id:'active'},{id:'archived',archived_at:'2026-01-01'},{id:'moved',archived_at:'2026-01-02'}]
  assert.deepEqual(excludeTransferredItems(existing,[{item_id:'moved'}]),existing.slice(0,2))
})

test('PWA pages are accessible, responsive, expose core lifecycle, and keep attachments unavailable', () => {
  const list=source('src/pages/MyStuff.jsx'), create=source('src/pages/MyStuffCreate.jsx'), detail=source('src/pages/MyStuffDetail.jsx'), css=source('src/pages/myStuff.css')
  assert.match(list,/includeArchived:true[\s\S]*excludeTransferred:true/)
  assert.match(list,/Free includes one My Stuff item/)
  assert.doesNotMatch(list,/slice\(0,\s*1\)/)
  for(const label of ['Model year','Make','Model','Serial number','Transmission','Drivetrain','Fuel / power type','Purchase price']) assert.match(create,new RegExp(label,'i'))
  for(const symbol of ['updateMyStuffItemV2','setMyStuffItemArchivedV2','deleteMyStuffItem','recordMyStuffReadingV2','createMyStuffExpenseV3','reviseMyStuffExpenseV3','voidMyStuffExpenseV3','getMyStuffFinancialSummaryV3','transferMyStuffToProjectV1']) assert.match(detail,new RegExp(symbol))
  assert.match(detail,/Attachments are not available/)
  for(const feature of ['ManufacturerMaintenanceResearch','MyStuffMaintenancePanel','PrivateReportPanel']) assert.match(detail,new RegExp(feature))
  assert.doesNotMatch(create,/type="file"/)
  assert.doesNotMatch(detail,/type="file"/)
  assert.match(css,/@media\s*\(min-width:\s*700px\)/)
  assert.match(create,/aria-describedby/)
  assert.match(detail,/role="alert"/)
})
