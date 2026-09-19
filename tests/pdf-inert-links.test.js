import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {readDocumentBundle} from '../supabase/functions/_shared/document-maintenance.js'
import {createXaiDocumentAdapter} from '../supabase/functions/maintenance-research-worker/xai-document-adapter.js'
const safe=['https','http','internal','goto','named','indirect','schemeless']
const unsafe=['javascript','credentials','control','space','scheme-trick','backslash','bad-port','malformed-percent','contents','author','unknown','hidden-metadata','aa','chain','launch','remote','embedded','unknown-action','bad-dest','generation','cycle','both','nonlink','geometry','text','widget','attachment','mixed','orphan-unsafe','orphan-script']
const oddFields=['BS','NM','AP','F','P','C','H','QuadPoints','Popup','M','CreationDate','RC','Subj']
unsafe.push(...oddFields.map(field=>'bare-field-'+field),'bare-action-extra','bare-uri-name','bare-uri-number')
const bareCases=JSON.parse(await readFile(new URL('./fixtures/inert-bare-host-cases.json',import.meta.url),'utf8'))
for(const [kind,entry] of Object.entries(bareCases))(entry.safe?safe:unsafe).push(kind)
for(const selection of ['1','1-2'])for(const kind of [...safe,...unsafe])test(`inert-link policy generated ${kind} pages=${selection}: whole original, wire exclusion`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'inert-policy-'));let calls=0
 const provider=createXaiDocumentAdapter({apiKey:'offline-fixture',model:'grok-4.6',authorized:true,documentPrivacyReviewed:true,maxCostTicks:100000000,inputTicksPerToken:1,outputTicksPerToken:1,maxOutputTokens:8000,reserve:async()=>({settle:async()=>{}}),fetchImpl:async(_u,init)=>{
  calls++;if(bareCases[kind])assert.equal(init.body.includes(bareCases[kind].value),false)
  for(const privateValue of ['www.example.com','www.wirelessconformity.ford.com','annotation-canary.example','ONLY_IN_ANNOTATION_984771','HIDDEN_PRIVATE_CANARY_984771'])assert.equal(init.body.includes(privateValue),false)
  assert.ok(init.body.includes('https://public.example/manual-body'))
  const body=JSON.parse(init.body);assert.deepEqual(body.tools,[]);assert.equal(body.store,false)
  return new Response(JSON.stringify({status:'completed',model:'grok-4.6',usage:{cost_in_usd_ticks:7},output:[{type:'message',status:'completed',content:[{type:'output_text',text:'{}'}]}]}))
 }})
 try{
  const path=join(dir,'original.pdf');execFileSync('python3',['tests/helpers/inert-link-fixture.py',path,kind]);const before=await readFile(path)
  const attempt=async()=>{const bundle=await readDocumentBundle(path,selection,{rejectPrivateAnnotations:true});assert.equal(JSON.stringify(bundle).includes('ONLY_IN_ANNOTATION'),false);await provider.extract(bundle)}
  if(safe.includes(kind)){await attempt();assert.equal(calls,1)}else{await assert.rejects(attempt(),/Private annotations/);assert.equal(calls,0)}
  assert.deepEqual(await readFile(path),before)
 }finally{await rm(dir,{recursive:true,force:true})}
})

const rawUnsafe=['duplicate-action','duplicate-action-private-goto','duplicate-uri-nul','duplicate-uri-javascript','duplicate-dest-private','duplicate-rect-private','duplicate-subtype','duplicate-encoded-uri','duplicate-comment-whitespace','ref-depth','objstm-duplicate']
const rawSafe=['safe-string-lookalike','safe-stream-lookalike','objstm-safe','ref-depth-32']
for(const selection of ['1','1-2'])for(const kind of [...rawUnsafe,...rawSafe])test(`raw inert-link preflight ${kind} pages=${selection}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'raw-inert-policy-'));let calls=0
 const provider=createXaiDocumentAdapter({apiKey:'offline-fixture',model:'grok-4.6',authorized:true,documentPrivacyReviewed:true,maxCostTicks:100000000,inputTicksPerToken:1,outputTicksPerToken:1,maxOutputTokens:8000,reserve:async()=>({settle:async()=>{}}),fetchImpl:async(_u,init)=>{
  calls++;for(const value of ['RAW_PRIVATE_CANARY_712934','annotation-canary.example'])assert.equal(init.body.includes(value),false)
  return new Response(JSON.stringify({status:'completed',model:'grok-4.6',usage:{cost_in_usd_ticks:7},output:[{type:'message',status:'completed',content:[{type:'output_text',text:'{}'}]}]}))
 }})
 try{
  const path=join(dir,'original.pdf')
  execFileSync('python3',['tests/helpers/raw-pdf-fixture.py',path,kind])
  const before=await readFile(path)
  const attempt=async()=>{const bundle=await readDocumentBundle(path,selection,{rejectPrivateAnnotations:true});await provider.extract(bundle);return bundle}
  if(rawSafe.includes(kind)){
   const bundle=await attempt()
   assert.ok(JSON.stringify(bundle).includes('https://public.example/manual-body'))
   assert.equal(calls,1)
  }else{await assert.rejects(attempt(),/Private annotations/);assert.equal(calls,0)}
  assert.deepEqual(await readFile(path),before)
 }finally{await rm(dir,{recursive:true,force:true})}
})

for(const selection of ['1','1-2'])for(const kind of ['hybrid-duplicate','hybrid-alias'])test(`raw inert-link preflight rejects unsupported ${kind} pages=${selection} before provider`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'raw-hybrid-policy-'));let calls=0
 try{
  const path=join(dir,'original.pdf')
  execFileSync('python3',['tests/helpers/raw-hybrid-fixture.py',path,kind])
  const before=await readFile(path)
  const attempt=async()=>{await readDocumentBundle(path,selection,{rejectPrivateAnnotations:true});calls++}
  await assert.rejects(attempt(),/Private annotations/)
  assert.equal(calls,0)
  assert.deepEqual(await readFile(path),before)
 }finally{await rm(dir,{recursive:true,force:true})}
})
