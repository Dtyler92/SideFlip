import { useEffect, useRef, useState } from 'react'
import { deletePhoto, uploadPhoto } from '../supabase'
import { photoLimitForPlan, projectPhotoRoles } from '../projectParity'

export default function ProjectPhotoGallery({ userId, photos = [], project = {}, plan = 'free', onUpdate, onUpgrade }) {
  const [busy, setBusy] = useState(false)
  const [previews, setPreviews] = useState([])
  const [viewedPhoto, setViewedPhoto] = useState(null)
  const busyRef = useRef(false)
  const mountedRef = useRef(true)
  const limit = photoLimitForPlan(plan)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  function setOperationBusy(value) {
    busyRef.current = value
    if (mountedRef.current) setBusy(value)
  }

  function showLimit() {
    if (plan === 'free') onUpgrade?.()
    else if (plan === 'pro') alert(`SideFlip Pro supports up to ${limit} photos per project.`)
  }

  async function addFiles(event) {
    const input = event.currentTarget
    const selected = Array.from(input.files || [])
    input.value = ''
    if (!selected.length || busyRef.current) return
    const remaining = limit - photos.length
    if (remaining <= 0) return showLimit()
    const accepted = selected.slice(0, remaining)
    const objectUrls = accepted.map(file => URL.createObjectURL(file))
    setPreviews(objectUrls)
    setOperationBusy(true)
    const uploaded = []
    try {
      for (const file of accepted) uploaded.push(await uploadPhoto(userId, file))
      if (!mountedRef.current) throw new Error('Photo selection was cancelled.')
      await onUpdate([...photos, ...uploaded])
      if (selected.length > accepted.length) showLimit()
    } catch (error) {
      await Promise.allSettled(uploaded.map(url => deletePhoto(userId, url)))
      if (mountedRef.current) alert('Photo upload failed: ' + error.message)
    } finally {
      objectUrls.forEach(url => URL.revokeObjectURL(url))
      if (mountedRef.current) setPreviews([])
      setOperationBusy(false)
    }
  }

  async function persist(nextPhotos, removedUrl = null) {
    if (busyRef.current) return
    setOperationBusy(true)
    try {
      await onUpdate(nextPhotos)
      if (viewedPhoto === removedUrl && mountedRef.current) setViewedPhoto(null)
    } catch (error) {
      if (mountedRef.current) alert('Could not save project photos: ' + error.message)
    } finally { setOperationBusy(false) }
  }

  function move(index, offset) {
    const destination = index + offset
    if (destination < 0 || destination >= photos.length) return
    const next = [...photos]
    ;[next[index], next[destination]] = [next[destination], next[index]]
    void persist(next)
  }

  function remove(url) {
    if (confirm('Remove photo?')) void persist(photos.filter(photo => photo !== url), url)
  }

  return <div style={{ marginBottom: 20 }}>
    <div className="project-photo-gallery" style={{ display: 'flex', gap: 10, overflowX: 'auto', padding: '4px 0' }}>
      {photos.map((url, index) => {
        const roles = projectPhotoRoles(project, url)
        if (index === 0 && !roles.includes('Main')) roles.unshift('Main')
        return <div key={url} style={{ position: 'relative', flex: '0 0 120px' }}>
          <button type="button" onClick={() => setViewedPhoto(url)} aria-label={`Preview photo ${index + 1}`} style={{ border: 0, padding: 0, background: 'none', width: '100%' }}>
            <img src={url} alt={`Project photo ${index + 1}`} style={{ width: 120, height: 110, borderRadius: 12, objectFit: 'cover', display: 'block' }} />
          </button>
          <button type="button" disabled={busy} onClick={() => remove(url)} aria-label={`Remove photo ${index + 1}`} style={{ position: 'absolute', top: 5, right: 5, border: 0, borderRadius: '50%', width: 25, height: 25, color: '#fff', background: 'rgba(0,0,0,.7)' }}>✕</button>
          <div style={{ position: 'absolute', left: 5, top: 83, display: 'flex', gap: 3 }}>{roles.map(role => <span key={role} style={{ background: 'var(--accent)', color: '#fff', borderRadius: 5, padding: '2px 5px', fontSize: 9, fontWeight: 700 }}>{role}</span>)}</div>
          <div style={{ display: 'flex', gap: 4, marginTop: 5 }}>
            <button type="button" className="btn btn-secondary" disabled={busy || index === 0} onClick={() => move(index, -1)} aria-label={`Move photo ${index + 1} left`} style={{ padding: 4, margin: 0 }}>←</button>
            <button type="button" className="btn btn-secondary" disabled={busy || index === photos.length - 1} onClick={() => move(index, 1)} aria-label={`Move photo ${index + 1} right`} style={{ padding: 4, margin: 0 }}>→</button>
          </div>
        </div>
      })}
      {previews.map((url, index) => <div key={url} style={{ flex: '0 0 120px', opacity: .65 }}><img src={url} alt={`Uploading photo ${index + 1}`} style={{ width: 120, height: 110, borderRadius: 12, objectFit: 'cover' }} /><div style={{ fontSize: 11 }}>Uploading…</div></div>)}
      {photos.length >= limit
        ? <button type="button" onClick={showLimit} style={{ flex: '0 0 120px', height: 110, border: '2px dashed var(--border)', borderRadius: 12, background: 'none', color: 'var(--muted)' }}>Limit reached</button>
        : <label style={{ flex: '0 0 120px', height: 110, border: '2px dashed var(--border)', borderRadius: 12, display: 'grid', placeItems: 'center', textAlign: 'center', cursor: busy ? 'wait' : 'pointer', color: 'var(--muted)', fontSize: 12 }}>
            <span>{busy ? 'Uploading…' : photos.length ? '📷 Add more' : '📷 Add photos'}</span>
            <input type="file" accept="image/*" multiple disabled={busy} onChange={addFiles} style={{ display: 'none' }} />
          </label>}
    </div>
    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 7 }}>First photo is main · {photos.length}/{limit} total photos{photos.length >= limit && plan === 'free' ? ' · Select the limit card to view Pro' : ''}</div>
    {viewedPhoto && <div role="dialog" aria-modal="true" aria-label="Photo preview" onClick={() => setViewedPhoto(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.86)', display: 'grid', placeItems: 'center', padding: 20 }}>
      <button type="button" aria-label="Close photo preview" onClick={() => setViewedPhoto(null)} style={{ position: 'absolute', top: 18, right: 18, color: '#fff', background: 'none', border: 0, fontSize: 28 }}>✕</button>
      <img src={viewedPhoto} alt="Project photo preview" onClick={event => event.stopPropagation()} style={{ maxWidth: '100%', maxHeight: '88vh', objectFit: 'contain' }} />
    </div>}
  </div>
}