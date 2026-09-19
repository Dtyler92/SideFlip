import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
const pdf='/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf'
const privateText='PRIVATE_BODY_VIN_KEY_HEADER'
const cases=[
 ['provider-detail',`return new Response(JSON.stringify({error:{type:'invalid_request_error',code:'unsupported_parameter',param:'parallel_tool_calls',message:'${privateText}'}}),{status:400})`, 'http_rejection',400,null,'parsed'],
 ['provider-unknown',`return new Response(JSON.stringify({code:'${privateText}',error:'${privateText}'}),{status:400})`, 'http_rejection',400,null,'parsed'],
 ['unknown',`throw Object.assign(new Error('${privateText}'),{code:'${privateText}'})`, 'transport_error',null,'unknown','not_started'],
 ['dns',`throw Object.assign(new Error('${privateText}'),{cause:{code:'ENOTFOUND'}})`, 'transport_error',null,'dns','not_started'],
 ['stream-limit',`return new Response('x'.repeat(1000001))`, 'response_limit',200,null,'too_large'],
 ['envelope',`return new Response(JSON.stringify({status:'incomplete',error:'${privateText}'}))`, 'envelope_validation',200,null,'parsed'],
 ['http',`return new Response('${privateText}',{status:429,headers:{'x-request-id':'${privateText}'}})`, 'http_rejection',429,null,'invalid_json'],
 ['reset',`throw Object.assign(new Error('${privateText}'),{cause:{code:'ECONNRESET'}})`, 'transport_error',null,'reset','not_started'],
 ['abort',`throw Object.assign(new Error('${privateText}'),{name:'AbortError'})`, 'transport_error',null,'abort','not_started'],
 ['json',`return new Response('${privateText}')`, 'response_parse',200,null,'invalid_json'],
 ['read',`return new Response(new ReadableStream({start(c){c.error(Object.assign(new Error('${privateText}'),{code:'ECONNRESET'}))}}))`, 'response_read',200,'reset','read_failed'],
 ['limit',`return new Response('x',{headers:{'content-length':'1000001'}})`, 'response_limit',200,null,'too_large'],
 ['known',`return new Response(JSON.stringify({usage:{cost_in_usd_ticks:17},error:'${privateText}'}),{status:503})`, 'http_rejection',503,null,'parsed'],
]
for(const [name,stub,category,status,transportKind,responseParse] of cases)test(`actual CLI offline diagnostics: ${name}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'document-diagnostics-'))
 try {
  const preload=join(dir,'intercept.mjs'),calls=join(dir,'calls'),ledger=join(dir,'ledger')
  await writeFile(preload,`import {appendFileSync} from 'node:fs'; globalThis.fetch=async()=>{appendFileSync(${JSON.stringify(calls)},'1');${stub}};`)
  const env={PATH:process.env.PATH,HOME:process.env.HOME,XAI_API_KEY:'dummy-offline',XAI_DOCUMENT_MODEL:'grok-4.6',DOCUMENT_MAX_COST_TICKS:'10000000000',DOCUMENT_INPUT_TICKS_PER_TOKEN:'1',DOCUMENT_OUTPUT_TICKS_PER_TOKEN:'1',DOCUMENT_TRIAL_LEDGER:ledger}
  const run=(out,flags)=>spawnSync(process.execPath,['--experimental-default-type=module','--import',preload,'scripts/document-maintenance.mjs','--pdf',pdf,'--pages','560','--out',join(dir,out),...flags],{env,encoding:'utf8',timeout:15000})
  const flags=['--live-authorized','--document-privacy-reviewed']
  const result=run('first',flags);assert.equal(result.status,2,result.stderr)
  const summary=JSON.parse(await readFile(join(dir,'first/summary.json')))
  const providerError=status>=400&&responseParse==='parsed'?{providerError:name==='provider-detail'?{type:'invalid_request_error',code:'unsupported_parameter',param:'parallel_tool_calls',reason:'unsupported_parameter'}:{type:'unknown',code:'unknown',param:'unknown',reason:'unknown'}}:{}
  assert.deepEqual(summary.diagnostics,{category,httpStatus:status,httpCategory:status===null?'no_response':status>=500?'server_error':status>=400?'client_error':'success',transportKind,responseParse,...providerError})
  const known=name==='known'?17:null
  assert.equal(summary.costInUsdTicks,known);assert.equal(summary.providerCalled,true);assert.equal(summary.stored,false)
  const settled=JSON.parse(await readFile(ledger+'.settled'));assert.equal(settled.costInUsdTicks,known);assert.equal(settled.chargedTicks,known??10000000000)
  assert.ok(!(result.stdout+result.stderr+JSON.stringify(summary)+JSON.stringify(settled)).includes(privateText))
  const again=run('again',flags);assert.equal(again.status,2);assert.equal(JSON.parse(await readFile(join(dir,'again/summary.json'))).stage,'document_reservation')
  assert.equal(await readFile(calls,'utf8'),'1')
  const dry=run('dry',[]);assert.equal(dry.status,0);assert.equal(JSON.parse(dry.stdout).providerCalled,false)
  const blocked=run('blocked',['--live-authorized']);assert.notEqual(blocked.status,0);assert.equal(await readFile(calls,'utf8'),'1')
 }finally{await rm(dir,{recursive:true,force:true})}
})
