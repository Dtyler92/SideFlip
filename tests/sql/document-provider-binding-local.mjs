// LOCAL PostgreSQL only. Every RPC opens an independent socket connection.
import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {createXaiDocumentAdapter} from '/root/sideflip-maintenance-xai-backend/supabase/functions/maintenance-research-worker/xai-document-adapter.js'
import {dispatchDocumentJob} from '/root/sideflip-maintenance-xai-backend/supabase/functions/maintenance-research-worker/document-dispatch.js'
import {documentJobRpcAdapter} from '/root/sideflip-maintenance-xai-backend/supabase/functions/maintenance-research-worker/document-job-rpc.js'
import {terminalFixture} from '/root/sideflip-maintenance-xai-backend/tests/helpers/document-terminal-fixture.js'
import {retainedBundle,retainedExtraction} from '/root/sideflip-maintenance-xai-backend/tests/helpers/document-job-harness.js'
import {localTemplateStorage} from '/root/sideflip-maintenance-xai-backend/scripts/local-template-storage.mjs'
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
sql(`update private.my_stuff_research_jobs set status='cancelled' where status in ('queued','running','awaiting_review','approved');update private.my_stuff_research_runtime_config set enabled=true,document_lane_enabled=true,per_job_budget_cents=306,monthly_user_budget_cents=2500,global_monthly_budget_cents=2500;update private.my_stuff_research_source_domains set terms_reviewed_on=current_date,robots_reviewed_on=current_date where lower(manufacturer)='honda'`)
async function owner(){
 const u=randomUUID();sql(`insert into auth.users(id) values(${q(u)});insert into public.user_entitlements(user_id,source,status,expires_at,last_verified_at) values(${q(u)},'apple','active',now()+interval '30 days',now())`)
 const auth=`set session authorization authenticated;set request.jwt.claim.sub=${q(u)};`
 const i=sql(auth+`select public.create_my_stuff_item_v2('{"name":"Dispatch fixture","item_type":"car","usage_dimensions":["mileage"],"current_mileage":0,"origin_mileage":0,"purchase_price":1000,"purchase_currency":"USD"}',${q(randomUUID())})`)
 sql(auth+`select public.confirm_my_stuff_vehicle_identity_v3(${q(i)},'{"model_year":2020,"make":"Ford","model":"F-150"}',${q(randomUUID())})`)
 const fp=sql(`select vin_confirmation_fingerprint from public.my_stuff_items where id=${q(i)}`)
 const enqueue=(key,lane='document')=>auth+rpc(lane==='document'?'enqueue_my_document_job_v1':'enqueue_my_stuff_research_v3',{p_item_id:i,p_confirmed_fingerprint:fp,p_mutation_id:key})
 return {u,i,fp,auth,enqueue}
}
const lease=async()=>{const r=await client.rpc('lease_document_dispatch_v1',{p_worker:'offline'});assert.equal(r.error,null,JSON.stringify(r));return r.data}
const execution=id=>JSON.parse(sql(`select jsonb_build_object('binding',binding,'state',state,'attemptId',attempt_id,'ticks',cost_ticks) from private.my_stuff_document_executions where job_id=${q(id)}`))
const counts=id=>JSON.parse(sql(`select jsonb_build_object('reservation',(select count(*) from private.my_stuff_research_budget_ledger where job_id=${q(id)} and kind='reservation'),'settlement',(select count(*) from private.my_stuff_research_budget_ledger where job_id=${q(id)} and kind='settlement'),'release',(select coalesce(sum(cents),0) from private.my_stuff_research_budget_ledger where job_id=${q(id)} and kind='release'),'templates',(select count(*) from public.manufacturer_template_versions where template_key=${q('document-job:'+id)}))`))
const cancel=(o,id)=>run(o.auth+rpc('cancel_my_stuff_research_v1',{p_job_id:id,p_mutation_id:'cancel-'+id}))

// Full acquisition -> real adapter -> SQL commit/readback. All HTTP intercepted.
const {dispatchBoundDocumentJob}=await import('../../scripts/document-job-provider-binding.mjs')
const {EventEmitter}=await import('node:events'),{Readable}=await import('node:stream')
const {readFileSync}=await import('node:fs')
const bytes=readFileSync('/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf')
const url=JSON.parse(readFileSync('/root/sideflip-release-evidence/manufacturer-second-vehicle-test/source-retrieval.json')).url
sql(`insert into private.my_stuff_research_source_domains(domain,source_class,enabled,manufacturer,terms_reviewed_on,robots_reviewed_on,licensing_disposition,reviewed_by) values('www.fordservicecontent.com','manufacturer',true,'Ford',current_date,current_date,'offline interception fixture ONLY','local harness') on conflict(domain) do update set enabled=true,terms_reviewed_on=current_date,robots_reviewed_on=current_date`)
let acquired=0,invocations=0,currentJob
const selection={url,expectedSha256:bundle.sourceSha256,pages:'561'}
const sourcePolicy={url,manufacturer:'Ford',policyVersion:'research-v2-xai-citations',expiresAt:'2099-01-01T00:00:00Z',termsAllowed:true,robotsAllowed:true,officialSourceApproved:true,documentPrivacyReviewed:true}
const http=(status=200)=>(_url,init,callback)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{acquired++;init.lookup(_url.hostname,{},(e,ip)=>assert.equal(ip,'93.184.216.34'));queueMicrotask(()=>{const res=Readable.from([bytes]);res.statusCode=status;res.headers={'content-type':'application/pdf'};callback(res)})};return req}
const response=()=>new Response(JSON.stringify({id:'offline-document-binding',object:'response',status:'completed',model:'grok-4.6',usage:{cost_in_usd_ticks:150000001},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(retainedExtraction())}]}]}))
const fetchImpl=async(endpoint,init)=>{
 invocations++;assert.equal(endpoint,'https://api.x.ai/v1/responses')
 const body=JSON.parse(init.body);assert.equal(body.model,'grok-4.6');assert.deepEqual(body.reasoning,{effort:'low'});assert.equal(body.store,false);assert.deepEqual(body.tools,[]);assert.equal('tool_choice' in body,false)
 for(const secret of ['ownerId','leaseToken','confirmedFingerprint','PRIVATE_OWNER_NOTE'])assert.equal(init.body.includes(secret),false)
 assert.equal(execution(currentJob).state,'attempted');assert.equal(counts(currentJob).reservation,1);assert.equal(counts(currentJob).settlement,0)
 return response()
}
const options={enabled:true,client,workerId:'local-bound',storage,approvedSources:[sourcePolicy],
 sourceForJob:async binding=>({jobId:binding.jobId,confirmedFingerprint:binding.confirmedFingerprint,policyVersion:binding.policyVersion,source:selection}),
 acquisitionOptions:{lookupImpl:async()=>[{address:'93.184.216.34',family:4}],requestImpl:http()},
 transportOptions:{timeoutMs:5000,pollMs:50,rpcTimeoutMs:1500},
 provider:{apiKey:'offline-placeholder',model:'grok-4.6',authorized:true,documentPrivacyReviewed:true,maxCostTicks:306000000,inputTicksPerToken:1,outputTicksPerToken:1,fetchImpl}}
const own=await owner();currentJob=await run(own.enqueue('bound-success'))
const completed=await dispatchBoundDocumentJob(options)
assert.equal(completed.processed,1);assert.equal(invocations,1);assert.equal(acquired,1)
const exact=JSON.parse(await run(own.auth+rpc('get_my_document_job_result_v1',{p_job_id:currentJob})))
assert.deepEqual(exact.record,completed.row.record);assert.equal(exact.templateId,completed.row.id)
assert.equal(exact.record.validation_report.document_job.confirmedFingerprint,own.fp)
assert.equal(exact.record.validation_report.document_job.requestSnapshot.make,'Ford')
assert.equal('market' in exact.record.validation_report.document_job.requestSnapshot,false)
assert.equal(exact.record.validation_report.sourceAuthenticated,false);assert.equal(exact.record.validation_report.applicable,false)
assert.deepEqual(counts(currentJob),{reservation:1,settlement:1,release:304,templates:1})
assert.equal(await run(`set session authorization authenticated;set request.jwt.claim.sub=${q(randomUUID())};`+rpc('get_my_document_job_result_v1',{p_job_id:currentJob})), '')
assert.equal((await dispatchBoundDocumentJob(options)).processed,0);assert.equal(invocations,1)
writeFileSync('/root/sideflip-release-evidence/document-maintenance-pipeline/retained-ford-quality-pass/provider-binding-local/owner-readback.json',JSON.stringify(exact,null,2))
pass('bound original HTTP PDF + actual xAI adapter + one SQL reserve + exact owner result')
for(const mode of ['403','missing-source','policy-denied','stale-selection']){
 const o=await owner();currentJob=await run(o.enqueue(mode));const before=invocations
 let opt={...options}
 if(mode==='403')opt.acquisitionOptions={...options.acquisitionOptions,requestImpl:http(403)}
 if(mode==='missing-source')opt.sourceForJob=async()=>null
 if(mode==='policy-denied')opt.approvedSources=[{...sourcePolicy,robotsAllowed:false}]
 if(mode==='stale-selection')opt.sourceForJob=async b=>({...await options.sourceForJob(b),confirmedFingerprint:'0'.repeat(64)})
 await assert.rejects(dispatchBoundDocumentJob(opt),/DOCUMENT_SOURCE_UNAVAILABLE/)
 assert.equal(invocations,before);assert.deepEqual(counts(currentJob),{reservation:1,settlement:1,release:306,templates:0})
 pass('nonbillable acquisition '+mode+' no provider or legacy fallback')
}
// Actual adapter held fetch cancellation / timeout. Uncertain compute stays fenced.
for(const mode of ['cancel','timeout','known-http-error']){
 const o=await owner();currentJob=await run(o.enqueue(mode));let started
 const entered=new Promise(r=>started=r)
 const pending=dispatchBoundDocumentJob({...options,transportOptions:{timeoutMs:mode==='timeout'?700:5000,pollMs:25,rpcTimeoutMs:1500},provider:{...options.provider,fetchImpl:async(_u,init)=>{
  invocations++;started();if(mode==='known-http-error')return new Response(JSON.stringify({usage:{cost_in_usd_ticks:150000001},error:{message:'PRIVATE_OWNER_NOTE'}}),{status:403})
  return await new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(Object.assign(Error('offline abort'),{name:'AbortError'})),{once:true})})
 }}}).then(()=>assert.fail('unexpected success'),e=>e)
 await entered;if(mode==='cancel')await cancel(o,currentJob)
 const err=await pending;assert.ok(!err.message.includes('PRIVATE_OWNER_NOTE'))
 const status=JSON.parse(await run(o.auth+rpc('get_my_document_job_result_v1',{p_job_id:currentJob})))
 assert.equal(status.admissionQuarantined,true);assert.equal(status.reconciliationRequired,true);assert.equal(counts(currentJob).templates,0);assert.equal(counts(currentJob).settlement,1)
 assert.equal(status.costUnknown,mode!=='known-http-error');assert.equal(counts(currentJob).release,mode==='known-http-error'?304:0)
 const before=invocations;assert.equal((await dispatchBoundDocumentJob(options)).processed,0);assert.equal(invocations,before)
 // Explicit privileged risk acceptance isolates fixtures; NEVER worker behavior.
 const d=execution(currentJob);const released=await client.rpc('authorize_document_transport_release_v1',{p_binding:d.binding,p_attempt_id:d.attemptId,p_authorization_id:randomUUID(),p_accept_remote_unknown:true});assert.equal(released.error,null)
 pass('bound actual adapter '+mode+' one invoke, privacy and uncertain quarantine')
}
// A delayed SQL admission response cannot authorize HTTP after local cancellation.
{
 const o=await owner();currentJob=await run(o.enqueue('late-reserve-ack'));let statusCalls=0,lateFetches=0
 const delayedClient={rpc:async(n,a)=>{const result=await client.rpc(n,a);if(n==='get_document_transport_status_v1'&&++statusCalls===1)await new Promise(r=>setTimeout(r,900));return result}}
 await assert.rejects(dispatchBoundDocumentJob({...options,client:delayedClient,transportOptions:{timeoutMs:500,pollMs:1000,rpcTimeoutMs:1500},provider:{...options.provider,fetchImpl:async()=>{lateFetches++;return response()}}}),/DOCUMENT_TRANSPORT_TIMEOUT/)
 await new Promise(r=>setTimeout(r,1000));assert.equal(lateFetches,0)
 assert.equal(counts(currentJob).templates,0)
 const d=execution(currentJob);await client.rpc('authorize_document_transport_release_v1',{p_binding:d.binding,p_attempt_id:d.attemptId,p_authorization_id:randomUUID(),p_accept_remote_unknown:true})
 pass('late reserve-status acknowledgement cannot invoke after transport deadline')
}
writeFileSync('/root/sideflip-release-evidence/document-maintenance-pipeline/retained-ford-quality-pass/provider-binding-local/binding-results.json',JSON.stringify({database:db,groups:checks.length,checks,invocations,acquired},null,2))
console.log('PROVIDER_BINDING_PASS '+checks.length)
