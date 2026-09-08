import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applyMyStuffResearch,
  approveMyStuffResearch,
  cancelMyStuffResearch,
  enqueueMyStuffResearch,
  getMyStuffResearchReview,
  getMyStuffResearchStatus,
} from '../myStuff/api.js'
import { createMutationAttemptState, mutationIdForPayload, resetMutationAttemptState } from '../myStuff/mutation.js'
import {
  createResearchRequestGate,
  evidenceForCandidate,
  formatResearchInterval,
  normalizeResearchReview,
  normalizeResearchStatus,
  researchCanPoll,
  researchEvidenceVerificationLabel,
  researchSourceAccessibilityLabel,
  researchSourceClassLabel,
} from '../myStuff/maintenanceResearchModel.js'
import './myStuffResearch.css'

const POLL_MS = 5000

function messageForError(error) {
  const code = String(error?.code || error?.message || '').toUpperCase()
  if (code.includes('PRO_REQUIRED')) return 'SideFlip Pro is required at every research, approval, and apply step.'
  if (code.includes('IDENTITY_UNCONFIRMED')) return 'Confirm the vehicle identity again before researching its schedule.'
  if (code.includes('RESEARCH_DISABLED') || code.includes('PROVIDER_DISABLED')) return 'Manufacturer research is not available right now. Manual schedule entry still works.'
  if (code.includes('BUDGET') || code.includes('RATE')) return 'The research limit has been reached. Try again later or add schedules manually.'
  return error?.message || 'Manufacturer research could not be loaded. Manual schedule entry still works.'
}

export default function ManufacturerMaintenanceResearch({ item, isPro, onUpgrade, onApplied, operationLock, parentBusy = false }) {
  const [status, setStatus] = useState(null)
  const [review, setReview] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [sourcesVerified, setSourcesVerified] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const gate = useRef(createResearchRequestGate())
  const selectionJob = useRef(null)
  const attempts = useRef({ enqueue: createMutationAttemptState(), approve: createMutationAttemptState(), apply: createMutationAttemptState(), cancel: createMutationAttemptState() })

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!isPro || !item?.id) return null
    const snapshot = gate.current.snapshot(item.id)
    if (!gate.current.isCurrent(snapshot, item.id, true)) return null
    if (!quiet) setLoading(true)
    try {
      const next = normalizeResearchStatus(await getMyStuffResearchStatus(item.id))
      if (!gate.current.isCurrent(snapshot, item.id, true)) return null
      setStatus(next)
      setError('')
      if (next?.jobId && ['awaiting_review', 'approved', 'applied'].includes(next.status)) {
        const nextReview = normalizeResearchReview(await getMyStuffResearchReview(next.jobId))
        if (!gate.current.isCurrent(snapshot, item.id, true)) return null
        setReview(nextReview)
        if (next.status === 'awaiting_review' && selectionJob.current !== next.jobId) {
          selectionJob.current = next.jobId
          setSelected(new Set(nextReview.candidates.map(candidate => candidate.id)))
          setSourcesVerified(false)
        }
      } else if (!researchCanPoll(next?.status)) setReview(null)
      return next
    } catch (nextError) {
      if (gate.current.isCurrent(snapshot, item.id, true)) setError(messageForError(nextError))
      return null
    } finally {
      if (gate.current.isCurrent(snapshot, item.id, true)) setLoading(false)
    }
  }, [isPro, item?.id])

  useEffect(() => {
    gate.current.invalidate()
    setStatus(null); setReview(null); setSelected(new Set()); setSourcesVerified(false); setError('')
    selectionJob.current = null
    for (const attempt of Object.values(attempts.current)) resetMutationAttemptState(attempt)
    if (!isPro || !item?.id) return undefined
    gate.current.activate(item.id)
    void load()
    return () => gate.current.invalidate()
  }, [isPro, item?.id, load])

  useEffect(() => {
    if (!researchCanPoll(status?.status)) return undefined
    const timer = setInterval(() => { void load({ quiet: true }) }, POLL_MS)
    return () => clearInterval(timer)
  }, [status?.status, load])

  async function run(kind, descriptor, action, after) {
    if (busy || parentBusy || operationLock?.current) return
    if (!isPro) return onUpgrade?.()
    const mutationId = mutationIdForPayload(attempts.current[kind], descriptor)
    if (operationLock) operationLock.current = true
    setBusy(true); setError('')
    try {
      await action(mutationId)
      resetMutationAttemptState(attempts.current[kind])
      await after?.()
    } catch (nextError) {
      setError(messageForError(nextError))
    } finally {
      if (operationLock) operationLock.current = false
      setBusy(false)
    }
  }

  function startResearch() {
    const fingerprint = item?.vin_confirmation_fingerprint
    if (!fingerprint) return setError('Confirm the decoded vehicle identity before starting manufacturer research.')
    return run('enqueue', { itemId: item.id, fingerprint }, mutationId => enqueueMyStuffResearch(item.id, fingerprint, mutationId), () => load({ quiet: true }))
  }

  function toggleCandidate(id) {
    setSourcesVerified(false)
    setSelected(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next })
  }

  function approveSelected() {
    const candidateIds = [...selected].sort()
    if (!candidateIds.length) return setError('Choose at least one cited maintenance task.')
    if (!sourcesVerified) return setError('Open the official source links and verify each selected interval before approval.')
    if (!window.confirm('Approve the selected cited suggestions? Applying them is a separate step.')) return
    return run('approve', { jobId: status.jobId, candidateIds }, mutationId => approveMyStuffResearch(status.jobId, candidateIds, true, mutationId), () => load({ quiet: true }))
  }

  function applyApproved() {
    const approvalId = status?.approvalId || review?.approvalId
    if (!approvalId || !window.confirm('Apply approved schedules? Existing manual schedules will not be silently overwritten.')) return
    return run('apply', { approvalId }, mutationId => applyMyStuffResearch(approvalId, mutationId), async () => { await load({ quiet: true }); await onApplied?.() })
  }

  function cancelResearch() {
    if (!status?.jobId || !window.confirm('Cancel this research job? No suggestions will be applied.')) return
    return run('cancel', { jobId: status.jobId }, mutationId => cancelMyStuffResearch(status.jobId, mutationId), () => load({ quiet: true }))
  }

  const disabled = busy || loading || parentBusy || Boolean(operationLock?.current)
  if (!isPro) return <section className="mystuff-tool"><h2>Manufacturer maintenance research</h2><p>Pro can research cited manufacturer guidance for a confirmed vehicle. You review every suggestion before anything is applied.</p><p><strong>Manual schedule entry stays available for everyone.</strong></p><button type="button" className="btn btn-secondary" onClick={onUpgrade}>View Pro</button></section>

  return <section className="mystuff-tool" aria-labelledby="maintenance-research-title">
    <h2 id="maintenance-research-title">Manufacturer maintenance research</h2>
    <p>Grok uses real web search for this research. Review suggestions against the official source links before approval because SideFlip has not independently verified them. Results are suggestions, not service or safety advice.</p>
    <p>Starting sends the confirmed vehicle/item type, year, make, model, trim, engine, transmission, drivetrain, fuel, and market details to xAI. VIN, serial number, notes, location, costs, and expenses are never sent.</p>
    <p><strong>Manual schedule entry stays available if research is unavailable or inconclusive.</strong></p>
    {error && <div className="mystuff-error" role="alert">{error} <button type="button" onClick={() => load()}>Retry status</button></div>}
    {!status && <button type="button" className="btn btn-primary" disabled={disabled} onClick={startResearch}>{busy ? 'Starting…' : 'Research manufacturer schedule'}</button>}
    {researchCanPoll(status?.status) && <div role="status" className="mystuff-research-progress"><strong>{status.status === 'queued' ? 'Research queued' : 'Researching manufacturer sources'}</strong><p>You can leave this screen. Results must still be reviewed and applied manually.</p></div>}
    {status?.jobId && ['queued', 'running', 'awaiting_review', 'approved'].includes(status.status) && <button type="button" className="btn btn-secondary" disabled={disabled} onClick={cancelResearch}>Cancel research</button>}
    {['failed', 'cancelled', 'superseded', 'deleted'].includes(status?.status) && <button type="button" className="btn btn-primary" disabled={disabled} onClick={startResearch}>Research again</button>}
    {status?.status === 'awaiting_review' && review && <div><h3>Review suggestions</h3>{review.candidates.map(candidate => <article className="mystuff-research-candidate" key={candidate.id}><label><input type="checkbox" checked={selected.has(candidate.id)} onChange={() => toggleCandidate(candidate.id)}/><span><strong>{candidate.name}</strong><small>{formatResearchInterval(candidate)}</small></span></label>{evidenceForCandidate(candidate, review.evidence).map(source => <div className="mystuff-research-source" key={source.key}><strong>{researchSourceClassLabel(source.sourceClass)}: {source.title}</strong><blockquote>{source.exactExcerpt}</blockquote><small>{researchEvidenceVerificationLabel(source)}</small>{/^https:\/\//i.test(source.canonicalUrl) && <a href={source.canonicalUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open ${researchSourceAccessibilityLabel(source)} for ${candidate.name}`}>Open source</a>}</div>)}</article>)}
      {review.unresolved.map((row, index) => <div className="mystuff-research-unresolved" key={`${row.name || 'unresolved'}-${index}`}><strong>{row.name || 'Unresolved guidance'}</strong><p>{row.reason || row.message || 'The sources did not support one clear interval.'}</p></div>)}
      {review.candidates.length > 0 && <><label className="mystuff-research-ack"><input type="checkbox" checked={sourcesVerified} onChange={event => setSourcesVerified(event.target.checked)}/><span>I checked the official source links and verified the selected maintenance intervals.</span></label><button type="button" className="btn btn-primary" disabled={disabled || !selected.size || !sourcesVerified} onClick={approveSelected}>Approve cited suggestions</button></>}
    </div>}
    {status?.status === 'approved' && <div><h3>Research approved</h3><p>The cited snapshot is sealed. Apply is a separate step and rechecks ownership and Pro access.</p><button type="button" className="btn btn-primary" disabled={disabled} onClick={applyApproved}>Apply approved schedules</button></div>}
    {status?.status === 'applied' && <div className="mystuff-research-success" role="status"><strong>Manufacturer schedules applied</strong><p>The approved citation snapshot is preserved. Manual schedules were not overwritten.</p></div>}
  </section>
}
