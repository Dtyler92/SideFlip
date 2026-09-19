import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {privateProviderErrorCapture} from '../scripts/private-provider-error.mjs'
import {createHash} from 'node:crypto'
const repo=new URL('../',import.meta.url).pathname
const pdf='/root/sideflip-release-evidence/manufacturer-second-vehicle-test/2020-Ford-F-150-Owners-Manual.pdf'
for(const name of ['json-authorization','diagnostic-after-auth','output-symlink'])test(`private capture regression actual CLI: ${name}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'capture-regression-'))
 try{
  const home=join(dir,'home');await mkdir(home,{mode:0o700})
  const alias=join(dir,'output-alias');await symlink(home,alias)
  const body=name==='json-authorization'?JSON.stringify({headers:{Authorization:'Custom AUTH_VALUE_MUST_NOT_SURVIVE','Proxy-Authorization':'Other PROXY_SECRET'},reason:'REASON_MUST_SURVIVE'}):name==='diagnostic-after-auth'?JSON.stringify({debug:'Authorization: Bearer ***',reason:'REASON_MUST_SURVIVE'}):JSON.stringify({reason:'REASON_MUST_SURVIVE'})
  const preload=join(dir,'stub.mjs');await writeFile(preload,`globalThis.fetch=async()=>new Response(${JSON.stringify(body)},{status:400});`)
  const out=name==='output-symlink'?alias:join(dir,'out')
  const env={PATH:process.env.PATH,HOME:home,XAI_API_KEY:'dummy-independent-key',XAI_DOCUMENT_MODEL:'grok-4.6',DOCUMENT_MAX_COST_TICKS:'10000000000',DOCUMENT_INPUT_TICKS_PER_TOKEN:'1',DOCUMENT_OUTPUT_TICKS_PER_TOKEN:'1',DOCUMENT_TRIAL_LEDGER:join(dir,'ledger')}
  const child=spawnSync(process.execPath,['--experimental-default-type=module','--import',preload,join(repo,'scripts/document-maintenance.mjs'),'--pdf',pdf,'--pages','560','--out',out,'--live-authorized','--document-privacy-reviewed','--private-error-capture'],{cwd:name==='output-symlink'?repo:dir,env,encoding:'utf8',timeout:20000})
  assert.equal(child.status,2,child.stderr)
  const summary=JSON.parse(await readFile(join(out,'summary.json'),'utf8')),meta=summary.diagnostics.privateCapture
  assert.equal(summary.diagnostics.category,'http_rejection')
  for(const marker of ['REASON_MUST_SURVIVE','AUTH_VALUE_MUST_NOT_SURVIVE','PROXY_SECRET'])assert.ok(!(child.stdout+child.stderr+JSON.stringify(summary)).includes(marker))
  if(name==='output-symlink'){
   assert.equal(meta.state,'capture_failed')
   await assert.rejects(access(join(out,'.sideflip-private-provider-errors')))
  }else{
   assert.equal(meta.state,'saved')
   const artifact=JSON.parse(await readFile(meta.path,'utf8'))
   assert.ok(artifact.bodyText.includes('REASON_MUST_SURVIVE'))
   assert.ok(!artifact.bodyText.includes('AUTH_VALUE_MUST_NOT_SURVIVE'))
   assert.ok(!artifact.bodyText.includes('PROXY_SECRET'))
   assert.equal(JSON.parse(artifact.bodyText).reason,'REASON_MUST_SURVIVE')
  }
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('private sink preserves JSON spans, escaped credentials, binary bytes and canonical exclusions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'capture-sink-')),oldHome=process.env.HOME
 try{
  process.env.HOME=dir
  const secret='dummy-"雪\\credential',reason='REASON_KEEP'
  const invoke=async(bytes,roots=[],extra={})=>privateProviderErrorCapture({apiKey:secret,forbiddenRoots:roots})({bytes:Buffer.from(bytes),status:400,headers:new Headers(),request:{model:'dummy',body:JSON.stringify({nested:{echo:secret,Authorization:'Custom REQUEST_SECRET'},reason})},truncated:false,readComplete:true,readFailed:false,...extra})
  const original='{ "headers": {"Authorization": "Custom AUTH_SECRET", "proxy-authorization": {"nested": "PROXY_SECRET"}}, "echo": '+JSON.stringify(secret)+', "escaped": "dummy-\\\"\\u96ea\\\\credential", "reason": "REASON_KEEP", "n": 1e+02 }'
  const meta=await invoke(original);assert.equal(meta.state,'saved')
  const artifact=JSON.parse(await readFile(meta.path,'utf8'))
  assert.equal(artifact.bodyText,'{ "headers": {"Authorization": "[REDACTED]", "proxy-authorization": "[REDACTED]"}, "echo": "[REDACTED]", "escaped": "[REDACTED]", "reason": "REASON_KEEP", "n": 1e+02 }')
  const request=JSON.parse(artifact.request.sanitizedBody)
  assert.equal(request.nested.echo,'[REDACTED]');assert.equal(request.nested.Authorization,'[REDACTED]');assert.equal(request.reason,reason)
  const binary=Buffer.concat([Buffer.from([255,0]),Buffer.from(secret),Buffer.from([254,65])])
  const binaryMeta=await invoke(binary,[],{truncated:true,readComplete:false})
  const retained=JSON.parse(await readFile(binaryMeta.path,'utf8'))
  const expected=Buffer.concat([Buffer.from([255,0]),Buffer.from('[REDACTED]'),Buffer.from([254,65])])
  assert.deepEqual(Buffer.from(retained.bodyBase64,'base64'),expected)
  assert.equal(retained.retainedSha256,createHash('sha256').update(expected).digest('hex'))
  assert.equal(retained.originalAvailableSha256,createHash('sha256').update(binary).digest('hex'))
  assert.equal(retained.truncated,true);assert.equal(retained.readComplete,false)
  const malformed='{"debug":"Authorization: Custom OTHER_SECRET","reason":"REASON_KEEP",'
  const malformedMeta=await invoke(malformed,[],{truncated:true,readComplete:false})
  const malformedArtifact=JSON.parse(await readFile(malformedMeta.path,'utf8'))
  assert.ok(malformedArtifact.bodyText.includes('"reason":"REASON_KEEP"'))
  assert.ok(!malformedArtifact.bodyText.includes('OTHER_SECRET'))
  const lineMeta=await invoke('Authorization: Custom LINE_SECRET\nREASON_KEEP\nCookie: COOKIE_SECRET')
  const lineArtifact=JSON.parse(await readFile(lineMeta.path,'utf8'))
  assert.equal(lineArtifact.bodyText,'Authorization: [REDACTED]\nREASON_KEEP\nCookie: [REDACTED]')
  const alias=join(dir,'alias');await symlink(dir,alias)
  assert.equal((await invoke('private',[alias])).state,'capture_failed')
  assert.equal((await invoke('private',[join(alias,'.sideflip-private-provider-errors')])).state,'capture_failed')
  // Existing alias ancestor + absent private leaf is also resolved safely.
  await rm(join(dir,'.sideflip-private-provider-errors'),{recursive:true})
  assert.equal((await invoke('private',[join(alias,'.sideflip-private-provider-errors')])).state,'capture_failed')
  await assert.rejects(access(join(dir,'.sideflip-private-provider-errors')))
  process.env.HOME=repo
  assert.equal((await invoke('private')).state,'capture_failed')
 }finally{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;await rm(dir,{recursive:true,force:true})}
})
