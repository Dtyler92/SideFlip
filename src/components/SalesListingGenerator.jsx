import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { buildListingRequest, HUMOR_LEVELS, LISTING_STYLES } from '../projectParity'

export default function SalesListingGenerator({ projectId, isPro, onUpgrade }) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState('edit')
  const [text, setText] = useState('')
  const [sellerBrief, setSellerBrief] = useState('')
  const [style, setStyle] = useState('normal')
  const [humor, setHumor] = useState('balanced')
  const [preview, setPreview] = useState('')
  const [generating, setGenerating] = useState(false)
  const abortRef = useRef(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  function launch() {
    if (!isPro) return onUpgrade?.()
    setOpen(true)
  }

  function cancel() {
    abortRef.current?.abort()
    abortRef.current = null
    setGenerating(false)
    setPreview('')
    setStep('edit')
    setOpen(false)
  }

  async function generate(nextStyle = style, nextHumor = humor) {
    if (generating) return
    let request
    try { request = buildListingRequest(projectId, nextStyle, nextHumor, text, sellerBrief) }
    catch (error) { return alert(error.message) }
    const controller = new AbortController()
    abortRef.current?.abort()
    abortRef.current = controller
    setGenerating(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch('/api/generate-listing', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
        body: JSON.stringify(request),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (response.status === 403) onUpgrade?.()
        throw new Error(payload.error || "Couldn't generate a description. Try again.")
      }
      const description = String(payload.description || payload.listing || '').trim()
      if (!description) throw new Error("Couldn't generate a description. Try again.")
      if (text.trim()) setPreview(description)
      else setText(description)
      setStep('edit')
    } catch (error) {
      if (error.name !== 'AbortError') alert(error.message)
    } finally {
      if (abortRef.current === controller) { abortRef.current = null; setGenerating(false) }
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(text.trim())
  }

  async function share() {
    if (navigator.share) return navigator.share({ text: text.trim(), title: 'Sales listing' })
    await copy()
    alert('Listing copied to your clipboard.')
  }

  return <>
    <button className="btn btn-secondary" onClick={launch}>✨ Sales Listing Generator {isPro ? '' : '· PRO'}</button>
    {open && <div className="modal-overlay" onClick={cancel}>
      <div className="modal-sheet" onClick={event => event.stopPropagation()}>
        <div className="modal-title">Sales Listing Generator</div>
        {preview ? <>
          <div style={{ fontWeight: 700, margin: '12px 0 6px' }}>Preview generated description</div>
          <textarea value={preview} onChange={event => setPreview(event.target.value)} style={{ minHeight: 180 }} />
          <button className="btn btn-primary" onClick={() => { setText(preview); setPreview('') }}>Use Description</button>
          <button className="btn btn-secondary" disabled={generating} onClick={() => generate()}>{generating ? 'Writing…' : 'Regenerate'}</button>
          <button className="btn btn-secondary" onClick={() => setPreview('')}>Cancel Preview</button>
        </> : step === 'brief' ? <>
          <h3>What should buyers know?</h3>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>Briefly describe the condition and anything else you want the buyer to know. The generator will use only the facts you provide.</p>
          <textarea maxLength={2000} value={sellerBrief} onChange={event => setSellerBrief(event.target.value)} placeholder="Example: Runs well, small scratch on the left side, clean title, and the tires are one year old." />
          <button className="btn btn-primary" disabled={!sellerBrief.trim()} onClick={() => setStep('style')}>Continue</button>
          <button className="btn btn-secondary" onClick={() => setStep('edit')}>Cancel</button>
        </> : step === 'style' ? <>
          <h3>Choose a style</h3>
          {LISTING_STYLES.map(option => <button key={option.value} className="btn btn-secondary" onClick={() => { setStyle(option.value); option.value === 'funny' ? setStep('humor') : generate(option.value, null) }}>{option.label}</button>)}
          <button className="btn btn-secondary" onClick={() => setStep('edit')}>Cancel</button>
        </> : step === 'humor' ? <>
          <h3>How funny?</h3>
          {HUMOR_LEVELS.map(option => <button key={option.value} className="btn btn-secondary" onClick={() => { setHumor(option.value); generate('funny', option.value) }}>{option.label}{option.value === 'balanced' ? ' · Recommended' : ''}</button>)}
          <button className="btn btn-secondary" onClick={() => setStep('edit')}>Cancel</button>
        </> : <>
          <p style={{ color: 'var(--muted)', fontSize: 12 }}>Edit the description before copying or sharing.</p>
          {generating && <div role="status">Writing your description…</div>}
          <textarea value={text} onChange={event => setText(event.target.value)} placeholder="Add the details a buyer should know..." style={{ minHeight: 180 }} />
          <button className="btn btn-secondary" disabled={generating} onClick={() => setStep('brief')}>✨ Generate Description</button>
          <button className="btn btn-primary" disabled={!text.trim() || generating} onClick={share}>Share Listing</button>
          <button className="btn btn-secondary" disabled={!text.trim() || generating} onClick={copy}>Copy Listing</button>
          <button className="btn btn-secondary" onClick={cancel}>Cancel</button>
        </>}
      </div>
    </div>}
  </>
}
