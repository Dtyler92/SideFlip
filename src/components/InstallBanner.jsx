import { useInstallPrompt } from '../pwa'
import { useState } from 'react'

export default function InstallBanner({ onDismiss }) {
  const { isInstallable, isIOS, isStandalone, triggerInstall } = useInstallPrompt()
  const [iosOpen, setIosOpen] = useState(false)

  // Already installed or nothing to do
  if (isStandalone) return null
  if (!isInstallable && !isIOS) return null

  if (isIOS) return (
    <>
      <div onClick={() => setIosOpen(true)} style={bannerStyle}>
        <div style={{ fontSize: 28 }}>📲</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>Add SideFlip to your Home Screen</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Tap for instructions</div>
        </div>
        <button onClick={(e) => { e.stopPropagation(); onDismiss?.() }} style={dismissBtn}>✕</button>
      </div>

      {iosOpen && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 500,
          display: 'flex', alignItems: 'flex-end'
        }} onClick={() => setIosOpen(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            background: '#fff', borderRadius: '20px 20px 0 0', padding: '28px 24px 40px',
            width: '100%', boxShadow: '0 -8px 40px rgba(0,0,0,0.15)'
          }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 700, marginBottom: 16 }}>
              Install SideFlip
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Step n={1} text={<>Tap the <strong>Share</strong> button <span style={{ fontSize: 18 }}>⬆️</span> at the bottom of your browser</>} />
              <Step n={2} text={<>Scroll down and tap <strong>"Add to Home Screen"</strong></>} />
              <Step n={3} text={<>Tap <strong>"Add"</strong> — SideFlip will appear on your home screen like a native app</>} />
            </div>
            <button onClick={() => setIosOpen(false)} style={{
              marginTop: 24, width: '100%', padding: '14px',
              background: 'var(--accent)', color: '#fff', border: 'none',
              borderRadius: 'var(--radius)', fontWeight: 700, fontSize: 15,
              fontFamily: 'var(--font)', cursor: 'pointer'
            }}>Got it!</button>
          </div>
        </div>
      )}
    </>
  )

  return (
    <div style={bannerStyle}>
      <div style={{ fontSize: 28 }}>📲</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>Install SideFlip</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Add to your home screen for the best experience</div>
      </div>
      <button onClick={triggerInstall} style={{
        background: 'var(--accent)', color: '#fff', border: 'none',
        borderRadius: 8, padding: '8px 14px', fontWeight: 700, fontSize: 13,
        fontFamily: 'var(--font)', cursor: 'pointer', whiteSpace: 'nowrap'
      }}>Install</button>
      <button onClick={onDismiss} style={dismissBtn}>✕</button>
    </div>
  )
}

function Step({ n, text }) {
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%', background: 'var(--accent)',
        color: '#fff', fontWeight: 700, fontSize: 14, display: 'flex',
        alignItems: 'center', justifyContent: 'center', flexShrink: 0
      }}>{n}</div>
      <div style={{ fontSize: 14, color: 'var(--body)', paddingTop: 4, lineHeight: 1.5 }}>{text}</div>
    </div>
  )
}

const bannerStyle = {
  display: 'flex', alignItems: 'center', gap: 12,
  background: '#fff', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', padding: '12px 14px',
  margin: '12px 16px 0', boxShadow: 'var(--shadow)',
  cursor: 'pointer'
}

const dismissBtn = {
  background: 'none', border: 'none', color: 'var(--muted)',
  fontSize: 16, cursor: 'pointer', padding: '4px', flexShrink: 0
}
