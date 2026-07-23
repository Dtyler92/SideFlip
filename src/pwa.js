import { useEffect, useState } from 'react'

// Capture ?ref= param and store it for checkout
export function captureReferral() {
  const params = new URLSearchParams(window.location.search)
  const ref = params.get('ref')
  if (ref) {
    sessionStorage.setItem('sf_ref', ref.toUpperCase())
    // Clean URL without reloading
    const clean = window.location.pathname
    window.history.replaceState({}, '', clean)
  }
}

export function getReferral() {
  return sessionStorage.getItem('sf_ref') || null
}

// PWA install prompt hook
export function useInstallPrompt() {
  const [prompt, setPrompt] = useState(null)
  const [isInstallable, setIsInstallable] = useState(false)
  const [isIOS, setIsIOS] = useState(false)
  const [isStandalone, setIsStandalone] = useState(false)

  useEffect(() => {
    // Check if already installed
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true
    setIsStandalone(standalone)

    // Detect iOS
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream
    setIsIOS(ios)

    // Chrome/Android install prompt
    const handler = (e) => {
      e.preventDefault()
      setPrompt(e)
      setIsInstallable(true)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  async function triggerInstall() {
    if (!prompt) return false
    prompt.prompt()
    const { outcome } = await prompt.userChoice
    setPrompt(null)
    setIsInstallable(false)
    return outcome === 'accepted'
  }

  return { isInstallable, isIOS, isStandalone, triggerInstall }
}
