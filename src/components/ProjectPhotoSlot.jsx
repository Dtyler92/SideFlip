export default function ProjectPhotoSlot({ label, photo, onFile, uploading }) {
  return (
    <label style={{ display: 'block', cursor: uploading ? 'wait' : 'pointer' }}>
      <span style={{ display: 'block', color: 'var(--body)', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{label}</span>
      <div style={{
        position: 'relative', aspectRatio: '4 / 3', overflow: 'hidden', borderRadius: 10,
        border: '1px dashed var(--border)', background: 'var(--surface)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: 'var(--muted)',
      }}>
        {photo ? (
          <img src={photo} alt={`${label} preview`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        ) : (
          <span style={{ padding: 12, fontSize: 12, lineHeight: 1.35 }}>📷<br />Add {label.toLowerCase()}</span>
        )}
        <span style={{
          position: 'absolute', right: 7, bottom: 7, padding: '4px 7px', borderRadius: 6,
          background: 'rgba(13,13,11,0.65)', color: '#fff', fontSize: 11, fontWeight: 700,
        }}>{uploading ? 'Uploading…' : photo ? 'Change' : 'Add'}</span>
        <input type="file" accept="image/*" disabled={uploading} onChange={onFile} style={{ display: 'none' }} />
      </div>
    </label>
  )
}
