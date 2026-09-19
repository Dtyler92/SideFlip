import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateMaintenanceTemplate, evaluateCondition, selectTemplateRules } from '../supabase/functions/_shared/maintenance-templates.js'
const load = () => JSON.parse(readFileSync(new URL('./fixtures/scion-2012-xd-template.json', import.meta.url)))
test('known non-0W20 exception stays finite, preserves notes and deduplicates overrides',()=>{
 const t=load(), raw=JSON.parse(readFileSync(new URL('./fixtures/scion-2012-xd-source-rows.json',import.meta.url)));
 const r=t.rules.find(r=>r.id==='oil-non0'); assert.ok(r,'missing executable non-0W20 note');
 const notes=raw.rows.filter(r=>r.scope==='non0'); assert.equal(notes.length,11);
 assert.equal(r.timing.kind,'milestones'); assert.deepEqual(r.timing.points.map(p=>[p.miles,p.months]),notes.map(p=>[p.miles,p.months]));
 for(const row of notes)for(const id of row.evidenceIds)assert.ok(r.evidenceIds.includes(id));
 for(const spec of ['0W-20','5W-20 mineral','10W-30',null,undefined,'unknown','synthetic','']){
  const selected=oil({...normal,oil_spec:spec});const active=selected.filter(r=>r.selection==='applicable');
  if(spec==='10W-30'){assert.equal(active.length,1);assert.equal(active[0].id,'oil-non0')}
  else if(spec==='0W-20'||spec==='5W-20 mineral'){assert.equal(active.length,1);assert.notEqual(active[0].id,'oil-non0')}
  else {assert.equal(active.length,0);assert.equal(selected.find(r=>r.id==='oil-non0').selection,'needs_information')}
  const primary=oil({...normal,oil_spec:spec,primarily_dirt_dust:true}).filter(r=>r.selection==='applicable');assert.deepEqual(primary.map(r=>r.id),['oil-special']);
 }
 assert.equal(evaluateCondition({op:'not',arg:{op:'eq',field:'oil_spec',value:'0W-20'}},{}),'unknown');
 for(const op of ['all','any'])assert.equal(evaluateCondition({op,args:[{op:'eq',field:'a',value:true},{op:'eq',field:'b',value:true}]},{a:op==='all'}),'unknown');
})
test('monitor modes require a strict discriminant, string instruction and no scheduling fields',()=>{
 for(const change of [ti=>delete ti.mode,ti=>ti.mode='future_mode',ti=>ti.mode={},ti=>ti.instruction={},ti=>ti.instruction='  ',ti=>ti.interval={miles:5000},ti=>ti.trigger='whichever_first',ti=>ti.autoApply=true]){
  const t=load();change(t.rules.find(r=>r.timing.kind==='monitor').timing);
  const result=validateMaintenanceTemplate(t);
  assert.ok(result.errors.some(e=>/invalid monitor/.test(e)),JSON.stringify(result));
 }
 const reset=load().rules.find(r=>r.id==='reset-reminder');assert.equal(reset.timing.mode,'reset_reminder');
 for(const mode of ['source_instruction','inspection_finding','care_instruction','reset_reminder','vehicle_monitor']){
  const t=load();t.rules.find(r=>r.id==='reset-reminder').timing.mode=mode;
  const result=validateMaintenanceTemplate(t);
  assert.ok(!result.errors.some(e=>/invalid monitor/.test(e)),mode);
  if(mode!=='reset_reminder')assert.ok(result.errors.includes('source semantic mismatch: rules'),'valid enum cannot override reviewed source semantics');
 }
})
test('full source-bound template validates', () => { const t=load(); assert.deepEqual(validateMaintenanceTemplate(t),{valid:true,errors:[]}); assert.equal(t.coverage.scheduleMilestones,24); assert.ok(t.rules.length>25) })
const normal={oil_spec:'0W-20',primarily_dirt_dust:false,primarily_repeated_cold_short_trips:false,primarily_extensive_idling:false,primarily_low_speed_long_distance:false}
const oil=(a)=>selectTemplateRules(load(),a).filter(r=>r.service==='Engine oil and oil filter')
test('qualifying oil normal interval 10000/12, not general visit',()=>{const r=oil(normal).filter(r=>r.selection==='applicable');assert.equal(r.length,1);assert.deepEqual(r[0].timing.interval,{miles:10000,months:12})})
test('substitute mineral oil 5000/6 and return instruction',()=>{const r=oil({...normal,oil_spec:'5W-20 mineral'}).find(r=>r.selection==='applicable');assert.deepEqual(r.timing.interval,{miles:5000,months:6});assert.match(r.notes.join(' '),/0W-20/)})
test('each primary special condition overrides regardless of oil',()=>{for(const k of Object.keys(normal).filter(k=>k.startsWith('primarily'))){const r=oil({...normal,oil_spec:null,[k]:true}).filter(r=>r.selection==='applicable');assert.equal(r.length,1);assert.deepEqual(r[0].timing.interval,{miles:5000,months:6})}})
test('occasional use does not qualify and unknown is not longest interval',()=>{assert.equal(oil(normal).find(r=>r.id==='oil-special').selection,'not_applicable');assert.ok(!oil({...normal,oil_spec:null}).some(r=>r.selection==='applicable'));assert.ok(!oil({oil_spec:'synthetic'}).some(r=>r.selection==='applicable'))})
test('AND OR retain unknown and strict trip thresholds',()=>{assert.equal(evaluateCondition({op:'all',args:[{op:'eq',field:'primary',value:true},{op:'lt',field:'trip',value:5}]},{primary:true,trip:5}),false);assert.equal(evaluateCondition({op:'any',args:[{op:'eq',field:'a',value:true},{op:'eq',field:'b',value:true}]},{a:false}),'unknown')})
test('inspection separate from replacement and finite is not recurring',()=>{const t=load();assert.ok(t.rules.some(r=>r.service==='Engine air filter'&&r.action==='inspect'));assert.ok(t.rules.some(r=>r.service==='Engine air filter'&&r.action==='replace'));assert.equal(t.rules.find(r=>r.service==='Spark plugs').timing.kind,'milestones')})
test('reject forged quote, unsupported action, missing condition and interval unit',()=>{for(const mutate of [t=>t.evidence[0].quote='fabricated source',t=>t.rules[0].action='invent',t=>delete t.rules[0].condition,t=>t.rules[0].timing.points[0].kilometers=5000]){const t=load();mutate(t);assert.equal(validateMaintenanceTemplate(t).valid,false)}})
test('source evidence required on every rule and point',()=>{const t=load();t.rules[0].evidenceIds=[];assert.equal(validateMaintenanceTemplate(t).valid,false)})
test('semantic evidence rejects supported words used for wrong interval, scope or service',()=>{for(const mutate of [t=>t.rules.find(r=>r.id==='oil-normal').timing.interval.miles=5000,t=>t.rules.find(r=>r.id==='oil-special').condition={op:'always'},t=>t.rules[0].service='Transmission flush',t=>t.rules.pop(),t=>t.applicability.year=2013,t=>t.source.sha256='a'.repeat(64)]){const t=load();mutate(t);assert.equal(validateMaintenanceTemplate(t).valid,false)}})
test('short-trip threshold definition is evaluated, not just displayed',()=>{const base={...normal,primarily_repeated_cold_short_trips:null,driving_frequency:'primarily',repeated_trips:true,trip_distance_miles:4,ambient_temperature_c:-1};assert.equal(oil(base).find(r=>r.id==='oil-special').selection,'applicable');for(const facts of [{trip_distance_miles:5},{ambient_temperature_c:0},{driving_frequency:'occasionally'}])assert.equal(oil({...base,...facts}).find(r=>r.id==='oil-special').selection,'not_applicable')})
test('all source footnotes retain their exact service scope',()=>{const t=load();const spark=t.rules.find(r=>r.service==='Spark plugs');assert.ok(spark.evidenceIds.map(id=>t.evidence.find(e=>e.id===id).quote).some(q=>q.includes('Emission Control Warranty')));assert.equal(t.coverage.unparsedScheduleRows,0);assert.equal(t.coverage.sourceFootnotesAudited,true)})
test('rotate, coolant first/subsequent and owner independence',()=>{const t=load();assert.equal(t.rules.find(r=>r.service==='Tires').action,'rotate');const c=t.rules.find(r=>r.service==='Engine coolant'&&r.action==='replace');assert.deepEqual(c.timing.first,{miles:100000,months:120});assert.deepEqual(c.timing.subsequent,{miles:50000,months:60});assert.equal(selectTemplateRules(t,{}).find(r=>r.id===c.id).selection,'needs_information');const before=JSON.stringify(t);selectTemplateRules(t,{...normal,currentMileage:200000});assert.equal(JSON.stringify(t),before);assert.ok(!('ownerId' in t))})
test('all collected source rows remain covered and page-bound',()=>{const t=load();const raw=JSON.parse(readFileSync(new URL('./fixtures/scion-2012-xd-source-rows.json',import.meta.url)));assert.equal(raw.rows.length,t.coverage.rawScheduleRows);const ids=new Set(t.rules.flatMap(r=>r.evidenceIds));for(const row of raw.rows)for(const id of row.evidenceIds)assert.ok(ids.has(id),`uncovered ${id}`);assert.equal(raw.explanations.length,20)})
