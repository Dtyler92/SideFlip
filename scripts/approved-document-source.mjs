import {lookup} from 'node:dns/promises'
import {request} from 'node:https'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {isPublicIPv4} from './public-document-retrieval.mjs'
import {readDocumentBundle} from '../supabase/functions/_shared/document-maintenance.js'
const fail=code=>Object.assign(Error(code),{code})
// Exact official URLs are trusted operator policy input, NEVER browser/model input.
// Approval is a retrieval/rights gate, NOT authentication or vehicle applicability.
export function assertApprovedDocument({source,binding,approvedSources}) {
 let url
 try {url=new URL(source.url)}catch{throw fail('DOCUMENT_SOURCE_POLICY')}
 const policy=approvedSources?.find(p=>p.url===source.url)
 if(url.href!==source.url || url.protocol!=='https:' || url.username || url.password || url.hash || (url.port&&url.port!=='443') ||
   !/^[a-f0-9]{64}$/.test(source.expectedSha256||'') || typeof source.pages!=='string' || source.pages.length>500 ||
   !/^[1-9][0-9]*(?:-[1-9][0-9]*)?(?:,[1-9][0-9]*(?:-[1-9][0-9]*)?)*$/.test(source.pages) ||
   !policy || policy.officialSourceApproved!==true || policy.termsAllowed!==true || policy.robotsAllowed!==true || policy.documentPrivacyReviewed!==true ||
   !Number.isFinite(Date.parse(policy.expiresAt)) || Date.parse(policy.expiresAt)<=Date.now() || policy.policyVersion!==binding.policyVersion ||
   typeof binding.requestSnapshot?.make!=='string' || policy.manufacturer?.toLowerCase()!==binding.requestSnapshot.make.toLowerCase())throw fail('DOCUMENT_SOURCE_POLICY')
 return url
}
// Public IPv4 only; reject all ambiguous/mixed/private answers and every redirect.
// Resolver and HTTPS request injections exist for offline interception only.
export async function acquireApprovedDocument({source,binding,approvedSources,lookupImpl=lookup,requestImpl=request,maxBytes=25*1024*1024,timeoutMs=30000}={}) {
 const url=assertApprovedDocument({source,binding,approvedSources})
 if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>25*1024*1024||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw fail('DOCUMENT_SOURCE_LIMIT')
 let timer,req,res,stopped=false
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{stopped=true;reject(fail('DOCUMENT_SOURCE_TIMEOUT'));res?.destroy();req?.destroy()},timeoutMs)})
 let bytes
 try {
  bytes=await Promise.race([deadline,(async()=>{
   const addresses=await lookupImpl(url.hostname,{all:true})
   if(stopped)throw fail('DOCUMENT_SOURCE_TIMEOUT')
   if(!addresses.length||addresses.some(a=>a.family!==4||!isPublicIPv4(a.address)))throw fail('DOCUMENT_SOURCE_ADDRESS')
   return await new Promise((resolve,reject)=>{
    req=requestImpl(url,{lookup:(_host,opts,cb)=>opts.all?cb(null,[addresses[0]]):cb(null,addresses[0].address,4),headers:{Accept:'application/pdf','User-Agent':'SideFlip-local-document-job/1.0'}},response=>{
     res=response
     const stop=code=>{reject(fail(code));res.destroy();req.destroy()}
     if(stopped){stop('DOCUMENT_SOURCE_TIMEOUT');return}
     if(res.statusCode!==200){stop('DOCUMENT_SOURCE_HTTP');return}
     if(String(res.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/pdf'){stop('DOCUMENT_SOURCE_MIME');return}
     const length=res.headers['content-length']
     if(length!==undefined&&(!/^\d+$/.test(String(length))||Number(length)>maxBytes)){stop('DOCUMENT_SOURCE_LIMIT');return}
     let size=0;const chunks=[]
     res.on('error',()=>reject(fail('DOCUMENT_SOURCE_IO')))
     res.on('aborted',()=>reject(fail('DOCUMENT_SOURCE_IO')))
     res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){stop('DOCUMENT_SOURCE_LIMIT');return}chunks.push(chunk)})
     res.on('end',()=>resolve(Buffer.concat(chunks)))
    })
    req.on('error',()=>reject(fail('DOCUMENT_SOURCE_IO')));req.end()
   })
  })()])
 }finally{clearTimeout(timer)}
 if(bytes.subarray(0,5).toString()!=='%PDF-')throw fail('DOCUMENT_SOURCE_PDF')
 if(createHash('sha256').update(bytes).digest('hex')!==source.expectedSha256)throw fail('DOCUMENT_SOURCE_HASH')
 const dir=await mkdtemp(join(tmpdir(),'sideflip-document-source-'))
 try {
  const path=join(dir,'source.pdf');await writeFile(path,bytes,{flag:'wx',mode:0o600})
  const bundle=await readDocumentBundle(path,source.pages,{rejectPrivateAnnotations:true})
  if(bundle.sourceSha256!==source.expectedSha256)throw fail('DOCUMENT_SOURCE_HASH')
  return bundle
 }finally{await rm(dir,{recursive:true,force:true})}
}
