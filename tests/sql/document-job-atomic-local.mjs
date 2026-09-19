// Disposable PostgreSQL, separate process/connection for EVERY RPC. Offline retained output only.
import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {writeFileSync,readFileSync} from 'node:fs'
import {retainedBundle,retainedExtraction} from '../helpers/document-job-harness.js'
import {documentJobRpcAdapter} from '../../supabase/functions/maintenance-research-worker/document-job-rpc.js'
import {processLeasedJob} from '../../supabase/functions/maintenance-research-worker/worker-core.js'
import {ingestDocumentMaintenance} from '../../supabase/functions/_shared/document-maintenance-ingestion.js'
import {localTemplateStorage} from '../../scripts/local-template-storage.mjs'
const db=process.argv[2]
assert.match(db,/^sideflip_manufacturer_template_test_[0-9]+$/)
const out='/root/sideflip-release-evidence/document-maintenance-pipeline/retained-ford-quality-pass/review-corrections'
const args=['-u','postgres','env','-i','PATH=/usr/bin:/bin','psql','-XAtq','-h','/var/run/postgresql','-p','5432','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1']
const q=v=>v===null?'null':"'"+String(v).replaceAll("'","''")+"'"
const json=v=>q(JSON.stringify(v))+'::jsonb'
function sql(s,ok=true){const r=spawnSync('sudo',args,{input:s,encoding:'utf8',maxBuffer:16e6});assert.equal(r.status===0,ok,r.stderr);return r.stdout.trim()}
function asyncSql(s){return new Promise((resolve,reject)=>{const p=spawn('sudo',args);let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('close',c=>c?reject(Error(err)):resolve(out.trim()));p.stdin.end(s)})}
const rpcSql=(name,a)=>`select public.${name}(${Object.entries(a).map(([k,v])=>`${k}=>${v!==null&&typeof v==='object'?json(v):q(v)}`).join(',')})`
const client={rpc:async(name,a)=>{try{const raw=await asyncSql('set role service_role;'+rpcSql(name,a));return {data:name==='finalize_document_job_v1'?raw:['fail_document_job_v1','fail_document_job_v2','fail_document_preflight_v1','observe_document_transport_v1'].includes(name)?raw==='t':JSON.parse(raw),error:null}}catch(e){console.error(name,e.message);return {data:null,error:{message:e.message}}}}}
const rpcJobs=documentJobRpcAdapter(client)
// This harness isolates atomic claim/commit/accounting behavior. The transport
// lifecycle is exercised end-to-end by document-dispatch-local.mjs.
const {transport:_transport,transportStatus:_transportStatus,...jobs}=rpcJobs
const storage=localTemplateStorage(db),checks=[]
const check=(name)=>{checks.push(name);console.log('PASS '+name)}
assert.equal(sql('select document_lane_enabled from private.my_stuff_research_runtime_config'),'f')
check('migration default off')
const owner=randomUUID(),other='22222222-2222-4222-8222-222222222222'
sql(`insert into auth.users(id) values(${q(owner)});insert into public.user_entitlements(user_id,source,status,expires_at,last_verified_at) values(${q(owner)},'apple','active',now()+interval '30 days',now());`)
const itemId=sql(`set role authenticated;set request.jwt.claim.sub=${q(owner)};select public.create_my_stuff_item_v2('{"name":"Atomic document fixture","item_type":"car","usage_dimensions":["mileage"],"current_mileage":0,"origin_mileage":0,"purchase_price":1000,"purchase_currency":"USD"}','atomic-item')`)
sql(`set role authenticated;set request.jwt.claim.sub=${q(owner)};select public.confirm_my_stuff_vehicle_identity_v3(${q(itemId)},'{"model_year":2020,"make":"Honda","model":"Civic","engine_model":"L15B7","transmission":"CVT","drivetrain":"FWD","vehicle_market":"US"}','atomic-confirm')`)
const item=JSON.parse(sql(`select to_jsonb(i) from public.my_stuff_items i where id=${q(itemId)}`))
const tables=JSON.parse(sql("select json_agg(tablename order by tablename) from pg_tables where schemaname='public' and tablename<>'manufacturer_template_versions'"))
assert.equal(tables.length,27)
const snapshot=()=>Object.fromEntries(tables.map(t=>[t,sql(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from public."${t}" t ${t==='my_stuff_items'?`where id<>${q(item.id)}`:''}`)]))
const before=snapshot(),ledgerBefore=sql('select coalesce(jsonb_agg(to_jsonb(l) order by id),\'[]\') from private.my_stuff_research_budget_ledger l')
const existingLedger=JSON.parse(ledgerBefore).map(x=>x.id)
const testJobs=[]
async function fixture(enabled=true){
 // Independent scenarios share one owner; retire unfinished prior test work via
 // accounting RPCs rather than bypassing the now-complete active-owner index.
 sql(`do $$declare d private.my_stuff_document_executions;begin
 for d in select e.* from private.my_stuff_document_executions e join private.my_stuff_research_jobs j on j.id=e.job_id where j.user_id=${q(owner)} and e.state in ('ready','attempted') loop
 if d.state='ready' then perform public.fail_document_preflight_v1(d.binding,d.attempt_id);
 else perform public.fail_document_job_v1(d.binding,d.attempt_id,null,'DOCUMENT_ACCOUNTING_UNKNOWN'); end if;
 end loop;end$$;`)
 const id=randomUUID(),token=randomUUID();testJobs.push(id)
 sql(`insert into private.my_stuff_research_jobs(id,user_id,item_id,confirmed_fingerprint,status,request_snapshot,reserved_cents,client_mutation_id,request_hash,policy_version,reservation_month,lease_token,lease_expires_at,lease_owner,attempt_count,state_version)
 values(${q(id)},${q(owner)},${q(item.id)},${q(item.vin_confirmation_fingerprint)},'running','{"modelYear":2020,"make":"Honda","model":"Civic"}',25,${q(id)},repeat('a',64),'research-v2-xai-citations','2026-08-01',${q(token)},now()+interval '5 minutes','offline-fixture',1,1);
 insert into private.my_stuff_research_attempts(job_id,attempt_number,provider,model,retention_policy,status) values(${q(id)},1,'offline','retained-fixture','no-network','running');
 insert into private.my_stuff_research_budget_ledger(job_id,user_id,month_start,kind,cents,attempt_number) values(${q(id)},${q(owner)},'2026-08-01','reservation',25,0);`)
 if(enabled) sql('update private.my_stuff_research_runtime_config set enabled=true,document_lane_enabled=true where singleton')
 if(enabled==='legacy') return {id,token}
 const statement=`set role service_role;select public.prepare_document_job_v1(${q(id)},${q(token)})`
 if(!enabled){sql(statement,false);sql(`update private.my_stuff_research_jobs set status='failed' where id=${q(id)}`);return}
 const b=JSON.parse(sql(statement))
 assert.deepEqual(JSON.parse(sql(statement)),b)
 const lease={id:b.jobId,user_id:b.ownerId,item_id:b.itemId,lease_token:b.leaseToken,confirmed_fingerprint:b.confirmedFingerprint,state_version:b.jobRevision,policy_version:b.policyVersion,reserved_cents:b.reservedCents,reservation_month:b.reservationMonth,request_snapshot:b.requestSnapshot,attempt_count:1,execution_lane:'document_v2'}
 return {b,lease,attemptId:JSON.parse(sql(`set role service_role;select public.read_document_job_v1(${json(b)})`)).attemptId}
}
await fixture(false);check('default-off prepare rejected atomically')
const bundle=await retainedBundle(),source={sourceSha256:bundle.sourceSha256,selectedPages:bundle.selectedPages}
const recordFor=async b=>{const {record}=await ingestDocumentMaintenance({extraction:retainedExtraction(),bundle,templateKey:'document-job:'+b.jobId,version:1,ownerId:owner,dryRun:true});const {leaseToken,...binding}=b;record.validation_report.document_job={...binding,source};return record}
const counts=b=>JSON.parse(sql(`select jsonb_build_object('templates',(select count(*) from public.manufacturer_template_versions where template_key=${q('document-job:'+b.jobId)}),'settlements',(select count(*) from private.my_stuff_research_budget_ledger where job_id=${q(b.jobId)} and kind='settlement'),'releases',(select count(*) from private.my_stuff_research_budget_ledger where job_id=${q(b.jobId)} and kind='release'))`))
const finalArgs=(b,a,r,t=150000001)=>({p_binding:b,p_attempt_id:a,p_record:r,p_cost_ticks:t})
const finalize=(b,a,r,t)=>'set role service_role;'+rpcSql('finalize_document_job_v1',finalArgs(b,a,r,t))
// Multi-connection race through the REAL worker seam. Only acknowledged claim winner invokes offline extractor.
const f=await fixture();let invocations=0
const options={lease:f.lease,config:{documentLaneEnabled:true},documentLane:{jobs,storage,acquireDocument:async()=>bundle,extract:async()=>{invocations++;return {extraction:retainedExtraction(),usage:{costInUsdTicks:150000001}}}}}
const results=await Promise.allSettled(Array.from({length:6},()=>processLeasedJob(options)))
assert.equal(invocations,1,JSON.stringify(results));assert.ok(results.some(x=>x.status==='fulfilled'),JSON.stringify(results))
const success=results.find(x=>x.status==='fulfilled').value
assert.equal((await processLeasedJob(options)).row.id,success.row.id);assert.equal(invocations,1)
assert.deepEqual(counts(f.b),{templates:1,settlements:1,releases:1})
check('six-connection worker claim race: one extraction, append, settlement; read-only replay')
const duplicates=await Promise.all(Array.from({length:5},()=>asyncSql(finalize(f.b,f.attemptId,success.row.record))))
assert.equal(new Set(duplicates).size,1);assert.deepEqual(counts(f.b),{templates:1,settlements:1,releases:1})
check('five concurrent duplicate finalizes return exact version without double settlement')
const changed=structuredClone(success.row.record);changed.payload.rules.pop()
sql(finalize(f.b,f.attemptId,changed),false)
sql(finalize({...f.b,ownerId:other},f.attemptId,success.row.record),false)
sql(finalize({...f.b,jobRevision:99},f.attemptId,success.row.record),false)
sql(finalize(f.b,randomUUID(),success.row.record),false)
sql(finalize(f.b,f.attemptId,success.row.record,150000002),false)
check('record/cost/owner/revision/attempt replay conflicts rejected')
assert.equal(await storage.read(other,success.row.id),null)
const ownerResult=JSON.parse(sql(`set session authorization authenticated;set request.jwt.claim.sub=${q(owner)};select public.get_my_document_job_result_v1(${q(f.b.jobId)})`))
assert.equal(ownerResult.templateId,success.row.id);assert.deepEqual(ownerResult.record,success.row.record)
assert.equal(JSON.stringify(ownerResult).includes(f.b.leaseToken),false)
assert.equal(sql(`set session authorization authenticated;set request.jwt.claim.sub=${q(other)};select public.get_my_document_job_result_v1(${q(f.b.jobId)})`),'')
check('authenticated direct-session owner exact readback; cross-owner denied; no lease disclosure')
for(const role of ['anon','authenticated']) sql(`set session authorization ${role};select public.read_document_job_v1(${json(f.b)})`,false)
for(const role of ['anon','authenticated','service_role']) {
 for(const table of ['my_stuff_document_executions','my_stuff_research_jobs','my_stuff_research_attempts','my_stuff_research_budget_ledger']) sql(`set role ${role};update private.${table} set ${table==='my_stuff_document_executions'?"state='ready'":table==='my_stuff_research_jobs'?"status='queued'":table==='my_stuff_research_attempts'?"status='running'":"cents=0"}`,false)
 sql(`set role ${role};update public.manufacturer_template_versions set status='reviewed'`,false)
}
sql(`revoke execute on function public.finalize_document_job_v1(jsonb,uuid,jsonb,bigint) from service_role`)
sql(finalize(f.b,f.attemptId,success.row.record),false)
sql(`grant execute on function public.finalize_document_job_v1(jsonb,uuid,jsonb,bigint) to service_role`)
check('browser RPC ACLs, all direct job/ledger/template writes, revoked finalizer denied')
// Boundary failures use LOCAL test-only triggers, never injectable production RPC switches.
for(const [table,event,condition] of [
 ['public.manufacturer_template_versions','after insert','true'],
 ['private.my_stuff_document_executions','after update',"new.state='completed'"],
 ['private.my_stuff_research_budget_ledger','after insert',"new.kind='settlement'"],
 ['private.my_stuff_research_budget_ledger','after insert',"new.kind='release'"],
 ['private.my_stuff_research_attempts','after update',"new.status='succeeded'"],
 ['private.my_stuff_research_jobs','after update',"new.status='document_complete'"],
 ]){
 const x=await fixture();await jobs.claim({binding:x.b,source});const r=await recordFor(x.b)
 sql(`create function public._atomic_inject() returns trigger language plpgsql as $$begin if ${condition} then raise exception 'LOCAL_BOUNDARY_FAILURE'; end if;return new;end$$;
 create trigger _atomic_inject ${event} on ${table} for each row execute function public._atomic_inject();`)
 const message=await asyncSql(finalize(x.b,x.attemptId,r)).then(()=>'',e=>e.message)
 assert.match(message,/LOCAL_BOUNDARY_FAILURE/)
 sql(`drop trigger _atomic_inject on ${table};drop function public._atomic_inject()`)
 assert.deepEqual(counts(x.b),{templates:0,settlements:0,releases:0})
 assert.equal((await jobs.read(x.b)).state,'attempted')
 await jobs.fail({binding:x.b,attemptId:x.attemptId,costInUsdTicks:150000001,code:'DOCUMENT_STORAGE_UNCONFIRMED',requeue:false})
 check('rollback after '+table+' '+condition)
}
// Lost claim ACK: SQL commits but client response is discarded; no extraction permission.
const lost=await fixture();await jobs.claim({binding:lost.b,source})
assert.equal((await jobs.claim({binding:lost.b,source})).claimed,false)
await assert.rejects(processLeasedJob({...options,lease:lost.lease}))
assert.equal(invocations,1);assert.deepEqual(counts(lost.b),{templates:0,settlements:0,releases:0})
sql(`update private.my_stuff_research_jobs set lease_expires_at=now()-interval '1 second' where id=${q(lost.b.jobId)}`)
sql(`set role service_role;select private.lease_my_stuff_research_job_v4('offline-reaper',300)`)
assert.equal(sql(`select status from private.my_stuff_research_jobs where id=${q(lost.b.jobId)}`),'document_pending')
await jobs.fail({binding:lost.b,attemptId:lost.attemptId,costInUsdTicks:null,code:'DOCUMENT_ACCOUNTING_UNKNOWN',requeue:false})
await jobs.fail({binding:lost.b,attemptId:lost.attemptId,costInUsdTicks:null,code:'DOCUMENT_ACCOUNTING_UNKNOWN',requeue:false})
assert.equal(sql(`select cents from private.my_stuff_research_budget_ledger where job_id=${q(lost.b.jobId)} and kind='release'`),'0')
assert.equal(sql(`select usage_ticks is null and usage_cents=25 from private.my_stuff_research_attempts where id=${q(lost.attemptId)}`),'t')
check('lost claim ACK, expiry, legacy reaper cannot retry; unknown charge holds original reserve')
// Before COMMIT disconnect (EOF with open transaction) versus after COMMIT response loss.
const ack=await fixture();await jobs.claim({binding:ack.b,source});const ar=await recordFor(ack.b)
await asyncSql('begin;'+finalize(ack.b,ack.attemptId,ar))
assert.deepEqual(counts(ack.b),{templates:0,settlements:0,releases:0})
await asyncSql('begin;'+finalize(ack.b,ack.attemptId,ar)+';commit;') // deliberately discard returned ID
await jobs.fail({binding:ack.b,attemptId:ack.attemptId,costInUsdTicks:150000001,code:'DOCUMENT_STORAGE_UNCONFIRMED',requeue:false})
assert.equal((await jobs.read(ack.b)).state,'completed');assert.deepEqual(counts(ack.b),{templates:1,settlements:1,releases:1})
check('connection close before commit rolls back; lost post-commit ACK stays completed')
// Atomic current identity fence, cancellation and revoked policy/entitlement.
for(const mutation of [
 `update public.my_stuff_items set vin_confirmation_fingerprint=repeat('f',64) where id=${q(item.id)}`,
 'update private.my_stuff_research_runtime_config set document_lane_enabled=false',
 `update public.user_entitlements set status='expired' where user_id=${q(owner)}`,
 ]){
 const x=await fixture();await jobs.claim({binding:x.b,source});const r=await recordFor(x.b)
 sql('begin;'+mutation+';'+finalize(x.b,x.attemptId,r),false)
 assert.deepEqual(counts(x.b),{templates:0,settlements:0,releases:0})
 await jobs.fail({binding:x.b,attemptId:x.attemptId,costInUsdTicks:0,code:'DOCUMENT_EXTRACTION_FAILED',requeue:false})
}
check('stale identity, disabled policy, revoked entitlement finalization rollback')
const cancel=await fixture();await jobs.claim({binding:cancel.b,source});const cr=await recordFor(cancel.b)
sql(`update private.my_stuff_research_jobs set cancellation_requested_at=now() where id=${q(cancel.b.jobId)}`)
sql(finalize(cancel.b,cancel.attemptId,cr),false)
await jobs.fail({binding:cancel.b,attemptId:cancel.attemptId,costInUsdTicks:3000000000,code:'DOCUMENT_BUDGET_EXCEEDED',requeue:false})
assert.equal(sql(`select actual_cents=30 and actual_cost_ticks=3000000000 from private.my_stuff_research_jobs where id=${q(cancel.b.jobId)}`),'t')
assert.equal(sql(`select sum(case when kind='reservation' then cents when kind='release' then -cents else 0 end) from private.my_stuff_research_budget_ledger where job_id=${q(cancel.b.jobId)}`),'30')
check('cancellation prevents append; over-budget known usage retained uncapped and global budget sees overrun')
const pre=await fixture();await jobs.fail({binding:pre.b,attemptId:pre.attemptId,costInUsdTicks:0,code:'DOCUMENT_SOURCE_UNAVAILABLE',requeue:false})
assert.equal(sql(`select cents from private.my_stuff_research_budget_ledger where job_id=${q(pre.b.jobId)} and kind='release'`),'25')
check('explicit nonbillable preflight terminal release')
const orphan=await fixture();await jobs.claim({binding:orphan.b,source});const or=await recordFor(orphan.b)
sql(`set role service_role;select public.store_manufacturer_template_version(${q(owner)},${json(or)})`,false)
assert.deepEqual(counts(orphan.b),{templates:0,settlements:0,releases:0})
check('direct document-family append cannot commit an orphan')
// Explicit separate correction version cannot retarget the immutable job result.
const correction=JSON.parse(readFileSync(new URL('../fixtures/ford-retained-local-correction.json',import.meta.url)))
const corrected=(await ingestDocumentMaintenance({extraction:correction,bundle,templateKey:success.row.record.template_key,version:2,ownerId:owner,dryRun:true})).record
corrected.validation_report.document_job=success.row.record.validation_report.document_job
const correctedId=await storage.append(owner,corrected)
assert.notEqual(correctedId,success.row.id)
assert.deepEqual((await storage.read(owner,success.row.id)).record,success.row.record)
assert.equal((await jobs.read(f.b)).templateId,success.row.id)
assert.deepEqual((await storage.read(owner,correctedId)).record,corrected)
const promoted=structuredClone(corrected);promoted.version=3;promoted.status='reviewed';promoted.applicability_reviewed=true
await assert.rejects(storage.append(owner,promoted))
check('raw/corrected immutable versions remain distinct; link never retargets; semantic promotion denied')
// Genuine concurrent identity change: wait for observed row lock, not scheduling luck.
const identityRace=await fixture();await jobs.claim({binding:identityRace.b,source});const ir=await recordFor(identityRace.b)
const writer=asyncSql(`set application_name='document-identity-writer';begin;update public.my_stuff_items set vin_confirmation_fingerprint=repeat('f',64) where id=${q(item.id)};select pg_sleep(2);commit;`)
let ready=false
for(let n=0;n<100;n++) {if(sql("select exists(select 1 from pg_stat_activity where application_name='document-identity-writer' and wait_event='PgSleep')")==='t'){ready=true;break} await new Promise(r=>setTimeout(r,10))}
assert.equal(ready,true)
const blocked=asyncSql("set application_name='document-finalize-waiter';"+finalize(identityRace.b,identityRace.attemptId,ir)).then(()=>'',e=>e.message)
let waited=false
for(let n=0;n<100;n++){if(sql("select exists(select 1 from pg_stat_activity where application_name='document-finalize-waiter' and wait_event_type='Lock')")==='t'){waited=true;break}await new Promise(r=>setTimeout(r,10))}
assert.equal(waited,true);await writer;assert.match(await blocked,/IDENTITY_UNCONFIRMED/)
assert.deepEqual(counts(identityRace.b),{templates:0,settlements:0,releases:0})
sql(`update public.my_stuff_items set vin_confirmation_fingerprint=${q(item.vin_confirmation_fingerprint)} where id=${q(item.id)}`)
await jobs.fail({binding:identityRace.b,attemptId:identityRace.attemptId,costInUsdTicks:0,code:'DOCUMENT_EXTRACTION_FAILED',requeue:false})
check('observed concurrent item lock wait; changed identity blocks append after commit')
// An uncommitted claim cannot consume authority; an interrupted failure cannot partially settle.
const interrupted=await fixture()
await asyncSql('begin;set role service_role;'+rpcSql('claim_document_job_v1',{p_binding:interrupted.b,p_source:source}))
assert.equal((await jobs.read(interrupted.b)).state,'ready')
await jobs.claim({binding:interrupted.b,source})
await asyncSql('begin;set role service_role;'+rpcSql('fail_document_job_v1',{p_binding:interrupted.b,p_attempt_id:interrupted.attemptId,p_cost_ticks:null,p_code:'DOCUMENT_ACCOUNTING_UNKNOWN'}))
assert.deepEqual(counts(interrupted.b),{templates:0,settlements:0,releases:0})
assert.equal((await jobs.read(interrupted.b)).state,'attempted')
await jobs.fail({binding:interrupted.b,attemptId:interrupted.attemptId,costInUsdTicks:null,code:'DOCUMENT_ACCOUNTING_UNKNOWN',requeue:false})
check('connection loss before claim/failure commits rolls back all effects')
const missing=await fixture()
for(const mutation of [`update private.my_stuff_research_jobs set lease_expires_at=null where id=${q(missing.b.jobId)}`,`delete from private.my_stuff_research_runtime_config`,`delete from private.my_stuff_research_budget_ledger where job_id=${q(missing.b.jobId)}`]){
 sql(`begin;${mutation};set role service_role;select public.claim_document_job_v1(${json(missing.b)},${json(source)})`,false)
}
const legacy=await fixture('legacy')
for(const mutation of ["lease_expires_at=null","lease_token=null","attempt_count=2","actual_cost_ticks=1","reserved_cents=0","policy_version=null"]){
 sql(`begin;update private.my_stuff_research_jobs set ${mutation} where id=${q(legacy.id)};set role service_role;select public.prepare_document_job_v1(${q(legacy.id)},${q(legacy.token)})`,false)
}
check('missing lease/config/reservation and reused or malformed lease fail closed')
sql(`set role service_role;select public.fail_my_stuff_research_worker_v2(${q(legacy.id)},${q(legacy.token)},100000000,'WORKER_ERROR','LOCAL_ONLY')`)
assert.equal(sql(`select status='queued' and actual_cents=1 and actual_cost_ticks=100000000 from private.my_stuff_research_jobs where id=${q(legacy.id)}`),'t')
assert.equal(sql(`select count(*) from private.my_stuff_document_executions where job_id=${q(legacy.id)}`),'0')
check('legacy retry-capable failure RPC still queues unmarked jobs after ACL hardening')
const acl=JSON.parse(sql(`select jsonb_agg(jsonb_build_object('function',p.oid::regprocedure::text,'acl',p.proacl,'anon',has_function_privilege('anon',p.oid,'execute'),'authenticated',has_function_privilege('authenticated',p.oid,'execute'),'service',has_function_privilege('service_role',p.oid,'execute'))) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('prepare_document_job_v1','read_document_job_v1','claim_document_job_v1','finalize_document_job_v1','fail_document_job_v1','get_my_document_job_result_v1')`))
assert.equal(acl.length,6)
for(const a of acl){assert.equal(a.anon,false);const own=a.function.startsWith('get_my_');assert.equal(a.authenticated,own);assert.equal(a.service,!own)}
sql('set session authorization authenticated;set role service_role',false)
writeFileSync(out+'/document-job-atomic-acl.json',JSON.stringify(acl,null,2))
check('all six RPC ACLs verified from catalog; authenticated service escalation denied')
assert.deepEqual(snapshot(),before)
const currentFixture=JSON.parse(sql(`select to_jsonb(i)-'updated_at' from public.my_stuff_items i where id=${q(item.id)}`))
const {updated_at,...originalFixture}=item;assert.deepEqual(currentFixture,originalFixture)
assert.equal(sql(`select coalesce(jsonb_agg(to_jsonb(l) order by id),'[]') from private.my_stuff_research_budget_ledger l where id in (${existingLedger.map(q).join(',') || 'null'})`),ledgerBefore)
assert.equal(sql(`select count(*) from private.my_stuff_research_budget_ledger where job_id in (${testJobs.map(q).join(',')}) and month_start<>'2026-08-01'`),'0')
assert.equal(sql("select count(*) from public.manufacturer_template_versions where schema_version='manufacturer-template-v2' and status='reviewed'"),'0')
check('27 public tables unchanged excluding test item updated_at; prior ledger unchanged; original month; no promotion')
const report={result:'PASS',database:db,checks,checkCount:checks.length,fixtureJobs:testJobs.length,fixtureOwner:owner,fixtureItem:item.id,preservationException:'explicit test item updated_at only; every other fixture item field compared',providerRequests:0,offlineExtractionInvocations:invocations,preservedPublicTables:tables.length,sourceSha256:source.sourceSha256,jobProtocol:'real PostgreSQL transactions via RPC adapter; concurrent independent connections',limits:['seeded first-lease/reservation fixtures, not new enqueue integration','pgmq/cron/net local extension stubs','offline retained extraction, not provider transport']}
writeFileSync(out+'/document-job-atomic-sql-verification.json',JSON.stringify(report,null,2))
writeFileSync(out+'/document-job-atomic-owner-readback.json',JSON.stringify(ownerResult,null,2))
console.log(JSON.stringify(report))
const {reviewCorrections}=await import('./document-job-review-corrections.mjs')
await reviewCorrections({sql,asyncSql,q,json,rpcSql,fixture,jobs,source,counts,finalize,recordFor,owner,item,legacy,out,db,bundle,retainedExtraction,processLeasedJob,storage})
