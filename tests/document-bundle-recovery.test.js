import test from 'node:test'
import assert from 'node:assert/strict'
import { readDocumentBundle, validateDocumentExtraction, buildDocumentExtractionRequest, extractDocumentRules } from '../supabase/functions/_shared/document-maintenance.js'
import { retrievePublicPdf } from '../scripts/public-document-retrieval.mjs'
const pdf='/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf'
const bundle=await readDocumentBundle(pdf,'560-573')
function response(){
 const evidence=bundle.pages.flatMap(p=>p.blocks.filter(b=>b.text.trim()).map(b=>({id:b.id,pdfPage:p.pdfPage,quote:b.text,role:'note'})))
 return {schemaVersion:2,sourceSha256:bundle.sourceSha256,evidence,rules:[{id:'synthetic',service:'Synthetic contract probe, not semantic extraction',action:'inspect',condition:{op:'always'},timing:{kind:'monitor',mode:'source_instruction',instruction:'Unresolved source requires review'},evidenceIds:[evidence[0].id],relatedEvidenceIds:[],overrides:[]}],ownerQuestions:[],unresolved:evidence.map(e=>({reason:'Synthetic transport: source semantics unresolved',evidenceIds:[e.id]})),coverage:bundle.pages.map(p=>({pdfPage:p.pdfPage,disposition:'needs_review',evidenceIds:evidence.filter(e=>e.pdfPage===p.pdfPage).map(e=>e.id)}))}
}
test('all blocks accounted is not semantic completeness; omissions explicitly flagged',()=>{
 const t=response();const v=validateDocumentExtraction(t,bundle)
 assert.equal(v.valid,true);assert.equal(v.coverageAccounting.allSelectedBlocksAccounted,true);assert.equal(v.semanticVerified,false)
 const nonSignal=t.evidence.find(e=>!bundle.contextSignals.some(s=>s.id===e.id)&&e.id!==t.rules[0].evidenceIds[0])
 t.unresolved=t.unresolved.filter(u=>!u.evidenceIds.includes(nonSignal.id))
 const missing=validateDocumentExtraction(t,bundle)
 assert.equal(missing.coverageAccounting.allSelectedBlocksAccounted,false)
 assert.ok(missing.coverageAccounting.missingBlockIds.includes(nonSignal.id))
 assert.equal(missing.applicable,false)
 assert.match(buildDocumentExtractionRequest(bundle).system,/Every nonempty source block/)
})
test('page range parser rejects malformed tokens instead of normalizing',async()=>{
 for(const selection of ['560-561-562','560,','+560','560.0','560--561']) await assert.rejects(readDocumentBundle(pdf,selection))
 await assert.rejects(readDocumentBundle('/nonexistent/document.pdf','1'))
})
test('retrieval failures are explicit before HTTP or storage, no invented PDF fallback',async()=>{
 for(const url of ['file:///missing/manual.pdf','http://example.com/manual.pdf','https://user:secret@example.com/manual.pdf']) await assert.rejects(retrievePublicPdf(url,'/nonexistent/no-write.pdf'),/Public HTTPS/)
 await assert.rejects(retrievePublicPdf('https://127.0.0.1/manual.pdf','/nonexistent/no-write.pdf'),/Non-public/)
})
test('scripted transport unknown fields and fabricated review flags rejected',async()=>{
 for(const mutate of [t=>t.rules[0].timing.kind='unknown',t=>t.rules[0].reviewed=true,t=>t.evidence[0].pdfPage=1,t=>t.rules[0].condition={op:'unknown'}]){
 const t=response();mutate(t);const r=await extractDocumentRules(bundle,{mode:'offline',transport:async()=>t});assert.equal(r.validation.valid,false)
 }
})
