export function createMutationId(){if(globalThis.crypto?.randomUUID)return globalThis.crypto.randomUUID();return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`}
function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.keys(value).sort().reduce((result,key)=>{if(value[key]!==undefined)result[key]=stable(value[key]);return result},{});return value}
export const createMutationAttemptState=()=>({mutationId:null,payloadKey:null})
export function mutationIdForPayload(state,payload,generate=createMutationId){const payloadKey=JSON.stringify(stable(payload));if(!state.mutationId||state.payloadKey!==payloadKey){state.mutationId=generate();state.payloadKey=payloadKey}return state.mutationId}
export function resetMutationAttemptState(state){state.mutationId=null;state.payloadKey=null}
export const canCreateMyStuffItem=({isPro,itemCount})=>Boolean(isPro)||Number(itemCount)<1
