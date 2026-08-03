import { supabase } from './supabase'
import { createMutationId } from './goals'

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
  if (data.goalId) {
    const { data: projectId, error } = await supabase.rpc('create_trade_up_project', {
      p_title: data.title,
      p_category: data.category || 'other',
      p_purchase_price: Number(data.purchasePrice) || 0,
      p_photo: data.photo || null,
      p_notes: data.notes || null,
      p_model_number: data.modelNumber || null,
      p_serial_number: data.serialNumber || null,
      p_engine_model: data.engineModel || null,
      p_engine_serial: data.engineSerial || null,
      p_vin: data.vin || null,
      p_hull_number: data.hullNumber || null,
      p_vehicle_year: data.vehicleYear ? Number(data.vehicleYear) : null,
      p_vehicle_make: data.vehicleMake || null,
      p_vehicle_model: data.vehicleModel || null,
      p_goal_id: data.goalId,
      p_goal_funding: Number(data.goalFundingAmount) || 0,
      p_out_of_pocket: Number(data.outOfPocketAmount) || 0,
      p_mutation_id: data.mutationId || createMutationId(),
    })
    if (error) throw error
    return getProject(userId, projectId)
  }

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
  const { error } = await supabase.rpc('delete_trade_up_project', { p_project_id: id })
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

// ── Trade-Up Goals ────────────────────────────────────────────

export async function getGoals(userId) {
  const { data, error } = await supabase
    .from('trade_up_goals')
    .select('*, goal_ledger(*)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data || []).map(normalizeGoal)
}

export async function createGoal(userId, goal) {
  const { data: goalId, error } = await supabase.rpc('create_trade_up_goal', {
    p_name: goal.name,
    p_goal_type: goal.goalType,
    p_target_item: goal.targetItem || null,
    p_target_amount: Number(goal.targetAmount) || 0,
    p_description: goal.description || null,
    p_starting_amount: Number(goal.startingAmount) || 0,
    p_mutation_id: goal.mutationId || createMutationId(),
  })
  if (error) throw error
  const { data, error: fetchError } = await supabase.from('trade_up_goals')
    .select('*, goal_ledger(*)').eq('id', goalId).eq('user_id', userId).single()
  if (fetchError) throw fetchError
  return normalizeGoal(data)
}

export async function updateGoal(userId, goalId, updates) {
  const row = {}
  if (updates.status !== undefined) row.status = updates.status
  if (updates.name !== undefined) row.name = updates.name.trim()
  if (updates.targetAmount !== undefined) row.target_amount = Number(updates.targetAmount) || 0
  if (updates.completedAt !== undefined) row.completed_at = updates.completedAt
  const { data, error } = await supabase.from('trade_up_goals').update(row)
    .eq('id', goalId).eq('user_id', userId).select('*, goal_ledger(*)').single()
  if (error) throw error
  return normalizeGoal(data)
}

export async function deleteGoal(userId, goalId) {
  const { error } = await supabase.rpc('delete_trade_up_goal', { p_goal_id: goalId })
  if (error) throw error
}

export async function adjustGoalBalance(goalId, type, amount, note, mutationId = createMutationId()) {
  const { data, error } = await supabase.rpc('adjust_trade_up_goal', {
    p_goal_id: goalId,
    p_type: type,
    p_amount: Number(amount),
    p_note: note || null,
    p_mutation_id: mutationId,
  })
  if (error) throw error
  return data
}

export async function recordProjectSale(userId, project, salePrice, keepAmount) {
  const { error } = await supabase.rpc('record_trade_up_sale', {
    p_project_id: project.id,
    p_sale_price: Number(salePrice),
    p_keep_amount: Number(keepAmount),
  })
  if (error) throw error
}

export async function recordDirectTrade(userId, outgoing, trade) {
  const { data: incomingId, error } = await supabase.rpc('record_trade_up_direct_trade', {
    p_outgoing_id: outgoing.id,
    p_incoming_title: trade.incomingTitle,
    p_category: trade.category || 'other',
    p_trade_credit: Number(trade.tradeCredit) || 0,
    p_cash_direction: trade.cashDirection,
    p_cash_amount: Number(trade.cashAmount) || 0,
    p_goal_cash: Number(trade.goalCashAmount) || 0,
    p_keep_cash: Number(trade.keepCashAmount) || 0,
    p_notes: trade.notes || null,
    p_mutation_id: trade.mutationId || createMutationId(),
  })
  if (error) throw error
  return getProject(userId, incomingId)
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
    goalId: p.goal_id,
    goalFundingAmount: p.goal_funding_amount,
    outOfPocketAmount: p.out_of_pocket_amount,
    tradeCreditAmount: p.trade_credit_amount,
    tradedFromProjectId: p.traded_from_project_id,
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
  if (data.goalId !== undefined) row.goal_id = data.goalId || null
  if (data.goalFundingAmount !== undefined) row.goal_funding_amount = Number(data.goalFundingAmount) || 0
  if (data.outOfPocketAmount !== undefined) row.out_of_pocket_amount = Number(data.outOfPocketAmount) || 0
  if (data.tradeCreditAmount !== undefined) row.trade_credit_amount = Number(data.tradeCreditAmount) || 0
  if (data.tradedFromProjectId !== undefined) row.traded_from_project_id = data.tradedFromProjectId || null
  return row
}

function normalizeGoal(goal) {
  return {
    id: goal.id,
    userId: goal.user_id,
    name: goal.name,
    goalType: goal.goal_type,
    targetItem: goal.target_item,
    targetAmount: goal.target_amount,
    description: goal.description,
    status: goal.status,
    createdAt: goal.created_at,
    completedAt: goal.completed_at,
    ledger: (goal.goal_ledger || []).map(entry => ({
      id: entry.id,
      goalId: entry.goal_id,
      projectId: entry.project_id,
      type: entry.type,
      amount: entry.amount,
      note: entry.note,
      createdAt: entry.created_at,
    })).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
  }
}
