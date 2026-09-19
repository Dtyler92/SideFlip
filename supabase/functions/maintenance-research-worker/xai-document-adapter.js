import {buildDocumentExtractionRequest} from '../_shared/document-maintenance.js'
import {safeProviderError} from './document-provider-error.js'
import {parseJsonText,exactTicks} from './xai-provider.js'
// Only this adapter can mint a terminal observation. Object identity plus the
// exact invocation signal/request prevent flags, copies and cross-attempt replay.
// No provider identifier or response body leaves this process-local WeakMap.
const terminalObservations=new WeakMap()
export function consumeDocumentTerminalObservation(value,request,signal) {
  const evidence=value && terminalObservations.get(value)
  if(!evidence || evidence.signal!==signal || evidence.request!==JSON.stringify(request))return false
  terminalObservations.delete(value)
  return {costInUsdTicks:evidence.costInUsdTicks}
}
// Only fixed enums and a bounded integer leave this local boundary. No provider
// request ID is retained: arbitrary headers have not received privacy approval.
const transportKind = error => {
  if(error?.name==='AbortError')return 'abort'
  const code=error?.cause?.code??error?.code
  if(['ECONNRESET','UND_ERR_SOCKET'].includes(code))return 'reset'
  if(['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(code))return 'timeout'
  if(['ENOTFOUND','EAI_AGAIN'].includes(code))return 'dns'
  if(['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code))return 'tls'
  return 'unknown'
}
async function readDocumentResponse(response,diagnostics,capture,signal,bodyFinished) {
  if(!capture && Number(response.headers?.get?.('content-length')||0)>1000000){diagnostics.category='response_limit';diagnostics.responseParse='too_large';void response.body?.cancel().catch(()=>{});throw Error()}
  diagnostics.category='response_read';diagnostics.responseParse='read_failed'
  const state=capture?.state??{chunks:[],length:0,truncated:false,readComplete:false,readFailed:false}
  let reader
  // Cancel the owned reader explicitly as well as fetch: injected transports
  // and already-returned bodies need not react to fetch's AbortSignal.
  const abortRead=()=>{state.readFailed=true;void reader?.cancel().catch(()=>{})}
  try {
    if(signal.aborted)throw Error()
    if(response.body===null){state.readComplete=true}
    else {
      if(!response.body?.getReader)throw Error()
      reader=response.body.getReader()
      signal.addEventListener('abort',abortRead,{once:true})
      while(true){const {done,value}=await reader.read();if(signal.aborted)throw Error();if(done){state.readComplete=true;break}
        const remaining=1000000-state.length
        const chunk=value.slice(0,remaining);state.chunks.push(chunk);state.length+=chunk.byteLength
        if(value.byteLength>remaining){state.truncated=true;diagnostics.category='response_limit';diagnostics.responseParse='too_large';void reader.cancel().catch(()=>{});throw Error()}
      }
    }
  }catch(error){state.readFailed=!state.truncated;throw error}
  finally{signal.removeEventListener('abort',abortRead);reader?.releaseLock();bodyFinished();if(capture)await capture.save()}
  if(signal.aborted)throw Error()
  const bytes=new Uint8Array(state.length);let offset=0
  for(const chunk of state.chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
  diagnostics.category='response_parse';diagnostics.responseParse='invalid_json'
  const result=JSON.parse(new TextDecoder().decode(bytes))
  diagnostics.responseParse='parsed'
  return result
}
const positive = n => Number.isSafeInteger(n) && n > 0
const safeError = (stage,ticks=null) => Object.assign(new Error('Document extraction boundary failed'),{code:'DOCUMENT_EXTRACTION_FAILED',stage,costInUsdTicks:ticks})
// xAI's reasoning/Responses guides recommend a longer client timeout. Keep
// the old default; a reviewed local invocation may opt into at most 4 minutes.
// This is an overall fetch+body deadline, never extended by received bytes.
// No SDK/retries/background storage or changes to token/cost limits are added.
export const DOCUMENT_DEFAULT_TIMEOUT_MS=120000
export const DOCUMENT_MAX_TIMEOUT_MS=240000
// Trusted local caller only; never exposed as a production worker/job protocol.
export function createXaiDocumentAdapter({apiKey,model,authorized,documentPrivacyReviewed,reserve,fetchImpl=fetch,maxCostTicks,inputTicksPerToken,outputTicksPerToken,maxInputBytes=200000,maxOutputTokens=8000,timeoutMs=DOCUMENT_DEFAULT_TIMEOUT_MS,privateErrorCapture}) {
  if (authorized!==true || documentPrivacyReviewed!==true || typeof apiKey!=='string' || !apiKey.trim() || typeof model!=='string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(model) || typeof reserve!=='function' || !positive(maxCostTicks) || maxCostTicks>10000000000 || !positive(inputTicksPerToken) || !positive(outputTicksPerToken) || !positive(maxInputBytes) || maxInputBytes>200000 || !positive(maxOutputTokens) || maxOutputTokens>8000 || !positive(timeoutMs) || timeoutMs>DOCUMENT_MAX_TIMEOUT_MS) throw safeError('document_configuration')
  let used=false
  return {async extract(bundle,{signal}={}) {
    if(used) throw safeError('document_reservation')
    let request
    try {request=buildDocumentExtractionRequest(bundle)} catch {throw safeError('document_input')}
    // Only independently parsed selected PDF pages; no asset/VIN/owner context.
    const {sourceSha256,selectedPages,pages,contextSignals}=request.document
    // xAI rejects any tool_choice with no tools, including 'none'. Empty tools
    // plus the response tool-use validation below retain this lane's no-tools policy.
    // Keep exact source blocks, order and geometry. Omit page.text ONLY when
    // it is byte-for-byte reconstructable from those blocks; otherwise retain it.
    // The response schema already contains every contract enum/field list.
    const sourcePages=pages.map(page=>{
      if(page.blocks.map(block=>block.text).join('\n')+'\n'!==page.text)return page
      const {text,...rest}=page;return rest
    })
    // Reviewed local document policy for this exact model only. Official xAI
    // reasoning guide + Responses ModelRequest specify reasoning.effort='low'.
    // Other models/aliases retain their provider default; infer no capability.
    const reasoningConfig=model==='grok-4.6'?{reasoning:{effort:'low'}}:{}
    const body=JSON.stringify({model,store:false,tools:[],parallel_tool_calls:false,max_output_tokens:maxOutputTokens,...reasoningConfig,
      input:[{role:'system',content:request.system},{role:'user',content:JSON.stringify({schemaVersion:2,responseSchema:request.responseSchema,document:{sourceSha256,selectedPages,pages:sourcePages,contextSignals}})}]})
    const bytes=new TextEncoder().encode(body).length
    // Conservative byte-as-token upper bound + framing allowance; caller must
    // provide reviewed upper-bound prices including reasoning/output charges.
    const ceiling=(bytes+4096)*inputTicksPerToken+maxOutputTokens*outputTicksPerToken
    if(bytes>maxInputBytes || !Number.isSafeInteger(ceiling) || ceiling>maxCostTicks) throw safeError('document_input')
    used=true
    let reservation
    try {reservation=await reserve({maxCostTicks,estimatedCeilingTicks:ceiling,sourceSha256,selectedPages,model});if(typeof reservation?.settle!=='function')throw Error()} catch {throw safeError('document_reservation')}
    let ticks=null, extraction, failure
    const diagnostics={category:'transport_error',httpStatus:null,httpCategory:'no_response',transportKind:null,responseParse:'not_started'}
    let httpRejected=false,capture,terminalValidated=false
    const controller=new AbortController()
    const abortExternal=()=>controller.abort()
    signal?.addEventListener('abort',abortExternal,{once:true})
    if(signal?.aborted)controller.abort()
    let timer
    try {
      const operation=(async()=>{
        const response=await fetchImpl('https://api.x.ai/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'content-type':'application/json'},body,signal:controller.signal,redirect:'error'})
        if(!response)throw Error()
        // A noncooperative fetch can resolve after the race has timed out.
        // Do not parse/capture late bytes or mutate the settled unknown charge.
        if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw Error()}
        const status=response.status
        diagnostics.httpStatus=Number.isInteger(status)&&status>=100&&status<=599?status:null
        diagnostics.httpCategory=diagnostics.httpStatus===null?'unknown':status<200?'informational':status<300?'success':status<400?'redirect':status<500?'client_error':'server_error'
        httpRejected=!response.ok
        // Bounded error envelopes can contain measured charges; retain them
        // before rejecting HTTP failure, without exposing the provider body.
        if(httpRejected && typeof privateErrorCapture==='function'){
          const state={chunks:[],length:0,truncated:false,readComplete:false,readFailed:false}
          let pending
          capture={state,save(){
            if(!pending)pending=(async()=>{
              const bytes=new Uint8Array(state.length);let offset=0
              for(const chunk of state.chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
              try{diagnostics.privateCapture=await privateErrorCapture({bytes,status:diagnostics.httpStatus,headers:response.headers,request:{body,model},truncated:state.truncated,readComplete:state.readComplete,readFailed:state.readFailed})}
              catch{diagnostics.privateCapture={state:'capture_failed'}}
            })()
            return pending
          }}
        }
        // The deadline bounds remote fetch/body I/O, not the awaited local
        // capture. Slow capture must not discard usage in a fully read envelope.
        const result=await readDocumentResponse(response,diagnostics,capture,controller.signal,()=>clearTimeout(timer))
        const cost=result?.usage?.cost_in_usd_ticks
        if(Number.isSafeInteger(cost)&&cost>=0)ticks=cost
        if(httpRejected){diagnostics.providerError=safeProviderError(result);throw Error()}
        if(status!==200)throw Error()
        diagnostics.category='envelope_validation'
        // This tools-disabled lane rejects tool-role messages as well as tool
        // call items, including a tool message beside valid assistant JSON.
        if(exactTicks(result,model)>maxCostTicks || !Array.isArray(result.output) || result.output.some(x=>!x||(x.type!=='message'&&x.type!=='reasoning')||(x.type==='message'&&(x.status!=='completed'||(x.role!==undefined&&x.role!=='assistant')))) || (result.usage?.num_server_side_tools_used||0)!==0)throw Error()
        diagnostics.category='output_parse'
        const parsed=parseJsonText(result)
        // Retained official Responses contract: id is a string (no guessed
        // prefix), object=response, exact requested model; no alias inference.
        terminalValidated=result.object==='response' && typeof result.id==='string' && result.id.trim().length>0 &&
          result.error==null && result.incomplete_details==null && result.background!==true &&
          result.output.every(item=>item.type==='message'?item.role==='assistant':item.status===undefined||item.status==='completed')
        return parsed
      })()
      extraction=await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>{diagnostics.category='timeout';diagnostics.transportKind='timeout';controller.abort();reject(Error())},timeoutMs)})])
    } catch(error) {
      if(capture)await capture.save()
      if(['transport_error','response_read'].includes(diagnostics.category))diagnostics.transportKind=transportKind(error)
      if(httpRejected && diagnostics.category!=='timeout')diagnostics.category='http_rejection'
      failure=Object.assign(safeError('document_response',ticks),{diagnostics:{...diagnostics}})
    } finally {clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',abortExternal)}
    const usage={costInUsdTicks:ticks,costKnown:ticks!==null,chargedTicks:ticks===null?maxCostTicks:ticks,reservedTicks:maxCostTicks}
    const attest=value=>{
      if(terminalValidated)terminalObservations.set(value,{signal,request:JSON.stringify(request),costInUsdTicks:ticks})
      return value
    }
    try {await reservation.settle(usage)} catch {throw attest(safeError('document_settlement',ticks))}
    if(failure)throw attest(failure)
    return attest({extraction,usage})
  }}
}
