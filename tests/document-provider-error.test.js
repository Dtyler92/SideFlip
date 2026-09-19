import test from 'node:test'
import assert from 'node:assert/strict'
import {safeProviderError} from '../supabase/functions/maintenance-research-worker/document-provider-error.js'

// Synthetic offline compatibility fixtures, NOT retained live provider responses.
const unknown={type:'unknown',code:'unknown',param:'unknown',reason:'unknown'}
test('nested compatibility error retains only fixed identifiers',()=>{
 assert.deepEqual(safeProviderError({error:{type:'invalid_request_error',code:'unsupported_parameter',param:'parallel_tool_calls',message:'SECRET document echoed'}}),{type:'invalid_request_error',code:'unsupported_parameter',param:'parallel_tool_calls',reason:'unsupported_parameter'})
})
test('flat xAI-style code/error envelope and exact message classification',()=>{
 assert.deepEqual(safeProviderError({code:'InvalidArgument',error:"Unsupported parameter: 'tool_choice'."}),{...unknown,code:'InvalidArgument',reason:'unsupported_parameter'})
 assert.deepEqual(safeProviderError({error:{message:'Invalid JSON schema.'}}),{...unknown,reason:'invalid_schema'})
})
test('unknown and hostile values never escape or become inferred explanations',()=>{
 for(const body of [null,[],{},'SECRET',{error:'SECRET'},{error:{type:'SECRET',code:'SECRET',param:'input.SECRET',message:"Unsupported parameter: 'SECRET'."}},{error:{message:"Invalid JSON schema. SECRET"}},{error:{code:['invalid_request_error'],param:{toString:()=> 'model'}}},{error:{message:'x'.repeat(10000)}}])assert.deepEqual(safeProviderError(body),unknown)
})
test('bounded deserialization diagnostics retain only fixed request-field signals',()=>{
 const actual=safeProviderError({error:'Failed to deserialize the JSON body into the target type: input[0].content: invalid type: string PRIVATE_SECRET, expected a sequence at line 1 column 500'})
 assert.deepEqual(actual,{...unknown,messageSignals:{category:'request_deserialization',fields:['input[0].content'],kind:'invalid_type'}})
 assert.ok(!JSON.stringify(actual).includes('PRIVATE_SECRET'))
 assert.deepEqual(safeProviderError({error:'PRIVATE_SECRET input[0].content invalid type'}),unknown)
})
test('known code categories and nested params use exact enums only',()=>{
 assert.deepEqual(safeProviderError({error:{code:'context_length_exceeded',param:'text.format.schema'}}),{...unknown,code:'context_length_exceeded',param:'text.format.schema',reason:'context_limit'})
 assert.equal(safeProviderError({error:{code:'invalid_api_key'}}).reason,'authentication')
 assert.equal(safeProviderError({error:{code:'invalid_request_error'}}).reason,'unknown')
})
