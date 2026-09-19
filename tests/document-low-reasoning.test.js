import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createXaiDocumentAdapter} from '../supabase/functions/maintenance-research-worker/xai-document-adapter.js'
import {readDocumentBundle,buildDocumentExtractionRequest} from '../supabase/functions/_shared/document-maintenance.js'
const evidence='/root/sideflip-release-evidence/document-maintenance-pipeline'
const pdf='/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf'
const baseline=JSON.parse(await readFile(join(evidence,'efficiency-and-timeout-review/offline-compact-request.json')))
const bundle=await readDocumentBundle(pdf,'561')
// Retain historical wire on disk; advance only explicit local quality deltas.
// Dedicated quality tests independently verify prompt semantics and footer binding.
baseline.input[0].content=buildDocumentExtractionRequest(bundle).system
const baselineInput=JSON.parse(baseline.input[1].content)
// Explicit additive v2 hours contract delta; historical artifact stays unchanged.
assert.equal(Object.hasOwn(baselineInput.responseSchema.$defs.interval.properties,'hours'),false)
baselineInput.responseSchema.$defs.interval.properties.hours={type:'integer',minimum:1,maximum:10000000}
for(const page of baselineInput.document.pages){
 const fresh=bundle.pages.find(p=>p.pdfPage===page.pdfPage)
 if(fresh.printedPage!==undefined){page.printedPage=fresh.printedPage;page.printedPageEvidence=fresh.printedPageEvidence}
}
baseline.input[1].content=JSON.stringify(baselineInput)
const config={apiKey:'dummy-offline-low',model:'grok-4.6',authorized:true,documentPrivacyReviewed:true,maxCostTicks:2500000000,inputTicksPerToken:44000,outputTicksPerToken:132000}
const envelope=model=>({model,status:'completed',usage:{cost_in_usd_ticks:17},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'{}'}]}]})
test('exact document model adds only documented low effort to optimized wire',async()=>{
 let wire,reserved,calls=0
 const adapter=createXaiDocumentAdapter({...config,reserve:async r=>{reserved=r;return {settle:async()=>{}}},fetchImpl:async(url,init)=>{calls++;assert.equal(url,'https://api.x.ai/v1/responses');assert.equal(init.redirect,'error');wire=JSON.parse(init.body);return new Response(JSON.stringify(envelope(config.model)))}})
 await adapter.extract(bundle)
 assert.deepEqual(wire,{...baseline,reasoning:{effort:'low'}})
 assert.equal(calls,1)
 assert.equal(reserved.estimatedCeilingTicks,(Buffer.byteLength(JSON.stringify(wire))+4096)*config.inputTicksPerToken+8000*config.outputTicksPerToken)
})
test('unreviewed model identities retain omitted reasoning, without inferred capabilities',async()=>{
 for(const model of ['grok-4.5','grok-4.6-latest','GROK-4.6','grok-4.20-multi-agent','unknown-model']){
  let wire
  const adapter=createXaiDocumentAdapter({...config,model,reserve:async()=>({settle:async()=>{}}),fetchImpl:async(_url,init)=>{wire=JSON.parse(init.body);return new Response(JSON.stringify(envelope(model)))}})
  await adapter.extract(bundle);assert.deepEqual(wire,{...baseline,model});assert.equal(Object.hasOwn(wire,'reasoning'),false)
 }
})
test('actual CLI low wire is exact; known and unknown errors stay private, single-use and gated offline',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'document-low-reasoning-'))
 try{
  const preload=join(dir,'intercept.mjs'),calls=join(dir,'calls'),wire=join(dir,'wire.json')
  await writeFile(preload,`import {appendFileSync,writeFileSync} from 'node:fs';globalThis.fetch=async(url,init)=>{appendFileSync(${JSON.stringify(calls)},'1');writeFileSync(${JSON.stringify(wire)},init.body);return new Response(JSON.stringify({error:{message:'PRIVATE_LOW_ERROR dummy-offline-low'},...(process.env.MOCK_KNOWN==='yes'?{usage:{cost_in_usd_ticks:17}}:{})}),{status:400})};`)
  const env={PATH:process.env.PATH,HOME:process.env.HOME,XAI_API_KEY:'dummy-offline-low',XAI_DOCUMENT_MODEL:'grok-4.6',DOCUMENT_MAX_COST_TICKS:'2500000000',DOCUMENT_INPUT_TICKS_PER_TOKEN:'44000',DOCUMENT_OUTPUT_TICKS_PER_TOKEN:'132000'}
  const run=(out,ledger,flags=[],known='yes')=>spawnSync(process.execPath,['--experimental-default-type=module','--import',preload,'scripts/document-maintenance.mjs','--pdf',pdf,'--pages','561','--out',join(dir,out),...flags],{env:{...env,DOCUMENT_TRIAL_LEDGER:ledger,MOCK_KNOWN:known},encoding:'utf8',timeout:15000})
  const flags=['--live-authorized','--document-privacy-reviewed']
  for(const known of ['yes','no']){
   const ledger=join(dir,'ledger-'+known),result=run(known,ledger,flags,known)
   assert.equal(result.status,2,result.stderr)
   assert.deepEqual(JSON.parse(await readFile(wire)),{...baseline,reasoning:{effort:'low'}})
   const summary=JSON.parse(await readFile(join(dir,known,'summary.json'))),settled=JSON.parse(await readFile(ledger+'.settled'))
   assert.equal(summary.diagnostics.category,'http_rejection');assert.equal(summary.costInUsdTicks,known==='yes'?17:null)
   assert.equal(summary.timeoutMs,120000);assert.equal(settled.chargedTicks,known==='yes'?17:2500000000)
   for(const secret of ['PRIVATE_LOW_ERROR','dummy-offline-low'])assert.ok(!(result.stdout+result.stderr+JSON.stringify(summary)).includes(secret))
   assert.equal(run('reuse-'+known,ledger,flags,known).status,2)
  }
  assert.equal(run('dry',join(dir,'unused')).status,0)
  assert.notEqual(run('blocked',join(dir,'unused'),['--live-authorized']).status,0)
  assert.equal(await readFile(calls,'utf8'),'11')
  // Optional local evidence retention contains no credentials or raw errors.
  if(process.env.LOW_REASONING_EVIDENCE_DIR){
   await writeFile(join(process.env.LOW_REASONING_EVIDENCE_DIR,'actual-cli-wire.json'),await readFile(wire))
   await writeFile(join(process.env.LOW_REASONING_EVIDENCE_DIR,'cli-verification.json'),JSON.stringify({interceptedCalls:2,paidCalls:0,wireEqualsBaselinePlusLow:true,knownCharge:17,unknownCharge:2500000000,dryRunAndPrivacyAndReuseGated:true},null,2))
  }
 }finally{await rm(dir,{recursive:true,force:true})}
})
