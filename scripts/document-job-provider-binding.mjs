import {dispatchDocumentJob} from '../supabase/functions/maintenance-research-worker/document-dispatch.js'
import {documentJobRpcAdapter} from '../supabase/functions/maintenance-research-worker/document-job-rpc.js'
import {createXaiDocumentAdapter} from '../supabase/functions/maintenance-research-worker/xai-document-adapter.js'
import {buildDocumentExtractionRequest} from '../supabase/functions/_shared/document-maintenance.js'
import {acquireApprovedDocument,assertApprovedDocument} from './approved-document-source.mjs'
const fail=()=>{throw Error('DOCUMENT_BINDING_DISABLED')}
// Local Node/Python only; deliberately NOT imported by the deployed Edge worker.
// sourceForJob returns a trusted explicit selection, never automatic discovery:
// {jobId, confirmedFingerprint, policyVersion, source:{url,expectedSha256,pages}}.
export async function dispatchBoundDocumentJob({enabled=false,client,workerId,storage,sourceForJob,approvedSources,provider,acquisitionOptions,transportOptions}={}) {
 if(enabled!==true||typeof client?.rpc!=='function'||typeof storage?.read!=='function'||typeof sourceForJob!=='function'||!Array.isArray(approvedSources)||!approvedSources.length||
   provider?.authorized!==true||provider?.documentPrivacyReviewed!==true||provider?.model!=='grok-4.6')fail()
 const policies=structuredClone(approvedSources)
 const jobs=documentJobRpcAdapter(client,{timeoutMs:transportOptions?.rpcTimeoutMs??10000})
 let bundle,binding,source,invocationSignal,reserved=false
 const adapter=createXaiDocumentAdapter({apiKey:provider.apiKey,model:provider.model,authorized:true,documentPrivacyReviewed:true,
  maxCostTicks:provider.maxCostTicks,inputTicksPerToken:provider.inputTicksPerToken,outputTicksPerToken:provider.outputTicksPerToken,
  maxInputBytes:provider.maxInputBytes,maxOutputTokens:provider.maxOutputTokens,timeoutMs:provider.timeoutMs,fetchImpl:provider.fetchImpl,
  // No file ledger, second job, reserve mutation or legacy retry. Re-authorize the
  // already persisted SQL claim and start fence immediately before actual HTTP.
  reserve:async proposed=>{
   if(reserved||!binding||!bundle)fail()
   assertApprovedDocument({source,binding,approvedSources:policies})
   const state=await jobs.read(binding)
   if(state.state!=='attempted'||state.cancelled!==false||!['authorized','identityConfirmed','policyCurrent','entitlementCurrent','reservationPersisted','leaseCurrent'].every(k=>state[k]===true)||
      state.source?.sourceSha256!==bundle.sourceSha256||JSON.stringify(state.source.selectedPages)!==JSON.stringify(bundle.selectedPages)||
      proposed.sourceSha256!==bundle.sourceSha256||JSON.stringify(proposed.selectedPages)!==JSON.stringify(bundle.selectedPages)||
      proposed.maxCostTicks>binding.reservedCents*100000000)fail()
   const status=await jobs.transportStatus({binding,attemptId:state.attemptId})
   if(invocationSignal?.aborted||status.stopRequested!==false||status.transportState!=='in_flight')fail()
   reserved=true
   // Adapter usage is returned to the existing lifecycle/atomic finalizer.
   // This acknowledgement MUST NOT independently release or settle SQL budget.
   return {settle:async()=>{}}
  }})
 return dispatchDocumentJob({enabled:true,client,workerId,storage,transportOptions,
  acquireDocument:async context=>{
   binding=context.binding
   const selected=await sourceForJob(binding)
   if(selected?.jobId!==binding.jobId||selected?.confirmedFingerprint!==binding.confirmedFingerprint||selected?.policyVersion!==binding.policyVersion)throw Error('DOCUMENT_SOURCE_SELECTION_REQUIRED')
   source=structuredClone(selected.source)
   bundle=await acquireApprovedDocument({...acquisitionOptions,source,binding,approvedSources:policies})
   return bundle
  },
  extract:async({request,signal})=>{
   if(!bundle||JSON.stringify(request)!==JSON.stringify(buildDocumentExtractionRequest(bundle)))fail()
   if(signal?.aborted)fail()
   invocationSignal=signal
   return adapter.extract(bundle,{signal})
  }})
}
