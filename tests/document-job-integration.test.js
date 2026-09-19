import test from 'node:test'
import assert from 'node:assert/strict'
import {harness,retainedExtraction} from './helpers/document-job-harness.js'
import {processLeasedJob} from '../supabase/functions/maintenance-research-worker/worker-core.js'

test('marked document jobs fail closed rather than entering legacy retry settlement', async () => {
  let calls = 0
  await assert.rejects(processLeasedJob({
    lease: {id:'job', lease_token:'token', execution_lane:'document_v2'},
    db: {fail:async()=>{calls++}},
  }), error => error.code === 'DOCUMENT_LANE_DISABLED')
  assert.equal(calls, 0)
})

test('same existing job -> retained extraction -> exact immutable readback; replay never invokes extractor',async()=>{
  const h=harness(), first=await processLeasedJob(h.options)
  assert.equal(first.jobId,h.options.lease.id)
  assert.equal(first.persisted,true);assert.equal(first.status,'needs_review');assert.equal(first.candidateCount,0)
  assert.deepEqual(first.row.record.payload.rules,retainedExtraction().rules)
  assert.equal(first.row.record.schema_version,'manufacturer-template-v2')
  assert.equal(first.row.record.validation_report.semanticVerified,false)
  assert.equal(first.row.record.validation_report.auto_apply_allowed,false)
  assert.equal(first.row.record.payload.documentBundle.pages[0].printedPage,558)
  assert.deepEqual(h.calls,['read','source','claim','read','extract','commit','read','storage.read'])
  const second=await processLeasedJob(h.options)
  assert.deepEqual(second.row,first.row);assert.equal(second.replayed,true)
  assert.equal(h.calls.filter(x=>x==='extract').length,1)
  assert.equal(h.calls.filter(x=>x==='source').length,1)
  assert.equal(h.calls.filter(x=>x==='commit').length,1)
})
for(const field of ['authorized','identityConfirmed','policyCurrent','entitlementCurrent','reservationPersisted','leaseCurrent']) {
  test(`${field} fails before source or extraction`,async()=>{
    const h=harness();h.flags[field]=false
    await assert.rejects(processLeasedJob(h.options))
    assert.deepEqual(h.calls,['read'])
  })
}
test('cancelled before source fails closed',async()=>{
  const h=harness();h.flags.cancelled=true
  await assert.rejects(processLeasedJob(h.options));assert.deepEqual(h.calls,['read'])
})
test('capabilities, explicit source and strict flag required before any adapter call',async()=>{
  for(const mutate of [h=>delete h.options.config.documentLaneEnabled,h=>h.options.config.documentLaneEnabled='true',h=>delete h.options.documentLane.acquireDocument,h=>delete h.jobs.capabilities.atomicSingleAttempt,h=>delete h.jobs.capabilities.atomicTemplateCommit,h=>delete h.options.documentLane.storage.read]) {
    const h=harness();mutate(h);await assert.rejects(processLeasedJob(h.options));assert.deepEqual(h.calls,[])
  }
})
test('serialized source bundle cannot invoke extraction or consume an attempt',async()=>{
  const h=harness();h.options.documentLane.acquireDocument=async()=>({sourceSha256:'a'.repeat(64),pages:[]})
  await assert.rejects(processLeasedJob(h.options));assert.deepEqual(h.calls,['read'])
})
test('claim denial, lost claim response and missing persisted claim never invoke extractor',async()=>{
  for(const mutate of [h=>h.jobs.claim=async()=>({claimed:false}),h=>h.jobs.claim=async()=>{throw Error('lost response')},h=>{const claim=h.jobs.claim;h.jobs.claim=async x=>{const r=await claim(x);h.setState(null);return r}}]) {
    const h=harness();mutate(h);await assert.rejects(processLeasedJob(h.options));assert.ok(!h.calls.includes('extract'))
  }
})
test('concurrent deliveries consume only one attempt',async()=>{
  const h=harness(), result=await Promise.allSettled([processLeasedJob(h.options),processLeasedJob(h.options)])
  assert.equal(result.filter(x=>x.status==='fulfilled').length,1)
  assert.equal(h.calls.filter(x=>x==='extract').length,1)
})
test('provider failure records unknown charge and cannot retry or use legacy fail',async()=>{
  const h=harness();h.options.documentLane.extract=async()=>{h.calls.push('extract');throw Error('private provider body')}
  h.options.db={fail:()=>{throw Error('must not use legacy retry')}}
  await assert.rejects(processLeasedJob(h.options),e=>e.code==='DOCUMENT_EXTRACTION_FAILED'&&!e.message.includes('private'))
  assert.equal(h.state.costInUsdTicks,null);assert.equal(h.state.chargeUnknown,true);assert.equal(h.state.requeue,false)
  await assert.rejects(processLeasedJob(h.options));assert.equal(h.calls.filter(x=>x==='extract').length,1)
})
test('known failed-provider cost retained, malformed or over-budget usage fails without append',async()=>{
  for(const usage of [undefined,-1,Number.MAX_SAFE_INTEGER,2500000001]) {
    const h=harness();h.options.documentLane.extract=async()=>({extraction:retainedExtraction(),usage:{costInUsdTicks:usage}})
    await assert.rejects(processLeasedJob(h.options));assert.ok(!h.calls.includes('commit'));assert.equal(h.state.state,'failed')
  }
  const h=harness();h.options.documentLane.extract=async()=>{throw Object.assign(Error('private'),{costInUsdTicks:123})}
  await assert.rejects(processLeasedJob(h.options));assert.equal(h.state.costInUsdTicks,123)
})
test('invalid extraction cannot be relabeled as a valid review result',async()=>{
  const h=harness();h.options.documentLane.extract=async()=>({extraction:{...retainedExtraction(),sourceSha256:'f'.repeat(64)},usage:{costInUsdTicks:7}})
  await assert.rejects(processLeasedJob(h.options));assert.equal(h.state.costInUsdTicks,7);assert.ok(!h.calls.includes('commit'))
})
test('cancellation or identity change during extraction is checked atomically at commit',async()=>{
  for(const field of ['cancelled','identityConfirmed','leaseCurrent']) {
    const h=harness(),extract=h.options.documentLane.extract
    h.options.documentLane.extract=async()=>{h.flags[field]=field==='cancelled';return extract()}
    await assert.rejects(processLeasedJob(h.options));assert.equal(h.state.state,'failed');assert.equal(h.state.costInUsdTicks,0)
    assert.ok(!h.calls.includes('storage.read'))
  }
})
test('uncertain commit response does not retry or regress; read-only replay recovers saved result',async()=>{
  const h=harness(),commit=h.jobs.commit
  h.jobs.commit=async args=>{await commit(args);throw Error('lost commit response')}
  await assert.rejects(processLeasedJob(h.options));assert.equal(h.state.state,'completed')
  const result=await processLeasedJob(h.options);assert.equal(result.persisted,true);assert.equal(result.replayed,true)
  assert.equal(h.calls.filter(x=>x==='extract').length,1)
})
test('wrong owner, altered envelope and unconfirmed persisted job readback cannot claim success',async()=>{
  for(const mutate of [row=>({...row,owner_id:'22222222-2222-4222-8222-222222222222'}),row=>({...row,record:{...row.record,status:'reviewed'}}),()=>null]) {
    const h=harness(),read=h.storage.read;h.storage.read=async(...args)=>mutate(await read(...args))
    await assert.rejects(processLeasedJob(h.options));await assert.rejects(processLeasedJob(h.options))
    assert.equal(h.calls.filter(x=>x==='extract').length,1)
  }
})
test('stale revision, wrong job owner and changed identity cannot replay',async()=>{
  for(const field of ['state_version','user_id','confirmed_fingerprint','request_snapshot','reservation_month']) {
    const h=harness();await processLeasedJob(h.options)
    h.options.lease[field]=field==='state_version'?3:field==='request_snapshot'?{make:'Other'}:field==='reservation_month'?'2026-10-01':field==='user_id'?'22222222-2222-4222-8222-222222222222':'b'.repeat(64)
    await assert.rejects(processLeasedJob(h.options));assert.equal(h.calls.filter(x=>x==='extract').length,1)
  }
})
test('failure settlement interruption leaves consumed attempt, never a second invocation',async()=>{
  const h=harness();h.options.documentLane.extract=async()=>{h.calls.push('extract');throw Error('timeout')}
  h.jobs.fail=async()=>{throw Error('db offline')}
  await assert.rejects(processLeasedJob(h.options));assert.equal(h.state.state,'attempted')
  await assert.rejects(processLeasedJob(h.options));assert.equal(h.calls.filter(x=>x==='extract').length,1)
})

test('identity fingerprint and reservation month reject coercible non-string tokens before reads',async()=>{
  for(const field of ['confirmed_fingerprint','reservation_month']) {
    const h=harness();h.options.lease[field]=[h.options.lease[field]]
    await assert.rejects(processLeasedJob(h.options),e=>e.code==='DOCUMENT_JOB_INVALID')
    assert.deepEqual(h.calls,[])
  }
})

test('durably claimed but lost response cannot invoke on replay',async()=>{
  const h=harness(),claim=h.jobs.claim
  h.jobs.claim=async args=>{await claim(args);throw Error('lost acknowledgement')}
  await assert.rejects(processLeasedJob(h.options),e=>e.code==='DOCUMENT_CLAIM_UNCONFIRMED')
  assert.equal(h.state.state,'attempted')
  await assert.rejects(processLeasedJob(h.options),e=>e.code==='DOCUMENT_ATTEMPT_ALREADY_CONSUMED')
  assert.equal(h.calls.filter(x=>x==='extract').length,0)
  assert.equal(h.calls.filter(x=>x==='claim').length,1)
})

test('exact successful cost is retained; provider sees document only and record excludes lease token',async()=>{
  const h=harness(),extract=h.options.documentLane.extract
  h.options.documentLane.extract=async args=>{
    assert.deepEqual(Object.keys(args),['request'])
    for(const value of [h.options.lease.id,h.options.lease.user_id,h.options.lease.item_id,h.options.lease.lease_token,h.options.lease.confirmed_fingerprint]) assert.ok(!JSON.stringify(args).includes(value))
    return {...await extract(args),usage:{costInUsdTicks:289580000}}
  }
  const result=await processLeasedJob(h.options)
  assert.equal(h.state.costInUsdTicks,289580000)
  assert.equal(result.row.record.validation_report.document_job.reservationMonth,'2026-09-01')
  assert.ok(!JSON.stringify(result.row.record).includes(h.options.lease.lease_token))
  await processLeasedJob(h.options)
  assert.equal(h.calls.filter(x=>x==='extract').length,1)
})
