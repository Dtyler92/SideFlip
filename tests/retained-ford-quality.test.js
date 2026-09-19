import test from 'node:test'
import assert from 'node:assert/strict'
import {readDocumentBundle,buildDocumentExtractionRequest} from '../supabase/functions/_shared/document-maintenance.js'
import {readFileSync,mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
import {validateDocumentExtraction,previewDocumentRules} from '../supabase/functions/_shared/document-maintenance.js'
import {ingestDocumentMaintenance} from '../supabase/functions/_shared/document-maintenance-ingestion.js'
const fixture=name=>JSON.parse(readFileSync(new URL('./fixtures/'+name,import.meta.url)))
const original=fixture('ford-retained-live-extraction.json'),corrected=fixture('ford-retained-local-correction.json')
const pdf='/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf'
test('printed folio is bound to original PDF footer, not PDF index or model claims',async()=>{
 const b=await readDocumentBundle(pdf,'561'); const p=b.pages[0]
 assert.equal(p.printedPage,558)
 assert.equal(p.printedPageEvidence.blockId,'p561b13')
 assert.equal(p.printedPageEvidence.quote,'558')
 assert.equal(p.printedPageEvidence.method,'isolated_centered_numeric_footer')
 assert.equal(p.blocks.find(x=>x.id===p.printedPageEvidence.blockId).text,p.printedPageEvidence.quote)
})
test('generic prompt teaches existing instruction modes without invented intervals or applicability',async()=>{
 const r=buildDocumentExtractionRequest(await readDocumentBundle(pdf,'561'))
 for(const text of ['source_instruction','inspection_finding','every refueling','immediately','vehicle class','discoloration alone','each service']) assert.ok(r.system.includes(text),text)
 assert.ok(!r.system.includes('Ford'))
})
test('retained real output and authored correction bind every original block without promoting trust',async()=>{
 const b=await readDocumentBundle(pdf,'561')
 const retained=JSON.parse(readFileSync('/root/sideflip-release-evidence/document-maintenance-pipeline/ford-low-reasoning-live-verification/live/review-record.json'))
 assert.deepEqual(original,retained.payload)
 assert.equal(original.rules.length,2);assert.equal(corrected.rules.length,4)
 assert.deepEqual(corrected.rules.slice(0,2),original.rules)
 assert.deepEqual(corrected.evidence,original.evidence)
 for(const t of [original,corrected]) {
  const v=validateDocumentExtraction(t,b)
  assert.deepEqual(v.errors,[]);assert.equal(v.coverageAccounting.accountedBlockCount,16)
  assert.equal(v.semanticVerified,false);assert.equal(v.sourceAuthenticated,false);assert.equal(v.applicable,false)
  const {record}=await ingestDocumentMaintenance({extraction:t,bundle:b,templateKey:'retained-quality',version:1})
  assert.deepEqual(JSON.parse(JSON.stringify(record)).payload.rules,t.rules)
  assert.equal(record.payload.documentBundle.pages[0].printedPage,558)
  assert.equal(record.validation_report.auto_apply_allowed,false)
 }
 assert.equal(corrected.unresolved.length,6)
 assert.equal(corrected.ownerQuestions.length,7)
 assert.ok(corrected.unresolved.some(u=>u.evidenceIds.includes('e561-b12')))
 for(const e of corrected.evidence) assert.ok(b.pages[0].blocks.some(block=>block.text===e.quote))
 for(const r of corrected.rules.slice(2)){
  assert.notEqual(r.action,'replace');assert.equal(r.timing.interval,undefined)
  assert.equal(r.timing.responseWindow,undefined)
 }
})
test('local additions preserve scoped unknown, class/use AND, finding AND/OR and review-only selection',async()=>{
 const b=await readDocumentBundle(pdf,'561')
 const check=answers=>previewDocumentRules(corrected,b,answers).slice(2)
 assert.deepEqual(check({}).map(r=>r.conditionResult),['unknown','unknown'])
 assert.equal(check({high_performance_vehicle:true})[0].conditionResult,'unknown')
 assert.equal(check({high_performance_vehicle:false,high_oil_consumption_use:true})[0].conditionResult,false)
 assert.equal(check({high_performance_vehicle:true,high_oil_consumption_use:true})[0].conditionResult,true)
 assert.equal(check({fluid_discolored:true,fluid_overheating_signs:false,fluid_foreign_material_contamination:false})[1].conditionResult,false)
 assert.equal(check({fluid_discolored:false,fluid_overheating_signs:true})[1].conditionResult,false)
 for(const field of ['fluid_overheating_signs','fluid_foreign_material_contamination']) {
  const rows=check({fluid_discolored:true,[field]:true})
  assert.equal(rows[1].conditionResult,true);assert.ok(rows.every(r=>r.selection==='needs_review'&&!r.applicable))
 }
 const bad=structuredClone(corrected);bad.rules[2].timing.interval={miles:500}
 assert.equal(validateDocumentExtraction(bad,b).valid,false)
 bad.rules[2].timing=corrected.rules[2].timing;bad.evidence[2].quote='Invented source'
 assert.equal(validateDocumentExtraction(bad,b).valid,false)
})
test('footer extraction abstains on absent, off-center, ambiguous and body numerals',async()=>{
 const dir=mkdtempSync(tmpdir()+'/folio-quality-')
 try {
  const path=dir+'/sample.pdf'
  execFileSync('python3',['-c',`import fitz,sys
D=fitz.open()
for positions in [[],[(190,300,'31')],[(20,510,'31')],[(190,510,'31'),(290,510,'32')],[(190,510,'31')]]:
 p=D.new_page(width=400,height=550)
 p.insert_text((20,100),'Synthetic footer classification fixture; not maintenance evidence')
 for x,y,text in positions: p.insert_text((x,y),text)
D.save(sys.argv[1])`,path])
  const b=await readDocumentBundle(path,'1-5')
  assert.deepEqual(b.pages.map(p=>p.printedPage),[undefined,undefined,undefined,undefined,31])
  assert.equal(b.pages[4].printedPageEvidence.status,'extracted_unreviewed')
 }finally{rmSync(dir,{recursive:true,force:true})}
})
