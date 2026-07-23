import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CATEGORIES, getExtraFields } from '../store'
import { createProject } from '../db'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { uploadPhoto } from '../supabase'

function PhotoPicker({ photo, onFile, uploading }) {
  return (
    <div className="photo-upload">
      {photo && <img src={photo} alt="preview" />}
      {!photo && !uploading && <>
        <span className="photo-upload-icon">📷</span>
        <span>Tap to add a photo</span>
      </>}
      {uploading && <span style={{ fontSize: 13, color: 'var(--muted)' }}>Uploading…</span>}
      {photo && !uploading && (
        <div style={{
          position: 'absolute', bottom: 8, right: 8,
          background: 'rgba(13,13,11,0.6)', color: '#fff',
          borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 600,
          zIndex: 2, pointerEvents: 'none'
        }}>✏️ Change Photo</div>
      )}
      <input type="file" accept="image/*" onChange={onFile} />
    </div>
  )
}

export default function NewProject() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { refresh } = useData()
  const [photo, setPhoto] = useState(null)
  const [photoUploading, setPhotoUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    title: '', category: 'mower', purchasePrice: '', notes: '',
    modelNumber: '', serialNumber: '',
    engineModel: '', engineSerial: '',
    vin: '', hullNumber: '',
  })

  const fields = getExtraFields(form.category)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function handlePhotoFile(e) {
    const file = e.target.files[0]
    if (!file) return
    setPhotoUploading(true)
    try {
      const url = await uploadPhoto(user.id, file)
      setPhoto(url)
    } catch (err) {
      alert('Photo upload failed: ' + err.message)
    } finally {
      setPhotoUploading(false)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.title.trim()) return alert('Give your project a name')
    setSaving(true)
    try {
      await createProject(user.id, { ...form, photo })
      await refresh()
      navigate('/')
    } catch (err) {
      alert('Failed to save: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="page-header">
        <button className="back-btn" onClick={() => navigate(-1)}>‹</button>
        <h1>New Project</h1>
      </div>

      <div className="page">
        <form onSubmit={handleSubmit}>

          {/* Photo */}
          <div className="form-group">
            <label>Photo (optional)</label>
            <PhotoPicker photo={photo} onFile={handlePhotoFile} uploading={photoUploading} />
          </div>

          {/* Title */}
          <div className="form-group">
            <label>Project Name *</label>
            <input
              type="text"
              placeholder="e.g. Honda HRR216 Mower"
              value={form.title}
              onChange={e => set('title', e.target.value)}
            />
          </div>

          {/* Category */}
          <div className="form-group">
            <label>Category</label>
            <select value={form.category} onChange={e => set('category', e.target.value)}>
              {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>

          {/* Purchase Price */}
          <div className="form-group">
            <label>Purchase Price</label>
            <input
              type="number" inputMode="decimal" placeholder="0.00"
              value={form.purchasePrice}
              onChange={e => set('purchasePrice', e.target.value)}
            />
          </div>

          {/* ── Category-specific identifiers ── */}
          {(fields.hasVin || fields.hasHull) && (
            <div className="form-group">
              <label>{fields.hasHull ? 'Hull Number' : 'VIN Number'}</label>
              <input
                type="text"
                placeholder={fields.hasHull ? 'e.g. ABC12345D102' : 'e.g. 1HGCM82633A123456'}
                value={fields.hasVin ? form.vin : form.hullNumber}
                onChange={e => set(fields.hasVin ? 'vin' : 'hullNumber', e.target.value)}
              />
            </div>
          )}

          {fields.hasModel && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div className="form-group">
                <label>Model #</label>
                <input
                  type="text" placeholder="e.g. HRR216K9"
                  value={form.modelNumber}
                  onChange={e => set('modelNumber', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Serial #</label>
                <input
                  type="text" placeholder="e.g. SN-1234567"
                  value={form.serialNumber}
                  onChange={e => set('serialNumber', e.target.value)}
                />
              </div>
            </div>
          )}

          {fields.hasEngine && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div className="form-group">
                <label>Engine Model</label>
                <input
                  type="text" placeholder="e.g. GCV170"
                  value={form.engineModel}
                  onChange={e => set('engineModel', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Engine Serial</label>
                <input
                  type="text" placeholder="e.g. GJAFA-1234567"
                  value={form.engineSerial}
                  onChange={e => set('engineSerial', e.target.value)}
                />
              </div>
            </div>
          )}

          {/* Notes */}
          <div className="form-group">
            <label>Notes (optional)</label>
            <textarea
              placeholder="What's wrong with it? What's the plan?"
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
            />
          </div>

          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Create Project →'}</button>
        </form>
      </div>
    </>
  )
}
