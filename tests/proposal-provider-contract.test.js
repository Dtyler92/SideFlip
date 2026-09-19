import test from 'node:test'
import assert from 'node:assert/strict'
import { validateResearchProposals, reconcileResearchTasks } from '../supabase/functions/_shared/research-proposals.js'
import { createXaiMaintenanceProvider, SUPPORTED_MODEL } from '../supabase/functions/maintenance-research-worker/xai-provider.js'
const registry = new Map([['e1',{exactExcerpt:'Replace air filter. 30,000 miles or 36 months. Normal. Whichever first. No other notes.'}],['e2',{exactExcerpt:'Replace air filter. 60,000 miles or 72 months. Normal.'}]])
const span=(id,quote)=>({evidenceId:id,quote})
const proposal=()=>({schemaVersion:1,id:'air',name:'Air filter',action:'replace',evidenceIds:['e1','e2'],support:{origin:'provider_claim',coverage:'finite_list_only',row:[span('e1','Replace air filter.'),span('e2','Replace air filter.')],actionContext:[span('e1','Replace'),span('e2','Replace')],headingContext:[span('e1','30,000 miles or 36 months'),span('e2','60,000 miles or 72 months')],notesContext:[span('e1','No other notes.')],timingContext:[span('e1','Whichever first.')],applicabilityContext:[span('e1','Normal.')]},schedule:{kind:'milestones',dueSemantics:'whichever_first',milestones:[{miles:30000,months:36,evidenceIds:['e1']},{miles:60000,months:72,evidenceIds:['e2']}],end:{miles:60000,months:72}},blockedReasons:[]})
test('each finite threshold links actual heading, row and action context',()=>{
 assert.equal(validateResearchProposals([proposal()],registry).length,1)
 for(const mutate of [p=>p.schedule=null,p=>p.schedule.milestones[1].evidenceIds=['e1'],p=>p.support.row.pop(),p=>p.support.actionContext.pop(),p=>p.support.headingContext.pop(),p=>p.schedule.milestones[0].miles=29000]){const p=proposal();mutate(p);assert.throws(()=>validateResearchProposals([p],registry),e=>e.code==='INVALID_CANDIDATE')}
})
test('task reconciliation blocks duplicate aliases and unresolved bypass across lanes',()=>{
 const p=proposal()
 assert.throws(()=>reconcileResearchTasks([], [p,{...p,id:'other',name:' replace AIR   FILTER '}], []))
 assert.throws(()=>reconcileResearchTasks([{name:'air filter'}],[p],[]))
 assert.throws(()=>reconcileResearchTasks([], [p], [{name:'Air filter',reason:'Applicability unknown'}]))
 assert.doesNotThrow(()=>reconcileResearchTasks([], [{...p,blockedReasons:['Applicability unknown']}], [{name:'Air filter',reason:'Applicability unknown'}]))
})
test('normalization requests existing typed wire contract without tools or authentication claims',async()=>{
 let body
 const provider=createXaiMaintenanceProvider({apiKey:'offline-placeholder',model:SUPPORTED_MODEL,fetchImpl:async(_,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({status:'completed',model:SUPPORTED_MODEL,usage:{cost_in_usd_ticks:17},output:[{type:'message',status:'completed',content:[{type:'output_text',text:JSON.stringify({candidates:[],proposals:[proposal()],unresolved:[]})}]}]}),{status:200})}})
 const result=await provider.normalize({evidence:[...registry.values()]})
 const request=JSON.parse(body.input[1].content)
 assert.ok(request.proposalContract)
 assert.match(request.task,/proposals/)
 assert.equal(request.proposalContract.support.origin,'provider_claim')
 assert.equal(body.tools,undefined)
 assert.deepEqual(result.proposals,[proposal()]);assert.equal(result.usage.costInUsdTicks,17)
})
