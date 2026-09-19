import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {Readable} from 'node:stream'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {acquireApprovedDocument} from '../scripts/approved-document-source.mjs'
import {dispatchBoundDocumentJob} from '../scripts/document-job-provider-binding.mjs'
const pdf=await readFile('/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf')
const sha=createHash('sha256').update(pdf).digest('hex')
export function responseTransport({bytes=pdf,status=200,mime='application/pdf',onRequest=()=>{}}={}) {
 return (url,options,callback)=>{const req=new EventEmitter();req.end=()=>{onRequest(url,options);queueMicrotask(()=>{const res=Readable.from([bytes]);res.statusCode=status;res.headers={'content-type':mime,'content-length':String(bytes.length)};callback(res)})};req.destroy=e=>{if(e)req.emit('error',e);req.emit('close')};return req}
}
const source={url:'https://www.fordservicecontent.com/Ford_Content/Catalog/owner_information/2020-Ford-F-150-Owners-Manual-version-1_om-EN-US_08_2019.pdf?div=f',expectedSha256:sha,pages:'561'}
const binding={jobId:'job',confirmedFingerprint:'a'.repeat(64),policyVersion:1,requestSnapshot:{make:'Ford'}}
const policy={url:source.url,manufacturer:'Ford',policyVersion:1,expiresAt:'2099-01-01T00:00:00Z',termsAllowed:true,robotsAllowed:true,officialSourceApproved:true,documentPrivacyReviewed:true}
const options={source,binding,approvedSources:[policy],lookupImpl:async()=>[{address:'93.184.216.34',family:4}],requestImpl:responseTransport()}
test('binding default off and missing capabilities cannot lease or invoke',async()=>{
 let calls=0;const client={rpc:()=>{calls++;throw Error('unexpected')}}
 await assert.rejects(dispatchBoundDocumentJob({client}),/DOCUMENT_BINDING_DISABLED/)
 await assert.rejects(dispatchBoundDocumentJob({enabled:true,client}),/DOCUMENT_BINDING_DISABLED/)
 assert.equal(calls,0)
})
test('original HTTPS PDF is pinned, hashed, parsed and never promoted',async()=>{
 const bundle=await acquireApprovedDocument({...options,requestImpl:responseTransport({onRequest:(url,init)=>{assert.equal(url.href,source.url);assert.equal(init.headers.Authorization,undefined);init.lookup(url.hostname,{},(e,ip)=>{assert.equal(e,null);assert.equal(ip,'93.184.216.34')})}})})
 assert.equal(bundle.sourceSha256,sha);assert.deepEqual(bundle.selectedPages,[561]);assert.ok(bundle.pages[0].blocks.length>0)
 assert.equal(bundle.sourceAuthenticated,undefined)
})
test('policy, unknown source and identity cannot authorize discovery',async()=>{
 for(const change of [{robotsAllowed:false},{termsAllowed:false},{officialSourceApproved:false},{documentPrivacyReviewed:false},{expiresAt:'2000-01-01'},{policyVersion:2},{manufacturer:'Honda'}]){
  await assert.rejects(acquireApprovedDocument({...options,approvedSources:[{...policy,...change}]}),/DOCUMENT_SOURCE_POLICY/)
 }
 await assert.rejects(acquireApprovedDocument({...options,source:null}),/DOCUMENT_SOURCE_POLICY/)
})
test('SSRF redirects 403 MIME hash and byte limits stop without retry',async()=>{
 for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','::1','192.168.0.1'])await assert.rejects(acquireApprovedDocument({...options,lookupImpl:async()=>[{address,family:4}]}),/DOCUMENT_SOURCE_ADDRESS/)
 for(const status of [301,302,307,403]){let calls=0;await assert.rejects(acquireApprovedDocument({...options,requestImpl:responseTransport({status,onRequest:()=>calls++})}),/DOCUMENT_SOURCE_HTTP/);assert.equal(calls,1)}
 await assert.rejects(acquireApprovedDocument({...options,requestImpl:responseTransport({mime:'text/html'})}),/DOCUMENT_SOURCE_MIME/)
 await assert.rejects(acquireApprovedDocument({...options,source:{...source,expectedSha256:'0'.repeat(64)}}),/DOCUMENT_SOURCE_HASH/)
 await assert.rejects(acquireApprovedDocument({...options,maxBytes:100}),/DOCUMENT_SOURCE_LIMIT/)
 await assert.rejects(acquireApprovedDocument({...options,requestImpl:responseTransport({bytes:Buffer.from('not a PDF')})}),/DOCUMENT_SOURCE_PDF/)
})
for(const kind of ['text','link','unknown','widget','attachment'])test(`private PDF ${kind} annotations are excluded before provider by rejecting the source`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sideflip-annotation-test-'))
 try{
  const path=join(dir,'annotated.pdf')
  execFileSync('python3',['-c',`import fitz,sys
d=fitz.open();p=d.new_page();p.insert_text((72,72),'Public manual');p=d.new_page()
kind=sys.argv[2]
if kind=='text':p.add_text_annot((100,100),'PRIVATE_OWNER_NOTE')
if kind=='link':
 x=d.get_new_xref();d.update_object(x,'<< /Subtype /Link /Rect [10 10 100 30] /A << /S /URI /URI (javascript:PRIVATE_OWNER_NOTE) >> >>');d.xref_set_key(p.xref,'Annots',f'[{x} 0 R]')
if kind=='unknown':
 x=d.get_new_xref();d.update_object(x,'<< /Type /Annot /Subtype /FutureAnnotation /Rect [10 10 100 30] /Contents (PRIVATE_OWNER_NOTE) >>');d.xref_set_key(p.xref,'Annots',f'[{x} 0 R]')
if kind=='widget':
 w=fitz.Widget();w.field_name='PRIVATE_OWNER_NOTE';w.field_type=fitz.PDF_WIDGET_TYPE_TEXT;w.rect=fitz.Rect(10,10,100,30);p.add_widget(w)
if kind=='attachment':d.embfile_add('private.txt',b'PRIVATE_OWNER_NOTE')
d.save(sys.argv[1])`,path,kind])
  const bytes=await readFile(path),expectedSha256=createHash('sha256').update(bytes).digest('hex')
  await assert.rejects(acquireApprovedDocument({...options,source:{...source,expectedSha256,pages:'1'},requestImpl:responseTransport({bytes})}),/Private annotations/)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('page selection, mixed DNS answers and response-body deadlines stay bounded',async()=>{
 await assert.rejects(acquireApprovedDocument({...options,source:{...source,pages:'1-81'}}),/Invalid page range/)
 await assert.rejects(acquireApprovedDocument({...options,lookupImpl:async()=>[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}]}),/DOCUMENT_SOURCE_ADDRESS/)
 await assert.rejects(acquireApprovedDocument({...options,timeoutMs:20,requestImpl:(_url,_init,cb)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{const res=new Readable({read(){}});res.statusCode=200;res.headers={'content-type':'application/pdf'};cb(res)};return req}}),/DOCUMENT_SOURCE_TIMEOUT/)
})
test('DNS deadline cannot launch HTTP after foreground timeout',async()=>{
 let release,calls=0;const lookupImpl=()=>new Promise(r=>release=r)
 await assert.rejects(acquireApprovedDocument({...options,timeoutMs:20,lookupImpl,requestImpl:()=>{calls++;throw Error()}}),/DOCUMENT_SOURCE_TIMEOUT/)
 release([{address:'93.184.216.34',family:4}]);await new Promise(r=>setTimeout(r,5));assert.equal(calls,0)
})
