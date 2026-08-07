import { createClient } from '@supabase/supabase-js'

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
  const ext = file.name.split('.').pop().toLowerCase().replace('heic', 'jpg') || 'jpg'
  const path = `${userId}/${Date.now()}.${ext}`

  const { error } = await supabase.storage
    .from('project-photos')
    .upload(path, compressed, { upsert: true, contentType: compressed.type })

  if (error) throw error

  const { data } = supabase.storage.from('project-photos').getPublicUrl(path)
  return data.publicUrl
}

export async function deletePhoto(url) {
  if (!url || url.startsWith('data:')) return // skip base64
  const path = url.split('/project-photos/')[1]
  if (!path) return
  await supabase.storage.from('project-photos').remove([path])
}

async function compressImage(file) {
  return new Promise(resolve => {
    const MAX = 1200
    const reader = new FileReader()
    reader.onload = ev => {
      const img = new Image()
      img.onload = () => {
        let { width, height } = img
        if (width > MAX || height > MAX) {
          if (width > height) { height = Math.round(height * MAX / width); width = MAX }
          else { width = Math.round(width * MAX / height); height = MAX }
        }
        const canvas = document.createElement('canvas')
        canvas.width = width; canvas.height = height
        canvas.getContext('2d').drawImage(img, 0, 0, width, height)
        canvas.toBlob(blob => resolve(blob || file), 'image/jpeg', 0.82)
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
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()
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
  return data.entitlement || null
}

