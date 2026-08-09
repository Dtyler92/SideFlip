import { useEffect, useState } from 'react'
import { sanitizeAttributionValue } from './analytics.js'

const REFERRAL_KEY = 'sf_ref'

function referralOwner(userId) {
  return typeof userId === 'string' && userId ? userId : null
}

function readReferralRecord() {
  if (typeof window === 'undefined') return null
  try {
    const record = JSON.parse(window.sessionStorage.getItem(REFERRAL_KEY) || 'null')
    if (!record || !Object.hasOwn(record, 'owner') || typeof record.value !== 'string') return null
    const value = sanitizeAttributionValue('referral_code', record.value)
    return value ? { owner: referralOwner(record.owner), value: value.toUpperCase() } : null
  } catch {
    // Remove legacy unscoped strings and malformed data rather than risking a
    // checkout referral crossing accounts.
    try { window.sessionStorage.removeItem(REFERRAL_KEY) } catch { /* storage may be disabled */ }
    return null
  }
}

export function getStoredReferral(userId = null) {
  const record = readReferralRecord()
  return record?.owner === referralOwner(userId) ? record.value : null
}

export function clearReferral() {
  if (typeof window === 'undefined') return
  try { window.sessionStorage.removeItem(REFERRAL_KEY) } catch { /* storage may be disabled */ }
}

export function transitionReferralScope(previousUserId, nextUserId) {
  const previous = referralOwner(previousUserId)
  const next = referralOwner(nextUserId)
  if (previous === next) return
  const record = readReferralRecord()
  clearReferral()
  // A referral intentionally captured before signup may follow that anonymous
  // session into its first account. All sign-out and account switches clear it.
  if (previous === null && next && record?.owner === null) {
    try { window.sessionStorage.setItem(REFERRAL_KEY, JSON.stringify({ owner: next, value: record.value })) } catch { /* storage may be disabled */ }
  }
}

// Capture ?ref= for checkout, scoped to the current auth identity.
export function captureReferral(input = typeof window !== 'undefined' ? window.location.href : '', userId = null) {
  if (typeof window === 'undefined') return null
  let url
  try { url = new URL(input, window.location.href) } catch { return null }
  const ref = sanitizeAttributionValue('referral_code', url.searchParams.get('ref'))
  if (ref) {
    try {
      window.sessionStorage.setItem(REFERRAL_KEY, JSON.stringify({ owner: referralOwner(userId), value: ref.toUpperCase() }))
    } catch { /* storage may be disabled */ }
  }
  if (url.searchParams.has('ref')) {
    url.searchParams.delete('ref')
    const query = url.searchParams.toString()
    window.history.replaceState({}, '', `${url.pathname}${query ? `?${query}` : ''}${url.hash}`)
  }
  return ref?.toUpperCase() || null
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
