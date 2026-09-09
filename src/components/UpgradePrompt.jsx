import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function UpgradePrompt({ open, onDismiss, message = 'Upgrade to SideFlip Pro to unlock this feature.' }) {
  const navigate = useNavigate()
  const dialog = useRef(null)
  const upgradeButton = useRef(null)
  const previousFocus = useRef(null)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss

  useEffect(() => {
    if (!open) return undefined
    previousFocus.current = document.activeElement
    upgradeButton.current?.focus()
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        dismiss.current?.()
        return
      }
      if (event.key === 'Tab') {
        const focusable = [...(dialog.current?.querySelectorAll(FOCUSABLE) || [])]
        if (!focusable.length) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previousFocus.current?.focus()
    }
  }, [open])

  if (!open) return null
  return <div className="modal-overlay" onClick={() => dismiss.current?.()}>
    <section ref={dialog} className="modal-sheet upgrade-prompt" role="dialog" aria-modal="true" aria-labelledby="upgrade-prompt-title" onClick={event => event.stopPropagation()}>
      <div className="modal-handle" aria-hidden="true" />
      <div className="mystuff-eyebrow">SIDEFLIP PRO</div>
      <h2 id="upgrade-prompt-title">Unlock more with SideFlip Pro</h2>
      <p>{message}</p>
      <ul>
        <li>More projects, My Stuff items, goals, and photos</li>
        <li>Portfolio analytics and AI listing tools</li>
        <li>Private reports and manufacturer maintenance research</li>
      </ul>
      <button ref={upgradeButton} type="button" className="btn btn-primary" onClick={() => navigate('/upgrade')}>Upgrade to SideFlip Pro</button>
      <button type="button" className="btn btn-secondary" onClick={() => dismiss.current?.()}>Dismiss</button>
    </section>
  </div>
}
