// Disposable SQL storage gate test. Synthetic contract fixture, NOT AI extraction.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {localTemplateStorage} from '../../scripts/local-template-storage.mjs'
const database=process.argv[2], storage=localTemplateStorage(database)
const owner='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222'
const q=x=>"'"+String(x).replaceAll("'","''")+"'", j=x=>q(JSON.stringify(x))+'::jsonb'
function sql(text,ok=true){const r=spawnSync('sudo',['-u','postgres','env','-i','PATH=/usr/bin:/bin','psql','-XAtq','-h','/var/run/postgresql','-p','5432','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'],{input:text,encoding:'utf8',maxBuffer:16*1024*1024});assert.equal(r.status===0,ok,r.stderr);return r.stdout.trim()}
const tables=JSON.parse(sql("select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and tablename<>'manufacturer_template_versions'"))
const snapshot=()=>Object.fromEntries(tables.map(t=>[t,sql(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from public.\"${t}\" t`)]))
const before=snapshot(), app={year:null,make:null,model:null,engine:null,transmission:null,market:null}
const source={id:'synthetic-storage-contract-only',sha256:'a'.repeat(64),version:null}
const record={template_key:'document-sql-contract',version:1,source_sha256:source.sha256,source_document_id:source.id,source_version:null,source_url:null,source_authenticity:'user_uploaded_unverified',source_authenticity_evidence:null,schema_version:'manufacturer-template-v2',validator_version:'document-maintenance-v2',applicability:app,applicability_reviewed:false,status:'needs_review',validation_report:{passed:true,source_support_checked:false,auto_apply_allowed:false},payload:{schemaVersion:2,source,sourceSha256:source.sha256,applicability:app,rules:[],evidence:[],unresolved:[{reason:'Synthetic SQL contract fixture; not an extraction',evidenceIds:[]}]}}
const append=r=>storage.append(owner,r)
const id=await append(record), first=await storage.read(owner,id)
assert.deepEqual(first.record,record);assert.equal(await append(record),id)
const failure=structuredClone(record);failure.version=2;failure.status='extraction_failed';failure.validation_report.passed=false;failure.validation_report.errors=['explicit offline failure fixture']
const failed=await storage.read(owner,await append(failure));assert.equal(failed.status,'extraction_failed')
assert.deepEqual(await storage.read(owner,id),first)
await assert.rejects(append({...failure,version:1}));await assert.rejects(append({...failure,version:4}))
for(const mutate of [r=>r.source_sha256='b'.repeat(64),r=>r.source_version='wrong',r=>r.payload.source.id='wrong',r=>r.payload.applicability={...r.payload.applicability,year:2020},r=>r.validation_report.auto_apply_allowed=true,r=>{r.status='reviewed';r.applicability_reviewed=true;r.validation_report.source_support_checked=true;r.applicability={...app,year:2020,make:'Ford',model:'F-150'};r.payload.applicability=r.applicability}]){const bad=structuredClone(record);bad.version=3;mutate(bad);await assert.rejects(append(bad))}
assert.equal(await storage.read(other,id),null)
for(const role of ['authenticated','anon']){
 sql(`set role ${role};set request.jwt.claim.sub=${q(owner)};select public.store_manufacturer_template_version(${q(owner)}::uuid,${j(record)});`,false)
 sql(`set role ${role};set request.jwt.claim.sub=${q(owner)};update public.manufacturer_template_versions set status='reviewed' where id=${q(id)}::uuid;`,false)
 sql(`set role ${role};set request.jwt.claim.sub=${q(owner)};delete from public.manufacturer_template_versions where id=${q(id)}::uuid;`,false)
}
sql(`update public.manufacturer_template_versions set status='reviewed' where id=${q(id)}::uuid`,false)
sql('set role anon;select * from public.manufacturer_template_versions',false)
assert.equal(sql(`set role authenticated;set request.jwt.claim.sub=${q(owner)};select count(*) from public.find_my_manufacturer_templates(${j(app)}) where template_key='document-sql-contract'`),'0')
assert.equal(sql("select count(*) from public.manufacturer_template_versions where template_key='document-sql-contract'"),'2')
await import('./document-maintenance-source-local.mjs')
assert.equal(sql("select count(*) from public.manufacturer_template_versions where template_key='ford-offline-source-storage'"),'4')
assert.equal(sql("select count(*) from public.manufacturer_template_versions where template_key='concurrent-scripted-failure'"),'1')
assert.equal(sql("select count(*) from public.manufacturer_template_versions where schema_version='manufacturer-template-v2' and status='reviewed'"),'0')
assert.deepEqual(snapshot(),before)
writeFileSync('/root/sideflip-release-evidence/document-maintenance-pipeline/sql-owner-readback.json',JSON.stringify({fixtureType:'synthetic SQL contract only; not source extraction',rows:[first,failed]},null,2))
console.log(JSON.stringify({result:'PASS',fixtureType:'synthetic SQL contract only',immutableVersions:2,ownerIsolation:true,directTamperDenied:true,reviewedPromotionDenied:true,sourceMetadataBinding:true,preservedPublicTables:tables.length,nativePayloadPath:'row.record.payload'}))
