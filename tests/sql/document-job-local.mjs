// Real immutable PostgreSQL storage + IN-MEMORY job protocol double.
// This does not prove atomic database job claim/commit/accounting or production RPCs.
import assert from 'node:assert/strict'
import {writeFileSync,mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {harness,retainedExtraction} from '../helpers/document-job-harness.js'
import {processLeasedJob} from '../../supabase/functions/maintenance-research-worker/worker-core.js'
import {localTemplateStorage} from '../../scripts/local-template-storage.mjs'
const database=process.argv[2], storage=localTemplateStorage(database)
const out='/root/sideflip-release-evidence/document-maintenance-pipeline/retained-ford-quality-pass'
mkdirSync(out,{recursive:true})
const q=x=>"'"+String(x).replaceAll("'","''")+"'"
const sql=(text,ok=true)=>{
  const r=spawnSync('sudo',['-u','postgres','env','-i','PATH=/usr/bin:/bin','psql','-XAtq','-h','/var/run/postgresql','-p','5432','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'],{input:text,encoding:'utf8',maxBuffer:16*1024*1024})
  assert.equal(r.status===0,ok,r.stderr);return r.stdout.trim()
}
const tables=JSON.parse(sql("select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and tablename<>'manufacturer_template_versions'"))
const snapshot=()=>Object.fromEntries(tables.map(t=>[t,sql(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from public."${t}" t`)]))
const before=snapshot(),h=harness(storage),owner=h.options.lease.user_id,other='22222222-2222-4222-8222-222222222222'
const first=await processLeasedJob(h.options), replay=await processLeasedJob(h.options)
assert.deepEqual(replay.row,first.row);assert.equal(replay.replayed,true)
assert.equal(h.calls.filter(x=>x==='extract').length,1)
assert.equal(h.calls.filter(x=>x==='commit').length,1)
assert.deepEqual(first.row.record.payload.rules,retainedExtraction().rules)
assert.deepEqual(await storage.read(owner,first.row.id),first.row)
assert.equal(await storage.read(other,first.row.id),null)
assert.equal(await storage.append(owner,first.row.record),first.row.id)
assert.equal(sql(`select count(*) from public.manufacturer_template_versions where template_key=${q(first.row.record.template_key)}`),'1')
const conflict=structuredClone(first.row.record);conflict.payload.rules.pop()
await assert.rejects(storage.append(owner,conflict))
const promoted=structuredClone(first.row.record);promoted.version=2;promoted.status='reviewed';promoted.applicability_reviewed=true
await assert.rejects(storage.append(owner,promoted))
for(const role of ['anon','authenticated']) {
  sql(`set role ${role};set request.jwt.claim.sub=${q(owner)};select public.store_manufacturer_template_version(${q(owner)}::uuid,${q(JSON.stringify(first.row.record))}::jsonb)`,false)
  sql(`set role ${role};update public.manufacturer_template_versions set status='reviewed' where id=${q(first.row.id)}::uuid`,false)
}
sql(`update public.manufacturer_template_versions set status='reviewed' where id=${q(first.row.id)}::uuid`,false)
// A real SQL append with a lost acknowledgement must not cause an automatic
// second append or extraction. Recovering/linking this orphan requires a future
// atomic job+template RPC, not a fabricated success in the test double.
let appendCalls=0
const uncertainStorage={...storage,append:async(...args)=>{appendCalls++;await storage.append(...args);throw Error('lost SQL append response')}}
const interrupted=harness(uncertainStorage)
interrupted.options.lease.id='88888888-8888-4888-8888-888888888888'
await assert.rejects(processLeasedJob(interrupted.options))
await assert.rejects(processLeasedJob(interrupted.options))
assert.equal(appendCalls,1);assert.equal(interrupted.calls.filter(x=>x==='extract').length,1)
assert.equal(interrupted.state.state,'failed')
assert.equal(sql(`select count(*) from public.manufacturer_template_versions where template_key='document-job:88888888-8888-4888-8888-888888888888'`),'1')
assert.deepEqual(await storage.read(owner,first.row.id),first.row)
assert.equal(sql("select count(*) from public.manufacturer_template_versions where schema_version='manufacturer-template-v2' and status='reviewed'"),'0')
assert.deepEqual(snapshot(),before)
writeFileSync(out+'/document-job-sql-owner-readback.json',JSON.stringify({fixtureType:'retained genuine Ford output; offline injected extractor; in-memory job double and real disposable SQL template storage',row:first.row},null,2))
const summary={result:'PASS',database,newProviderCalls:0,extractionInvocations:h.calls.filter(x=>x==='extract').length,successfulJobRows:1,uncertainAppendRows:1,uncertainAppendAttempts:appendCalls,preservedPublicTables:tables.length,ownerReadback:true,otherOwnerDenied:true,immutableReplay:true,conflictingReplayDenied:true,reviewedPromotionDenied:true,directTamperDenied:true,sourceSha256:first.row.record.source_sha256,jobProtocol:'in-memory contract double; not SQL job RPC',sqlStorage:'real append and authenticated readback'}
writeFileSync(out+'/document-job-sql-verification.json',JSON.stringify(summary,null,2))
console.log(JSON.stringify(summary))
