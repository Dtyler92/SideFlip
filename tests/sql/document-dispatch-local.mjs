// LOCAL PostgreSQL only. Every RPC opens an independent socket connection.
import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {createXaiDocumentAdapter} from '../../supabase/functions/maintenance-research-worker/xai-document-adapter.js'
import {dispatchDocumentJob} from '../../supabase/functions/maintenance-research-worker/document-dispatch.js'
import {documentJobRpcAdapter} from '../../supabase/functions/maintenance-research-worker/document-job-rpc.js'
import {retainedBundle,retainedExtraction} from '../helpers/document-job-harness.js'
import {localTemplateStorage} from '../../scripts/local-template-storage.mjs'
const db=process.argv[2];assert.match(db,/^sideflip_manufacturer_template_test_[0-9]+$/)
const args=['-u','postgres','env','-i','PATH=/usr/bin:/bin','psql','-XAtq','-h','/var/run/postgresql','-p','5432','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1']
const q=v=>v===null?'null':"'"+String(v).replaceAll("'","''")+"'",json=v=>q(JSON.stringify(v))+'::jsonb'
function sql(s){const r=spawnSync('sudo',args,{input:s,encoding:'utf8',maxBuffer:16e6});assert.equal(r.status,0,r.stderr);return r.stdout.trim()}
function run(s){return new Promise((resolve,reject)=>{const p=spawn('sudo',args);let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('close',c=>c?reject(Error(err)):resolve(out.trim()));p.stdin.end(s)})}
const rpc=(n,a)=>`select public.${n}(${Object.entries(a).map(([k,v])=>`${k}=>${v!==null&&typeof v==='object'?json(v):q(v)}`).join(',')})`
const client={rpc:async(n,a)=>{try{const s=await run('set role service_role;'+rpc(n,a));return {data:s===''?null:s==='t'?true:s==='f'?false:n==='finalize_document_job_v1'?s:JSON.parse(s),error:null}}catch(e){return {data:null,error:{message:e.message}}}}}
const jobs=documentJobRpcAdapter(client),storage=localTemplateStorage(db),bundle=await retainedBundle(),checks=[]
const pass=n=>{checks.push(n);console.log('DISPATCH '+n)}
// Isolate earlier disposable fixtures; never alter any external data.
sql(`update private.my_stuff_research_jobs set status='cancelled' where status in ('queued','running','awaiting_review','approved');update private.my_stuff_research_budget_ledger set month_start=(date_trunc('month',current_date)-interval '2 months')::date;update private.my_stuff_research_runtime_config set enabled=true,document_lane_enabled=true,per_job_budget_cents=306,monthly_user_budget_cents=2500,global_monthly_budget_cents=2500;update private.my_stuff_research_source_domains set terms_reviewed_on=current_date,robots_reviewed_on=current_date where lower(manufacturer)='honda'`)
async function owner(){
 const u=randomUUID();sql(`insert into auth.users(id) values(${q(u)});insert into public.user_entitlements(user_id,source,status,expires_at,last_verified_at) values(${q(u)},'apple','active',now()+interval '30 days',now())`)
 const auth=`set session authorization authenticated;set request.jwt.claim.sub=${q(u)};`
 const i=sql(auth+`select public.create_my_stuff_item_v2('{"name":"Dispatch fixture","item_type":"car","usage_dimensions":["mileage"],"current_mileage":0,"origin_mileage":0,"purchase_price":1000,"purchase_currency":"USD"}',${q(randomUUID())})`)
 sql(auth+`select public.confirm_my_stuff_vehicle_identity_v3(${q(i)},'{"model_year":2020,"make":"Honda","model":"Civic","engine_model":"L15B7","transmission":"CVT","drivetrain":"FWD"}',${q(randomUUID())})`)
 const fp=sql(`select vin_confirmation_fingerprint from public.my_stuff_items where id=${q(i)}`)
 const enqueue=(key,lane='document')=>auth+rpc(lane==='document'?'enqueue_my_document_job_v1':'enqueue_my_stuff_research_v3',{p_item_id:i,p_confirmed_fingerprint:fp,p_mutation_id:key})
 return {u,i,fp,auth,enqueue}
}
const lease=async()=>{const r=await client.rpc('lease_document_dispatch_v1',{p_worker:'offline'});assert.equal(r.error,null,JSON.stringify(r));return r.data}
const execution=id=>JSON.parse(sql(`select jsonb_build_object('binding',binding,'state',state,'attemptId',attempt_id,'ticks',cost_ticks) from private.my_stuff_document_executions where job_id=${q(id)}`))
const counts=id=>JSON.parse(sql(`select jsonb_build_object('reservation',(select count(*) from private.my_stuff_research_budget_ledger where job_id=${q(id)} and kind='reservation'),'settlement',(select count(*) from private.my_stuff_research_budget_ledger where job_id=${q(id)} and kind='settlement'),'release',(select coalesce(sum(cents),0) from private.my_stuff_research_budget_ledger where job_id=${q(id)} and kind='release'),'templates',(select count(*) from public.manufacturer_template_versions where template_key=${q('document-job:'+id)}))`))
const cancel=(o,id)=>run(o.auth+rpc('cancel_my_stuff_research_v1',{p_job_id:id,p_mutation_id:'cancel-'+id}))
const source={sourceSha256:bundle.sourceSha256,selectedPages:bundle.selectedPages}
let invokes=0
const options={enabled:true,client,workerId:'offline',storage,acquireDocument:async()=>bundle,extract:async({signal})=>{
 // Exercise the real bounded HTTP adapter with a fetch mock. Its reservation
 // callback ACKNOWLEDGES the existing SQL claim, never adds another reserve or
 // independently settles the ledger; the atomic job finalizer owns accounting.
 const provider=createXaiDocumentAdapter({apiKey:'offline-not-a-credential',model:'grok-4.6',authorized:true,documentPrivacyReviewed:true,maxCostTicks:10000000000,inputTicksPerToken:1,outputTicksPerToken:1,timeoutMs:1000,
  reserve:async()=>{assert.equal(sql("select count(*) from private.my_stuff_document_executions where state='attempted'"),'1');return {settle:async usage=>assert.equal(usage.costInUsdTicks,150000001)}},
  fetchImpl:async(url,init)=>{invokes++;assert.equal(url,'https://api.x.ai/v1/responses');const body=JSON.parse(init.body);assert.deepEqual(body.tools,[]);assert.equal(body.store,false);assert.ok(!init.body.includes('ownerId'));return new Response(JSON.stringify({id:'offline-response',object:'response',status:'completed',model:'grok-4.6',error:null,incomplete_details:null,background:false,usage:{cost_in_usd_ticks:150000001,num_server_side_tools_used:0},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(retainedExtraction())}]}]}))}})
 return provider.extract(bundle,{signal})
}}
const o=await owner()
sql('update private.my_stuff_research_runtime_config set document_lane_enabled=false')
await assert.rejects(run(o.enqueue('disabled')),/DOCUMENT_DISABLED/)
assert.equal(sql(`select count(*) from private.my_stuff_research_jobs where user_id=${q(o.u)}`),'0')
sql('update private.my_stuff_research_runtime_config set document_lane_enabled=true')
const ids=await Promise.all([run(o.enqueue('doubletap')),run(o.enqueue('doubletap'))]);assert.equal(ids[0],ids[1]);const id=ids[0]
assert.equal(counts(id).reservation,1)
assert.equal(sql(`select request_snapshot ? 'market' from private.my_stuff_research_jobs where id=${q(id)}`),'f')
assert.equal(sql(`set role service_role;select public.lease_my_stuff_research_worker_v2('legacy')`),'')
pass('explicit authenticated document enqueue, disabled gate, doubletap, unknown market and legacy queue exclusion')
const results=await Promise.allSettled(Array.from({length:4},()=>dispatchDocumentJob(options)))
const result=results.find(x=>x.status==='fulfilled'&&x.value.processed===1)?.value
assert.ok(result,JSON.stringify(results));assert.equal(invokes,1)
assert.deepEqual(counts(id),{reservation:1,settlement:1,release:304,templates:1})
const exact=JSON.parse(sql(o.auth+rpc('get_my_document_job_result_v1',{p_job_id:id})))
assert.equal(exact.templateId,result.row.id);assert.deepEqual(exact.record,result.row.record)
assert.equal(JSON.stringify(exact).includes(execution(id).binding.leaseToken),false)
assert.equal(await run(`set session authorization authenticated;set request.jwt.claim.sub=${q(randomUUID())};`+rpc('get_my_document_job_result_v1',{p_job_id:id})), '')
const completed=execution(id)
const repeated=await Promise.all(Array.from({length:5},()=>jobs.commit({binding:completed.binding,attemptId:completed.attemptId,record:result.row.record,costInUsdTicks:150000001})))
assert.deepEqual([...new Set(repeated)],[result.row.id]);assert.equal(counts(id).settlement,1)
writeFileSync('/root/sideflip-release-evidence/document-maintenance-pipeline/retained-ford-quality-pass/document-dispatch-owner-readback.json',JSON.stringify(exact,null,2))
assert.equal(await run(o.enqueue('doubletap')),id)
assert.equal((await dispatchDocumentJob(options)).processed,0)
pass('actual dispatch four-connection completion: one extraction, exact owner readback, immutable review-only result')
const failedOwner=await owner(),failed=await run(failedOwner.enqueue('acquisition'))
await assert.rejects(dispatchDocumentJob({...options,acquireDocument:async()=>{throw Error('private source detail')}}),/DOCUMENT_SOURCE_UNAVAILABLE/)
assert.deepEqual(counts(failed),{reservation:1,settlement:1,release:306,templates:0})
pass('dispatch acquisition failure uses ready-only preflight settlement')
const readyOwner=await owner(),ready=await run(readyOwner.enqueue('ready'));await lease();await cancel(readyOwner,ready)
assert.equal(execution(ready).state,'failed');assert.equal(counts(ready).release,306)
pass('ready cancellation settles known zero and restores owner slot')
// READY holds no global paid slot: another owner's legacy lease can proceed.
const docOwner=await owner(),doc=await run(docOwner.enqueue('crosslane'));await lease()
const legacyOwner=await owner(),legacy=await run(legacyOwner.enqueue('legacy','legacy'))
const legacyLease=JSON.parse(await run(`set role service_role;select public.lease_my_stuff_research_worker_v2('legacy')`)).lease
assert.equal(legacyLease.id,legacy)
const x=execution(doc)
assert.equal((await jobs.claim({binding:x.binding,source})).claimed,false)
await run(legacyOwner.auth+rpc('cancel_my_stuff_research_v1',{p_job_id:legacy,p_mutation_id:'legacy-cancel'}))
await run('set role service_role;'+rpc('fail_my_stuff_research_worker_v2',{p_job_id:legacy,p_lease_token:legacyLease.lease_token,p_cost_ticks:0,p_error_code:'WORKER_ERROR',p_error_detail:'LOCAL'}))
assert.equal((await jobs.claim({binding:x.binding,source})).claimed,true)
await cancel(docOwner,doc)
assert.equal(sql(`select status from private.my_stuff_research_jobs where id=${q(doc)}`),'document_pending')
await assert.rejects(run(docOwner.enqueue('blocked-cancel')),/RESEARCH_ALREADY_ACTIVE/)
assert.equal(counts(doc).settlement,0)
await jobs.fail({binding:x.binding,attemptId:x.attemptId,costInUsdTicks:null,code:'DOCUMENT_ACCOUNTING_UNKNOWN',requeue:false})
assert.equal(counts(doc).release,0);assert.equal(counts(doc).settlement,1)
pass('READY does not starve legacy; claimed cancel retains owner/global/accounting lifetime; unknown consumes reserve')
// New isolated accounting cohort so tests do not exhaust the configured global cap.
sql(`update private.my_stuff_research_budget_ledger set month_start=(date_trunc('month',current_date)-interval '2 months')::date`)
const rOwner=await owner(),rId=await run(rOwner.enqueue('race'));await lease();const r=execution(rId)
const lOwner=await owner(),lId=await run(lOwner.enqueue('race-legacy','legacy'))
const [claim,legacyResult]=await Promise.all([jobs.claim({binding:r.binding,source}),run(`set role service_role;select public.lease_my_stuff_research_worker_v2('racer')`)])
assert.equal(Number(claim.claimed)+Number(legacyResult!==''),1)
if(claim.claimed){assert.equal(await run(`set role service_role;select public.lease_my_stuff_research_worker_v2('blocked')`),'');await jobs.fail({binding:r.binding,attemptId:r.attemptId,costInUsdTicks:1,code:'DOCUMENT_EXTRACTION_FAILED',requeue:false});await cancel(lOwner,lId)}
else{await cancel(rOwner,rId);const l=JSON.parse(legacyResult).lease;await cancel(lOwner,lId);await run('set role service_role;'+rpc('fail_my_stuff_research_worker_v2',{p_job_id:lId,p_lease_token:l.lease_token,p_cost_ticks:0,p_error_code:'WORKER_ERROR',p_error_detail:'LOCAL'}))}
pass('real independent-connection document claim versus legacy lease race has exactly one paid winner')
// Lost commit acknowledgement: status is authoritative, never extract again.
const ackOwner=await owner(),ack=await run(ackOwner.enqueue('lost-ack'))
let ackInvokes=0
const lostClient={rpc:async(n,a)=>{const r=await client.rpc(n,a);return n==='finalize_document_job_v1'&&!r.error?{data:null,error:{message:'offline lost acknowledgement'}}:r}}
await assert.rejects(dispatchDocumentJob({...options,client:lostClient,extract:async args=>{ackInvokes++;return options.extract(args)}}),/DOCUMENT_STORAGE_UNCONFIRMED/)
assert.equal(execution(ack).state,'completed');assert.equal(counts(ack).settlement,1);assert.equal(counts(ack).templates,1)
assert.equal((await dispatchDocumentJob(options)).processed,0);assert.equal(ackInvokes,1)
pass('actual dispatcher lost finalize acknowledgement preserves committed exact result without retry')
const staleOwner=await owner(),stale=await run(staleOwner.enqueue('stale'));await lease()
sql(`update public.my_stuff_items set vin_confirmation_fingerprint=null where id=${q(staleOwner.i)}`)
const staleExec=execution(stale)
await assert.rejects(jobs.claim({binding:staleExec.binding,source}),/IDENTITY_UNCONFIRMED/)
assert.equal(counts(stale).settlement,0)
// The SQL recovery is explicit, bounded and never leases/requeues/re-reserves.
sql(`update private.my_stuff_research_jobs set lease_expires_at=now()-interval '10 minutes' where id=${q(stale)}`)
let recovered=await client.rpc('recover_document_dispatch_v1',{p_limit:1});assert.equal(recovered.error,null,JSON.stringify(recovered));assert.equal(recovered.data,1)
assert.equal(execution(stale).ticks,0);assert.equal(counts(stale).release,306)
pass('stale confirmed identity prevents cost; expired READY recovers known zero once')
const timeoutOwner=await owner(),timeout=await run(timeoutOwner.enqueue('lost-claim'));await lease();const tx=execution(timeout)
// Acknowledgement is discarded intentionally after the database really claims.
await client.rpc('claim_document_job_v1',{p_binding:tx.binding,p_source:source})
assert.equal((await jobs.claim({binding:tx.binding,source})).claimed,false)
sql(`update private.my_stuff_research_jobs set lease_expires_at=now()-interval '10 minutes' where id=${q(timeout)}`)
recovered=await client.rpc('recover_document_dispatch_v1',{p_limit:1});assert.equal(recovered.error,null,JSON.stringify(recovered));assert.equal(recovered.data,1)
assert.equal(execution(timeout).ticks,null);assert.equal(counts(timeout).release,0);assert.equal(counts(timeout).reservation,1)
const argsReconcile={p_binding:tx.binding,p_attempt_id:tx.attemptId,p_cost_ticks:150000001}
const rec=await Promise.all(Array.from({length:4},()=>client.rpc('reconcile_document_usage_v1',argsReconcile)))
assert.ok(rec.every(r=>r.error===null&&r.data===true),JSON.stringify(rec));assert.equal(counts(timeout).release,304);assert.equal(counts(timeout).settlement,1);assert.equal(counts(timeout).reservation,1)
const conflict=await client.rpc('reconcile_document_usage_v1',{...argsReconcile,p_cost_ticks:2});assert.match(conflict.error.message,/DOCUMENT_RECONCILIATION_CONFLICT/)
await jobs.fail({binding:tx.binding,attemptId:tx.attemptId,costInUsdTicks:null,code:'DOCUMENT_ACCOUNTING_UNKNOWN',requeue:false})
const status=JSON.parse(await run(timeoutOwner.auth+rpc('get_my_document_job_result_v1',{p_job_id:timeout})))
assert.equal(status.costInUsdTicks,150000001);assert.equal(status.costUnknown,false);assert.equal(status.accountingState,'reconciled');assert.equal(status.templateId,null)
assert.equal((await client.rpc('recover_document_dispatch_v1',{p_limit:1})).data,0)
pass('lost claim is never reinvoked; expired claim conservatively settles unknown; concurrent known reconciliation releases once without new reserve')
const timeoutRelease=await client.rpc('authorize_document_transport_release_v1',{p_binding:tx.binding,p_attempt_id:tx.attemptId,p_authorization_id:randomUUID(),p_accept_remote_unknown:true})
assert.equal(timeoutRelease.error,null,JSON.stringify(timeoutRelease));assert.equal(timeoutRelease.data,true)
pass('explicit operator authorization releases reconciled remote-unknown transport quarantine')
for(const ticks of [150000001,null]) {
 const own=await owner(),job=await run(own.enqueue('inflight'))
 let release,started
 const hold=new Promise(r=>release=r),entered=new Promise(r=>started=r)
 const pending=dispatchDocumentJob({...options,extract:async()=>{started();await hold;throw Object.assign(Error('PRIVATE_PROVIDER_BODY'),{costInUsdTicks:ticks})}}).then(value=>({fulfilled:true,value}),error=>({fulfilled:false,error}))
 await entered;await cancel(own,job)
 const during=JSON.parse(await run(own.auth+rpc('get_my_document_job_result_v1',{p_job_id:job})))
 assert.equal(during.cancellationRequested,true);assert.equal(during.accountingPending,true);assert.equal(counts(job).settlement,0)
 await assert.rejects(run(own.enqueue('while-cancelling')),/RESEARCH_ALREADY_ACTIVE/)
 release();const outcome=await pending;assert.equal(outcome.fulfilled,false,JSON.stringify(outcome.value));const failure=outcome.error;assert.equal(failure.code,'DOCUMENT_EXTRACTION_FAILED');assert.ok(!failure.message.includes('PRIVATE_PROVIDER_BODY'))
 assert.equal(counts(job).templates,0);assert.equal(counts(job).settlement,1);assert.equal(counts(job).release,ticks===null?0:304)
 pass('actual dispatcher in-flight cancellation settles '+(ticks===null?'unknown':'known')+' usage exactly once')
 const terminal=execution(job),authorized=await client.rpc('authorize_document_transport_release_v1',{p_binding:terminal.binding,p_attempt_id:terminal.attemptId,p_authorization_id:randomUUID(),p_accept_remote_unknown:true})
 assert.equal(authorized.error,null,JSON.stringify(authorized));assert.equal(authorized.data,true)
}
async function observed(name,predicate){for(let n=0;n<200;n++){if(sql(`select exists(select 1 from pg_stat_activity where datname=current_database() and application_name=${q(name)} and ${predicate})`)==='t')return;await new Promise(r=>setTimeout(r,10))}assert.fail('missing lock observation '+name)}
for(const first of ['document','legacy']){
 const dOwner=await owner(),dId=await run(dOwner.enqueue('ordered'));await lease();const d=execution(dId)
 const lOwner=await owner(),lId=await run(lOwner.enqueue('ordered-legacy','legacy'))
 const claimSql='set role service_role;'+rpc('claim_document_job_v1',{p_binding:d.binding,p_source:source})
 const legacySql="set role service_role;select public.lease_my_stuff_research_worker_v2('ordered')"
 const name='dispatch-first-'+randomUUID(),loser='dispatch-second-'+randomUUID()
 const a=run(`set application_name=${q(name)};begin;${first==='document'?claimSql:legacySql};select pg_sleep(2);commit;`)
 await observed(name,"wait_event='PgSleep'")
 const b=run(`set application_name=${q(loser)};${first==='document'?legacySql:claimSql}`)
 await observed(loser,"wait_event_type='Lock'")
 const winner=await a,blocked=await b
 if(first==='document'){assert.equal(JSON.parse(winner).claimed,true);assert.equal(blocked,'');await jobs.fail({binding:d.binding,attemptId:d.attemptId,costInUsdTicks:0,code:'DOCUMENT_EXTRACTION_FAILED',requeue:false});await cancel(lOwner,lId)}
 else{assert.equal(JSON.parse(blocked).claimed,false);const ll=JSON.parse(winner).lease;await cancel(dOwner,dId);await cancel(lOwner,lId);await run('set role service_role;'+rpc('fail_my_stuff_research_worker_v2',{p_job_id:lId,p_lease_token:ll.lease_token,p_cost_ticks:0,p_error_code:'WORKER_ERROR',p_error_detail:'LOCAL'}))}
 pass('observed database global lock race '+first+' first; exactly one paid authority')
}
const invalidOwner=await owner()
sql(`delete from public.user_entitlements where user_id=${q(invalidOwner.u)}`)
await assert.rejects(run(invalidOwner.enqueue('no-pro')),/PRO_REQUIRED/)
assert.equal(sql(`select count(*) from private.my_stuff_research_jobs where user_id=${q(invalidOwner.u)}`),'0')
const queuedOwner=await owner(),queued=await run(queuedOwner.enqueue('stale-queued'))
sql(`update public.my_stuff_items set vin_confirmation_fingerprint=null where id=${q(queuedOwner.i)}`)
assert.equal((await dispatchDocumentJob(options)).processed,0);assert.equal(counts(queued).release,306)
assert.equal(sql(`select count(*) from private.my_stuff_research_attempts where job_id=${q(queued)}`),'0')
assert.equal(sql(`select status from private.my_stuff_research_jobs where id=${q(queued)}`),'document_failed')
const queuedStatus=JSON.parse(await run(queuedOwner.auth+rpc('get_my_document_job_result_v1',{p_job_id:queued})))
assert.equal(queuedStatus.accountingPending,false);assert.equal(queuedStatus.costUnknown,false)
pass('Pro denied before reservation; stale queued identity terminates before attempt and cannot poison queue head')
const acl=JSON.parse(sql(`select jsonb_agg(jsonb_build_object('name',p.proname,'anon',has_function_privilege('anon',p.oid,'execute'),'auth',has_function_privilege('authenticated',p.oid,'execute'),'service',has_function_privilege('service_role',p.oid,'execute'))) from pg_proc p where p.proname in ('enqueue_my_document_job_v1','lease_document_dispatch_v1','recover_document_dispatch_v1','reconcile_document_usage_v1')`))
assert.equal(acl.length,4);for(const a of acl){assert.equal(a.anon,false);assert.equal(a.auth,a.name.startsWith('enqueue'));assert.equal(a.service,!a.name.startsWith('enqueue'))}
for(const role of ['anon','authenticated','service_role']) await assert.rejects(run(`set session authorization ${role};update private.my_stuff_document_usage_reconciliations set cost_ticks=0`),/permission denied/)
assert.equal(sql(`select count(*) from private.my_stuff_research_budget_ledger l join private.my_stuff_research_jobs j on j.id=l.job_id where j.id=${q(timeout)} and l.month_start<>j.reservation_month`),'0')
assert.equal(sql(`select actual_cents from private.my_stuff_research_jobs where id=${q(timeout)}`),'2')
pass('new RPC grants verified; no browser service dispatch')
writeFileSync('/root/sideflip-release-evidence/document-maintenance-pipeline/retained-ford-quality-pass/document-dispatch-sql.json',JSON.stringify({result:'PASS',database:db,checks,groups:checks.length,providerRequests:0,extractInvocations:invokes,limits:['PGMQ fixture stubs','retained source and extraction, no real retrieval or paid transport']},null,2))
