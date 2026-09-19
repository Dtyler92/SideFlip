import { reviewedTemplateCatalog } from './maintenance-template-catalog.js'
// Reusable source templates. Deliberately independent of owner history and due-date materialization.
const canonical = x => JSON.stringify(x, function(_k,v){ return v && typeof v==='object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v })
const UNKNOWN = 'unknown'
const actions = new Set(['check','inspect','visually_inspect','inspect_adjust','replace','rotate','tighten','adjust','clean','repair','reset','repack','wax'])
const norm = s => String(s).replace(/\s+/g,' ').trim()
export function evaluateCondition(c, answers = {}) {
  if (!c || typeof c !== 'object') return UNKNOWN
  if (c.op === 'always') return true
  if (c.op === 'not') { const r=evaluateCondition(c.arg,answers);return r===UNKNOWN?UNKNOWN:!r }
  if (c.op === 'all' || c.op === 'any') {
    if (!Array.isArray(c.args)||!c.args.length) return UNKNOWN
    const rs=c.args.map(a=>evaluateCondition(a,answers))
    return c.op==='all' ? (rs.includes(false)?false:rs.includes(UNKNOWN)?UNKNOWN:true) : (rs.includes(true)?true:rs.includes(UNKNOWN)?UNKNOWN:false)
  }
  const v=Object.hasOwn(answers,c.field)?answers[c.field]:null
  if(v===null||v===undefined)return UNKNOWN
  if(c.op==='eq')return typeof v===typeof c.value ? v===c.value : UNKNOWN
  if(typeof v!=='number'||!Number.isFinite(v))return UNKNOWN
  return ({lt:()=>v<c.value,lte:()=>v<=c.value,gt:()=>v>c.value,gte:()=>v>=c.value}[c.op]?.())??UNKNOWN
}
export function validateMaintenanceTemplate(t) {
  const errors=[]; const bad=s=>errors.push(s)
  if(!t||typeof t!=='object')return {valid:false,errors:['template required']}
  for(const key of ['pages','evidence','rules','ownerQuestions','unresolved'])if(!Array.isArray(t[key])||t[key].length>10000||t[key].some(x=>!x||typeof x!=='object'||Array.isArray(x)))bad('invalid array '+key)
  if(errors.length)return {valid:false,errors}
  if(t.schemaVersion!==1)bad('unsupported schemaVersion')
  if(!t.templateId||!t.applicability||!Number.isInteger(t.applicability.year)||!t.applicability.make||!t.applicability.model)bad('verified applicability required')
  if(!/^[a-f0-9]{64}$/.test(t.source?.sha256||'')||!t.source?.version||!t.source?.provenance)bad('source identity/version required')
  const pages=new Map((t.pages||[]).map(p=>[p.pdfPage,p]))
  if(pages.size!==t.source?.pageCount)bad('incomplete source pages')
  const evidence=new Map()
  for(const e of t.evidence||[]){
    if(evidence.has(e.id))bad('duplicate evidence '+e.id)
    evidence.set(e.id,e)
    const p=pages.get(e.pdfPage)
    if(!e.id||!e.role||!e.quote||!p||p.printedPage!==e.printedPage||!norm(p.text).includes(norm(e.quote)))bad('unbound evidence '+e.id)
  }
  const refs=(ids,label)=>{if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!evidence.has(id)))bad('missing/invalid evidence '+label)}
  const fields=new Set((t.ownerQuestions||[]).map(q=>q.field))
  function condition(c,depth=0){
    if(!c||depth>12){bad('invalid condition');return}
    if(c.op==='always')return
    if(c.op==='not')return condition(c.arg,depth+1)
    if(['all','any'].includes(c.op)){if(!Array.isArray(c.args)||!c.args.length)bad('empty condition');else c.args.forEach(a=>condition(a,depth+1));return}
    if(!['eq','lt','lte','gt','gte'].includes(c.op)||!fields.has(c.field)||c.value===null||c.value===undefined)bad('invalid condition atom')
    if(c.op!=='eq'&&(typeof c.value!=='number'||!Number.isFinite(c.value)))bad('invalid numeric condition')
  }
  const threshold=(p,label)=>{
    if(!p||!Object.keys(p).some(k=>['miles','months'].includes(k))||Object.keys(p).some(k=>!['miles','months','evidenceIds'].includes(k)))bad('invalid interval units '+label)
    for(const k of ['miles','months'])if(p?.[k]!==undefined&&(!Number.isSafeInteger(p[k])||p[k]<=0))bad('invalid threshold '+label)
  }
  const rules=t.rules||[];const byId=new Map(rules.map(r=>[r.id,r]));const keys=new Set()
  if(!rules.length||byId.size!==rules.length)bad('empty/duplicate rules')
  for(const r of rules){
    if(!r.id||!r.service||!actions.has(r.action))bad('invalid service/action '+r.id)
    refs(r.evidenceIds,r.id);condition(r.condition)
    const k=JSON.stringify([r.service,r.action,r.condition,r.timing]);if(keys.has(k))bad('duplicate semantic rule');keys.add(k)
    const ti=r.timing
    if(!ti||!['milestones','recurring','first_subsequent','monitor'].includes(ti.kind)){bad('invalid timing '+r.id);continue}
    if(ti.kind!=='monitor'&&ti.trigger!=='whichever_first')bad('trigger required '+r.id)
    if(ti.kind==='milestones'){
      if(ti.anchor!=='vehicle_origin'||!Array.isArray(ti.points)||!ti.points.length)bad('invalid milestones '+r.id)
      let last=0;for(const p of ti.points||[]){threshold(p,r.id);refs(p.evidenceIds,r.id);if(p.miles<=last)bad('unordered milestones');last=p.miles}
    }else if(ti.kind==='recurring')threshold(ti.interval,r.id)
    else if(ti.kind==='first_subsequent'){threshold(ti.first,r.id);threshold(ti.subsequent,r.id)}
    else {
      // Schema-v1 monitor is a non-periodic instruction container, not an
      // automatic vehicle-monitor schedule. Classification must be explicit.
      if(!['source_instruction','inspection_finding','care_instruction','reset_reminder','vehicle_monitor'].includes(ti.mode))bad('invalid monitor mode '+r.id)
      if(typeof ti.instruction!=='string'||!ti.instruction.trim())bad('invalid monitor instruction '+r.id)
      if(Object.keys(ti).some(key=>!['kind','mode','instruction'].includes(key)))bad('invalid monitor field '+r.id)
    }
    for(const id of r.overrides||[]){const target=byId.get(id);if(!target||id===r.id||target.service!==r.service||target.action!==r.action)bad('invalid override '+id)}
  }
  function visit(id,path=new Set()){if(path.has(id)){bad('override cycle');return}const next=new Set(path).add(id);for(const child of byId.get(id)?.overrides||[])visit(child,next)}
  for(const id of byId.keys())visit(id)
  // Literal quote membership alone cannot prove action/timing/condition semantics.
  // Only compiler-reviewed, source-version-bound claims may be treated as usable.
  const reviewed=reviewedTemplateCatalog[t.source?.sha256]
  if(!reviewed)bad('source semantics require review: no reviewed document compiler')
  else for(const key of Object.keys(reviewed))if(canonical(t[key])!==canonical(reviewed[key]))bad('source semantic mismatch: '+key)
  return {valid:errors.length===0,errors}
}
export function selectTemplateRules(t, answers={}) {
  const result=validateMaintenanceTemplate(t)
  if(!result.valid)throw new Error('Invalid maintenance template: '+result.errors.join('; '))
  const resolved={...answers}
  // A generic label or unknown sentinel is not a known viscosity grade.
  if (Object.hasOwn(resolved,'oil_spec') &&
      (typeof resolved.oil_spec!=='string' || !/^\d{1,2}W-\d{2}(?: mineral)?$/.test(resolved.oil_spec))) resolved.oil_spec=null
  for(const q of t.ownerQuestions||[])if(q.definition && (resolved[q.field]===undefined||resolved[q.field]===null)){
    const derived=evaluateCondition(q.definition,answers)
    if(derived!==UNKNOWN)resolved[q.field]=derived
  }
  const evaluated=t.rules.map(r=>({...r,applicability:evaluateCondition(r.condition,resolved)}))
  return evaluated.map(r=>{
    const overrides=evaluated.filter(o=>(o.overrides||[]).includes(r.id))
    const selection=r.applicability===false?'not_applicable':overrides.some(o=>o.applicability===true)?'overridden':r.applicability===UNKNOWN||overrides.some(o=>o.applicability===UNKNOWN)?'needs_information':'applicable'
    return {...r,selection}
  })
}
