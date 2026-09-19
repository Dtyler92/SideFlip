// Local CLI only. Never imported by production workers; no telemetry or logging.
import {mkdir,lstat,open,realpath} from 'node:fs/promises'
import {join,resolve,sep,dirname,basename} from 'node:path'
import {fileURLToPath} from 'node:url'
import {homedir} from 'node:os'
import {createHash,randomUUID} from 'node:crypto'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const credentialKey=/^(?:authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie|set-cookie)$/i
const repositoryRoot=fileURLToPath(new URL('../',import.meta.url))
// Resolve existing ancestors too, so a not-yet-created leaf cannot hide an alias.
async function canonical(path){
 path=resolve(path)
 try{return await realpath(path)}catch(error){
  if(error.code!=='ENOENT')throw error
  const parent=dirname(path);if(parent===path)throw error
  return join(await canonical(parent),basename(path))
 }
}
function redactText(text){
 // A physical line or compact-JSON delimiter bounds a header value. Never eat
 // neighboring JSON fields when a malformed/truncated body uses the fallback.
 return text.replace(/\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*[:=]\s*[^\r\n"'<>},]*/gi,'$1: [REDACTED]')
  .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,'$1 [REDACTED]')
  .replace(/((?:["'](?:authorization|proxy-authorization|cookie|set-cookie)["']|["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}<]+)/gi,'$1[REDACTED]')
}
function protect(bytes,secret='',truncated=false){
 const original=Buffer.from(bytes)
 const variants=[secret,JSON.stringify(secret).slice(1,-1),encodeURIComponent(secret),Buffer.from(secret).toString('base64')].filter(Boolean)
 const exact=text=>{for(const value of new Set(variants))text=text.split(value).join('[REDACTED]');return text}
 const utf8=original.toString('utf8')
 let retained
 // Private-only parsing does not move the adapter's capture-before-parse boundary.
 // Edit token spans instead of reserializing: all non-secret bytes/format survive.
 try{
  if(!Buffer.from(utf8).equals(original))throw Error()
  JSON.parse(utf8)
  const tokens=[...utf8.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)]
  let i=0;const edits=[]
  const value=(sensitive=false)=>{
   const start=tokens[i].index,token=tokens[i++][0]
   if(token==='{'||token==='['){
    const close=token==='{'?'}':']'
    while(tokens[i][0]!==close){
     if(token==='{'){
      const key=tokens[i++];i++
      const decoded=JSON.parse(key[0])
      const safeKey=exact(decoded)
      if(!sensitive&&safeKey!==decoded)edits.push([key.index,key.index+key[0].length,JSON.stringify(safeKey)])
      value(sensitive||credentialKey.test(decoded))
     }else value(sensitive)
     if(tokens[i][0]===',')i++
    }
    i++
   }else if(!sensitive&&token.startsWith('"')){
    const decoded=JSON.parse(token),safe=exact(redactText(exact(decoded)))
    if(safe!==decoded)edits.push([start,start+token.length,JSON.stringify(safe)])
   }
   if(sensitive){
    const end=tokens[i-1].index+tokens[i-1][0].length
    // Parent sensitive values supersede their nested edits.
    while(edits.length&&edits.at(-1)[0]>=start)edits.pop()
    edits.push([start,end,'"[REDACTED]"'])
   }
  }
  value()
  let text=utf8
  for(const [start,end,replacement] of edits.sort((a,b)=>b[0]-a[0]))text=text.slice(0,start)+replacement+text.slice(end)
  retained=Buffer.from(text)
 }catch{
  // Latin-1 round trips arbitrary bytes; replace known UTF-8 secret sequences.
  let text=original.toString('latin1')
  for(const variant of new Set(variants)){
   const token=Buffer.from(variant).toString('latin1')
   text=text.split(token).join('[REDACTED]')
   if(truncated)for(let n=Math.min(token.length-1,text.length);n>0;n--)if(text.endsWith(token.slice(0,n))){text=text.slice(0,-n)+'[REDACTED]';break}
  }
  retained=Buffer.from(redactText(text),'latin1')
 }
 return {bytes:retained,redacted:!retained.equals(original)}
}
export function privateProviderErrorCapture({apiKey,forbiddenRoots=[]}){
 const home=resolve(homedir()),directory=join(home,'.sideflip-private-provider-errors')
 return async({bytes,status,headers,request,truncated,readComplete,readFailed})=>{
  try{
   // Refuse home/directory symlinks, and canonicalize every exclusion root.
   if(await realpath(home)!==home)throw Error()
   const target=await canonical(directory)
   for(const root of [repositoryRoot,...forbiddenRoots]){
    const base=await canonical(root)
    if(target===base||target.startsWith(base.endsWith(sep)?base:base+sep))throw Error()
   }
   await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error})
   const info=await lstat(directory)
   if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o777)!==0o700||info.uid!==process.getuid())throw Error()
   if(await realpath(directory)!==target)throw Error()
   const original=Buffer.from(bytes),safe=protect(original,apiKey,truncated||!readComplete)
   const safeHeaders={}
   const contentType=headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase()
   if(['application/json','application/problem+json','text/plain','text/html','application/octet-stream'].includes(contentType))safeHeaders['content-type']=contentType
   const retry=headers?.get?.('retry-after');if(/^\d{1,8}$/.test(retry??''))safeHeaders['retry-after']=retry
   const body=protect(Buffer.from(request.body),apiKey).bytes
   const artifact={version:1,status,contentType:safeHeaders['content-type']??'unknown',headers:safeHeaders,
    request:{method:'POST',endpoint:'https://api.x.ai/v1/responses',model:request.model,sanitizedBodySha256:hash(body),sanitizedBody:body.toString('utf8')},
    originalAvailableBytes:original.length,originalAvailableSha256:hash(original),truncated,readComplete,readFailed,
    redacted:safe.redacted,retainedBytes:safe.bytes.length,retainedSha256:hash(safe.bytes),bodyBase64:safe.bytes.toString('base64'),bodyText:safe.bytes.toString('utf8')}
   const path=join(directory,randomUUID()+'.json')
   const file=await open(path,'wx',0o600)
   try{await file.writeFile(JSON.stringify(artifact));await file.sync()}finally{await file.close()}
   return {state:'saved',path,sha256:artifact.retainedSha256,size:artifact.retainedBytes,status,truncated,redacted:safe.redacted}
  }catch{return {state:'capture_failed'}}
 }
}
