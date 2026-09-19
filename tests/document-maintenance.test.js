import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { readDocumentBundle, validateDocumentExtraction, extractDocumentRules, previewDocumentRules, prepareDocumentReviewRecord, buildDocumentExtractionRequest } from '../supabase/functions/_shared/document-maintenance.js'
import { validateMaintenanceTemplate, selectTemplateRules } from '../supabase/functions/_shared/maintenance-templates.js'
const fordPath='/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf'
const scionPath='/root/sideflip-release-evidence/maintenance-owner-ui/source/2012_Scion_xD_WMG.pdf'
// Offline authored response fixtures test contracts, NOT AI semantic accuracy.
const fixture = bundle => {
  const evidence=bundle.contextSignals.map(s=>({id:s.id,pdfPage:s.pdfPage,quote:s.quote,role:'note'}))
  const p=bundle.pages.find(p=>p.text.trim())
  evidence.push({id:'row',pdfPage:p.pdfPage,quote:p.blocks.find(b=>b.text.trim()).text,role:'row'})
  return {schemaVersion:2,sourceSha256:bundle.sourceSha256,evidence,
    rules:[{id:'sample',service:'offline contract fixture',action:'inspect',condition:{op:'always'},timing:{kind:'recurring',interval:{miles:5000,months:6},anchor:'last_service',trigger:'whichever_first'},evidenceIds:['row'],relatedEvidenceIds:[],overrides:[]}],
    ownerQuestions:[],unresolved:bundle.contextSignals.map(s=>({reason:'Offline fixture: semantic/layout interpretation remains unresolved',evidenceIds:[s.id]})),
    coverage:bundle.pages.map(p=>({pdfPage:p.pdfPage,disposition:'needs_review',evidenceIds:[]}))}
}
let ford
const haveFord=existsSync(fordPath)
test('actual Ford bytes produce bounded geometry bundle including exception pages', {skip:!haveFord}, async()=>{
  ford=await readDocumentBundle(fordPath,'560-573')
  assert.equal(ford.sourceSha256,'fe486194ca101e23b48eca6ca772a845fdac9b1d6f2d73a48f2259ab732d70de')
  assert.equal(ford.pageCount,629);assert.equal(ford.pages.length,14)
  assert.ok(ford.pages.every(p=>p.blocks.every(b=>b.bbox.length===4)))
  assert.match(ford.pages.find(p=>p.pdfPage===572).text,/Exception/i)
  assert.match(ford.pages.find(p=>p.pdfPage===573).text,/climate/i)
  assert.match(ford.pages.find(p=>p.pdfPage===561).text,/500/)
  assert.ok(ford.contextSignals.length>0)
  assert.throws(()=>{ford.pages[0].text='fabricated'},TypeError)
})
test('offline injection validates source support but never promotes review/apply', {skip:!haveFord},async()=>{
  const t=fixture(ford);let calls=0
  const result=await extractDocumentRules(ford,{mode:'offline',transport:async request=>{calls++;assert.equal(request.document,ford);return JSON.stringify(t)}})
  assert.equal(calls,1);assert.equal(result.providerCalled,false)
  assert.deepEqual(result.validation.errors,[]);assert.equal(result.validation.semanticVerified,false)
  assert.ok(previewDocumentRules(t,ford).every(r=>r.selection==='needs_review'&&!r.applicable))
  const record=prepareDocumentReviewRecord(t,ford,{templateKey:'ford-offline-test',version:1})
  assert.equal(record.status,'needs_review');assert.equal(record.applicability_reviewed,false)
  assert.equal(record.source_authenticity,'user_uploaded_unverified')
  await assert.rejects(extractDocumentRules(ford),/Explicit injected/)
})
test('forged source hash, bundle, quote, trust fields, missing scope fail closed', {skip:!haveFord},()=>{
  const mutations=[t=>t.sourceSha256='0'.repeat(64),t=>t.evidence[0].quote='invented maintenance claim',t=>t.semanticVerified=true,t=>t.coverage.pop(),t=>t.unresolved=[],t=>t.rules[0].relatedEvidenceIds=undefined]
  for(const mutate of mutations){const t=fixture(ford);mutate(t);assert.equal(validateDocumentExtraction(t,ford).valid,false)}
  assert.equal(validateDocumentExtraction(fixture(ford),structuredClone(ford)).valid,false)
  assert.throws(()=>buildDocumentExtractionRequest({...ford,verified:true}),/Original PDF/)
})
test('all generic timing variants survive independently; monitor cap/fallback retained', {skip:!haveFord},()=>{
  const t=fixture(ford)
  t.ownerQuestions=[{field:'monitor_failed',type:'boolean',question:'Has the monitor failed?',evidenceIds:['row']}]
  const timings=[
    {kind:'monitor',mode:'vehicle_monitor',instruction:'Offline authored monitor example; needs review',responseWindow:{days:14,miles:500},maximum:{months:12,miles:10000},fallback:{condition:{op:'eq',field:'monitor_failed',value:true},interval:{months:6,miles:5000},anchor:'last_service',trigger:'whichever_first'}},
    {kind:'first_subsequent',first:{months:120,miles:200000},subsequent:{months:60,miles:100000},anchor:'vehicle_origin',trigger:'whichever_first'},
    {kind:'milestones',points:[{miles:5000},{miles:15000}],anchor:'vehicle_origin',trigger:'whichever_first'},
    {kind:'service_relative',service:'engine oil and filter change',every:2,startsAfter:{miles:100000},until:'Accessory drive belt replacement'},
  ]
  for(const timing of timings){t.rules[0].timing=timing;assert.deepEqual(validateDocumentExtraction(t,ford).errors,[])}
  t.rules[0].timing={...timings[0],interval:{miles:7500}}
  assert.equal(validateDocumentExtraction(t,ford).valid,false)
})
test('AND OR unknown conditions, overrides and cycles remain bounded/review-only', {skip:!haveFord},()=>{
  const t=fixture(ford)
  t.ownerQuestions=[{field:'towing',type:'boolean',question:'Primary towing use?',evidenceIds:['row']},{field:'dust',type:'boolean',question:'Primary dusty use?',evidenceIds:['row']}]
  t.rules[0].condition={op:'all',args:[{op:'eq',field:'towing',value:true},{op:'any',args:[{op:'eq',field:'dust',value:true},{op:'not',arg:{op:'eq',field:'dust',value:false}}]}]}
  t.rules.push({...structuredClone(t.rules[0]),id:'special',overrides:['sample']})
  assert.equal(previewDocumentRules(t,ford,{towing:true})[0].conditionResult,'unknown')
  assert.equal(previewDocumentRules(t,ford,{towing:false})[0].conditionResult,false)
  assert.equal(previewDocumentRules(t,ford,{towing:true,dust:true})[0].conditionResult,true)
  t.rules[0].overrides=['special'];assert.equal(validateDocumentExtraction(t,ford).valid,false)
})
test('malformed output rejects without crashes or silent fallback', {skip:!haveFord},async()=>{
  for(const timing of [null,{kind:'recurring',interval:{miles:-1},anchor:'last_service',trigger:'whichever_first'},{kind:'milestones',points:'oops'},{kind:'monitor',mode:'vehicle_monitor',instruction:'x',fallback:null},{kind:'service_relative',service:'oil',every:0,startsAfter:{miles:1},until:'replacement'}]){
    const t=fixture(ford);t.rules[0].timing=timing;assert.equal(validateDocumentExtraction(t,ford).valid,false)
  }
  await assert.rejects(extractDocumentRules(ford,{mode:'offline',transport:async()=>'{broken'}),SyntaxError)
  await assert.rejects(readDocumentBundle(fordPath,'0-20000'))
})
test('actual Scion PDF passes same generic reader without catalog changes', {skip:!existsSync(scionPath)},async()=>{
  const bundle=await readDocumentBundle(scionPath,'1-56')
  assert.equal(bundle.pageCount,56)
  assert.deepEqual(validateDocumentExtraction(fixture(bundle),bundle).errors,[])
  const legacy=JSON.parse(readFileSync(new URL('./fixtures/scion-2012-xd-template.json',import.meta.url),'utf8'))
  assert.equal(validateMaintenanceTemplate(legacy).valid,true)
  assert.ok(selectTemplateRules(legacy,{}).length>0)
  assert.equal(validateMaintenanceTemplate({...legacy,source:{...legacy.source,sha256:ford?.sourceSha256||'0'.repeat(64)}}).valid,false)
})
