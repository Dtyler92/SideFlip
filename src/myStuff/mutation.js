export function createMutationId(){if(globalThis.crypto?.randomUUID)return globalThis.crypto.randomUUID();return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`}
function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.keys(value).sort().reduce((result,key)=>{if(value[key]!==undefined)result[key]=stable(value[key]);return result},{});return value}
export const createMutationAttemptState=()=>({mutationId:null,payloadKey:null})
export function mutationIdForPayload(state,payload,generate=createMutationId){const payloadKey=JSON.stringify(stable(payload));if(!state.mutationId||state.payloadKey!==payloadKey){state.mutationId=generate();state.payloadKey=payloadKey}return state.mutationId}
export function resetMutationAttemptState(state){state.mutationId=null;state.payloadKey=null}
export const canCreateMyStuffItem=({isPro,itemCount})=>Boolean(isPro)||Number(itemCount)<1

export function isMyStuffItemLockedAfterProLoss(item,items=[],plan){
  if(plan==='pro')return false
  const oldest=[...items].sort((left,right)=>{
    const leftTime=Date.parse(left?.created_at)
    const rightTime=Date.parse(right?.created_at)
    const safeLeft=Number.isFinite(leftTime)?leftTime:Number.POSITIVE_INFINITY
    const safeRight=Number.isFinite(rightTime)?rightTime:Number.POSITIVE_INFINITY
    return safeLeft-safeRight||String(left?.id||'').localeCompare(String(right?.id||''))
  })[0]
  return Boolean(oldest&&item?.id!==oldest.id)
}
