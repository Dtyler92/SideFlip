// Local document diagnostics only. These compatibility allowlists are not a
// claim that xAI guarantees any particular error envelope or error vocabulary.
// Never return message substrings, arbitrary paths, headers, IDs or raw bodies.
const types=['invalid_request_error','authentication_error','permission_error','rate_limit_error','server_error']
const codes=['invalid_request_error','invalid_argument','InvalidArgument','unsupported_parameter','unsupported_value','invalid_value','missing_required_parameter','invalid_json_schema','context_length_exceeded','model_not_found','invalid_api_key','permission_denied','PermissionDenied','Unauthenticated','rate_limit_exceeded','insufficient_quota']
const params=['model','input','input[0].role','input[0].content','input[1].role','input[1].content','store','tools','tool_choice','parallel_tool_calls','max_output_tokens','temperature','top_p','reasoning','reasoning.effort','response_format','text','text.format','text.format.type','text.format.name','text.format.schema','text.format.strict']
const allowed=(value,list)=>typeof value==='string'&&list.includes(value)?value:'unknown'
const reasons=new Map([
 ['unsupported_parameter','unsupported_parameter'],['unsupported_value','unsupported_value'],['invalid_value','invalid_value'],['missing_required_parameter','missing_parameter'],['invalid_json_schema','invalid_schema'],['context_length_exceeded','context_limit'],['model_not_found','model_not_found'],['invalid_api_key','authentication'],['Unauthenticated','authentication'],['permission_denied','permission_denied'],['PermissionDenied','permission_denied'],['rate_limit_exceeded','rate_limit'],['insufficient_quota','quota'],
])
// Whole-message equality only: trailing echoed source or credentials invalidates
// a match. No regex captures or guessed free-text redaction can escape.
const messages=new Map([['Invalid JSON schema.','invalid_schema'],['Invalid API key.','authentication']])
for(const param of params){
 messages.set(`Unsupported parameter: '${param}'.`,'unsupported_parameter')
 messages.set(`Missing required parameter: '${param}'.`,'missing_parameter')
}
export function safeProviderError(body){
 const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)
 const root=object(body)?body:{}
 const error=object(root.error)?root.error:root
 const type=allowed(error.type,types),code=allowed(error.code,codes),param=allowed(error.param,params)
 const message=typeof error.message==='string'?error.message:typeof root.error==='string'?root.error:null
 const reason=reasons.get(code)??(message!==null&&message.length<=512?messages.get(message):undefined)??'unknown'
 // Bounded framework diagnostics: only fixed field/category tokens escape,
 // never the invalid value, expected-type prose, line/column or echoed input.
 const signals={}
 if(message!==null&&message.length<=8192&&/^Failed to deserialize (?:the )?JSON body into (?:the )?target type: /.test(message)){
  const tail=message.slice(message.indexOf(': ')+2)
  const fields=params.filter(field=>tail.startsWith(field+':'))
  const kind=tail.includes(': invalid type: ')?'invalid_type':tail.includes(': unknown variant ')?'unknown_variant':tail.includes(': missing field ')?'missing_field':'unknown'
  signals.messageSignals={category:'request_deserialization',fields,kind}
 }
 return {type,code,param,reason,...signals}
}
