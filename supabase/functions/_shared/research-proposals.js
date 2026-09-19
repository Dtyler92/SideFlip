// Typed provider claims are NOT authenticated extraction or owner attestation.
const fail = () => { throw Object.assign(new Error('Invalid research proposal'), { code: 'INVALID_CANDIDATE' }) }
const text = (v, n=2000) => typeof v === 'string' && v.trim().length > 0 && v.length <= n
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k=>Object.hasOwn(v,k))
const positive = v => Number.isSafeInteger(v) && v > 0 && v <= 10000000
const refs = (ids, allowed) => Array.isArray(ids) && ids.length > 0 && ids.length <= 30 && new Set(ids).size === ids.length && ids.every(id=>allowed.has(id))
export function validateResearchProposals(input, registry, candidateCount=0) {
  if (!(registry instanceof Map) || !Number.isInteger(candidateCount) || candidateCount < 0 || !Array.isArray(input) || input.length + candidateCount > 100 || new TextEncoder().encode(JSON.stringify(input)).length > 100000) fail()
  const seen = new Set()
  return input.map(p => {
    if (!exact(p,['schemaVersion','id','name','action','evidenceIds','support','schedule','blockedReasons']) || p.schemaVersion!==1 || !text(p.id,100) || !/^[a-zA-Z0-9_-]+$/.test(p.id) || seen.has(p.id) || !text(p.name,200) || !['inspect','adjust','replace'].includes(p.action) || !refs(p.evidenceIds,registry) || !Array.isArray(p.blockedReasons) || p.blockedReasons.length>20 || !p.blockedReasons.every(x=>text(x,1000))) fail()
    seen.add(p.id)
    const s=p.support, keys=['row','actionContext','headingContext','notesContext','timingContext','applicabilityContext']
    if (!exact(s,['origin',...keys,'coverage']) || s.origin!=='provider_claim' || s.coverage!=='finite_list_only') fail()
    const allowed=new Set(p.evidenceIds)
    for (const key of keys) {
      if (!Array.isArray(s[key]) || !s[key].length || s[key].length>30) fail()
      for (const span of s[key]) if (!exact(span,['evidenceId','quote']) || !allowed.has(span.evidenceId) || !text(span.quote) || !registry.get(span.evidenceId)?.exactExcerpt.includes(span.quote)) fail()
    }
    if (!p.schedule || typeof p.schedule !== 'object' || Array.isArray(p.schedule)) fail()
    if (p.schedule.kind==='milestones') {
      const spec=p.schedule
      if (!exact(spec,['kind','dueSemantics','milestones','end']) || !['whichever_first','all'].includes(spec.dueSemantics) || !Array.isArray(spec.milestones) || !spec.milestones.length || spec.milestones.length>100 || !exact(spec.end,['miles','months'])) fail()
      let miles=0,months=0
      for (const m of spec.milestones) {
        if (!exact(m,['miles','months','evidenceIds']) || !positive(m.miles) || !positive(m.months) || m.months>1200 || m.miles<=miles || m.months<=months || !refs(m.evidenceIds,allowed)) fail()
        // Structural source linkage, NOT authentication or semantic scope proof.
        for (const key of ['row','actionContext','headingContext']) {
          if (!s[key].some(span => m.evidenceIds.includes(span.evidenceId))) fail()
        }
        const heading = s.headingContext.filter(span => m.evidenceIds.includes(span.evidenceId))
        if (!heading.some(span => {
          const pairs = [...span.quote.matchAll(/\b([0-9][0-9,]*)\s+miles\s+(?:or|and|\/)\s+([0-9]+)\s+months\b/gi)]
          return pairs.some(pair => Number(pair[1].replaceAll(',', '')) === m.miles && Number(pair[2]) === m.months)
        })) fail()
        miles=m.miles; months=m.months
      }
      if (spec.end.miles!==miles || spec.end.months!==months) fail()
    } else if (!exact(p.schedule,['kind','details']) || !['conditional','first_then_recurring','recurring'].includes(p.schedule.kind) || !text(p.schedule.details,10000) || !p.blockedReasons.length) fail()
    return structuredClone(p)
  })
}

// Conservative lexical identity only: never claim synonym/component equivalence.
const taskKey = value => value.normalize('NFKC').trim().toLowerCase().replace(/^(?:inspect|adjust|replace)\s+/, '').replace(/\s+/g, ' ')
export function reconcileResearchTasks(candidates, proposals, unresolved) {
  const proposalNames = new Set()
  const candidateNames = new Set(candidates.map(c => taskKey(c.name)))
  for (const p of proposals) {
    const key = taskKey(p.name)
    if (!key || proposalNames.has(key) || candidateNames.has(key)) fail()
    proposalNames.add(key)
    for (const issue of unresolved) {
      if (taskKey(issue.name) === key && !p.blockedReasons.includes(issue.reason)) fail()
    }
  }
  // Do not let action-prefixed unresolved names bypass the legacy lane either.
  for (const c of candidates) if (unresolved.some(u => taskKey(u.name) === taskKey(c.name))) fail()
  return proposals
}

// Explicit history review is required; a used asset is not implicitly unserviced.
// Completion indices are supplied by authoritative history, not a meter-derived skip.
export function evaluateFiniteMilestones(spec, {historyReviewed=false,completedIndices=[],miles=null,ageMonths=null}={}) {
  if (spec?.kind!=='milestones') fail()
  if (!Array.isArray(completedIndices) || new Set(completedIndices).size!==completedIndices.length || completedIndices.some(i=>!Number.isInteger(i)||i<0||i>=spec.milestones.length)) fail()
  if (!historyReviewed) return {state:'history_unknown',next:null}
  const index=spec.milestones.findIndex((_,i)=>!completedIndices.includes(i))
  if (index<0) return {state:'source_coverage_exhausted',next:null}
  const next=spec.milestones[index]
  if (ageMonths===null) return {state:'in_service_unknown',next,index}
  if (miles===null) return {state:'meter_unknown',next,index}
  if (![miles,ageMonths].every(x=>Number.isFinite(x)&&x>=0)) fail()
  const due=spec.dueSemantics==='all' ? miles>=next.miles && ageMonths>=next.months : miles>=next.miles || ageMonths>=next.months
  return {state:due?'due':'planned',next,index}
}
