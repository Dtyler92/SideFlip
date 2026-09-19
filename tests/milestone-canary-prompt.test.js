import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createXaiMaintenanceProvider, SUPPORTED_MODEL } from '../supabase/functions/maintenance-research-worker/xai-provider.js'
import { validateResearchProposals, evaluateFiniteMilestones } from '../supabase/functions/_shared/research-proposals.js'

// Scripted transport tests request construction only, never model compliance.
async function requestFor(method) {
  let request
  const url='https://assets.sia.toyota.com/manual.pdf'
  const provider=createXaiMaintenanceProvider({apiKey:'offline-test',model:SUPPORTED_MODEL,fetchImpl:async (_url,init)=>{
    request=JSON.parse(init.body)
    const discovery=method==='discover'
    return new Response(JSON.stringify({status:'completed',model:SUPPORTED_MODEL,usage:{cost_in_usd_ticks:0,...(discovery?{num_server_side_tools_used:1,server_side_tool_usage_details:{web_search_calls:1}}:{})},output:[...(discovery?[{type:'web_search_call',status:'completed',action:{type:'search',sources:[{url}]}}]:[]),{type:'message',status:'completed',content:[{type:'output_text',text:JSON.stringify(discovery?{evidence:[]}:{candidates:[],proposals:[],unresolved:[]}),annotations:[{type:'url_citation',url}]}]}]}),{status:200})
  }})
  if(method==='discover') await provider.discover({asset:{make:'TOYOTA',model:'Scion xD',modelYear:2012},domains:[{domain:'assets.sia.toyota.com',sourceClass:'manufacturer',includeSubdomains:true,allowedPathPrefixes:['/']}],maxSearches:3,maxFetches:2})
  else await provider.normalize({evidence:[]})
  return {body:request,prompt:JSON.parse(request.input[1].content)}
}
test('discovery budgets governing context and earliest coverage, not only tail snippets',async()=>{
  const {body,prompt}=await requestFor('discover')
  assert.match(prompt.task,/earliest listed task threshold/)
  assert.match(prompt.task,/global timing and applicability/)
  assert.match(prompt.task,/partial coverage/)
  assert.equal(prompt.maxSearches,3);assert.equal(prompt.maxFetches,2)
  assert.equal(body.max_turns,5);assert.equal(body.store,false)
})
test('normalization explicitly permits one finite milestone but never invents missing coverage',async()=>{
  const {body,prompt}=await requestFor('normalize')
  assert.match(prompt.proposalRules,/single finite milestone is valid/)
  assert.match(prompt.proposalRules,/missing earlier coverage/)
  assert.match(prompt.proposalRules,/metadata is not an exactExcerpt/)
  assert.equal(body.tools,undefined)
})
test('actual full-page singleton passes unchanged validator, absent context fails, history stays unknown',()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/2012-scion-xd-proposal-pages.json',import.meta.url)))
  const registry=new Map(fixture.evidence.map(e=>[e.id,e]))
  const span=(evidenceId,quote)=>({evidenceId,quote})
  const full=id=>span(id,registry.get(id).exactExcerpt)
  const row=span('page-51','Replace engine air filter')
  const p={schemaVersion:1,id:'singleton',name:'Engine air filter',action:'replace',evidenceIds:['page-51','page-34'],support:{origin:'provider_claim',coverage:'finite_list_only',row:[row],actionContext:[row],headingContext:[span('page-51','120,000 miles or 144 months')],notesContext:[full('page-51')],timingContext:[full('page-34')],applicabilityContext:[full('page-34')]},schedule:{kind:'milestones',dueSemantics:'whichever_first',milestones:[{miles:120000,months:144,evidenceIds:['page-51']}],end:{miles:120000,months:144}},blockedReasons:['Partial coverage: missing earlier coverage; not a complete maintenance schedule.']}
  assert.equal(validateResearchProposals([p],registry).length,1)
  assert.equal(evaluateFiniteMilestones(p.schedule).state,'history_unknown')
  for(const key of ['notesContext','timingContext','applicabilityContext']) {
    const missing=structuredClone(p);missing.support[key]=[]
    assert.throws(()=>validateResearchProposals([missing],registry),e=>e.code==='INVALID_CANDIDATE')
  }
})
