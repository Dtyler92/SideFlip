import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createProject, CATEGORIES } from '../store'

export default function NewProject() {
  const navigate = useNavigate()
  const [form, setForm] = useState({ title: '', category: 'mower', purchasePrice: '', notes: '' })
  const [photo, setPhoto] = useState(null)

  function handlePhoto(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => setPhoto(ev.target.result)
    reader.readAsDataURL(file)
  }

  function set(field, val) { setForm(f => ({ ...f, [field]: val })) }

  function handleSubmit(e) {
    e.preventDefault()
    if (!form.title.trim()) return alert('Give your project a name')
    createProject({ ...form, photo })
    navigate('/')
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
            <div className="photo-upload">
              {photo && <img src={photo} alt="preview" />}
              {!photo && <>
                <span className="photo-upload-icon">📷</span>
                <span>Tap to add a photo</span>
              </>}
              <input type="file" accept="image/*" capture="environment" onChange={handlePhoto} />
            </div>
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
              type="number"
              inputMode="decimal"
              placeholder="0.00"
              value={form.purchasePrice}
              onChange={e => set('purchasePrice', e.target.value)}
            />
          </div>

          {/* Notes */}
          <div className="form-group">
            <label>Notes (optional)</label>
            <textarea
              placeholder="What's wrong with it? What's the plan?"
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
            />
          </div>

          <button type="submit" className="btn btn-primary">Create Project →</button>
        </form>
      </div>
    </>
  )
}
