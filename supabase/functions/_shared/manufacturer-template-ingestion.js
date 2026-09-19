import { validateMaintenanceTemplate } from './maintenance-templates.js'
const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v)
export const sameTemplateValue = (a, b) => canonical(a) === canonical(b)

// Trusted orchestration boundary, NOT a public endpoint or provider-output adapter.
// Identity review is supplied separately by the operator, never read from extraction.
export function prepareTemplateIngestion(input) {
  const {extraction: t, provenance: p, templateKey, version, identityReview} = structuredClone(input)
  if (!p || !t || p.documentId !== t.source?.id || p.sha256 !== t.source?.sha256 || p.sourceVersion !== t.source?.version) throw Error('Source identity/version mismatch')
  if (!['user_uploaded_unverified', 'provider_citation_unconfirmed'].includes(p.authenticity)) throw Error('Independent publisher authentication is not supported by this importer')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(templateKey || '') || !Number.isSafeInteger(version) || version < 1 || version > 999999999) throw Error('Invalid template key/version')
  for (const key of ['owner_id','user_id','item_id','current_mileage','service_history','last_service','overdue']) if (Object.hasOwn(t, key)) throw Error('Owner personalization is not template data')
  const validation = validateMaintenanceTemplate(t)
  if (!validation.valid) throw Error('Template validation failed: ' + validation.errors.join('; '))
  if (identityReview && (!identityReview.reviewedBy?.trim() || !identityReview.evidence?.trim() || !sameTemplateValue(identityReview.applicability, t.applicability))) throw Error('Explicit identity review mismatch or missing attestation')
  // Deliberately no path to reviewed here: catalog equality is not fresh source review.
  return {
    template_key: templateKey, version, source_sha256: p.sha256,
    source_document_id: p.documentId, source_version: p.sourceVersion,
    source_url: null, source_authenticity: p.authenticity, source_authenticity_evidence: null,
    schema_version: 'manufacturer-template-v1', validator_version: 'maintenance-templates-v1',
    applicability: t.applicability, applicability_reviewed: Boolean(identityReview),
    status: 'needs_review', validation_report: {passed: true, source_support_checked: false,
      identity_review: identityReview || null, reason: 'Validated retained extraction; fresh source support and publisher authentication not asserted'},
    payload: t,
  }
}

export async function ingestTemplate(input, {ownerId, storage}) {
  const record = prepareTemplateIngestion(input)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId || '')) throw Error('Explicit trusted owner UUID required')
  const id = await storage.append(ownerId, record)
  const row = await storage.read(ownerId, id)
  if (!row || row.id !== id || row.owner_id !== ownerId || !sameTemplateValue(row.record, record)) throw Error('Template readback mismatch')
  return row // Native contract: row.record.payload, never row.payload.
}
