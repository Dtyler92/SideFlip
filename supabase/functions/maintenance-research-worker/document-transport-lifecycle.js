import {consumeDocumentTerminalObservation} from './xai-document-adapter.js'
// Local/unreleased. Local completion, usage and remote termination are distinct.
export async function runDocumentTransport({extract,request,jobs,binding,attemptId,timeoutMs=240000,pollMs=1000}) {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>240000||!Number.isInteger(pollMs)||pollMs<1||pollMs>10000) throw Error('DOCUMENT_TRANSPORT_CONFIG')
  const controller=new AbortController(),ackController=new AbortController()
  const observe=(event,costInUsdTicks=null,signal)=>jobs.transport({binding,attemptId,event,costInUsdTicks,signal})
  let timer,poll,stopped=false,finished=false,knownCost=null
  let rejectStop
  const stopPromise=new Promise((_,reject)=>{rejectStop=reject})
  const stop=code=>{
    if(stopped||finished)return
    stopped=true;controller.abort();ackController.abort()
    // One bounded best-effort notification; the durable start fence already
    // blocks admission. Aborting HTTP does NOT claim remote SQL cancellation.
    void observe('abort_requested',knownCost).catch(()=>{})
    rejectStop(Object.assign(Error(code),{code,costInUsdTicks:knownCost}))
  }
  timer=setTimeout(()=>stop('DOCUMENT_TRANSPORT_TIMEOUT'),timeoutMs)
  const check=async()=>{
    try {const status=await jobs.transportStatus({binding,attemptId,signal:ackController.signal});if(status.stopRequested)stop('DOCUMENT_TRANSPORT_CANCELLED')}
    catch {stop('DOCUMENT_TRANSPORT_CONTROL_UNCONFIRMED')}
    if(!stopped&&!finished)poll=setTimeout(check,pollMs)
  }
  const operation=(async()=>{
    // A bounded/lost start acknowledgement never permits a paid invocation.
    await observe('start',null,ackController.signal)
    if(stopped)throw Error('DOCUMENT_TRANSPORT_TIMEOUT')
    poll=setTimeout(check,pollMs)
    let result,failure
    try {result=await extract({request,signal:controller.signal})}catch(e){failure=e}
    const value=failure??result
    const cost=failure?failure?.costInUsdTicks:result?.usage?.costInUsdTicks
    knownCost=Number.isSafeInteger(cost)&&cost>=0?cost:null
    const terminal=consumeDocumentTerminalObservation(value,request,controller.signal)
    if(terminal)knownCost=terminal.costInUsdTicks
    // Late results only observe/reconcile; Promise.race cannot resume ingestion.
    // If timeout already fired, use the RPC adapter's independent bounded call.
    try {await observe(terminal?'response_complete':'local_stopped',knownCost,stopped?undefined:ackController.signal)}
    catch(e){throw Object.assign(e,{costInUsdTicks:knownCost})}
    if(failure)throw failure
    if(!terminal)throw Object.assign(Error('DOCUMENT_TERMINAL_UNCONFIRMED'),{code:'DOCUMENT_TERMINAL_UNCONFIRMED',costInUsdTicks:knownCost})
    return {...result,usage:{...result.usage,costInUsdTicks:knownCost}}
  })()
  try {return await Promise.race([operation,stopPromise])}
  finally {finished=true;clearTimeout(timer);clearTimeout(poll)}
}
