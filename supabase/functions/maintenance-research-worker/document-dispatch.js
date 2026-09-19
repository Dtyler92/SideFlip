import {documentJobRpcAdapter} from './document-job-rpc.js'
import {processLeasedJob} from './worker-core.js'

// Local/unreleased dispatcher. No discovery, retrieval, provider, credentials or
// activation defaults. Callers must explicitly supply bounded transports.
export async function dispatchDocumentJob({enabled=false,client,workerId,storage,acquireDocument,extract,transportOptions}={}) {
  if (enabled!==true || typeof client?.rpc!=='function' || typeof storage?.read!=='function' ||
      typeof acquireDocument!=='function' || typeof extract!=='function') throw Error('DOCUMENT_LANE_DISABLED')
  const {data:lease,error}=await client.rpc('lease_document_dispatch_v1',{p_worker:workerId})
  if(error) throw Error('DOCUMENT_DISPATCH_UNCONFIRMED')
  if(!lease) return {processed:0}
  if(lease.execution_lane!=='document_v2') throw Error('DOCUMENT_LANE_MISMATCH')
  const result=await processLeasedJob({lease,config:{documentLaneEnabled:true},documentLane:{jobs:documentJobRpcAdapter(client,{timeoutMs:transportOptions?.rpcTimeoutMs??transportOptions?.timeoutMs??10000}),storage,acquireDocument,extract,transportOptions}})
  return {processed:1,...result}
}
