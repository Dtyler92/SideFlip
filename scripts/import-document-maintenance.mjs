// Local only; default dry-run. No provider call, production configuration or credentials.
import {readFile} from 'node:fs/promises'
import {readDocumentBundle} from '../supabase/functions/_shared/document-maintenance.js'
import {ingestDocumentMaintenance} from '../supabase/functions/_shared/document-maintenance-ingestion.js'
import {localTemplateStorage} from './local-template-storage.mjs'
try {
 const args=process.argv.slice(2), options={}
 for(let i=0;i<args.length;i++){const k=args[i];if(k==='--write')options.write=true;else if(['--pdf','--pages','--response','--template-key','--version','--owner','--local-db'].includes(k)&&args[i+1]&&!args[i+1].startsWith('--'))options[k.slice(2)]=args[++i];else throw Error('Invalid CLI argument '+k)}
 if(!options.pdf||!options.pages||!options.response||!options['template-key'])throw Error('Required: --pdf PATH --pages RANGE --response OFFLINE_JSON --template-key KEY [--version N] [--write --local-db DISPOSABLE_DB --owner UUID]')
 const storage=options.write?localTemplateStorage(options['local-db']):undefined
 let bundle
 try { bundle=await readDocumentBundle(options.pdf,options.pages) } catch { throw Error('DOCUMENT_UNAVAILABLE: original PDF could not be read; no source identity invented and no failure record stored') }
 const result=await ingestDocumentMaintenance({bundle,transport:async()=>readFile(options.response,'utf8'),mode:'offline',templateKey:options['template-key'],version:Number(options.version||1),ownerId:options.owner,storage,dryRun:!options.write})
 console.log(JSON.stringify({...result,mode:'offline',providerCalled:false}))
}catch(error){
 const safe=['DOCUMENT_UNAVAILABLE: original PDF could not be read; no source identity invented and no failure record stored','Trusted owner UUID required','Invalid template key/version','Source provenance mismatch','Unbound source quote: source provenance rejected','Refusing non-disposable local database']
 console.error(safe.includes(error.message)?error.message:'DOCUMENT_IMPORT_FAILED: invalid input or storage operation; persistence not confirmed')
 process.exitCode=1
}
