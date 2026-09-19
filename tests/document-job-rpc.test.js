import test from 'node:test'
import assert from 'node:assert/strict'
import {documentJobRpcAdapter} from '../supabase/functions/maintenance-research-worker/document-job-rpc.js'
test('document RPC adapter uses atomic methods and propagates database errors',async()=>{
 const calls=[]
 const jobs=documentJobRpcAdapter({rpc:async(name,args)=>{calls.push([name,args]);return {data:{claimed:true},error:null}}})
 assert.equal(jobs.capabilities.atomicTemplateCommit,true)
 await jobs.read({jobId:'id'})
 await jobs.claim({binding:{},source:{}})
 await jobs.commit({binding:{},attemptId:'a',record:{},costInUsdTicks:7})
 await jobs.fail({binding:{},attemptId:'a',costInUsdTicks:null,code:'DOCUMENT_ACCOUNTING_UNKNOWN',requeue:false})
 assert.deepEqual(calls.map(x=>x[0]),['read_document_job_v1','claim_document_job_v1','finalize_document_job_v1','fail_document_job_v2'])
 assert.equal(calls[2][1].p_cost_ticks,7)
 assert.equal(calls[3][1].p_cost_ticks,null)
 await assert.rejects(documentJobRpcAdapter({rpc:async()=>({error:{message:'denied'}})}).read({}),/denied/)
})
