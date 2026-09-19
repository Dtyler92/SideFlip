import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
// Local CLI only. Ordinary HTTPS, public IPv4, no credentials, no anti-bot bypass.
export function isPublicIPv4(ip) {
  if (isIP(ip) !== 4) return false
  const [a,b] = ip.split('.').map(Number)
  return !(a===0 || a===10 || a===127 || a>=224 || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&(b===168||b===0||b===2)) || (a===100&&b>=64&&b<=127) || (a===198&&(b===18||b===19||b===51)) || (a===203&&b===0))
}
export async function retrievePublicPdf(sourceUrl, destination) {
  const url=new URL(sourceUrl)
  if(url.protocol!=='https:' || url.username || url.password || (url.port && url.port!=='443')) throw Error('Public HTTPS without credentials required')
  const addresses=await lookup(url.hostname,{all:true,family:4})
  if(!addresses.length || addresses.some(x=>!isPublicIPv4(x.address))) throw Error('Non-public destination rejected')
  const bytes=await new Promise((resolve,reject)=>{
    // Pin checked DNS result so a second DNS lookup cannot redirect into local services.
    const req=request(url,{lookup:(_host,opts,cb)=>opts.all ? cb(null,[addresses[0]]) : cb(null,addresses[0].address,4),headers:{Accept:'application/pdf','User-Agent':'SideFlip-local-document-retrieval/1.0'}},res=>{
      if(res.statusCode!==200){res.resume();reject(Error(`HTTP ${res.statusCode}; no redirect, retry or access-wall bypass`));return}
      if(Number(res.headers['content-length']||0)>25*1024*1024){res.destroy();reject(Error('PDF exceeds limit'));return}
      let size=0;const chunks=[]
      res.on('data',chunk=>{size+=chunk.length;if(size>25*1024*1024){res.destroy(Error('PDF exceeds limit'));return}chunks.push(chunk)})
      res.on('error',reject);res.on('end',()=>resolve(Buffer.concat(chunks)))
    })
    const timer=setTimeout(()=>req.destroy(Error('Retrieval deadline exceeded')),30000)
    req.on('close',()=>clearTimeout(timer));req.on('error',reject);req.end()
  })
  if(bytes.subarray(0,5).toString()!=='%PDF-') throw Error('Response is not a PDF')
  await writeFile(destination,bytes,{flag:'wx'})
  return {url:url.href,httpStatus:200,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),authenticity:'provider_citation_unconfirmed',publisherAuthenticated:false,retrieval:'ordinary_https_no_bypass'}
}
