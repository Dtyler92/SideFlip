import test from 'node:test'
import assert from 'node:assert/strict'
import {dispatchDocumentJob} from '../supabase/functions/maintenance-research-worker/document-dispatch.js'
test('document dispatch is off unless explicit capability and transports supplied',async()=>{
 let calls=0;const client={rpc:async()=>{calls++;throw Error('must not lease')}}
 await assert.rejects(()=>dispatchDocumentJob({client}),/DOCUMENT_LANE_DISABLED/)
 await assert.rejects(()=>dispatchDocumentJob({client,enabled:true}),/DOCUMENT_LANE_DISABLED/)
 assert.equal(calls,0)
})
test('empty queue has no provider invocation',async()=>{
 let calls=0
 const r=await dispatchDocumentJob({enabled:true,workerId:'offline',client:{rpc:async(name)=>{assert.equal(name,'lease_document_dispatch_v1');calls++;return {data:null,error:null}}},storage:{read(){}},acquireDocument(){assert.fail()},extract(){assert.fail()}})
 assert.deepEqual(r,{processed:0});assert.equal(calls,1)
})
