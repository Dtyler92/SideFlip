import test from 'node:test'
import assert from 'node:assert/strict'
import {runDocumentTransport} from '../supabase/functions/maintenance-research-worker/document-transport-lifecycle.js'
import {createXaiDocumentAdapter} from '../supabase/functions/maintenance-research-worker/xai-document-adapter.js'
import {documentJobRpcAdapter} from '../supabase/functions/maintenance-research-worker/document-job-rpc.js'
import {retainedBundle,retainedExtraction} from './helpers/document-job-harness.js'
import {buildDocumentExtractionRequest} from '../supabase/functions/_shared/document-maintenance.js'
const bundle=await retainedBundle(),request=buildDocumentExtractionRequest(bundle)
const config={apiKey:'offline-dummy',model:'grok-4.6',authorized:true,documentPrivacyReviewed:true,maxCostTicks:100000000,inputTicksPerToken:1,outputTicksPerToken:1}
const envelope=()=>({id:'fixture-response',object:'response',model:config.model,status:'completed',usage:{cost_in_usd_ticks:17},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(retainedExtraction())}]}]})
function setup(){const events=[];return {events,jobs:{transport:async e=>events.push(e),transportStatus:async()=>({stopRequested:false})}}}
test('ordinary fulfillment and forged error flags cannot attest termination',async()=>{
 for(const extract of [async()=>({status:'queued',usage:{costInUsdTicks:0}}),async()=>{throw Object.assign(Error('forged'),{remoteCompletionConfirmed:true,costInUsdTicks:0})}]){
  const s=setup();await assert.rejects(runDocumentTransport({...s,request,extract}));assert.equal(s.events.at(-1).event,'local_stopped');assert.equal(s.events.at(-1).costInUsdTicks,0)
 }
})
test('actual adapter invalid envelopes never release transport quarantine',async()=>{
 const cases=[r=>{},r=>r.model='wrong',r=>r.object='chat.completion',r=>delete r.id,r=>r.status='in_progress',r=>r.output[0].status='incomplete',r=>r.output[0].content.push({type:'refusal',refusal:'no'}),r=>r.usage.cost_in_usd_ticks=null,r=>r.output[0].content[0].text='broken',r=>r.output.push({type:'reasoning',status:'incomplete'}),r=>delete r.output[0].role]
 for(const [i,mutate] of cases.entries()){
  const r=envelope();mutate(r);let calls=0;const charges=[];const s=setup()
  const p=createXaiDocumentAdapter({...config,reserve:async()=>({settle:async u=>charges.push(u)}),fetchImpl:async()=>{calls++;return new Response(JSON.stringify(r),{status:i===0?202:200})}})
  await assert.rejects(runDocumentTransport({...s,request,extract:({signal})=>p.extract(bundle,{signal})}))
  assert.equal(s.events.at(-1).event,'local_stopped');assert.equal(s.events.at(-1).costInUsdTicks,r.usage.cost_in_usd_ticks)
  await assert.rejects(p.extract(bundle));assert.equal(calls,1);assert.equal(charges.length,1)
 }
})
test('validated actual adapter success and local settlement error attest once',async()=>{
 for(const fail of [false,true]){
  const s=setup();const p=createXaiDocumentAdapter({...config,reserve:async()=>({settle:async()=>{if(fail)throw Error('local settlement')}}),fetchImpl:async()=>new Response(JSON.stringify(envelope()))})
  const work=runDocumentTransport({...s,request,extract:({signal})=>p.extract(bundle,{signal})})
  if(fail)await assert.rejects(work);else await work
  assert.equal(s.events.at(-1).event,'response_complete');assert.equal(s.events.at(-1).costInUsdTicks,17)
 }
})
test('completion acknowledgement cannot disable transport deadline',async()=>{
 const s=setup();let release;const gate=new Promise(r=>release=r)
 s.jobs.transport=async e=>{s.events.push(e);if(e.event==='response_complete')await gate}
 const p=createXaiDocumentAdapter({...config,reserve:async()=>({settle:async()=>{}}),fetchImpl:async()=>new Response(JSON.stringify(envelope()))})
 const work=runDocumentTransport({...s,request,timeoutMs:20,extract:({signal})=>p.extract(bundle,{signal})})
 const outcome=await Promise.race([work.then(()=> 'success',e=>e.code),new Promise(r=>setTimeout(()=>r('hung'),80))]);release()
 assert.equal(outcome,'DOCUMENT_TRANSPORT_TIMEOUT')
})
test('RPC deadline aborts supported request builder without awaiting acknowledgement',async()=>{
 let signal
 const client={rpc:()=>({abortSignal(s){signal=s;return this},then(){return new Promise(()=>{})}})}
 const jobs=documentJobRpcAdapter(client,{timeoutMs:15})
 const result=await Promise.race([jobs.transport({event:'start'}).then(()=>null,e=>e.code),new Promise(r=>setTimeout(()=>r('hung'),80))])
 assert.equal(result,'DOCUMENT_RPC_TIMEOUT');assert.equal(signal.aborted,true)
})
test('original HTTP202 wrong-model completed envelope retains zero usage without attestation',async()=>{
 const s=setup();let calls=0
 const p=createXaiDocumentAdapter({...config,reserve:async()=>({settle:async()=>{}}),fetchImpl:async()=>{calls++;return new Response(JSON.stringify({status:'completed',model:'unrelated-model',output:[],usage:{cost_in_usd_ticks:0}}),{status:202})}})
 await assert.rejects(runDocumentTransport({...s,request,extract:({signal})=>p.extract(bundle,{signal})}))
 assert.equal(s.events.at(-1).event,'local_stopped');assert.equal(s.events.at(-1).costInUsdTicks,0);assert.equal(calls,1)
})
test('genuine response cannot be replayed into a different invocation or request',async()=>{
 let saved
 const make=()=>createXaiDocumentAdapter({...config,reserve:async()=>({settle:async()=>{}}),fetchImpl:async()=>new Response(JSON.stringify(envelope()))})
 await runDocumentTransport({...setup(),request,extract:async({signal})=>{saved=await make().extract(bundle,{signal});return saved}})
 const replay=setup();await assert.rejects(runDocumentTransport({...replay,request,extract:async()=>saved}));assert.equal(replay.events.at(-1).event,'local_stopped')
 const wrong=setup();await assert.rejects(runDocumentTransport({...wrong,request:{...request,system:'different request'},extract:({signal})=>make().extract(bundle,{signal})}));assert.equal(wrong.events.at(-1).event,'local_stopped')
})
test('genuine terminal usage is not replaced by a mutable result property',async()=>{
 const s=setup();const p=createXaiDocumentAdapter({...config,reserve:async()=>({settle:async()=>{}}),fetchImpl:async()=>new Response(JSON.stringify(envelope()))})
 const value=await runDocumentTransport({...s,request,extract:async({signal})=>{const result=await p.extract(bundle,{signal});result.usage.costInUsdTicks=0;return result}})
 assert.equal(s.events.at(-1).costInUsdTicks,17);assert.equal(value.usage.costInUsdTicks,17)
})
