// OFFLINE ONLY: terminal evidence comes from the real adapter, never a fake flag.
import {createXaiDocumentAdapter} from '../../supabase/functions/maintenance-research-worker/xai-document-adapter.js'
import {retainedExtraction} from './document-job-harness.js'
export function terminalFixture(bundle,signal,costInUsdTicks=150000001,extraction=retainedExtraction()) {
 const provider=createXaiDocumentAdapter({apiKey:'offline-dummy',model:'grok-4.6',authorized:true,documentPrivacyReviewed:true,maxCostTicks:1000000000,inputTicksPerToken:1,outputTicksPerToken:1,
 reserve:async()=>({settle:async()=>{}}),fetchImpl:async()=>new Response(JSON.stringify({id:'offline-response',object:'response',status:'completed',model:'grok-4.6',usage:{cost_in_usd_ticks:costInUsdTicks},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(extraction)}]}]}))})
 return provider.extract(bundle,{signal})
}
