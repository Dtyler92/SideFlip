import { useNavigate } from 'react-router-dom'

export default function FeaturePlaceholder({ title }) {
  const navigate = useNavigate()
  return (
    <main className="page" style={{ paddingTop: 40, textAlign: 'center' }}>
      <div className="empty">
        <div className="empty-icon">🛠️</div>
        <h1 style={{ fontSize: 24 }}>{title}</h1>
        <p>Coming to the PWA: {title}. Your account and existing data remain available on supported SideFlip apps.</p>
        <button className="btn btn-secondary" type="button" onClick={() => navigate('/')}>Back to Projects</button>
      </div>
    </main>
  )
}
