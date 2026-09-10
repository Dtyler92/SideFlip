import { createClient } from '@supabase/supabase-js'
import { requireJpegBlob } from './media/jpeg.js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// ── Auth helpers ──────────────────────────────────────────────

export async function signUp(email, password) {
  return supabase.auth.signUp({ email, password })
}

export async function signIn(email, password) {
  return supabase.auth.signInWithPassword({ email, password })
}

export async function signOut() {
  return supabase.auth.signOut()
}

export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null)
  })
}

// ── Photo upload helpers ──────────────────────────────────────

export async function uploadPhoto(userId, file) {
  // Compress/resize before upload if large
  const compressed = await compressImage(file)
  const objectId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const path = `${userId}/${objectId}.jpg`

  const { error } = await supabase.storage
    .from('project-photos')
    .upload(path, compressed, { upsert: true, contentType: 'image/jpeg' })

  if (error) throw error

  const { data } = supabase.storage.from('project-photos').getPublicUrl(path)
  return data.publicUrl
}

export async function deletePhoto(userId, url) {
  if (!userId || !url || url.startsWith('data:') || url.startsWith('blob:')) return
  let path
  try {
    const marker = '/project-photos/'
    const pathname = new URL(url).pathname
    const markerIndex = pathname.indexOf(marker)
    if (markerIndex < 0) return
    path = decodeURIComponent(pathname.slice(markerIndex + marker.length))
  } catch { return }
  if (!path.startsWith(`${userId}/`) || path.includes('../') || path.includes('\\')) return
  const { error } = await supabase.storage.from('project-photos').remove([path])
  if (error) throw error
}

async function compressImage(file) {
  return new Promise((resolve, reject) => {
    const MAX = 1200
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read this image. Please choose another file.'))
    reader.onload = ev => {
      const img = new Image()
      img.onerror = () => reject(new Error('This image format cannot be processed in this browser. Please choose a JPEG, PNG, or WebP image.'))
      img.onload = () => {
        let { width, height } = img
        if (!width || !height) {
          reject(new Error('Could not read this image. Please choose another file.'))
          return
        }
        if (width > MAX || height > MAX) {
          if (width > height) { height = Math.round(height * MAX / width); width = MAX }
          else { width = Math.round(width * MAX / height); height = MAX }
        }
        const canvas = document.createElement('canvas')
        canvas.width = width; canvas.height = height
        const context = canvas.getContext('2d')
        if (!context) {
          reject(new Error('Could not process this image. Please try another browser.'))
          return
        }
        context.drawImage(img, 0, 0, width, height)
        canvas.toBlob(blob => {
          try {
            resolve(requireJpegBlob(blob))
          } catch (error) {
            reject(error)
          }
        }, 'image/jpeg', 0.82)
      }
      img.src = ev.target.result
    }
    reader.readAsDataURL(file)
  })
}

export async function resetPassword(email) {
  return supabase.auth.resetPasswordForEmail(email, {
    redirectTo: 'https://sideflip.org'
  })
}


export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()
  if (error) throw error
  if (!data) throw new Error('Could not load your profile.')
  return data
}

// Entitlement rows are intentionally not readable by browser clients. This
// endpoint authenticates the session and returns only the capability-safe data.
export async function getEntitlement() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) return null
  const response = await fetch('/api/entitlement', {
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  if (!response.ok) throw new Error('Could not resolve your plan.')
  const data = await response.json()
  if (data?.plan !== 'free' && data?.plan !== 'pro') {
    throw new Error('Could not resolve your plan.')
  }
  return data
}

