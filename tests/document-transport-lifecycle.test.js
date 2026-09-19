import test from 'node:test'
import assert from 'node:assert/strict'
import {runDocumentTransport} from '../supabase/functions/maintenance-research-worker/document-transport-lifecycle.js'
const turn=()=>new Promise(r=>setImmediate(r))
function setup(){const events=[];return {events,jobs:{transport:async e=>events.push(e),transportStatus:async()=>({stopRequested:false})}}}
test('held uncooperative extraction is aborted; late unattested usage stays unknown',async()=>{
 const s=setup();let release,signal,calls=0
 const gate=new Promise(r=>release=r)
 await assert.rejects(runDocumentTransport({...s,timeoutMs:15,extract:async x=>{calls++;signal=x.signal;await gate;return {usage:{costInUsdTicks:17}}}}),/DOCUMENT_TRANSPORT_TIMEOUT/)
 assert.equal(signal.aborted,true);assert.equal(calls,1);assert.ok(s.events.some(e=>e.event==='abort_requested'))
 release();await turn();assert.equal(s.events.at(-1).event,'local_stopped');assert.equal(s.events.at(-1).costInUsdTicks,17)
})
test('cancellation requests abort but local rejection does not confirm remote termination',async()=>{
 const s=setup();s.jobs.transportStatus=async()=>({stopRequested:true})
 await assert.rejects(runDocumentTransport({...s,pollMs:2,timeoutMs:100,extract:({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('socket closed'))))}),/DOCUMENT_TRANSPORT_CANCELLED/)
 await turn();assert.ok(s.events.some(e=>e.event==='local_stopped'));assert.ok(!s.events.some(e=>e.event==='response_complete'))
})
test('lost start acknowledgement consumes authority without extraction',async()=>{
 const s=setup();s.jobs.transport=async()=>{throw Error('lost ack')};let calls=0
 await assert.rejects(runDocumentTransport({...s,extract:()=>{calls++}}),/lost ack/);assert.equal(calls,0)
})
test('connection reset with known usage remains remote unknown',async()=>{
 const s=setup();await assert.rejects(runDocumentTransport({...s,extract:async()=>{throw Object.assign(Error('reset'),{costInUsdTicks:8})}}),/reset/)
 assert.equal(s.events.at(-1).event,'local_stopped');assert.equal(s.events.at(-1).costInUsdTicks,8)
})
