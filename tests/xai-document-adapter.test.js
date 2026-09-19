import test from 'node:test'
import assert from 'node:assert/strict'
import {createXaiDocumentAdapter} from '../supabase/functions/maintenance-research-worker/xai-document-adapter.js'
import {readDocumentBundle,extractDocumentRules} from '../supabase/functions/_shared/document-maintenance.js'
const bundle=await readDocumentBundle('/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf','560')
import {localDocumentReservation} from '../scripts/local-document-budget.mjs'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const config={apiKey:'offline-test-key',model:'configured-model',authorized:true,documentPrivacyReviewed:true,maxCostTicks:100000000,inputTicksPerToken:1,outputTicksPerToken:1}
const envelope=(text='{}',ticks=7)=>({status:'completed',model:config.model,usage:{cost_in_usd_ticks:ticks},output:[{type:'message',status:'completed',content:[{type:'output_text',text}]}]})
function setup(extra={},result=envelope()) {let calls=0;const charges=[];const provider=createXaiDocumentAdapter({...config,reserve:async()=>({settle:async x=>charges.push(x)}),fetchImpl:async(url,opts)=>{calls++; const b=JSON.parse(opts.body);assert.equal(url,'https://api.x.ai/v1/responses');assert.equal(b.store,false);assert.deepEqual(b.tools,[]);assert.equal(Object.hasOwn(b,'tool_choice'),false);assert.equal(b.model,config.model);assert.equal(b.max_output_tokens,8000);assert.ok(b.input[1].content.includes(bundle.sourceSha256));assert.ok(!opts.body.includes('ownerId'));return new Response(JSON.stringify(result))},...extra});return {provider,charges,calls:()=>calls}}
test('no-tools document request omits tool_choice rejected by live provider',async()=>{
 let wire,calls=0;const charges=[]
 const provider=createXaiDocumentAdapter({...config,reserve:async()=>({settle:async usage=>charges.push(usage)}),fetchImpl:async(url,init)=>{
  calls++;wire=JSON.parse(init.body)
  // Offline reproduction of the verified provider request constraint, not a live retry.
  if(wire.tools.length===0 && Object.hasOwn(wire,'tool_choice'))return new Response(JSON.stringify({code:'InvalidArgument',error:'Invalid request content: A tool_choice was set on the request but no tools were specified.'}),{status:400})
  return new Response(JSON.stringify(envelope()))
 }})
 await provider.extract(bundle)
 assert.equal(Object.hasOwn(wire,'tool_choice'),false)
 assert.deepEqual(wire.tools,[]);assert.equal(wire.store,false);assert.equal(wire.parallel_tool_calls,false)
 assert.equal(calls,1);assert.equal(charges[0].costInUsdTicks,7)
 await assert.rejects(provider.extract(bundle),e=>e.stage==='document_reservation');assert.equal(calls,1)
})
test('durable single trial budget excludes concurrent and repeated attempts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'document-budget-'));const path=join(dir,'ledger')
 try {
  const reserve=localDocumentReservation(path)
  const attempts=await Promise.allSettled([reserve({maxCostTicks:10}),reserve({maxCostTicks:10})])
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1)
  await attempts.find(x=>x.status==='fulfilled').value.settle({costInUsdTicks:null,chargedTicks:10})
  assert.equal(JSON.parse(await readFile(path+'.settled')).chargedTicks,10)
  await assert.rejects(reserve({maxCostTicks:10}))
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('adapter rejects forged bundle, exhausted ceiling, and repeated call',async()=>{
 const x=setup();await assert.rejects(x.provider.extract(structuredClone(bundle)),e=>e.stage==='document_input');assert.equal(x.calls(),0)
 const low=setup({maxCostTicks:1});await assert.rejects(low.provider.extract(bundle));assert.equal(low.calls(),0)
 await x.provider.extract(bundle);await assert.rejects(x.provider.extract(bundle));assert.equal(x.calls(),1)
})
test('provider envelope errors retain ticks and never retry',async()=>{
 for(const mutate of [r=>r.model='wrong',r=>r.status='incomplete',r=>r.output.push({type:'web_search_call'}),r=>r.usage.cost_in_usd_ticks=100000001]){
  const r=envelope();mutate(r);const x=setup({},r);await assert.rejects(x.provider.extract(bundle));assert.equal(x.calls(),1);assert.equal(x.charges[0].costInUsdTicks,r.usage.cost_in_usd_ticks)
 }
})
test('non-2xx explicit usage survives rejection without exposing provider body',async()=>{
 let calls=0
 const x=setup({fetchImpl:async()=>{calls++;return new Response(JSON.stringify({...envelope('{}',17),error:'PRIVATE_HTTP_BODY'}),{status:429})}})
 await assert.rejects(x.provider.extract(bundle),e=>e.stage==='document_response'&&e.costInUsdTicks===17&&!JSON.stringify(e).includes('PRIVATE_HTTP_BODY')&&!e.message.includes('PRIVATE_HTTP_BODY'))
 assert.deepEqual(x.charges,[{costInUsdTicks:17,costKnown:true,chargedTicks:17,reservedTicks:config.maxCostTicks}])
 await assert.rejects(x.provider.extract(bundle),e=>e.stage==='document_reservation');assert.equal(calls,1)
})
test('completed response cannot hide incomplete sibling message',async()=>{
 for(const status of ['incomplete','in_progress',undefined]){
  const r=envelope('{}',17);r.output.push({type:'message',status,content:[{type:'output_text',text:'PRIVATE_TRUNCATED'}]})
  const x=setup({},r)
  await assert.rejects(x.provider.extract(bundle),e=>e.stage==='document_response'&&e.costInUsdTicks===17&&!JSON.stringify(e).includes('PRIVATE_TRUNCATED'))
  assert.equal(x.calls(),1);assert.equal(x.charges[0].chargedTicks,17)
 }
})
test('non-2xx missing or malformed usage remains unknown and fully reserved',async()=>{
 for(const cost of [undefined,null,-1,1.2,'17',9007199254740992]){
  const r=envelope();r.usage.cost_in_usd_ticks=cost
  const x=setup({fetchImpl:async()=>new Response(JSON.stringify(r),{status:500})})
  await assert.rejects(x.provider.extract(bundle),e=>e.stage==='document_response'&&e.costInUsdTicks===null)
  assert.equal(x.charges[0].costKnown,false);assert.equal(x.charges[0].chargedTicks,config.maxCostTicks)
 }
})
test('stream size and HTTP errors sanitize raw provider details',async()=>{
 for(const response of [new Response('SECRET',{status:429}),new Response('x'.repeat(1000001)),new Response('SECRET')]){
  const x=setup({fetchImpl:async()=>response});await assert.rejects(x.provider.extract(bundle),e=>!JSON.stringify(e).includes('SECRET'));assert.equal(x.charges[0].costInUsdTicks,null)
 }
})
test('real adapter HTTP mapping and accounting survive invalid extraction',async()=>{const x=setup();const r=await extractDocumentRules(bundle,{provider:x.provider,mode:'live_explicitly_authorized'});assert.equal(x.calls(),1);assert.equal(r.validation.valid,false);assert.equal(r.usage.costInUsdTicks,7);assert.equal(x.charges[0].costInUsdTicks,7)})
test('configuration and explicit consent fail closed',()=>{for(const extra of [{authorized:false},{documentPrivacyReviewed:false},{apiKey:''},{model:''},{reserve:null},{maxCostTicks:0}])assert.throws(()=>setup(extra))})
test('malformed output preserves known charge and safe stage',async()=>{const x=setup({},envelope('PRIVATE INVALID',19));await assert.rejects(extractDocumentRules(bundle,{provider:x.provider,mode:'live_explicitly_authorized'}),e=>e.stage==='document_response'&&e.costInUsdTicks===19&&!e.message.includes('PRIVATE'));assert.equal(x.calls(),1);assert.equal(x.charges[0].costInUsdTicks,19)})
test('unknown usage settles entire reservation without retries',async()=>{const x=setup({},envelope('{}',null));await assert.rejects(extractDocumentRules(bundle,{provider:x.provider,mode:'live_explicitly_authorized'}));assert.equal(x.calls(),1);assert.equal(x.charges[0].costInUsdTicks,null);assert.equal(x.charges[0].chargedTicks,config.maxCostTicks)})
test('reservation rejection never reaches HTTP',async()=>{const x=setup({reserve:async()=>{throw Error('PRIVATE')}});await assert.rejects(extractDocumentRules(bundle,{provider:x.provider,mode:'live_explicitly_authorized'}),e=>e.stage==='document_reservation'&&!e.message.includes('PRIVATE'));assert.equal(x.calls(),0)})
test('timeout is bounded and sanitized even for noncooperative injected HTTP',async()=>{const x=setup({timeoutMs:10,fetchImpl:async()=>new Promise(()=>{})});await assert.rejects(extractDocumentRules(bundle,{provider:x.provider,mode:'live_explicitly_authorized'}),e=>e.stage==='document_response'&&e.diagnostics.category==='timeout'&&e.diagnostics.transportKind==='timeout'&&e.diagnostics.httpStatus===null);assert.equal(x.charges[0].costInUsdTicks,null)})
test('input cap and mode rejected before reservation or network',async()=>{const x=setup({maxInputBytes:100});await assert.rejects(extractDocumentRules(bundle,{provider:x.provider,mode:'live_explicitly_authorized'}));assert.equal(x.calls(),0);await assert.rejects(extractDocumentRules(bundle,{provider:setup().provider,mode:'offline'}))})
