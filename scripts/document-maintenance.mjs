#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { retrievePublicPdf } from './public-document-retrieval.mjs'
import { readDocumentBundle, buildDocumentExtractionRequest, extractDocumentRules, prepareDocumentReviewRecord } from '../supabase/functions/_shared/document-maintenance.js'
import {createXaiDocumentAdapter,DOCUMENT_DEFAULT_TIMEOUT_MS} from '../supabase/functions/maintenance-research-worker/xai-document-adapter.js'
import {privateProviderErrorCapture} from './private-provider-error.mjs'
import {localDocumentReservation} from './local-document-budget.mjs'
const rawArgs=process.argv.slice(2)
const live=rawArgs.includes('--live-authorized')
const privateCapture=rawArgs.includes('--private-error-capture')
const privacyReviewed=rawArgs.includes('--document-privacy-reviewed')
const args = rawArgs.filter(x=>!['--live-authorized','--document-privacy-reviewed','--private-error-capture'].includes(x)), opts = {}
for (let i=0;i<args.length;i+=2) {
  if (!['--pdf','--url','--pages','--out','--response'].includes(args[i]) || !args[i+1] || opts[args[i]]) throw Error('Usage: (--pdf PATH | --url HTTPS_URL) --pages 560-573 --out DIRECTORY [--response OFFLINE_JSON]')
  opts[args[i]]=args[i+1]
}
if (Boolean(opts['--pdf']) === Boolean(opts['--url']) || !opts['--pages'] || !opts['--out']) throw Error('Required: exactly one --pdf/--url, --pages RANGE --out DIRECTORY; no model/storage is called')
if(live && (opts['--url'] || opts['--response'] || !privacyReviewed || !process.env.DOCUMENT_TRIAL_LEDGER)) throw Error('Live trial requires local PDF, privacy review, exclusive budget ledger, and no offline response')
if(privateCapture && (!live || !privacyReviewed))throw Error('Private capture requires explicit local live and privacy gates')
const out = resolve(opts['--out']); await mkdir(out, { recursive: true })
const save = (name, value) => writeFile(resolve(out, name), JSON.stringify(value, null, 2)+'\n', { flag: 'wx' })
let pdfPath=opts['--pdf'] && resolve(opts['--pdf'])
if(opts['--url']) { pdfPath=resolve(out,'source.pdf'); await save('retrieval.json',await retrievePublicPdf(opts['--url'],pdfPath)) }
const bundle = await readDocumentBundle(pdfPath, opts['--pages'])
await save('document-bundle.json', bundle)
await save('extraction-request.json', buildDocumentExtractionRequest(bundle))
let summary = { mode:'dry_run', sourceSha256:bundle.sourceSha256, pageCount:bundle.pageCount, selectedPages:bundle.selectedPages, contextSignals:bundle.contextSignals.length, providerCalled:false, stored:false }
if (opts['--response']) {
  const response = await readFile(resolve(opts['--response']), 'utf8')
  const result = await extractDocumentRules(bundle, { mode:'offline', transport: async () => response })
  await save('offline-validation.json', result)
  if (result.validation.valid) await save('review-record.json', prepareDocumentReviewRecord(result.extraction,bundle,{templateKey:bundle.sourceSha256,version:1}))
  summary={...summary,mode:'offline',validation:result.validation}
  if (!result.validation.valid) process.exitCode=2
}
if(live) {
  // Explicit local opt-in only; adapter enforces the hard maximum before reserve.
  const timeoutMs=process.env.DOCUMENT_TIMEOUT_MS===undefined?DOCUMENT_DEFAULT_TIMEOUT_MS:Number(process.env.DOCUMENT_TIMEOUT_MS)
  summary={...summary,timeoutMs}
  if(opts['--url'] || opts['--response'] || !privacyReviewed || !process.env.DOCUMENT_TRIAL_LEDGER) throw Error('Live trial requires local PDF, privacy review, exclusive budget ledger, and no offline response')
  const provider=createXaiDocumentAdapter({apiKey:process.env.XAI_API_KEY,model:process.env.XAI_DOCUMENT_MODEL,authorized:live,documentPrivacyReviewed:privacyReviewed,
    privateErrorCapture:privateCapture?privateProviderErrorCapture({apiKey:process.env.XAI_API_KEY,forbiddenRoots:[out]}):undefined,
    timeoutMs,maxCostTicks:Number(process.env.DOCUMENT_MAX_COST_TICKS),inputTicksPerToken:Number(process.env.DOCUMENT_INPUT_TICKS_PER_TOKEN),outputTicksPerToken:Number(process.env.DOCUMENT_OUTPUT_TICKS_PER_TOKEN),reserve:localDocumentReservation(resolve(process.env.DOCUMENT_TRIAL_LEDGER))})
  try {
    const result=await extractDocumentRules(bundle,{provider,mode:'live_explicitly_authorized'})
    await save('live-validation.json',result)
    summary={...summary,mode:'live_explicitly_authorized',providerCalled:true,usage:result.usage,validation:result.validation}
    if(result.validation.valid)await save('review-record.json',prepareDocumentReviewRecord(result.extraction,bundle,{templateKey:bundle.sourceSha256,version:1}))
    else process.exitCode=2
  } catch(error) {
    const stage=['document_input','document_reservation','document_response','document_settlement'].includes(error?.stage)?error.stage:'document_configuration'
    summary={...summary,mode:'live_failed',providerCalled:['document_response','document_settlement'].includes(stage),stage,costInUsdTicks:Number.isSafeInteger(error?.costInUsdTicks)?error.costInUsdTicks:null}
    if(stage==='document_response' && error?.code==='DOCUMENT_EXTRACTION_FAILED')summary.diagnostics=error.diagnostics
    process.exitCode=2
  }
}
await save('summary.json', summary)
console.log(JSON.stringify(summary,null,2))
