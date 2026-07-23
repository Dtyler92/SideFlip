import { supabase } from './supabase'

// ── Project helpers (Supabase) ────────────────────────────────

export async function getProjects(userId) {
  const { data, error } = await supabase
    .from('projects')
    .select('*, expenses(*)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data || []).map(normalizeProject)
}

export async function getProject(userId, id) {
  const { data, error } = await supabase
    .from('projects')
    .select('*, expenses(*)')
    .eq('user_id', userId)
    .eq('id', id)
    .single()
  if (error) throw error
  return normalizeProject(data)
}

export async function createProject(userId, data) {
  const row = toRow(userId, data)
  const { data: project, error } = await supabase
    .from('projects')
    .insert(row)
    .select('*, expenses(*)')
    .single()
  if (error) throw error
  return normalizeProject(project)
}

export async function updateProject(userId, id, updates) {
  const row = toRow(userId, updates)
  const { data, error } = await supabase
    .from('projects')
    .update(row)
    .eq('id', id)
    .eq('user_id', userId)
    .select('*, expenses(*)')
    .single()
  if (error) throw error
  return normalizeProject(data)
}

export async function deleteProject(userId, id) {
  const { error } = await supabase
    .from('projects')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

export async function addExpense(userId, projectId, expense) {
  const { data, error } = await supabase
    .from('expenses')
    .insert({
      project_id: projectId,
      user_id: userId,
      description: expense.description,
      amount: Number(expense.amount),
      category: expense.category || 'other'
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteExpense(userId, expenseId) {
  const { error } = await supabase
    .from('expenses')
    .delete()
    .eq('id', expenseId)
    .eq('user_id', userId)
  if (error) throw error
}

// ── Migration: move localStorage data to Supabase ─────────────

export async function migrateLocalData(userId) {
  const LOCAL_KEY = 'flipledger_projects'
  const raw = localStorage.getItem(LOCAL_KEY)
  if (!raw) return 0

  let local = []
  try { local = JSON.parse(raw) } catch { return 0 }
  if (!local.length) return 0

  let migrated = 0
  for (const p of local) {
    try {
      const row = {
        user_id: userId,
        title: p.title || 'Untitled',
        category: p.category || 'other',
        status: p.status || 'active',
        purchase_price: Number(p.purchasePrice) || 0,
        sale_price: p.salePrice ? Number(p.salePrice) : null,
        sold_at: p.soldAt || null,
        photo: p.photo || null,
        notes: p.notes || null,
        model_number: p.modelNumber || null,
        serial_number: p.serialNumber || null,
        engine_model: p.engineModel || null,
        engine_serial: p.engineSerial || null,
        vin: p.vin || null,
        hull_number: p.hullNumber || null,
        created_at: p.createdAt || new Date().toISOString()
      }
      const { data: inserted, error } = await supabase
        .from('projects')
        .insert(row)
        .select()
        .single()
      if (error) continue

      // Migrate expenses
      if (p.expenses?.length) {
        const expRows = p.expenses.map(e => ({
          project_id: inserted.id,
          user_id: userId,
          description: e.description || 'Expense',
          amount: Number(e.amount) || 0,
          category: e.category || 'other',
          created_at: e.createdAt || new Date().toISOString()
        }))
        await supabase.from('expenses').insert(expRows)
      }
      migrated++
    } catch {}
  }

  // Clear local data after migration
  if (migrated > 0) {
    localStorage.removeItem(LOCAL_KEY)
    localStorage.setItem('sf_migrated', '1')
  }
  return migrated
}

export function alreadyMigrated() {
  return localStorage.getItem('sf_migrated') === '1'
}

// ── Normalizers ───────────────────────────────────────────────

function normalizeProject(p) {
  return {
    id: p.id,
    createdAt: p.created_at,
    title: p.title,
    category: p.category,
    status: p.status,
    purchasePrice: p.purchase_price,
    salePrice: p.sale_price,
    soldAt: p.sold_at,
    photo: p.photo,
    notes: p.notes,
    modelNumber: p.model_number,
    serialNumber: p.serial_number,
    engineModel: p.engine_model,
    engineSerial: p.engine_serial,
    vin: p.vin,
    hullNumber: p.hull_number,
    expenses: (p.expenses || []).map(e => ({
      id: e.id,
      createdAt: e.created_at,
      description: e.description,
      amount: e.amount,
      category: e.category
    }))
  }
}

function toRow(userId, data) {
  const row = { user_id: userId }
  if (data.title !== undefined) row.title = data.title
  if (data.category !== undefined) row.category = data.category
  if (data.status !== undefined) row.status = data.status
  if (data.purchasePrice !== undefined) row.purchase_price = Number(data.purchasePrice) || 0
  if (data.salePrice !== undefined) row.sale_price = data.salePrice ? Number(data.salePrice) : null
  if (data.soldAt !== undefined) row.sold_at = data.soldAt
  if (data.photo !== undefined) row.photo = data.photo
  if (data.notes !== undefined) row.notes = data.notes
  if (data.modelNumber !== undefined) row.model_number = data.modelNumber
  if (data.serialNumber !== undefined) row.serial_number = data.serialNumber
  if (data.engineModel !== undefined) row.engine_model = data.engineModel
  if (data.engineSerial !== undefined) row.engine_serial = data.engineSerial
  if (data.vin !== undefined) row.vin = data.vin
  if (data.hullNumber !== undefined) row.hull_number = data.hullNumber
  return row
}
