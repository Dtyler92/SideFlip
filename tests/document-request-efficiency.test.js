import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {readDocumentBundle,buildDocumentExtractionRequest,validateDocumentExtraction,extractDocumentRules,previewDocumentRules} from '../supabase/functions/_shared/document-maintenance.js'
import {createXaiDocumentAdapter} from '../supabase/functions/maintenance-research-worker/xai-document-adapter.js'
const pdf='/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf'
const bundle=await readDocumentBundle(pdf,'561')
const config={apiKey:'offline-dummy',model:'grok-4.6',authorized:true,documentPrivacyReviewed:true,maxCostTicks:2500000000,inputTicksPerToken:20000,outputTicksPerToken:60000}
const envelope={model:config.model,status:'completed',usage:{cost_in_usd_ticks:17},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'{}'}]}]}
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve()}
test('compact wire preserves actual-source quote/coverage/unknown-owner review gates offline',async()=>{
 const evidence=bundle.pages.flatMap(p=>p.blocks.filter(b=>b.text.trim()).map(b=>({id:b.id,pdfPage:p.pdfPage,quote:b.text,role:'note'})))
 const synthetic={schemaVersion:2,sourceSha256:bundle.sourceSha256,evidence,ownerQuestions:[{field:'synthetic_unknown',type:'boolean',question:'Synthetic contract question, not extracted semantics?',evidenceIds:[evidence[0].id]}],rules:[{id:'synthetic',service:'Offline contract probe only',action:'inspect',condition:{op:'eq',field:'synthetic_unknown',value:true},timing:{kind:'monitor',mode:'source_instruction',instruction:'Synthetic; all semantics unresolved'},evidenceIds:[evidence[0].id],relatedEvidenceIds:[],overrides:[]}],unresolved:evidence.map(e=>({reason:'Synthetic offline: semantics unresolved',evidenceIds:[e.id]})),coverage:[{pdfPage:561,disposition:'needs_review',evidenceIds:evidence.map(e=>e.id)}]}
 const adapter=createXaiDocumentAdapter({...config,reserve:async()=>({settle:async()=>{}}),fetchImpl:async()=>new Response(JSON.stringify({...envelope,output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(synthetic)}]}]}))})
 const result=await extractDocumentRules(bundle,{provider:adapter,mode:'live_explicitly_authorized'})
 assert.equal(result.validation.valid,true);assert.equal(result.validation.coverageAccounting.allSelectedBlocksAccounted,true)
 assert.equal(result.validation.semanticVerified,false);assert.equal(result.validation.applicable,false)
 const preview=previewDocumentRules(synthetic,bundle)[0];assert.equal(preview.conditionResult,'unknown');assert.equal(preview.applicable,false)
 const omitted=structuredClone(synthetic);omitted.unresolved=omitted.unresolved.filter(u=>!u.evidenceIds.includes('p561b3'))
 assert.ok(validateDocumentExtraction(omitted,bundle).coverageAccounting.missingBlockIds.includes('p561b3'))
 for(const change of [t=>t.evidence[0].quote='invented claim',t=>t.sourceSha256='0'.repeat(64),t=>t.coverage=[]]){
  const bad=structuredClone(synthetic);change(bad);assert.equal(validateDocumentExtraction(bad,bundle).valid,false)
 }
})
test('deadline does not await noncooperative underlying body cancellation',async()=>{
 let cancelled=false;const charges=[]
 const stream=new ReadableStream({cancel(){cancelled=true;return new Promise(()=>{})}})
 const adapter=createXaiDocumentAdapter({...config,timeoutMs:10,reserve:async()=>({settle:async u=>charges.push(u)}),fetchImpl:async()=>new Response(stream)})
 await assert.rejects(adapter.extract(bundle),e=>e.diagnostics.category==='timeout')
 await flush();assert.equal(cancelled,true);assert.equal(stream.locked,false)
 assert.equal(charges.length,1);assert.equal(charges[0].costInUsdTicks,null);assert.equal(charges[0].chargedTicks,config.maxCostTicks)
})
test('actual Ford wire removes only exactly reconstructable page text and redundant contract',async()=>{
 const retained=JSON.parse(await readFile('/root/sideflip-release-evidence/document-maintenance-pipeline/ford-corrected-live-verification/sanitized-request.json'))
 const before=JSON.stringify(bundle),request=buildDocumentExtractionRequest(bundle)
 let wire,reserved
 const adapter=createXaiDocumentAdapter({...config,reserve:async r=>{reserved=r;return {settle:async()=>{}}},fetchImpl:async(_url,init)=>{wire=JSON.parse(init.body);return new Response(JSON.stringify(envelope))}})
 await adapter.extract(bundle)
 const input=JSON.parse(wire.input[1].content),old=JSON.parse(retained.body.input[1].content)
 assert.equal(Object.hasOwn(input,'contract'),false)
 assert.equal(Object.hasOwn(old.responseSchema.$defs.interval.properties,'hours'),false)
 // Explicit additive schema delta, not a rewrite of retained historical wire.
 old.responseSchema.$defs.interval.properties.hours={type:'integer',minimum:1,maximum:10000000}
 assert.deepEqual(input.responseSchema,old.responseSchema)
 assert.equal(wire.input[0].content,request.system)
 assert.deepEqual(input.document.contextSignals,bundle.contextSignals)
 for(let i=0;i<bundle.pages.length;i++){
  const page=bundle.pages[i],sent=input.document.pages[i]
  assert.equal(Object.hasOwn(sent,'text'),false)
  assert.equal(sent.blocks.map(b=>b.text).join('\n')+'\n',page.text)
  assert.deepEqual({...sent,text:page.text},page)
 }
 const restored=structuredClone(input);restored.contract=old.contract
 restored.document.pages.forEach((p,i)=>{p.text=bundle.pages[i].text})
  restored.document.pages.forEach(p=>{
    // New deterministic footer metadata is additive, not part of historical wire.
    delete p.printedPage; delete p.printedPageEvidence
  })
  assert.deepEqual(restored,old)
 assert.equal(JSON.stringify(bundle),before)
 assert.ok(Buffer.byteLength(JSON.stringify(wire))<Buffer.byteLength(JSON.stringify(retained.body)))
 assert.equal(reserved.estimatedCeilingTicks,(Buffer.byteLength(JSON.stringify(wire))+4096)*config.inputTicksPerToken+8000*config.outputTicksPerToken)
 // Request projection never substitutes an AI claim for independently read identity.
 assert.equal(validateDocumentExtraction({},structuredClone(bundle)).valid,false)
})
test('complete HTTP error usage survives local capture crossing remote deadline; capture is awaited',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 let saveDone,capturing=false,finished=false;const charges=[]
 const adapter=createXaiDocumentAdapter({...config,timeoutMs:120000,reserve:async()=>({settle:async u=>charges.push(u)}),privateErrorCapture:async()=>{capturing=true;await new Promise(resolve=>{saveDone=resolve});return {state:'saved'}},fetchImpl:async()=>new Response(JSON.stringify({error:{message:'PRIVATE'},usage:{cost_in_usd_ticks:17}}),{status:400})})
 const pending=assert.rejects(adapter.extract(bundle),e=>e.diagnostics.category==='http_rejection'&&e.costInUsdTicks===17).then(()=>{finished=true})
 await flush();assert.equal(capturing,true)
 t.mock.timers.tick(120001);await flush();assert.equal(finished,false);assert.equal(charges.length,0)
 saveDone();await pending;assert.equal(charges[0].costInUsdTicks,17);assert.equal(charges[0].chargedTicks,17)
})
