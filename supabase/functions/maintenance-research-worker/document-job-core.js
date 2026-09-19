import {buildDocumentExtractionRequest, validateDocumentExtraction} from '../_shared/document-maintenance.js'
import {ingestDocumentMaintenance} from '../_shared/document-maintenance-ingestion.js'
import {runDocumentTransport} from './document-transport-lifecycle.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const hash = /^[0-9a-f]{64}$/
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value
const same = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
const error = code => Object.assign(new Error(code),{code})
const ticks = value => Number.isSafeInteger(value) && value >= 0 ? value : null
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function bindingFor(lease) {
  if (![lease.id,lease.user_id,lease.item_id,lease.lease_token].every(value=>typeof value==='string' && uuid.test(value)) ||
      typeof lease.confirmed_fingerprint!=='string' || !hash.test(lease.confirmed_fingerprint) || !Number.isSafeInteger(lease.state_version) || lease.state_version<1 ||
      !(Number.isSafeInteger(lease.policy_version) && lease.policy_version>0 || typeof lease.policy_version==='string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(lease.policy_version)) || lease.attempt_count!==1 ||
      !Number.isSafeInteger(lease.reserved_cents) || lease.reserved_cents<1 || lease.reserved_cents>100000 ||
      typeof lease.reservation_month!=='string' || !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(lease.reservation_month) ||
      !lease.request_snapshot || typeof lease.request_snapshot!=='object' || Array.isArray(lease.request_snapshot)) throw error('DOCUMENT_JOB_INVALID')
  return freeze(structuredClone({jobId:lease.id,ownerId:lease.user_id,itemId:lease.item_id,leaseToken:lease.lease_token,
    confirmedFingerprint:lease.confirmed_fingerprint,jobRevision:lease.state_version,policyVersion:lease.policy_version,
    reservationMonth:lease.reservation_month,reservedCents:lease.reserved_cents,requestSnapshot:lease.request_snapshot}))
}
function checkState(state,binding) {
  if (!same(state?.binding,binding) || !['authorized','identityConfirmed','policyCurrent','entitlementCurrent','reservationPersisted'].every(key=>state?.[key]===true) || state.cancelled!==false ||
      !['ready','attempted','completed','failed'].includes(state.state) || (state.state!=='completed' && state.leaseCurrent!==true)) throw error('DOCUMENT_JOB_NOT_AUTHORIZED')
  return state
}
// A lease token is transient authority, not template metadata. Never persist it
// in owner-readable source records. Retain the originating job and exact identity.
function recordBinding(binding,source) {
  const {leaseToken,...publicBinding}=binding
  return {...publicBinding,source}
}
async function readResult({state,binding,storage,expectedRecord,replayed}) {
  const record=state.record, source=state.source
  if (!uuid.test(state.templateId || '') || !source || !hash.test(source.sourceSha256 || '') ||
      !same(record?.validation_report?.document_job,recordBinding(binding,source)) ||
      record?.schema_version!=='manufacturer-template-v2' || record.status!=='needs_review' || record.applicability_reviewed!==false ||
      record.source_sha256!==source.sourceSha256 || record.payload?.sourceSha256!==source.sourceSha256 ||
      record.validation_report.auto_apply_allowed!==false || record.validation_report.semanticVerified!==false ||
      record.validation_report.sourceAuthenticated!==false || record.validation_report.applicable!==false ||
      (expectedRecord && !same(record,expectedRecord)) || ticks(state.costInUsdTicks)===null || Math.ceil(state.costInUsdTicks/100_000_000)>binding.reservedCents) throw error('DOCUMENT_READBACK_MISMATCH')
  const row=await storage.read(binding.ownerId,state.templateId)
  if (!row || row.id!==state.templateId || row.owner_id!==binding.ownerId || !same(row.record,record)) throw error('DOCUMENT_READBACK_MISMATCH')
  return {jobId:binding.jobId,candidateCount:0,status:'needs_review',persisted:true,replayed,row}
}

/** Default-off integration seam, not an HTTP/authentication boundary.
 * documentLane is trusted server injection. The RPC adapter is local/unreleased.
 * See document-job-protocol.md: claim must be durable CAS on the EXISTING job;
 * commit must atomically fence identity/cancellation and append + link + settle.
 * Never implement these methods with the released retry-capable fail RPC.
 */
export async function processDocumentLeasedJob({lease,config,documentLane}={}) {
  const {jobs,storage,acquireDocument,extract}=documentLane || {}
  const caps=jobs?.capabilities
  if (config?.documentLaneEnabled!==true || lease?.execution_lane!=='document_v2' ||
      caps?.protocol!=='document-job-v1' || caps.atomicSingleAttempt!==true || caps.terminalNoRequeue!==true || caps.atomicTemplateCommit!==true ||
      !['read','claim','commit','fail'].every(key=>typeof jobs?.[key]==='function') || typeof storage?.read!=='function' ||
      typeof acquireDocument!=='function' || typeof extract!=='function') throw error('DOCUMENT_LANE_DISABLED')
  const binding=bindingFor(lease)
  let state
  try { state=checkState(await jobs.read(binding),binding) } catch { throw error('DOCUMENT_JOB_NOT_AUTHORIZED') }
  if (state.state==='completed') {
    try { return await readResult({state,binding,storage,replayed:true}) } catch { throw error('DOCUMENT_READBACK_MISMATCH') }
  }
  if (state.state!=='ready') throw error('DOCUMENT_ATTEMPT_ALREADY_CONSUMED')
  // No default discovery/retrieval. The adapter must provide an independently
  // read original bundle; serialized JSON or a model-supplied hash is rejected.
  let bundle,request
  try { bundle=await acquireDocument({binding}); request=buildDocumentExtractionRequest(bundle) }
  catch {
    // SQL capability is READY-only: a stale acquisition loser cannot settle an
    // already-claimed attempt. Older in-memory seams lack this capability.
    if (typeof jobs.failPreflight==='function') {
      try { await jobs.failPreflight({binding,attemptId:state.attemptId}) }
      catch { throw error('DOCUMENT_FAILURE_SETTLEMENT_UNCONFIRMED') }
    }
    throw error('DOCUMENT_SOURCE_UNAVAILABLE')
  }
  const source=freeze({sourceSha256:bundle.sourceSha256,selectedPages:bundle.selectedPages})
  let claim
  try { claim=await jobs.claim({binding,source}) } catch { throw error('DOCUMENT_CLAIM_UNCONFIRMED') }
  if (claim?.claimed!==true || !uuid.test(claim.attemptId || '')) throw error('DOCUMENT_ATTEMPT_ALREADY_CONSUMED')
  const attemptId=claim.attemptId
  let costInUsdTicks=0,stage='DOCUMENT_CLAIM_UNCONFIRMED'
  try {
    state=checkState(await jobs.read(binding),binding)
    if (state.state!=='attempted' || state.attemptId!==attemptId || !same(state.source,source)) throw error(stage)
    stage='DOCUMENT_EXTRACTION_FAILED'
    costInUsdTicks=null // Invocation may have charged even when no response arrived.
    let result
    try { result=typeof jobs.transport==='function'
      ? await runDocumentTransport({extract,request,jobs,binding,attemptId,timeoutMs:documentLane.transportOptions?.timeoutMs,pollMs:documentLane.transportOptions?.pollMs})
      : await extract({request}) }
    catch (failure) { costInUsdTicks=ticks(failure?.costInUsdTicks); if(failure?.code==='DOCUMENT_TRANSPORT_TIMEOUT')stage=failure.code; throw error(stage) }
    costInUsdTicks=ticks(result?.usage?.costInUsdTicks)
    if (costInUsdTicks===null) throw error('DOCUMENT_ACCOUNTING_UNKNOWN')
    if (Math.ceil(costInUsdTicks/100_000_000)>binding.reservedCents) throw error('DOCUMENT_BUDGET_EXCEEDED')
    if (!validateDocumentExtraction(result?.extraction,bundle).valid) throw error(stage)
    const prepared=await ingestDocumentMaintenance({extraction:result.extraction,bundle,templateKey:`document-job:${binding.jobId}`,version:1,ownerId:binding.ownerId,dryRun:true})
    const record=prepared.record
    record.validation_report.document_job=recordBinding(binding,source)
    freeze(record)
    stage='DOCUMENT_STORAGE_UNCONFIRMED'
    await jobs.commit({binding,attemptId,record,costInUsdTicks})
    state=checkState(await jobs.read(binding),binding)
    if (state.state!=='completed' || state.attemptId!==attemptId || !same(state.source,source) || state.costInUsdTicks!==costInUsdTicks) throw error(stage)
    return await readResult({state,binding,storage,expectedRecord:record,replayed:false})
  } catch (failure) {
    // Never retry extraction, append, claim or settlement. A consumed attempt
    // stays consumed if failure settlement is interrupted. No raw provider text.
    const code=['DOCUMENT_ACCOUNTING_UNKNOWN','DOCUMENT_BUDGET_EXCEEDED'].includes(failure?.code)?failure.code:stage
    try { await jobs.fail({binding,attemptId,costInUsdTicks,code,requeue:false}) }
    catch { throw Object.assign(error(stage==='DOCUMENT_TRANSPORT_TIMEOUT'?stage:'DOCUMENT_FAILURE_SETTLEMENT_UNCONFIRMED'),{settlementUnconfirmed:true}) }
    throw error(code)
  }
}
