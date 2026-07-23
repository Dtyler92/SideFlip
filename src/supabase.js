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

export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null)
  })
}

export async function resetPassword(email) {
  return supabase.auth.resetPasswordForEmail(email, {
    redirectTo: 'https://sideflip.org'
  })
}
// ── Profile / subscription helpers ───────────────────────────

export async function getProfile(userId) {
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()
  return data
}

export async function upsertProfile(userId, updates) {
  return supabase
    .from('profiles')
    .upsert({ id: userId, ...updates }, { onConflict: 'id' })
}

// ── Project helpers (cloud) ───────────────────────────────────

export async function fetchProjects(userId) {
  const { data } = await supabase
    .from('projects')
    .select('*, expenses(*)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  return data || []
}

export async function upsertProject(project) {
  const { data, error } = await supabase
    .from('projects')
    .upsert(project, { onConflict: 'id' })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function removeProject(id) {
  return supabase.from('projects').delete().eq('id', id)
}

export async function upsertExpense(expense) {
  const { data, error } = await supabase
    .from('expenses')
    .upsert(expense, { onConflict: 'id' })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function removeExpense(id) {
  return supabase.from('expenses').delete().eq('id', id)
}
