// Private metadata: never classify arbitrary exception text or serialize payloads.
const diagnostics = new WeakMap()
const checks = new Map([
  ['xAI response did not complete', ['response', 'response_incomplete']],
  ['xAI returned an unsupported model', ['response', 'model_mismatch']],
  ['xAI cost_in_usd_ticks is invalid', ['response', 'usage_invalid']],
  ['xAI output text is missing or too large', ['schema', 'output_text_invalid']],
  ['xAI output JSON is invalid', ['schema', 'output_json_invalid']],
  ['xAI web tool usage does not match response actions', ['proof', 'action_usage_mismatch']],
  ['xAI web action is invalid', ['proof', 'action_invalid']],
  ['xAI web action type is invalid', ['proof', 'action_type_invalid']],
  ['xAI web action cap exceeded', ['limits', 'action_cap_invalid']],
  ['xAI citation URL is invalid', ['proof', 'citation_url_invalid']],
  ['xAI response body is unavailable', ['response', 'response_body_missing']],
  ['xAI response is too large', ['response', 'response_size_exceeded']],
  ['xAI response JSON is invalid', ['response', 'response_json_invalid']],
  ['xAI evidence is invalid', ['schema', 'evidence_shape_invalid']],
  ['xAI web action used an unapproved source', ['proof', 'source_unapproved']],
  ['xAI evidence URL is not present in both action sources and citations', ['proof', 'evidence_uncited']],
])
const codes = new Set(['BUDGET_EXCEEDED', 'INVALID_CANDIDATE', 'INVALID_CITATION', 'INVALID_EVIDENCE', 'INVALID_PROVIDER_RESPONSE', 'PROVIDER_REJECTED', 'PROVIDER_TRANSIENT', 'POLICY_SUPERSEDED', 'RESEARCH_DISABLED', 'UNAPPROVED_SOURCE', 'UNCITED_EVIDENCE'])
const stages = new Set(['worker_setup', 'discovery_response', 'discovery_schema', 'discovery_proof', 'discovery_limits', 'normalization_response', 'normalization_schema', 'normalization_support', 'settlement', 'failure_settlement'])
const objectLike = value => value !== null && (typeof value === 'object' || typeof value === 'function')

// Called only by the adapter's local error constructor, never with provider text.
export function tagProviderFailure(error, localMessage) {
  const check = checks.get(localMessage)
  if (check) diagnostics.set(error, { phase: check[0], reason: check[1] })
  return error
}

export function tagWorkerFailure(error, stage) {
  if (!objectLike(error)) return error
  const prior = diagnostics.get(error)
  let safeStage = stages.has(stage) ? stage : 'worker_setup'
  if (prior?.phase && (safeStage === 'discovery_response' || safeStage === 'normalization_response')) {
    const candidate = safeStage.replace('response', prior.phase)
    if (stages.has(candidate)) safeStage = candidate
  }
  diagnostics.set(error, { stage: safeStage, reason: prior?.reason || 'boundary_failed' })
  return error
}

export function failureDiagnostic(error) {
  const known = objectLike(error) ? diagnostics.get(error) : null
  return Object.freeze({ event: 'maintenance_research_worker_failed', code: codes.has(error?.code) ? error.code : 'WORKER_ERROR', stage: known?.stage || 'worker_setup', reason: known?.reason || 'unclassified' })
}

export function emitFailureDiagnostic(error, emit = record => console.error(JSON.stringify(record))) {
  // Logging cannot replace the underlying exception or alter retries.
  try { emit(failureDiagnostic(error)) } catch {}
}
