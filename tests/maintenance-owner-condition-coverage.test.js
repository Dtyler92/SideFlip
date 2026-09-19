import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evaluateCondition, selectTemplateRules, validateMaintenanceTemplate } from '../supabase/functions/_shared/maintenance-templates.js'
const t=JSON.parse(readFileSync(new URL('./fixtures/scion-2012-xd-template.json',import.meta.url)))
const raw=JSON.parse(readFileSync(new URL('./fixtures/scion-2012-xd-source-rows.json',import.meta.url)))
const primary=t.ownerQuestions.filter(q=>q.field.startsWith('primarily_')).map(q=>q.field)
const normal=Object.fromEntries(primary.map(f=>[f,false]))
const oil=a=>selectTemplateRules(t,a).filter(r=>r.service==='Engine oil and oil filter')

test('fresh source coverage has exact rows, rules, evidence and question dependencies',()=>{
 assert.deepEqual(validateMaintenanceTemplate(t),{valid:true,errors:[]})
 assert.equal(t.rules.length,56);assert.equal(t.evidence.length,359)
 assert.equal(raw.rows.length,338);assert.equal(raw.headings.length,24);assert.equal(raw.explanations.length,20)
 assert.equal(t.pages.length,56)
 const fields=new Set(t.ownerQuestions.map(q=>q.field));assert.equal(fields.size,t.ownerQuestions.length)
 function visit(c){if(c.field)assert.ok(fields.has(c.field),c.field);if(c.arg)visit(c.arg);for(const a of c.args||[])visit(a)}
 for(const r of t.rules)visit(r.condition)
 for(const q of t.ownerQuestions)assert.equal(q.unknownAllowed,true)
 const evidence=new Map(t.evidence.map(e=>[e.id,e]))
 const norm=s=>s.replace(/\s+/g,' ').trim()
 for(const e of evidence.values())assert.ok(norm(t.pages[e.pdfPage-1].text).includes(norm(e.quote)),e.id)
 for(const row of raw.rows)for(const id of row.evidenceIds)assert.ok(t.rules.some(r=>r.evidenceIds.includes(id)),id)
})

test('all three-valued AND OR and NOT combinations preserve unknown',()=>{
 const states=[true,false,null];const atom=f=>({op:'eq',field:f,value:true})
 for(const a of states)for(const b of states){
  const all=a===false||b===false?false:a===null||b===null?'unknown':true
  const any=a===true||b===true?true:a===null||b===null?'unknown':false
  assert.equal(evaluateCondition({op:'all',args:[atom('a'),atom('b')]},{a,b}),all)
  assert.equal(evaluateCondition({op:'any',args:[atom('a'),atom('b')]},{a,b}),any)
 }
 for(const a of states)assert.equal(evaluateCondition({op:'not',arg:atom('a')},{a}),a===null?'unknown':!a)
})

test('each unanswered special-use question blocks longest oil interval',()=>{
 for(const field of primary)for(const value of [null,undefined,'unknown']){
  const selected=oil({...normal,oil_spec:'0W-20',[field]:value})
  assert.equal(selected.find(r=>r.id==='oil-normal').selection,'needs_information',field)
  assert.equal(selected.filter(r=>r.selection==='applicable').length,0)
 }
 for(const oil_spec of [null,undefined,'unknown','synthetic','full synthetic','']){
  assert.equal(oil({...normal,oil_spec}).filter(r=>r.selection==='applicable').length,0)
 }
})

test('all 81 primary-use combinations select no default longest interval',()=>{
 const states=[true,false,null]
 for(const a of states)for(const b of states)for(const c of states)for(const d of states){
  const values=[a,b,c,d],answers={oil_spec:'0W-20',...Object.fromEntries(primary.map((f,i)=>[f,values[i]]))}
  const active=oil(answers).filter(r=>r.selection==='applicable').map(r=>r.id)
  assert.deepEqual(active,values.includes(true)?['oil-special']:values.includes(null)?[]:['oil-normal'])
 }
})

test('qualified cold-short-trip conjunction respects both strict boundaries and frequency',()=>{
 const base={...normal,oil_spec:'0W-20',primarily_repeated_cold_short_trips:null,driving_frequency:'primarily',repeated_trips:true,trip_distance_miles:4.99,ambient_temperature_c:-0.01}
 assert.equal(oil(base).find(r=>r.id==='oil-special').selection,'applicable')
 for(const facts of [{trip_distance_miles:5},{ambient_temperature_c:0},{repeated_trips:false},{driving_frequency:'occasionally'}])assert.equal(oil({...base,...facts}).find(r=>r.id==='oil-normal').selection,'applicable')
 for(const field of ['driving_frequency','repeated_trips','trip_distance_miles','ambient_temperature_c'])assert.equal(oil({...base,[field]:null}).find(r=>r.id==='oil-normal').selection,'needs_information')
})

test('facing page 51 numbered footnotes remain service-specific on page 50 and 51',()=>{
 const refs=row=>row.evidenceIds.map(id=>t.evidence.find(e=>e.id===id))
 for(const row of raw.rows.filter(r=>r.pdfPage===50&&r.service==='Engine oil and oil filter'))assert.ok(refs(row).some(e=>e.pdfPage===51&&e.role==='numbered_footnote'&&e.quote.startsWith('1 Reset')))
 const spark=raw.rows.find(r=>r.pdfPage===51&&r.service==='Spark plugs')
 assert.ok(refs(spark).some(e=>e.pdfPage===51&&e.quote.includes('Emission Control Warranty')))
 for(const row of raw.rows.filter(r=>r.pdfPage===51&&r.service!=='Spark plugs'))assert.ok(!refs(row).some(e=>e.quote.includes('Emission Control Warranty')))
 const brake=raw.rows.find(r=>r.pdfPage===51&&r.service==='Brake linings/drums and brake pads/discs')
 assert.ok(refs(brake).some(e=>e.pdfPage===51&&e.quote.startsWith('4 Inspect thickness')))
})
