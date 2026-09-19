// Genuine retained model output versus explicit local correction; disposable SQL only.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {readDocumentBundle,validateDocumentExtraction} from '../../supabase/functions/_shared/document-maintenance.js'
import {ingestDocumentMaintenance} from '../../supabase/functions/_shared/document-maintenance-ingestion.js'
import {localTemplateStorage} from '../../scripts/local-template-storage.mjs'
const out='/root/sideflip-release-evidence/document-maintenance-pipeline/retained-ford-quality-pass'
mkdirSync(out,{recursive:true})
const bundle=await readDocumentBundle('/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf','561')
const fixture=name=>JSON.parse(readFileSync(new URL('../fixtures/'+name,import.meta.url)))
const provenance=fixture('ford-retained-correction-provenance.json')
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222'
const database=process.argv[2],storage=localTemplateStorage(database)
const q=x=>"'"+String(x).replaceAll("'","''")+"'"
const sql=(text,ok=true)=>{const r=spawnSync('sudo',['-u','postgres','env','-i','PATH=/usr/bin:/bin','psql','-XAtq','-h','/var/run/postgresql','-p','5432','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'],{input:text,encoding:'utf8',maxBuffer:16*1024*1024});assert.equal(r.status===0,ok,r.stderr);return r.stdout.trim()}
const tables=JSON.parse(sql("select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and tablename<>'manufacturer_template_versions'"))
const snapshot=()=>Object.fromEntries(tables.map(t=>[t,sql(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from public.\"${t}\" t`)]))
const before=snapshot(),rows=[]
for(const [index,name] of ['ford-retained-live-extraction.json','ford-retained-local-correction.json'].entries()){
 const extraction=fixture(name)
 const {record}=await ingestDocumentMaintenance({extraction,bundle,templateKey:'retained-ford-quality',version:index+1})
 record.validation_report.extraction_provenance=index===0?{kind:'retained_genuine_model_output',newModelCall:false}:{...provenance,newModelCall:false}
 assert.deepEqual(validateDocumentExtraction(extraction,bundle).errors,[])
 const id=await storage.append(owner,record),row=await storage.read(owner,id)
 assert.deepEqual(row.record,record)
 assert.equal(await storage.append(owner,record),id)
 assert.equal(await storage.read(other,id),null)
 assert.equal(row.record.validation_report.auto_apply_allowed,false)
 assert.equal(row.record.validation_report.semanticVerified,false)
 assert.equal(row.record.validation_report.sourceAuthenticated,false)
 assert.equal(row.record.payload.documentBundle.pages[0].printedPage,558)
 rows.push(row)
 const forged=structuredClone(record);forged.version=index+2;forged.status='reviewed';forged.applicability_reviewed=true;forged.validation_report.source_support_checked=true
 await assert.rejects(storage.append(owner,forged))
 for(const role of ['anon','authenticated']){
  sql(`set role ${role};set request.jwt.claim.sub=${q(owner)};select public.store_manufacturer_template_version(${q(owner)}::uuid,${q(JSON.stringify(record))}::jsonb)`,false)
  sql(`set role ${role};update public.manufacturer_template_versions set status='reviewed' where id=${q(id)}::uuid`,false)
 }
}
assert.deepEqual(await storage.read(owner,rows[0].id),rows[0])
const conflict=structuredClone(rows[1].record);conflict.payload.rules.pop();await assert.rejects(storage.append(owner,conflict))
sql(`update public.manufacturer_template_versions set status='reviewed' where id=${q(rows[1].id)}::uuid`,false)
sql('set role anon;select * from public.manufacturer_template_versions',false)
assert.equal(sql("select count(*) from public.manufacturer_template_versions where template_key='retained-ford-quality'"),'2')
assert.equal(sql("select count(*) from public.manufacturer_template_versions where schema_version='manufacturer-template-v2' and status='reviewed'"),'0')
assert.deepEqual(snapshot(),before)
writeFileSync(out+'/sql-owner-readback.json',JSON.stringify({fixtureType:'retained live extraction and explicit local authored correction; no new model call',rows},null,2))
writeFileSync(out+'/corrected-review-record.json',JSON.stringify(rows[1].record,null,2))
writeFileSync(out+'/original-review-record-local-metadata.json',JSON.stringify(rows[0].record,null,2))
const summary={result:'PASS',newModelCalls:0,sourceSha256:bundle.sourceSha256,pdfPage:561,printedPage:558,modelOriginalRules:rows[0].record.payload.rules.length,locallyCorrectedRules:rows[1].record.payload.rules.length,evidenceCount:rows[1].record.payload.evidence.length,ownerQuestions:rows[1].record.payload.ownerQuestions.length,unresolved:rows[1].record.payload.unresolved.length,preservedPublicTables:tables.length,ownerIsolation:true,immutableReplay:true,conflictingReplayRejected:true,reviewedPromotionDenied:true,directTamperDenied:true,sqlOwnerReadback:true}
writeFileSync(out+'/sql-verification.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary))
