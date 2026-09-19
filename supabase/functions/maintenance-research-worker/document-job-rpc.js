// Trusted service client only. No activation, credentials, retrieval or provider defaults.
export function documentJobRpcAdapter(client,{timeoutMs=10000}={}) {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>240000)throw Error('DOCUMENT_RPC_CONFIG')
  if (typeof client?.rpc !== 'function') throw new TypeError('RPC client required')
  const call = async (name,args,signal) => {
    const controller=new AbortController()
    let timer,rejectStop
    const stop=new Promise((_,reject)=>{rejectStop=reject})
    const abort=()=>{
      controller.abort()
      rejectStop(Object.assign(Error('DOCUMENT_RPC_TIMEOUT'),{code:'DOCUMENT_RPC_TIMEOUT'}))
    }
    signal?.addEventListener('abort',abort,{once:true})
    timer=setTimeout(abort,timeoutMs)
    try {
      if(signal?.aborted){abort();return await stop}
      // PostgREST supports abortSignal. Custom/local clients may not; the local
      // race remains bounded, but remote commit/cancellation is NOT inferred.
      let query=client.rpc(name,args)
      if(typeof query?.abortSignal==='function')query=query.abortSignal(controller.signal)
      const {data,error}=await Promise.race([Promise.resolve(query),stop])
      if(error) throw Object.assign(new Error(error.message || 'DOCUMENT_RPC_FAILED'),{code:error.code})
      return data
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort)}
  }
  return {
    capabilities:{protocol:'document-job-v1',atomicSingleAttempt:true,terminalNoRequeue:true,atomicTemplateCommit:true},
    read:binding=>call('read_document_job_v1',{p_binding:binding}),
    claim:({binding,source})=>call('claim_document_job_v1',{p_binding:binding,p_source:source}),
    commit:({binding,attemptId,record,costInUsdTicks})=>call('finalize_document_job_v1',{p_binding:binding,p_attempt_id:attemptId,p_record:record,p_cost_ticks:costInUsdTicks}),
    failPreflight:({binding,attemptId})=>call('fail_document_preflight_v1',{p_binding:binding,p_attempt_id:attemptId}),
    transport:({binding,attemptId,event,costInUsdTicks,signal})=>call('observe_document_transport_v1',{p_binding:binding,p_attempt_id:attemptId,p_event:event,p_cost_ticks:costInUsdTicks},signal),
    transportStatus:({binding,attemptId,signal})=>call('get_document_transport_status_v1',{p_binding:binding,p_attempt_id:attemptId},signal),
    fail:({binding,attemptId,costInUsdTicks,code,requeue})=>{
      if(requeue!==false) throw new Error('DOCUMENT_REQUEUE_FORBIDDEN')
      return call('fail_document_job_v2',{p_binding:binding,p_attempt_id:attemptId,p_cost_ticks:costInUsdTicks,p_code:code})
    },
  }
}
