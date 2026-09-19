import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync, writeFileSync} from 'node:fs'
import {createXaiMaintenanceProvider, parseJsonText} from '../supabase/functions/maintenance-research-worker/xai-provider.js'
import {createXaiDocumentAdapter} from '../supabase/functions/maintenance-research-worker/xai-document-adapter.js'
import {readDocumentBundle} from '../supabase/functions/_shared/document-maintenance.js'
const fixture=JSON.parse(readFileSync(new URL('./fixtures/xai-official-responses-contract.json',import.meta.url)))
// Official example adapted for application JSON/model and optional measured cost.
// These are documentation-contract fixtures, NEVER authentic paid responses.
function response(){const r=structuredClone(fixture.responseExample);r.model='grok-4.6';r.usage.cost_in_usd_ticks=17;r.output[0].content[0].text='{"candidates":[],"unresolved":[]}';return r}
const provider=(r,status=200)=>createXaiMaintenanceProvider({apiKey:'offline-dummy',model:'grok-4.6',timeoutSeconds:10,fetchImpl:async()=>new Response(JSON.stringify(r),{status})})
test('documented raw Responses example uses output array, not SDK output_text',()=>{
 assert.equal(fixture.responseExample.output_text,undefined)
 assert.deepEqual(parseJsonText(response()),{candidates:[],unresolved:[]})
 assert.equal(fixture.responseExample.usage.cost_in_usd_ticks,undefined)
})
test('parser excludes documented tool-role messages from assistant JSON',()=>{
 const r=response();const tool=structuredClone(r.output[0]);tool.role='tool';tool.content[0].text='PRIVATE_TOOL_OUTPUT';r.output.unshift(tool)
 assert.deepEqual(parseJsonText(r),{candidates:[],unresolved:[]})
 const only=response();only.output[0].role='tool';assert.throws(()=>parseJsonText(only))
})
test('normalization rejects incomplete sibling instead of silently dropping it',async()=>{
 const r=response();r.output.push({...structuredClone(r.output[0]),status:'incomplete'})
 await assert.rejects(provider(r).normalize({evidence:[]}),e=>e.code==='INVALID_PROVIDER_RESPONSE'&&e.costInUsdTicks===17)
})
test('documented refusal content cannot be silently discarded beside valid JSON',async()=>{
 const r=response();r.output[0].content.push({type:'refusal',refusal:'PRIVATE_REFUSAL'})
 await assert.rejects(provider(r).normalize({evidence:[]}),e=>e.code==='INVALID_PROVIDER_RESPONSE'&&e.costInUsdTicks===17&&!e.message.includes('PRIVATE_REFUSAL'))
})
test('legacy non-2xx bounded usage survives rejection, malformed body stays HTTP failure',async()=>{
 for(const status of [400,429,503])await assert.rejects(provider(response(),status).normalize({evidence:[]}),e=>e.costInUsdTicks===17&&e.code===(status===400?'PROVIDER_REJECTED':'PROVIDER_TRANSIENT'))
 const p=createXaiMaintenanceProvider({apiKey:'offline-dummy',model:'grok-4.6',fetchImpl:async()=>new Response('PRIVATE_BAD_JSON',{status:429})})
 await assert.rejects(p.normalize({evidence:[]}),e=>e.code==='PROVIDER_TRANSIENT'&&e.costInUsdTicks===undefined&&!e.message.includes('PRIVATE'))
})
const bundle=await readDocumentBundle('/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf','560-573')
const config={apiKey:'offline-dummy',model:'grok-4.6',authorized:true,documentPrivacyReviewed:true,maxCostTicks:10000000000,inputTicksPerToken:44000,outputTicksPerToken:132000}
test('actual document serialization matches documented request fields with no provider network',async()=>{
 let captured,calls=0,settled
 const p=createXaiDocumentAdapter({...config,reserve:async()=>({settle:async x=>{settled=x}}),fetchImpl:async(url,init)=>{calls++;captured={url,method:init.method,headers:{...init.headers,Authorization:'[REDACTED]'},redirect:init.redirect,body:JSON.parse(init.body),serializedBytes:Buffer.byteLength(init.body)};return new Response(JSON.stringify(response()))}})
 await p.extract(bundle);assert.equal(calls,1);assert.equal(settled.costInUsdTicks,17)
 assert.equal(captured.url,'https://api.x.ai/v1/responses');assert.equal(captured.method,'POST');assert.equal(captured.redirect,'error')
 const b=captured.body;for(const key of Object.keys(b))assert.ok(key in fixture.schemas.ModelRequest.properties,`undocumented request field ${key}`)
 assert.deepEqual(b.input.map(x=>x.role),fixture.requestExample.input.map(x=>x.role));assert.ok(b.input.every(x=>typeof x.content==='string'))
 assert.equal(b.model,'grok-4.6');assert.equal(b.store,false);assert.equal(b.max_output_tokens,8000);assert.deepEqual(b.tools,[]);assert.equal(Object.hasOwn(b,'tool_choice'),false);assert.equal(b.parallel_tool_calls,false)
 assert.equal(b.response_format,undefined);assert.equal(b.text,undefined)
 if(process.env.XAI_CONTRACT_CAPTURE_PATH)writeFileSync(process.env.XAI_CONTRACT_CAPTURE_PATH,JSON.stringify({kind:'OFFLINE intercepted actual request; response is documentation fixture',...captured},null,2)+'\n',{mode:0o600})
})
test('actual legacy discovery and normalization fields remain distinct from document lane',async()=>{
 const calls=[]
 const p=createXaiMaintenanceProvider({apiKey:'offline-dummy',model:'grok-4.6',fetchImpl:async(url,init)=>{calls.push({url,method:init.method,headers:{...init.headers,Authorization:'[REDACTED]'},body:JSON.parse(init.body)});return new Response(JSON.stringify(response()))}})
 // No fabricated search success: the documentation example has no web actions.
 await assert.rejects(p.discover({asset:{modelYear:2020,make:'Ford',model:'F-150'},domains:[{domain:'ford.com',sourceClass:'manufacturer',includeSubdomains:true,allowedPathPrefixes:['/']}],maxSearches:3,maxFetches:2}))
 await p.normalize({evidence:[]});assert.equal(calls.length,2)
 for(const {body} of calls){for(const key of Object.keys(body))assert.ok(key in fixture.schemas.ModelRequest.properties);assert.equal(body.store,false);assert.equal(body.model,'grok-4.6');assert.equal(body.max_turns,5);assert.deepEqual(body.reasoning,{effort:'low'})}
 assert.equal(calls[0].body.max_output_tokens,12000);assert.equal(calls[0].body.tool_choice,'required');assert.equal(calls[0].body.tools[0].type,'web_search');assert.equal(calls[1].body.max_output_tokens,8000);assert.equal(calls[1].body.tools,undefined)
 if(process.env.XAI_CONTRACT_CAPTURE_PATH)writeFileSync(process.env.XAI_CONTRACT_CAPTURE_PATH.replace('.json','-legacy.json'),JSON.stringify({kind:'OFFLINE intercepted actual legacy requests; no provider output',calls},null,2)+'\n',{mode:0o600})
})
test('document boundary rejects documented tool-role output even with zero reported tool count',async()=>{
 for(const mixed of [false,true]){
 const r=response();const tool=structuredClone(r.output[0]);tool.role='tool';r.output=mixed?[tool,...r.output]:[tool];let settled
 const p=createXaiDocumentAdapter({...config,reserve:async()=>({settle:async x=>{settled=x}}),fetchImpl:async()=>new Response(JSON.stringify(r))})
 await assert.rejects(p.extract(bundle),e=>e.stage==='document_response'&&e.costInUsdTicks===17)
 assert.equal(settled.chargedTicks,17)
 }
})
