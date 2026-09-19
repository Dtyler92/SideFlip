// Local contract double, NOT a production database adapter. Atomicity/ACLs of
// the future job RPC must be implemented and independently tested before use.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {readDocumentBundle} from '../../supabase/functions/_shared/document-maintenance.js'
export const leaseFixture = () => ({
  id:'33333333-3333-4333-8333-333333333333', user_id:'11111111-1111-4111-8111-111111111111',
  item_id:'44444444-4444-4444-8444-444444444444', lease_token:'55555555-5555-4555-8555-555555555555',
  confirmed_fingerprint:'a'.repeat(64), policy_version:1, state_version:2, attempt_count:1,
  reserved_cents:25, reservation_month:'2026-09-01', execution_lane:'document_v2',
  request_snapshot:{modelYear:2020,make:'Ford',model:'F-150'},
})
let bundlePromise
export const retainedBundle = () => bundlePromise ||= readDocumentBundle('/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf','561')
export const retainedExtraction = () => JSON.parse(readFileSync(new URL('../fixtures/ford-retained-live-extraction.json',import.meta.url)))
export function harness(storageOverride) {
  const lease=leaseFixture(), calls=[], rows=new Map()
  let state=null
  const storage=storageOverride || {
    async append(owner, record) {
      const id='66666666-6666-4666-8666-666666666666'
      const row={id,owner_id:owner,record:structuredClone(record)}
      if(rows.has(id)) assert.deepEqual(rows.get(id),row)
      rows.set(id,row); return id
    },
    async read(owner,id) { calls.push('storage.read'); const row=rows.get(id); return row?.owner_id===owner?structuredClone(row):null },
  }
  const flags={authorized:true,identityConfirmed:true,policyCurrent:true,entitlementCurrent:true,reservationPersisted:true,cancelled:false,leaseCurrent:true}
  const jobs={
    capabilities:{protocol:'document-job-v1',atomicSingleAttempt:true,terminalNoRequeue:true,atomicTemplateCommit:true},
    async read(binding) {
      calls.push('read')
      if(state) assert.deepEqual(binding,state.binding)
      return structuredClone({...flags,...(state || {binding,state:'ready'})})
    },
    async claim({binding,source}) {
      calls.push('claim')
      if(state || !flags.authorized || !flags.identityConfirmed || !flags.policyCurrent || !flags.entitlementCurrent || flags.cancelled || !flags.leaseCurrent || !flags.reservationPersisted) return {claimed:false}
      state={binding:structuredClone(binding),source:structuredClone(source),state:'attempted',attemptId:'77777777-7777-4777-8777-777777777777'}
      return {claimed:true,attemptId:state.attemptId}
    },
    async commit({binding,attemptId,record,costInUsdTicks}) {
      calls.push('commit')
      assert.deepEqual(binding,state.binding); assert.equal(attemptId,state.attemptId)
      assert.equal(state.state,'attempted')
      for(const key of ['authorized','identityConfirmed','policyCurrent','entitlementCurrent','leaseCurrent']) assert.equal(flags[key],true,key)
      assert.equal(flags.cancelled,false)
      // Real storageOverride exercises the immutable SQL RPC, but this test
      // double does NOT make the SQL append and JS job state one transaction.
      const templateId=await storage.append(binding.ownerId,record)
      state={...state,state:'completed',record:structuredClone(record),templateId,costInUsdTicks}
    },
    async fail({binding,attemptId,costInUsdTicks,code}) {
      calls.push('fail')
      assert.deepEqual(binding,state.binding); assert.equal(attemptId,state.attemptId)
      if(state.state==='completed') return // never regress an uncertain committed success
      state={...state,state:'failed',costInUsdTicks,code,chargeUnknown:costInUsdTicks===null,requeue:false}
    },
  }
  const options={lease,config:{documentLaneEnabled:true},documentLane:{jobs,storage,
    acquireDocument:async()=>{calls.push('source');return retainedBundle()},
    extract:async()=>{calls.push('extract');return {extraction:retainedExtraction(),usage:{costInUsdTicks:0}}},
  }}
  return {options,calls,flags,jobs,storage,get state(){return state},setState(value){state=value}}
}
