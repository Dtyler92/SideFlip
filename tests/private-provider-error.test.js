import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm,stat,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
const pdf='/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf'
import {createHash} from 'node:crypto'
const secret='dummy-SECRET-credential-918273'
const reason='NOVEL_PROVIDER_REASON_KEEP_PRIVATE'
for(const [name,body] of [['nested',JSON.stringify({unexpected:[{deep:{why:reason}}]})],['known',JSON.stringify({usage:{cost_in_usd_ticks:17},unexpected:reason})],['failed',reason],['disabled',reason],['binary','\ufffd\u0000A'],['streamed',reason],['read-failed',reason],['declared-limit',reason],['plain',reason],['html',`<html>${reason}</html>`],['empty',''],['limit','x'.repeat(1000001)],['secret',`${reason} ${secret} Authorization: Bearer OTHER_SECRET\napi_key=ANOTHER_SECRET`]])test(`private capture actual CLI: ${name}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'private-error-test-'))
 try {
  const root=join(dir,'private'),preload=join(dir,'stub.mjs'),ledger=join(dir,'ledger'),calls=join(dir,'calls')
  await mkdir(root,{mode:0o700})
  await writeFile(preload,`import {appendFileSync} from 'node:fs';globalThis.fetch=async()=>{appendFileSync(${JSON.stringify(calls)},'1');return new Response(${JSON.stringify(body)},{status:400,headers:{'content-type':'text/plain','set-cookie':'DO_NOT_KEEP','x-request-id':'DO_NOT_KEEP'}})}`)
  if(['binary','streamed','read-failed','declared-limit'].includes(name)){
   const bytes=name==='binary'?[255,0,65]:Array.from(Buffer.from(body))
   await writeFile(preload,`import {appendFileSync} from 'node:fs';globalThis.fetch=async()=>{appendFileSync(${JSON.stringify(calls)},'1');let i=0;const bytes=new Uint8Array(${JSON.stringify(bytes)});return new Response(new ReadableStream({pull(c){if(i<bytes.length)c.enqueue(bytes.slice(i,i+=3));else ${name==='read-failed'?"c.error(new Error('PRIVATE_STREAM_FAILURE'))":"c.close()"}}}),{status:400,headers:${JSON.stringify(name==='declared-limit'?{'content-length':'9000000'}:{})}})}`)
  }
  const env={PATH:process.env.PATH,HOME:root,XAI_API_KEY:secret,XAI_DOCUMENT_MODEL:'grok-4.6',DOCUMENT_MAX_COST_TICKS:'10000000000',DOCUMENT_INPUT_TICKS_PER_TOKEN:'1',DOCUMENT_OUTPUT_TICKS_PER_TOKEN:'1',DOCUMENT_TRIAL_LEDGER:ledger}
  const run=(out,flags=[])=>spawnSync(process.execPath,['--experimental-default-type=module','--import',preload,'scripts/document-maintenance.mjs','--pdf',pdf,'--pages','560','--out',join(dir,out),'--live-authorized','--document-privacy-reviewed',...flags],{env,encoding:'utf8',timeout:20000})
  if(name==='failed')await writeFile(join(root,'.sideflip-private-provider-errors'),'blocked')
  const result=run('out',name==='disabled'?[]:['--private-error-capture']);assert.equal(result.status,2,result.stderr)
  const summary=JSON.parse(await readFile(join(dir,'out/summary.json')))
  assert.equal(summary.diagnostics.httpStatus,400)
  const meta=summary.diagnostics.privateCapture
  const publicOutput=result.stdout+result.stderr+JSON.stringify(summary)
  for(const marker of [secret,'OTHER_SECRET','ANOTHER_SECRET','DO_NOT_KEEP',reason])assert.ok(!publicOutput.includes(marker))
  assert.equal(summary.costInUsdTicks,name==='known'?17:null)
  if(name==='disabled')await assert.rejects(stat(join(root,'.sideflip-private-provider-errors')),{code:'ENOENT'})
  if(name==='failed'||name==='disabled'){
   assert.deepEqual(meta,name==='failed'?{state:'capture_failed'}:undefined)
   assert.equal(summary.diagnostics.category,'http_rejection')
   assert.equal(JSON.parse(await readFile(ledger+'.settled')).chargedTicks,10000000000)
   assert.ok(!(result.stdout+result.stderr).includes(reason))
   assert.equal(run('again',['--private-error-capture']).status,2)
   assert.equal(await readFile(calls,'utf8'),'1');return
  }
  assert.equal(meta.state,'saved')
  const artifact=JSON.parse(await readFile(meta.path,'utf8'))
  assert.equal((await stat(meta.path)).mode&0o777,0o600)
  assert.equal((await stat(join(meta.path,'..'))).mode&0o777,0o700)
  assert.equal(artifact.status,400);assert.equal(artifact.truncated,name==='limit')
  assert.equal(artifact.bodyText,name==='secret'?`${reason} [REDACTED] Authorization: [REDACTED]\napi_key=[REDACTED]`:body.slice(0,1000000))
  assert.equal(Buffer.from(artifact.bodyBase64,'base64').toString(),artifact.bodyText)
  const original=name==='binary'?Buffer.from([255,0,65]):Buffer.from(body).subarray(0,1000000)
  if(name==='binary')assert.deepEqual(Buffer.from(artifact.bodyBase64,'base64'),original)
  assert.equal(artifact.readFailed,name==='read-failed')
  assert.equal(artifact.originalAvailableBytes,original.length)
  assert.equal(artifact.originalAvailableSha256,createHash('sha256').update(original).digest('hex'))
  const retained=Buffer.from(artifact.bodyBase64,'base64')
  assert.equal(artifact.retainedBytes,retained.length)
  assert.equal(artifact.retainedSha256,createHash('sha256').update(retained).digest('hex'))
  assert.equal(meta.sha256,artifact.retainedSha256);assert.equal(meta.size,artifact.retainedBytes)
  assert.equal(artifact.readComplete,!['limit','read-failed'].includes(name))
  const saved=await readFile(meta.path,'utf8')
  for(const marker of [secret,'OTHER_SECRET','ANOTHER_SECRET','DO_NOT_KEEP'])assert.ok(!saved.includes(marker))
  assert.ok(!(result.stdout+result.stderr+JSON.stringify(summary)).includes(reason))
  assert.equal(JSON.parse(await readFile(ledger+'.settled')).chargedTicks,name==='known'?17:10000000000)
  const again=run('again',['--private-error-capture']);assert.equal(again.status,2);assert.equal(await readFile(calls,'utf8'),'1')
 }finally{await rm(dir,{recursive:true,force:true})}
})
