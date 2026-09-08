import { useRef, useState } from 'react'
import { supabase } from '../supabase'

const DISCLAIMER = 'Prepared by the owner; verify details independently.'

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

export function renderProjectReportHtml(payload, generatedAt = new Date().toISOString()) {
  const report = payload?.report || {}
  const rows = Object.entries(report).filter(([, value]) => value != null && typeof value !== 'object')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(report.title || 'SideFlip Project Report')}</title><style>body{font-family:system-ui;margin:40px;color:#1a1917}h1{color:#c8402f}dt{font-weight:700;margin-top:12px}dd{margin:3px 0}footer{margin-top:32px;color:#666;font-size:12px}</style></head><body><h1>SideFlip Project Report</h1><dl>${rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl><pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre><footer>Report date: ${escapeHtml(generatedAt)} · ${escapeHtml(payload?.disclaimer || DISCLAIMER)}</footer></body></html>`
}

export default function ProjectReportPanel({ projectId, isPro, onUpgrade }) {
  const [expanded, setExpanded] = useState(false)
  const [options, setOptions] = useState({ includeIdentifiers: false, includeDetailedCosts: false })
  const [generating, setGenerating] = useState(false)
  const [html, setHtml] = useState('')
  const requestRef = useRef(0)

  async function requestReport() {
    if (!isPro) return onUpgrade?.()
    const request = ++requestRef.current
    setGenerating(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch('/api/report-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
        body: JSON.stringify({ subjectType: 'project', subjectId: projectId, disclaimer: DISCLAIMER, ...options }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (response.status === 403) onUpgrade?.()
        throw new Error(payload.error || 'The report could not be created.')
      }
      if (request === requestRef.current) setHtml(renderProjectReportHtml(payload))
    } catch (error) { alert(error.message) }
    finally { if (request === requestRef.current) setGenerating(false) }
  }

  function printReport() {
    const popup = window.open('', '_blank', 'noopener,noreferrer')
    if (!popup) return alert('Allow pop-ups to print or save the report as PDF.')
    popup.document.write(html)
    popup.document.close()
    popup.focus()
    popup.print()
  }

  function downloadReport() {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'sideflip-project-report.html'
    link.click()
    URL.revokeObjectURL(url)
  }

  return <div className="card">
    <button type="button" onClick={() => setExpanded(value => !value)} style={{ border: 0, background: 'none', padding: 0, font: 'inherit', fontWeight: 800, cursor: 'pointer' }}>Private PDF Report <span style={{ color: 'var(--accent)', fontSize: 11 }}>PRO</span> {expanded ? '▲' : '▼'}</button>
    {expanded && <>
      <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>Photos and documents are not included. Identifiers and detailed costs are excluded by default. The authenticated server enforces Pro access and canonical bounded report data.</p>
      <label style={{ display: 'block', marginBottom: 10 }}><input type="checkbox" checked={options.includeIdentifiers} onChange={() => setOptions(value => ({ ...value, includeIdentifiers: !value.includeIdentifiers }))} /> Identifiers (VIN is masked)</label>
      <label style={{ display: 'block', marginBottom: 10 }}><input type="checkbox" checked={options.includeDetailedCosts} onChange={() => setOptions(value => ({ ...value, includeDetailedCosts: !value.includeDetailedCosts }))} /> Detailed costs</label>
      <button className="btn btn-primary" disabled={generating} onClick={requestReport}>{generating ? 'Preparing private report…' : isPro ? 'Create Report' : 'Unlock Pro PDF Reports'}</button>
      {html && <><button className="btn btn-secondary" onClick={printReport}>Print / Save as PDF</button><button className="btn btn-secondary" onClick={downloadReport}>Download Report</button></>}
    </>}
  </div>
}
