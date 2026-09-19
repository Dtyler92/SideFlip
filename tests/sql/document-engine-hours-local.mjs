// Real disposable SQL roundtrip of an analyst-authored real-excerpt fixture.
// Not a provider response or an executable/reviewed manufacturer schedule.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {readDocumentBundle} from '../../supabase/functions/_shared/document-maintenance.js'
import {ingestDocumentMaintenance} from '../../supabase/functions/_shared/document-maintenance-ingestion.js'
import {localTemplateStorage} from '../../scripts/local-template-storage.mjs'
const source=JSON.parse(readFileSync(new URL('../fixtures/document-engine-hours-row.json',import.meta.url),'utf8'))
const bundle=await readDocumentBundle('/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf','569')
assert.equal(bundle.sourceSha256,source.sourceSha256)
const evidence=bundle.pages.flatMap(p=>p.blocks.filter(b=>b.text.trim()).map(b=>({id:b.id,pdfPage:p.pdfPage,quote:b.text,role:'row'})))
const row=evidence.find(e=>e.quote===source.quote.trim());assert.ok(row)
const extraction={schemaVersion:2,sourceSha256:source.sourceSha256,evidence,ownerQuestions:[],rules:[{id:'hours-row',service:'Fuel filters — unapproved contract fixture',action:'replace',condition:{op:'always'},timing:source.timing,evidenceIds:[row.id],relatedEvidenceIds:[],overrides:[]}],unresolved:evidence.map(e=>({reason:source.unresolved,evidenceIds:[e.id]})),coverage:[{pdfPage:569,disposition:'needs_review',evidenceIds:evidence.map(e=>e.id)}]}
const storage=localTemplateStorage(process.argv[2]),ownerId='11111111-1111-4111-8111-111111111111'
const result=await ingestDocumentMaintenance({extraction,bundle,templateKey:'engine-hours-real-excerpt',version:1,ownerId,storage,dryRun:false})
assert.equal(result.persisted,true);assert.equal(result.row.record.payload.rules[0].timing.interval.hours,600)
assert.deepEqual(result.row.record.payload.rules,extraction.rules);assert.equal(result.row.status,'needs_review');assert.equal(result.row.record.validation_report.auto_apply_allowed,false)
assert.equal(await storage.read('22222222-2222-4222-8222-222222222222',result.row.id),null)
assert.deepEqual(await storage.read(ownerId,result.row.id),result.row)
const promoted=structuredClone(result.row.record);promoted.version=2;promoted.status='reviewed';await assert.rejects(storage.append(ownerId,promoted))
const out='/root/sideflip-release-evidence/document-maintenance-pipeline/retained-ford-quality-pass/overnight-full-section/document-engine-hours-owner-readback.json'
writeFileSync(out,JSON.stringify({fixtureType:source.fixtureType,rows:[result.row]},null,2)+'\n')
console.log(JSON.stringify({result:'PASS',hours:600,status:result.row.status,wrongOwnerDenied:true,promotionDenied:true,readback:out}))
