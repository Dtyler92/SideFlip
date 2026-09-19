import {prepareDocumentReviewRecord, validateDocumentExtraction, buildDocumentExtractionRequest, extractDocumentRules} from './document-maintenance.js'

const canonical = v => v && typeof v === 'object' ? Array.isArray(v) ? v.map(canonical) : Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])) : v
// Trusted local orchestration, not an HTTP authentication boundary. Never copy
// provider errors, IDs, text, or arbitrary state into the failure envelope.
export async function ingestDocumentMaintenance({extraction, bundle, templateKey, version, ownerId, storage, dryRun = true, transport, mode}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(templateKey || '') || !Number.isSafeInteger(version) || version < 1) throw Error('Invalid template key/version')
  if ((!dryRun || ownerId !== undefined) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId || '')) throw Error('Trusted owner UUID required')
  if (!dryRun && (!storage?.append || !storage?.read)) throw Error('Explicit storage adapter required')
  // Existing private WeakSet gate; no serialized bundle or guessed hash is accepted.
  try { buildDocumentExtractionRequest(bundle) } catch { throw Error('Untrusted source bundle: original document unavailable or not independently read') }
  if (transport !== undefined) {
    if (typeof transport !== 'function' || !['offline','live_explicitly_authorized'].includes(mode)) throw Error('Explicit injected transport and mode required')
    try { extraction = (await extractDocumentRules(bundle, {transport, mode})).extraction }
    catch { extraction = null } // Transport/JSON errors can contain owner text or secrets.
  }
  if (extraction && typeof extraction === 'object' && Object.hasOwn(extraction,'sourceSha256') && extraction.sourceSha256 !== bundle.sourceSha256) throw Error('Source provenance mismatch')
  const validation = validateDocumentExtraction(extraction, bundle)
  if (validation.errors.some(e => e.startsWith('Unbound source quote'))) throw Error('Unbound source quote: source provenance rejected')
  let record
  if (validation.valid) record = prepareDocumentReviewRecord(extraction, bundle, {templateKey, version})
  else {
    const hash = bundle.sourceSha256
    record = {
      template_key:templateKey, version, source_sha256:hash, source_document_id:hash, source_version:hash,
      source_url:null, source_authenticity:'user_uploaded_unverified', source_authenticity_evidence:null,
      schema_version:'manufacturer-template-v2', validator_version:'document-maintenance-v2',
      applicability_reviewed:false, status:'extraction_failed',
      validation_report:{passed:false, errors:['DOCUMENT_EXTRACTION_FAILED'], status:'extraction_failed', structuralVerified:false, document_structural_verified:false, semanticVerified:false, sourceAuthenticated:false, applicable:false, semantic_review:null, identity_review:null},
      payload:{schemaVersion:2, sourceSha256:hash, rules:[], evidence:[], ownerQuestions:[], unresolved:[{reason:'Extraction failed validation or could not be completed. Retry extraction from the original document; no schedule was applied.',evidenceIds:[]}], coverage:[]},
      document_bundle:{sourceSha256:hash, pages:bundle.pages.map(p=>({pdfPage:p.pdfPage}))},
    }
  }
  const documentBundle = record.document_bundle
  delete record.document_bundle
  record.applicability = {year:null,make:null,model:null,engine:null,transmission:null,market:null}
  record.payload = {...record.payload, source:{id:record.source_document_id,sha256:record.source_sha256,version:record.source_version}, applicability:record.applicability, documentBundle}
  if (record.schema_version !== 'manufacturer-template-v2' || !['needs_review','extraction_failed'].includes(record.status) || record.applicability_reviewed !== false) throw Error('Unsafe document proposal preparation')
  record.validation_report = {...record.validation_report, source_support_checked:false, auto_apply_allowed:false}
  if (dryRun) return {persisted:false, record}
  // Never transform an uncertain append/read failure into a second write or retry.
  let id, row
  try { id = await storage.append(ownerId, record); row = await storage.read(ownerId, id) }
  catch { throw Error('Document storage operation failed; persistence unconfirmed. Do not retry with a new version automatically') }
  if (!row || row.id !== id || row.owner_id !== ownerId || JSON.stringify(canonical(row.record)) !== JSON.stringify(canonical(record))) throw Error('Document append owner readback mismatch; do not claim success')
  return {persisted:true, row}
}
