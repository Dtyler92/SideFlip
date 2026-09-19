#!/usr/bin/env node
// Named synthetic response transport. NOT authentic AI or semantic extraction.
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readDocumentBundle, extractDocumentRules } from '../supabase/functions/_shared/document-maintenance.js'
const args=process.argv.slice(2),opts={}
for(let i=0;i<args.length;i+=2){
 if(!['--pdf','--pages','--out'].includes(args[i])||!args[i+1]||opts[args[i]])throw Error('Usage: --pdf PATH --pages RANGE --out NEW_DIRECTORY')
 opts[args[i]]=args[i+1]
}
if(!opts['--pdf']||!opts['--pages']||!opts['--out'])throw Error('PDF, explicit complete context page selection, and output directory required')
const out=resolve(opts['--out']);await mkdir(out,{recursive:true})
const save=(name,value)=>writeFile(resolve(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'})
const bundle=await readDocumentBundle(resolve(opts['--pdf']),opts['--pages'])
const evidence=bundle.pages.flatMap(p=>p.blocks.filter(b=>b.text.trim()).map(b=>({id:b.id,pdfPage:p.pdfPage,quote:b.text,role:'note'})))
if(!evidence.length)throw Error('No extractable text: OCR/layout review required; no substitute rules generated')
const response={schemaVersion:2,sourceSha256:bundle.sourceSha256,evidence,
 rules:[{id:'synthetic-source-review-probe',service:'SYNTHETIC transport contract probe — not a maintenance recommendation',action:'inspect',condition:{op:'always'},timing:{kind:'monitor',mode:'source_instruction',instruction:'No source semantics inferred. All document blocks remain unresolved for review.'},evidenceIds:[evidence[0].id],relatedEvidenceIds:[],overrides:[]}],
 ownerQuestions:[],unresolved:evidence.map(e=>({reason:'SYNTHETIC response: complete block retained; service meaning, table alignment and applicability NOT interpreted',evidenceIds:[e.id]})),
 coverage:bundle.pages.map(p=>({pdfPage:p.pdfPage,disposition:'needs_review',evidenceIds:evidence.filter(e=>e.pdfPage===p.pdfPage).map(e=>e.id)}))}
let transportCalls=0
const result=await extractDocumentRules(bundle,{mode:'offline',transport:async request=>{
 transportCalls++;if(request.document!==bundle||!request.responseSchema)throw Error('Incorrect transport request')
 return JSON.stringify(response)
}})
if(!result.validation.valid||!result.validation.coverageAccounting.allSelectedBlocksAccounted)throw Error(JSON.stringify(result.validation))
await save('synthetic-response-not-ai.json',response)
// Exercise the public CLI from fresh original bytes, not a trusted serialized bundle.
const cli=spawnSync(process.execPath,['--experimental-default-type=module',new URL('./document-maintenance.mjs',import.meta.url).pathname,'--pdf',resolve(opts['--pdf']),'--pages',opts['--pages'],'--out',resolve(out,'cli'),'--response',resolve(out,'synthetic-response-not-ai.json')],{encoding:'utf8',timeout:60000})
await writeFile(resolve(out,'cli-output.txt'),cli.stdout+cli.stderr,{flag:'wx'})
if(cli.status!==0)throw Error('CLI failed: '+cli.stderr)
const omitted=structuredClone(response)
const block=evidence.find(e=>e.id!==evidence[0].id&&!bundle.contextSignals.some(s=>s.id===e.id))
if(!block)throw Error('No non-context omission probe available')
omitted.unresolved=omitted.unresolved.filter(u=>!u.evidenceIds.includes(block.id))
const omission=await extractDocumentRules(bundle,{mode:'offline',transport:async()=>omitted})
if(!omission.validation.coverageAccounting.missingBlockIds.includes(block.id))throw Error('Silent omission accepted')
await save('omission-validation.json',omission.validation)
const report={kind:'named_synthetic_response_NOT_authentic_AI',sourceSha256:bundle.sourceSha256,pageCount:bundle.pageCount,selectedPages:bundle.selectedPages,transportCalls,providerCalled:false,stored:false,cliExitCode:cli.status,rules:response.rules.length,unresolved:response.unresolved.length,contextSignals:bundle.contextSignals.length,validation:result.validation,omissionDetected:block.id,semanticExtractionComplete:false}
await save('exercise-summary.json',report)
console.log(JSON.stringify(report,null,2))
