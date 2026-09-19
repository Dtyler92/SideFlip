import test from 'node:test'
import assert from 'node:assert/strict'
import {documentJobRpcAdapter} from '../supabase/functions/maintenance-research-worker/document-job-rpc.js'
test('nonbillable preflight uses a separate ready-only RPC without caller supplied cost or stage',async()=>{
 const calls=[]
 const jobs=documentJobRpcAdapter({rpc:async(name,args)=>{calls.push([name,args]);return {data:false,error:null}}})
 assert.equal(await jobs.failPreflight({binding:{jobId:'test'},attemptId:'attempt'}),false)
 assert.deepEqual(calls,[['fail_document_preflight_v1',{p_binding:{jobId:'test'},p_attempt_id:'attempt'}]])
})
