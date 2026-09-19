import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createXaiDocumentAdapter} from '../supabase/functions/maintenance-research-worker/xai-document-adapter.js'
import {readDocumentBundle} from '../supabase/functions/_shared/document-maintenance.js'
const pdf='/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf'
const bundle=await readDocumentBundle(pdf,'561')
const config={apiKey:'dummy-offline',model:'grok-4.6',authorized:true,documentPrivacyReviewed:true,maxCostTicks:2500000000,inputTicksPerToken:20000,outputTicksPerToken:60000}
const envelope={model:config.model,status:'completed',usage:{cost_in_usd_ticks:17},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'{}'}]}]}
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve()}
function setup(extra={}){const charges=[],reservations=[],wires=[];const provider=createXaiDocumentAdapter({...config,reserve:async r=>{reservations.push(r);return {settle:async u=>charges.push(u)}},fetchImpl:async(url,init)=>{wires.push({url,init});return new Response(JSON.stringify(envelope))},...extra});return {provider,charges,reservations,wires}}
test('explicit longer deadline accepts delayed complete envelope past old deadline without changing wire or budget',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 let finish,signal,wire,calls=0
 const x=setup({timeoutMs:240000,fetchImpl:async(url,init)=>{calls++;signal=init.signal;wire=init.body;return new Promise(resolve=>{finish=resolve})}})
 const pending=x.provider.extract(bundle);await flush()
 t.mock.timers.tick(120001);await flush();assert.equal(signal.aborted,false)
 finish(new Response(JSON.stringify(envelope)));assert.deepEqual((await pending).extraction,{})
 const normal=setup();await normal.provider.extract(bundle)
 assert.equal(wire,normal.wires[0].init.body);assert.deepEqual(x.reservations,normal.reservations)
 assert.equal(x.charges[0].costInUsdTicks,17);assert.equal(signal.aborted,true)
 await assert.rejects(x.provider.extract(bundle),e=>e.stage==='document_reservation');assert.equal(calls,1)
})
test('default remains 120 seconds; explicit long deadline stays overall, not idle',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 for(const timeoutMs of [undefined,240000]){
  let signal,calls=0
  const x=setup({timeoutMs,fetchImpl:async(url,init)=>{calls++;signal=init.signal;return new Promise(()=>{})}})
  const rejected=assert.rejects(x.provider.extract(bundle),e=>e.diagnostics.category==='timeout'&&e.costInUsdTicks===null)
  await flush();t.mock.timers.tick((timeoutMs??120000)-1);await flush();assert.equal(signal.aborted,false)
  t.mock.timers.tick(1);await rejected;assert.equal(signal.aborted,true);assert.equal(calls,1)
  assert.equal(x.charges[0].chargedTicks,config.maxCostTicks)
 }
})
test('incoming body bytes do not reset the overall deadline or make partial JSON acceptable',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 let source,cancelled=0
 const body=new ReadableStream({start(c){source=c},cancel(){cancelled++}})
 const x=setup({timeoutMs:240000,fetchImpl:async()=>new Response(body)})
 const rejected=assert.rejects(x.provider.extract(bundle),e=>e.diagnostics.category==='timeout'&&e.costInUsdTicks===null)
 await flush()
 for(let i=0;i<3;i++){t.mock.timers.tick(60000);source.enqueue(new TextEncoder().encode(' '));await flush()}
 t.mock.timers.tick(59999);await flush();assert.equal(cancelled,0)
 t.mock.timers.tick(1);await rejected;await flush();assert.equal(cancelled,1);assert.equal(body.locked,false)
 assert.equal(x.charges[0].chargedTicks,config.maxCostTicks)
})
test('invalid and over-hard-limit deadlines reject before reserve or HTTP',()=>{
 for(const timeoutMs of [0,-1,1.5,NaN,Infinity,240001,360000,'240000',null])assert.throws(()=>setup({timeoutMs}),e=>e.stage==='document_configuration')
})
test('deadline cancels stalled body reader and retains only bounded private HTTP error prefix',async()=>{
 let cancelled=0,captured,signal
 const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('PRIVATE_PARTIAL_ERROR'))},cancel(){cancelled++}})
 const x=setup({timeoutMs:15,privateErrorCapture:async value=>{captured=value;return {state:'saved'}},fetchImpl:async(url,init)=>{signal=init.signal;return new Response(stream,{status:500})}})
 await assert.rejects(x.provider.extract(bundle),e=>e.diagnostics.category==='timeout'&&!JSON.stringify(e).includes('PRIVATE_PARTIAL_ERROR'))
 await flush();assert.equal(signal.aborted,true);assert.equal(cancelled,1);assert.equal(stream.locked,false)
 assert.equal(new TextDecoder().decode(captured.bytes),'PRIVATE_PARTIAL_ERROR');assert.equal(captured.readComplete,false);assert.equal(captured.readFailed,true)
 assert.equal(x.charges[0].costInUsdTicks,null);assert.equal(x.charges[0].chargedTicks,config.maxCostTicks)
})
test('late headers from noncooperative fetch are cancelled without capture or second settlement',async()=>{
 let finish,cancelled=0,captures=0
 const x=setup({timeoutMs:10,privateErrorCapture:async()=>{captures++},fetchImpl:async()=>new Promise(resolve=>{finish=resolve})})
 await assert.rejects(x.provider.extract(bundle),e=>e.diagnostics.category==='timeout')
 finish(new Response(new ReadableStream({cancel(){cancelled++}}),{status:500}));await flush()
 assert.equal(cancelled,1);assert.equal(captures,0);assert.equal(x.charges.length,1);assert.equal(x.charges[0].costInUsdTicks,null)
})
test('non-streaming reader accepts fragmented complete JSON but never SSE or disconnected partial JSON',async()=>{
 const raw=new TextEncoder().encode(JSON.stringify(envelope))
 const x=setup({timeoutMs:240000,fetchImpl:async()=>new Response(new ReadableStream({start(c){for(const b of raw)c.enqueue(Uint8Array.of(b));c.close()}}))})
 assert.deepEqual((await x.provider.extract(bundle)).extraction,{})
 for(const payload of ['data: '+JSON.stringify({type:'response.completed',response:envelope})+'\n\ndata: [DONE]\n\n','{"status":"completed"']){
  const bad=setup({timeoutMs:240000,fetchImpl:async()=>new Response(payload)})
  await assert.rejects(bad.provider.extract(bundle),e=>e.diagnostics.responseParse==='invalid_json');assert.equal(bad.charges[0].costInUsdTicks,null)
 }
})
test('actual CLI carries explicit deadline; dry run and used ledger remain gated offline',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'document-long-response-'))
 try{
  const preload=join(dir,'intercept.mjs'),calls=join(dir,'calls'),timers=join(dir,'timers'),ledger=join(dir,'ledger')
  await writeFile(preload,`import {appendFileSync} from 'node:fs'; const original=globalThis.setTimeout; globalThis.setTimeout=(fn,ms,...args)=>{if(ms===120000||ms===240000)appendFileSync(${JSON.stringify(timers)},ms+'\\n');return original(fn,ms,...args)}; globalThis.fetch=async(url,init)=>{appendFileSync(${JSON.stringify(calls)},'1'); const b=JSON.parse(init.body); if(b.store!==false||b.tools.length||Object.hasOwn(b,'tool_choice')||b.stream||b.background||b.max_output_tokens!==8000)throw Error('wire changed'); return new Response(JSON.stringify({error:{message:'PRIVATE_LONG_ERROR'},usage:{cost_in_usd_ticks:17}}),{status:400})};`)
  const env={PATH:process.env.PATH,HOME:process.env.HOME,XAI_API_KEY:'dummy-offline',XAI_DOCUMENT_MODEL:'grok-4.6',DOCUMENT_MAX_COST_TICKS:'2500000000',DOCUMENT_INPUT_TICKS_PER_TOKEN:'20000',DOCUMENT_OUTPUT_TICKS_PER_TOKEN:'60000',DOCUMENT_TRIAL_LEDGER:ledger,DOCUMENT_TIMEOUT_MS:'240000'}
  const run=(out,flags=[],extra={})=>spawnSync(process.execPath,['--experimental-default-type=module','--import',preload,'scripts/document-maintenance.mjs','--pdf',pdf,'--pages','561','--out',join(dir,out),...flags],{env:{...env,...extra},encoding:'utf8',timeout:15000})
  const flags=['--live-authorized','--document-privacy-reviewed']
  const result=run('first',flags);assert.equal(result.status,2,result.stderr)
  assert.equal(await readFile(timers,'utf8'),'240000\n')
  const summary=JSON.parse(await readFile(join(dir,'first/summary.json')));assert.equal(summary.timeoutMs,240000);assert.equal(summary.diagnostics.category,'http_rejection');assert.equal(summary.costInUsdTicks,17);assert.ok(!result.stdout.includes('PRIVATE_LONG_ERROR'))
  assert.equal(JSON.parse(await readFile(ledger+'.settled')).chargedTicks,17)
  assert.equal(run('reuse',flags).status,2);assert.equal(run('dry').status,0);assert.notEqual(run('blocked',['--live-authorized']).status,0)
  assert.notEqual(run('invalid',flags,{DOCUMENT_TIMEOUT_MS:'240001'}).status,0)
  assert.equal(await readFile(calls,'utf8'),'1')
  // Exercise the real CLI timeout/unknown-cost branch with a shortened test
  // clock, not a provider call or a four-minute wall-clock wait.
  await writeFile(preload,`import {appendFileSync} from 'node:fs'; const original=globalThis.setTimeout; globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms===240000?15:ms,...args); globalThis.fetch=async(url,init)=>{appendFileSync(${JSON.stringify(calls)},'T');init.signal.addEventListener('abort',()=>appendFileSync(${JSON.stringify(calls)},'A'),{once:true});return new Promise(()=>{})};`)
  const fresh=join(dir,'timeout-ledger'),timeoutEnv={DOCUMENT_TRIAL_LEDGER:fresh}
  const expired=run('timeout',flags,timeoutEnv);assert.equal(expired.status,2,expired.stderr)
  const timedSummary=JSON.parse(await readFile(join(dir,'timeout/summary.json')))
  assert.equal(timedSummary.timeoutMs,240000);assert.equal(timedSummary.diagnostics.category,'timeout');assert.equal(timedSummary.diagnostics.httpCategory,'no_response');assert.equal(timedSummary.costInUsdTicks,null)
  const settled=JSON.parse(await readFile(fresh+'.settled'));assert.equal(settled.costInUsdTicks,null);assert.equal(settled.chargedTicks,2500000000)
  assert.equal(run('timeout-reuse',flags,timeoutEnv).status,2);assert.equal(await readFile(calls,'utf8'),'1TA')
 }finally{await rm(dir,{recursive:true,force:true})}
})
