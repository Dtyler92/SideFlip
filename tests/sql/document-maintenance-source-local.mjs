// Offline, deliberately single-page diagnostic; NOT complete Ford extraction or live AI.
import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
import {readDocumentBundle} from '../../supabase/functions/_shared/document-maintenance.js'
import {ingestDocumentMaintenance} from '../../supabase/functions/_shared/document-maintenance-ingestion.js'
import {localTemplateStorage} from '../../scripts/local-template-storage.mjs'
const storage=localTemplateStorage(process.argv[2]), ownerId='11111111-1111-4111-8111-111111111111'
const bundle=await readDocumentBundle('/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf','561')
const evidence=[{id:'oil',pdfPage:561,quote:'When the oil change message appears in',role:'row'},...bundle.contextSignals.map((s,i)=>({id:'context-'+i,pdfPage:s.pdfPage,quote:s.quote,role:'note'}))]
const extraction={schemaVersion:2,sourceSha256:bundle.sourceSha256,evidence,rules:[{id:'oil-monitor',service:'Engine oil',action:'replace',condition:{op:'always'},timing:{kind:'monitor',mode:'vehicle_monitor',instruction:'Review the oil-change message and surrounding source context; partial offline diagnostic only.'},evidenceIds:['oil'],relatedEvidenceIds:[],overrides:[]}],ownerQuestions:[],unresolved:evidence.map(e=>({reason:'Partial offline fixture; independent semantic/context review required',evidenceIds:[e.id]})),coverage:[{pdfPage:561,disposition:'needs_review',evidenceIds:evidence.map(e=>e.id)}]}
const input={extraction,bundle,templateKey:'ford-offline-source-storage',version:1,ownerId,storage}
assert.equal((await ingestDocumentMaintenance(input)).persisted,false)
const first=(await ingestDocumentMaintenance({...input,dryRun:false})).row
const {spawnSync}=await import('node:child_process')
const responsePath='/root/sideflip-release-evidence/document-maintenance-pipeline/storage-offline-response.json'
writeFileSync(responsePath,JSON.stringify(extraction,null,2))
for(const extra of [[],['--write','--local-db',process.argv[2],'--owner',ownerId]]) {
 const cli=spawnSync(process.execPath,['--experimental-default-type=module',new URL('../../scripts/import-document-maintenance.mjs',import.meta.url).pathname,'--pdf','/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf','--pages','561','--response',responsePath,'--template-key',input.templateKey,...extra],{encoding:'utf8',maxBuffer:8*1024*1024})
 assert.equal(cli.status,0,cli.stderr)
 const out=JSON.parse(cli.stdout);assert.equal(out.persisted,extra.length>0)
 if(out.persisted)assert.equal(out.row.id,first.id)
}
assert.deepEqual(first.record.payload.rules,extraction.rules)
assert.equal(first.record.source_sha256,bundle.sourceSha256)
assert.equal(first.status,'needs_review')
const second=(await ingestDocumentMaintenance({...input,version:2,dryRun:false})).row
assert.deepEqual(await storage.read(ownerId,first.id),first)
assert.equal(second.version,2)
const bad=structuredClone(extraction);bad.evidence[0].quote='Fabricated quote that does not exist in Ford source'
await assert.rejects(ingestDocumentMaintenance({...input,extraction:bad,version:3,dryRun:false}),/Unbound source quote/)
await assert.rejects(ingestDocumentMaintenance({...input,bundle:structuredClone(bundle),version:3,dryRun:false}),/Untrusted source bundle/)
assert.equal(await storage.read('22222222-2222-4222-8222-222222222222',first.id),null)
// Automatic failure: missing context, never save provider strings/IDs or rules.
const missing=structuredClone(extraction);missing.unresolved=[];missing.rules[0].id='PRIVATE_OWNER_TOKEN';missing.rules[0].service='PRIVATE_OWNER_TOKEN'
const failed=(await ingestDocumentMaintenance({...input,extraction:missing,version:3,dryRun:false})).row
assert.equal(failed.status,'extraction_failed')
assert.equal(failed.record.validation_report.passed,false)
assert.equal(failed.record.validation_report.auto_apply_allowed,false)
assert.deepEqual(failed.record.payload.rules,[])
assert.ok(!JSON.stringify(failed).includes('PRIVATE_OWNER_TOKEN'))
assert.equal((await ingestDocumentMaintenance({...input,extraction:missing,version:3,dryRun:false})).row.id,failed.id)
const malformed=(await ingestDocumentMaintenance({...input,extraction:null,version:4,dryRun:false})).row
assert.equal(malformed.status,'extraction_failed')
assert.deepEqual(await storage.read(ownerId,first.id),first)
assert.deepEqual(await storage.read(ownerId,second.id),second)
assert.equal(await storage.read('22222222-2222-4222-8222-222222222222',failed.id),null)
await assert.rejects(ingestDocumentMaintenance({...input,extraction,version:3,dryRun:false}))
await assert.rejects(ingestDocumentMaintenance({...input,extraction:null,version:6,dryRun:false}))
let writes=0;const noWrites={append:async()=>{writes++;throw Error('must not write')},read:async()=>null}
for(const change of [{bundle:structuredClone(bundle)},{bundle:null},{extraction:{...extraction,sourceSha256:'b'.repeat(64)}},{ownerId:'invalid-private-owner'},{templateKey:'invalid private key'},{version:0}])await assert.rejects(ingestDocumentMaintenance({...input,extraction:null,...change,storage:noWrites,dryRun:false}))
assert.equal(writes,0)
let requested=false
const scripted=(await ingestDocumentMaintenance({...input,templateKey:'scripted-request-failure',version:1,dryRun:false,mode:'offline',transport:async request=>{requested=true;assert.equal(request.document,bundle);assert.equal(request.stage,'document_rule_extraction');return '{PRIVATE_OWNER_TOKEN invalid JSON'}})).row
assert.equal(requested,true);assert.equal(scripted.status,'extraction_failed');assert.ok(!JSON.stringify(scripted).includes('PRIVATE_OWNER_TOKEN'))
let appends=0
await assert.rejects(ingestDocumentMaintenance({...input,dryRun:false,storage:{append:async()=>{appends++;throw Error('PRIVATE_OWNER_TOKEN')},read:async()=>null}}),e=>!e.message.includes('PRIVATE_OWNER_TOKEN'))
assert.equal(appends,1)
const invalidPath='/root/sideflip-release-evidence/document-maintenance-pipeline/storage-invalid-response.txt'
writeFileSync(invalidPath,'{PRIVATE_OWNER_TOKEN invalid JSON')
const cliArgs=['--experimental-default-type=module',new URL('../../scripts/import-document-maintenance.mjs',import.meta.url).pathname,'--pdf','/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf','--pages','561','--response',invalidPath,'--template-key','concurrent-scripted-failure']
const dry=spawnSync(process.execPath,cliArgs,{encoding:'utf8'});assert.equal(dry.status,0,dry.stderr);assert.equal(JSON.parse(dry.stdout).persisted,false);assert.equal(JSON.parse(dry.stdout).record.status,'extraction_failed')
const {spawn}=await import('node:child_process')
const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[...cliArgs,'--write','--local-db',process.argv[2],'--owner',ownerId]);let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',code=>{try{assert.equal(code,0,err);resolve(JSON.parse(out))}catch(e){reject(e)}})})
const concurrent=await Promise.all([run(),run()]);assert.equal(concurrent[0].row.id,concurrent[1].row.id)
assert.deepEqual(await storage.read(ownerId,concurrent[0].row.id),concurrent[0].row)
const unavailable=spawnSync(process.execPath,[...cliArgs.map(x=>x.endsWith('2020-Ford-F-150-Owners-Manual.pdf')?'/missing/PRIVATE_OWNER_TOKEN.pdf':x)],{encoding:'utf8'})
assert.equal(unavailable.status,1);assert.match(unavailable.stderr,/DOCUMENT_UNAVAILABLE/);assert.ok(!unavailable.stderr.includes('PRIVATE_OWNER_TOKEN'))
writeFileSync('/root/sideflip-release-evidence/document-maintenance-pipeline/failure-owner-readback.json',JSON.stringify({fixtureType:'actual PDF with scripted invalid extraction; no live AI',rows:[failed,malformed,scripted,concurrent[0].row]},null,2))
console.log(JSON.stringify({result:'PASS',automaticFailurePersistence:true,sanitizedErrors:true,scriptedRequestValidation:true,concurrentFailureReplay:true,unavailableDocumentNoFakeIdentity:true,uncertainWriteNotRetried:true}))
writeFileSync('/root/sideflip-release-evidence/document-maintenance-pipeline/source-owner-readback.json',JSON.stringify({fixtureType:'single-page offline Ford diagnostic, not full extraction or live AI',rows:[first,second]},null,2))
console.log(JSON.stringify({result:'PASS',originalPdfRead:true,sharedValidation:true,actualServiceRpc:true,authenticatedOwnerReadback:true,immutableVersions:2,invalidQuoteRejected:true,forgedBundleRejected:true,sourceSha256:bundle.sourceSha256}))
