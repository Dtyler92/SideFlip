import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateResearchProposals } from '../supabase/functions/_shared/research-proposals.js'
const fixture=JSON.parse(readFileSync(new URL('./fixtures/2012-scion-xd-proposal-pages.json',import.meta.url)))
const registry=new Map(fixture.evidence.map(e=>[e.id,e]))
const full=n=>({evidenceId:`page-${n}`,quote:registry.get(`page-${n}`).exactExcerpt})
function proposal(name,action,pages,id){
 const rows=pages.map(n=>({evidenceId:`page-${n}`,quote:name[0].toUpperCase()+name.slice(1)}))
 const headings=pages.map(n=>({evidenceId:`page-${n}`,quote:registry.get(`page-${n}`).exactExcerpt.match(/[\d,]+ miles or \d+ months/)[0]}))
 const milestones=headings.map(h=>{const m=h.quote.match(/([\d,]+) miles or (\d+) months/);return {miles:Number(m[1].replaceAll(',','')),months:Number(m[2]),evidenceIds:[h.evidenceId]}})
 return {schemaVersion:1,id,name,action,evidenceIds:[...pages.map(n=>`page-${n}`),'page-34'],support:{origin:'provider_claim',coverage:'finite_list_only',row:rows,headingContext:headings,actionContext:pages.map(n=>({evidenceId:`page-${n}`,quote:action==='replace'?'Replace engine air filter':'Inspect the following:'})),notesContext:pages.map(full),timingContext:[full(34)],applicabilityContext:[full(34)]},schedule:{kind:'milestones',dueSemantics:'whichever_first',milestones,end:{miles:120000,months:144}},blockedReasons:[]}
}
test('actual uploaded page excerpts structurally support 4/4/8 finite claims, not authentication',()=>{
 const air=proposal('engine air filter','replace',[39,43,47,51],'air')
 // Direct-action source row includes a lower-case component following Replace.
 air.support.row=air.support.actionContext
 const differential=proposal('front differential oil','inspect',[39,43,47,51],'diff')
 const brakes=proposal('brake lines and hoses','inspect',[37,39,41,43,45,47,49,51],'brakes')
 const out=validateResearchProposals([air,differential,brakes],registry)
 assert.deepEqual(out.map(p=>p.schedule.milestones.length),[4,4,8])
 assert.deepEqual(out[2].schedule.milestones.map(m=>[m.miles,m.months]),[[15000,18],[30000,36],[45000,54],[60000,72],[75000,90],[90000,108],[105000,126],[120000,144]])
 for(const p of out){assert.equal(p.support.origin,'provider_claim');assert.equal(p.schedule.milestones.at(-1).miles,120000)}
 const wrong=structuredClone(brakes);wrong.schedule.milestones[6].evidenceIds=['page-45']
 assert.throws(()=>validateResearchProposals([wrong],registry))
})
