import { useRef, useState } from 'react'
import { supabase } from '../supabase'

const FIELDS = [
  ['vehicleYear', 'Year', 'year'],
  ['vehicleMake', 'Make', 'make'],
  ['vehicleModel', 'Model', 'model'],
  ['engineModel', 'Engine', 'engineModel'],
  ['transmission', 'Transmission type', 'transmissionStyle'],
]

export default function VinDecodePanel({ values, onChange }) {
  const [review, setReview] = useState(null)
  const [message, setMessage] = useState('')
  const [decoding, setDecoding] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const requestRef = useRef(0)

  async function decode() {
    const request = ++requestRef.current
    setDecoding(true)
    setMessage('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch('/api/decode-vin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
        body: JSON.stringify({ vin: values.vin, subjectType: 'project' }),
      })
      const payload = await response.json().catch(() => ({}))
      if (request !== requestRef.current) return
      if (!response.ok) throw new Error(payload.error || 'VIN decoding failed.')
      const next = Object.fromEntries(FIELDS.map(([key, , apiKey]) => [key, values[key] || payload.vehicle?.[apiKey] || '']))
      setReview(next)
      setMessage('Review and edit every value before confirming. Nothing is saved automatically.')
    } catch (error) {
      if (request === requestRef.current) setMessage(`${error.message} Manual entry is still available.`)
    } finally {
      if (request === requestRef.current) setDecoding(false)
    }
  }

  function edit(key, value) {
    setReview(current => ({ ...(current || {}), [key]: value }))
  }

  async function confirm() {
    if (!review) return
    setConfirming(true)
    try {
      await onChange({ ...values, ...review, vin: String(values.vin || '').trim().toUpperCase() })
      setMessage('Vehicle details confirmed. You can keep editing them before saving or creating the Project.')
    } catch (error) {
      setMessage(error?.message || 'Could not save the confirmed vehicle details. Please try again.')
    } finally {
      setConfirming(false)
    }
  }

  return <div className="card" style={{ marginBottom: 18 }}>
    <div style={{ fontWeight: 800, marginBottom: 5 }}>VIN Decoder <span style={{ color: 'var(--green)', fontSize: 11 }}>BASIC</span></div>
    <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>To decode vehicle details, your full VIN is sent to NHTSA. You can enter every vehicle field manually instead.</div>
    <button type="button" className="btn btn-secondary" disabled={decoding || !values.vin?.trim()} onClick={decode}>{decoding ? 'Decoding…' : 'Decode VIN'}</button>
    {message && <div role="status" style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>{message}</div>}
    {review && <div style={{ marginTop: 12 }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Unconfirmed editable review</div>
      {FIELDS.map(([key, label]) => <div className="form-group" key={key}>
        <label>{label}</label>
        <input value={review[key] ?? ''} onChange={event => edit(key, event.target.value)} />
      </div>)}
      <button type="button" className="btn btn-primary" disabled={confirming} onClick={confirm}>{confirming ? 'Saving…' : 'Confirm Vehicle'}</button>
    </div>}
  </div>
}
