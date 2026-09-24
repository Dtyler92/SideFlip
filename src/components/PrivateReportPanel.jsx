import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase.js'
import { createReportDataClient, createReportRequestGate, renderCanonicalReportHtml } from '../myStuff/reports.js'

const PRIVATE_DEFAULTS = Object.freeze({ includeIdentifiers: false, includeDetailedCosts: false })
const OPTION_ROWS = [
  { key: 'includeIdentifiers', label: 'Identifiers (VIN is masked)', detail: 'Includes allowlisted model and serial identifiers. The server returns only the last four VIN characters.' },
  { key: 'includeDetailedCosts', label: 'Detailed costs', detail: 'Includes purchase, sale, service, and expense amounts when available.' },
]

export default function PrivateReportPanel({ subjectType, subjectId, isPro, onUpgrade, client: suppliedClient }) {
  const [expanded, setExpanded] = useState(false)
  const [options, setOptions] = useState(PRIVATE_DEFAULTS)
  const [generating, setGenerating] = useState(false)
  const [message, setMessage] = useState('')
  const [html, setHtml] = useState('')
  const client = useRef(null)
  const gate = useRef(null)
  if (!client.current) client.current = suppliedClient || createReportDataClient({ auth: supabase.auth })
  if (!gate.current) gate.current = createReportRequestGate()

  useEffect(() => {
    gate.current.invalidate()
    setGenerating(false)
    setMessage('')
    setHtml('')
    setOptions(PRIVATE_DEFAULTS)
    setExpanded(false)
    return () => gate.current.invalidate()
  }, [subjectType, subjectId])

  function toggleOption(key) {
    gate.current.invalidate()
    setGenerating(false)
    setOptions(current => ({ ...current, [key]: !current[key] }))
    setHtml('')
    setMessage('')
  }

  async function generate() {
    if (generating) return
    if (!isPro) return onUpgrade?.()
    const selectedOptions = { ...options }
    const requestKey = JSON.stringify({ subjectType, subjectId, options: selectedOptions })
    const request = gate.current.begin(requestKey)
    setGenerating(true)
    setHtml('')
    setMessage('')
    try {
      const payload = await client.current.load({ subjectType, subjectId, options: selectedOptions, signal: request.controller.signal })
      if (!gate.current.isCurrent(request, requestKey)) return
      setHtml(renderCanonicalReportHtml(payload, { generatedAt: new Date().toISOString() }))
      setMessage('Private report prepared. Review your selections before printing or downloading it.')
    } catch (error) {
      if (!gate.current.isCurrent(request, requestKey)) return
      if (error?.proRequired) onUpgrade?.()
      setMessage(error?.message || 'The report could not be created. Your records were not changed.')
    } finally {
      if (gate.current.finish(request)) setGenerating(false)
    }
  }

  function printReport() {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    setMessage('The private report opened in a new tab. Use your browser’s Print command to print or save it as PDF.')
  }

  function downloadReport() {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = subjectType === 'my_stuff_item' ? 'sideflip-my-stuff-report.html' : 'sideflip-project-report.html'
    link.click()
    URL.revokeObjectURL(url)
  }

  return <section className="mystuff-card">
    <button type="button" className="mystuff-link" onClick={() => !generating && setExpanded(value => !value)} disabled={generating} aria-expanded={expanded} aria-controls={`private-report-${subjectType}`}>
      Private PDF Report <span aria-label="Pro feature">PRO</span> {expanded ? '▲' : '▼'}
    </button>
    {expanded && <div id={`private-report-${subjectType}`}>
      <p className="mystuff-help">Photos and documents are not included. Identifiers and detailed costs are excluded by default; turn on only what you intend to share. The authenticated report service enforces Pro access and returns canonical bounded data.</p>
      <p className="mystuff-help">The report includes its creation date. Creating, printing, or downloading it never changes this record.</p>
      {OPTION_ROWS.map(option => <label key={option.key} style={{ display: 'block', margin: '12px 0' }} title={option.detail}>
        <input type="checkbox" checked={options[option.key]} onChange={() => toggleOption(option.key)} /> {option.label}
        <small className="mystuff-help" style={{ display: 'block', marginLeft: 22 }}>{option.detail}</small>
      </label>)}
      <div className="mystuff-actions">
        <button type="button" className="btn btn-primary" disabled={generating} onClick={generate}>{generating ? 'Preparing private report…' : isPro ? 'Create Report' : 'Unlock Pro PDF Reports'}</button>
        {html && <><button type="button" className="btn btn-secondary" onClick={printReport}>Print / Save as PDF</button><button type="button" className="btn btn-secondary" onClick={downloadReport}>Download Report</button></>}
      </div>
      {message && <p className="mystuff-help" role="status" aria-live="polite">{message}</p>}
    </div>}
  </section>
}
