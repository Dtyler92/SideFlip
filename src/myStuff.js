import { supabase } from './supabase'

export const MY_STUFF_TYPES = [
  ['car', 'Car'], ['truck', 'Truck'], ['motorcycle', 'Motorcycle'], ['boat', 'Boat'],
  ['airplane', 'Airplane'], ['atv', 'ATV'], ['side_by_side', 'Side-by-side'], ['mower', 'Mower'],
  ['tractor', 'Tractor'], ['trailer', 'Trailer'], ['generator', 'Generator'], ['rv', 'RV'],
  ['equipment', 'Equipment'], ['bicycle', 'Bicycle'], ['watch', 'Watch'], ['electronics', 'Electronics'],
  ['gaming', 'Gaming'], ['tool', 'Tool'], ['exercise', 'Exercise equipment'], ['instrument', 'Instrument'],
  ['furniture', 'Furniture'], ['house', 'House'], ['other', 'Other'],
]

export const READING_TYPES = [
  ['mileage', 'Mileage'], ['hours', 'Hours'], ['cycles', 'Cycles'],
]

const USAGE_REQUIRED_TYPES = new Set([
  'car', 'truck', 'motorcycle', 'boat', 'airplane', 'atv', 'side_by_side', 'mower',
  'tractor', 'trailer', 'generator', 'rv', 'equipment', 'bicycle', 'exercise',
])

export function createMutationId(prefix = 'pwa') {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}:${id}`
}

export function requiresUsage(itemType) {
  return USAGE_REQUIRED_TYPES.has(itemType)
}

export function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== '' && entry !== null && entry !== undefined))
}

function throwIf(error) {
  if (error) throw error
}

export async function getMaintenanceRollout() {
  const { data, error } = await supabase.rpc('get_my_stuff_integrity_rollout_v4')
  if (error) {
    if (error.code === 'PGRST202') {
      return { feature_enabled: false, phase: 'legacy' }
    }
    throw error
  }
  if (!data || typeof data !== 'object' || typeof data.feature_enabled !== 'boolean') {
    throw new Error('Invalid maintenance rollout response.')
  }
  return data
}

export async function listMyStuffItems(userId) {
  const { data, error } = await supabase
    .from('my_stuff_items')
    .select('id,name,item_type,category,model_year,make,model,trim,vin,vin_confirmed_at,usage_dimensions,current_mileage,current_hours,current_cycles,effective_current_mileage,effective_current_hours,effective_current_cycles,archived_at,created_at')
    .eq('user_id', userId)
    .is('archived_at', null)
    .order('created_at', { ascending: false })
  throwIf(error)
  return data || []
}

export async function decodeMyStuffVin(itemId, vin) {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
  throwIf(sessionError)
  const token = sessionData.session?.access_token
  if (!token) throw new Error('Sign in again before decoding a VIN.')
  const response = await fetch('/api/decode-vin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ vin: vin.trim().toUpperCase(), subjectType: 'my_stuff_item', subjectId: itemId }),
  })
  const decoded = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(decoded.error?.message || decoded.error || 'VIN decoding failed.')
  return { vehicle: decoded.vehicle || {}, warnings: decoded.nhtsaWarnings || [] }
}

export async function confirmMyStuffVin(itemId, vin, vehicle, mutationId) {
  const identity = compactObject({
    vin: vin.trim().toUpperCase(), model_year: vehicle.modelYear, manufacturer: vehicle.manufacturer,
    make: vehicle.make, model: vehicle.model, series: vehicle.series, trim: vehicle.trim,
    engine: vehicle.engine, engine_model: vehicle.engineModel, engine_displacement_liters: vehicle.displacementLiters,
    engine_cylinders: vehicle.engineCylinders, transmission: vehicle.transmissionStyle, drivetrain: vehicle.driveType,
    fuel_power_type: vehicle.fuelTypePrimary, vehicle_type: vehicle.vehicleType, body_style: vehicle.bodyClass,
    plant_name: vehicle.plantName, plant_country: vehicle.plantCountry, vehicle_market: 'US',
    vin_decoder_source: 'NHTSA vPIC', vin_decoder_version: 'v1',
  })
  const { data, error } = await supabase.rpc('confirm_my_stuff_vehicle_identity_v3', {
    p_item_id: itemId, p_identity: identity, p_mutation_id: mutationId,
  })
  throwIf(error)
  return data
}

export async function createMyStuffItem(form, mutationId) {
  const usage = form.usageType ? [form.usageType] : []
  const readingField = form.usageType ? { [`current_${form.usageType}`]: Number(form.currentReading) } : {}
  const item = compactObject({
    name: form.name.trim(),
    item_type: form.itemType,
    category: form.itemType,
    usage_dimensions: usage,
    purchase_price: form.purchasePrice === '' ? undefined : Number(form.purchasePrice),
    purchase_currency: 'USD',
    model_year: form.modelYear === '' ? undefined : Number(form.modelYear),
    make: form.make.trim(),
    model: form.model.trim(),
    notes: form.notes.trim(),
    ...readingField,
  })
  const { data, error } = await supabase.rpc('create_my_stuff_item_v2', {
    p_item: item,
    p_mutation_id: mutationId,
  })
  throwIf(error)
  return data
}

export async function loadMyStuffWorkspace(itemId, v4Enabled) {
  const [definitionsResult, plansResult, historyResult] = await Promise.all([
    supabase.from('my_stuff_maintenance_definitions')
      .select('id,name,description,service_action,normal_interval_miles,normal_interval_hours,normal_interval_cycles,normal_calendar_months,enabled,lifecycle_state,created_at')
      .eq('item_id', itemId).eq('enabled', true).order('created_at', { ascending: false }),
    supabase.from('my_stuff_planned_occurrences')
      .select('id,definition_id,status,due_at,due_mileage,due_hours,due_cycles,created_at')
      .eq('item_id', itemId).neq('status', 'completed').order('created_at', { ascending: false }),
    v4Enabled
      ? supabase.rpc('get_my_stuff_maintenance_report_v4', { p_item_id: itemId, p_limit: 100 })
      : supabase.from('my_stuff_service_occurrences')
        .select('id,definition_id,service_name,completed_at,mileage,hours,cycles,created_at')
        .eq('item_id', itemId).order('completed_at', { ascending: false }).limit(100),
  ])
  throwIf(definitionsResult.error)
  throwIf(plansResult.error)
  throwIf(historyResult.error)

  const definitions = definitionsResult.data || []
  let states = []
  if (v4Enabled) {
    for (let index = 0; index < definitions.length; index += 6) {
      const batch = await Promise.all(definitions.slice(index, index + 6).map(async definition => {
        const { data, error } = await supabase.rpc('get_my_stuff_maintenance_state_v4', { p_definition_id: definition.id })
        throwIf(error)
        return data
      }))
      states.push(...batch)
    }
  } else {
    const { data, error } = await supabase.rpc('get_my_stuff_due_state_v2', { p_item_id: itemId, p_as_of: new Date().toISOString() })
    throwIf(error)
    states = data || []
  }

  const plansByDefinition = new Map()
  for (const plan of plansResult.data || []) {
    if (!plansByDefinition.has(plan.definition_id)) plansByDefinition.set(plan.definition_id, plan)
  }
  const stateByDefinition = new Map(states.map(state => [state.definition_id, state]))
  return {
    definitions: definitions.map(definition => ({
      ...definition,
      state: stateByDefinition.get(definition.id) || null,
      plan: plansByDefinition.get(definition.id) || null,
    })),
    history: v4Enabled
      ? (historyResult.data?.completions || []).map(entry => ({
        id: entry.occurrence_id,
        service_name: entry.original?.service_name,
        original: entry.original,
        historical_locked_from_window_edit: entry.historical_locked_from_window_edit,
        correction_chain: entry.correction_chain || [],
        effective_snapshot_sha256: entry.effective_snapshot_sha256,
        ...entry.effective,
      }))
      : (historyResult.data || []),
    report: v4Enabled ? historyResult.data : null,
  }
}

export async function recordMyStuffReading(item, readingType, value, v4Enabled, mutationId) {
  const numeric = Number(value)
  if (v4Enabled) {
    const mileage = readingType === 'mileage'
    const { data, error } = await supabase.rpc(mileage ? 'record_my_stuff_current_mileage_v4' : 'record_my_stuff_current_reading_v4', mileage ? {
      p_item_id: item.id, p_current_mileage: numeric, p_device_now: new Date().toISOString(), p_mutation_id: mutationId,
    } : {
      p_item_id: item.id, p_reading_type: readingType, p_current_value: numeric, p_device_now: new Date().toISOString(), p_mutation_id: mutationId,
    })
    throwIf(error)
    return data
  }
  const { data, error } = await supabase.rpc('record_my_stuff_reading_v2', {
    p_item_id: item.id,
    p_reading_type: readingType,
    p_value: numeric,
    p_recorded_at: new Date().toISOString(),
    p_corrects_reading_id: null,
    p_correction_reason: null,
    p_metadata: { source: 'pwa' },
    p_mutation_id: mutationId,
  })
  throwIf(error)
  return data
}

export async function createMaintenanceTask(item, form, v4Enabled, mutationId) {
  const definition = compactObject({
    name: form.name.trim(),
    description: form.description.trim(),
    service_category: 'maintenance',
    service_action: form.action,
    due_semantics: 'whichever_first',
    active_profile: 'normal',
    cadence_anchor: 'last_completion',
    normal_interval_miles: form.intervalMiles === '' ? undefined : Number(form.intervalMiles),
    normal_interval_hours: form.intervalHours === '' ? undefined : Number(form.intervalHours),
    normal_interval_cycles: form.intervalCycles === '' ? undefined : Number(form.intervalCycles),
    normal_calendar_months: form.intervalMonths === '' ? undefined : Number(form.intervalMonths),
    due_soon_miles: 500,
    due_soon_hours: 10,
    due_soon_cycles: 10,
    due_soon_days: 30,
    uncertain: false,
    enabled: true,
  })

  if (v4Enabled) {
    const setup = compactObject({
      last_service_performed_on: form.lastServiceDate,
      last_service_mileage: form.lastServiceMileage === '' ? undefined : Number(form.lastServiceMileage),
      last_service_hours: form.lastServiceHours === '' ? undefined : Number(form.lastServiceHours),
      last_service_cycles: form.lastServiceCycles === '' ? undefined : Number(form.lastServiceCycles),
      current_mileage: form.currentMileage === '' ? undefined : Number(form.currentMileage),
    })
    const { data, error } = await supabase.rpc('setup_my_stuff_maintenance_preset_v4', {
      p_item_id: item.id,
      p_definition: definition,
      p_setup: setup,
      p_device_now: new Date().toISOString(),
      p_mutation_id: mutationId,
    })
    throwIf(error)
    return data
  }
  const { data, error } = await supabase.rpc('create_my_stuff_custom_task_v3', {
    p_item_id: item.id,
    p_definition: definition,
    p_mutation_id: mutationId,
  })
  throwIf(error)
  return data
}

export async function completeMaintenance(item, definition, form, v4Enabled, mutationId) {
  if (v4Enabled) {
    const completion = compactObject({
      service_performed_on: form.serviceDate,
      service_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      service_mileage: form.mileage === '' ? undefined : Number(form.mileage),
      service_hours: form.hours === '' ? undefined : Number(form.hours),
      service_cycles: form.cycles === '' ? undefined : Number(form.cycles),
      current_mileage: form.currentMileage === '' ? undefined : Number(form.currentMileage),
      current_hours: form.currentHours === '' ? undefined : Number(form.currentHours),
      current_cycles: form.currentCycles === '' ? undefined : Number(form.currentCycles),
      notes: form.notes.trim(),
      parts: [], labor: [], vendor: {}, warranty: {}, attachment_metadata: [],
      planned_occurrence_id: definition.plan?.id,
      expense: form.expenseAmount === '' ? undefined : compactObject({
        description: form.expenseDescription.trim() || definition.name,
        amount: Number(form.expenseAmount),
        category: 'maintenance',
        currency: 'USD',
        incurred_on: form.serviceDate,
      }),
    })
    const { data, error } = await supabase.rpc('complete_my_stuff_maintenance_v4', {
      p_definition_id: definition.id,
      p_completion: completion,
      p_device_now: new Date().toISOString(),
      p_mutation_id: mutationId,
    })
    throwIf(error)
    return data
  }
  const service = compactObject({
    service_name: definition.name,
    service_category: 'maintenance',
    service_action: definition.service_action || 'service',
    completed_at: `${form.serviceDate}T12:00:00.000Z`,
    mileage: form.mileage === '' ? undefined : Number(form.mileage),
    hours: form.hours === '' ? undefined : Number(form.hours),
    cycles: form.cycles === '' ? undefined : Number(form.cycles),
    notes: form.notes.trim(),
    parts: [], labor: [], vendor: {}, warranty: {}, attachment_metadata: [],
  })
  const rpc = definition.plan?.id ? 'complete_my_stuff_planned_occurrence_v3' : 'record_my_stuff_service_with_expense_v3'
  const args = definition.plan?.id
    ? { p_occurrence_id: definition.plan.id, p_service: service, p_expense: null, p_mutation_id: mutationId }
    : { p_item_id: item.id, p_planned_occurrence_id: null, p_definition_id: definition.id, p_service: service, p_expense: null, p_mutation_id: mutationId }
  if (form.expenseAmount !== '') {
    args.p_expense = compactObject({
      description: form.expenseDescription.trim() || definition.name,
      amount: Number(form.expenseAmount),
      category: 'maintenance',
      currency: 'USD',
      incurred_on: form.serviceDate,
    })
  }
  const { data, error } = await supabase.rpc(rpc, args)
  throwIf(error)
  return data
}

export async function correctMaintenanceCompletion(entry, form, mutationId) {
  const patch = compactObject({
    service_performed_on: form.serviceDate,
    service_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    service_mileage: form.mileage === '' ? undefined : Number(form.mileage),
    service_hours: form.hours === '' ? undefined : Number(form.hours),
    service_cycles: form.cycles === '' ? undefined : Number(form.cycles),
    current_mileage: form.currentMileage === '' ? undefined : Number(form.currentMileage),
    current_hours: form.currentHours === '' ? undefined : Number(form.currentHours),
    current_cycles: form.currentCycles === '' ? undefined : Number(form.currentCycles),
    notes: form.notes.trim(),
  })
  const windowEdit = !entry.historical_locked_from_window_edit && entry.original?.lock_deadline && Date.now() < new Date(entry.original.lock_deadline).getTime()
  const { data, error } = await supabase.rpc(windowEdit ? 'edit_my_stuff_completion_v4' : 'correct_my_stuff_completion_v4', {
    p_occurrence_id: entry.id,
    p_patch: patch,
    p_reason: form.reason.trim() || null,
    p_expected_revision: entry.correction_chain.length,
    p_expected_snapshot_hash: entry.effective_snapshot_sha256,
    p_device_now: new Date().toISOString(),
    p_mutation_id: mutationId,
  })
  throwIf(error)
  return data
}

export async function getMyStuffDeletionStatus(requestId) {
  const { data, error } = await supabase.rpc('get_my_stuff_deletion_status_v4', { p_request_id: requestId })
  throwIf(error)
  return data
}

export async function requestMyStuffItemDeletion(itemId, mutationId) {
  const { data, error } = await supabase.rpc('request_my_stuff_deletion_v4', {
    p_object_type: 'item',
    p_object_id: itemId,
    p_mutation_id: mutationId,
  })
  throwIf(error)
  return data
}

export function readingValue(item, readingType) {
  return item[`effective_current_${readingType}`] ?? item[`current_${readingType}`] ?? null
}

export function describeDue(state) {
  if (!state) return 'Schedule pending'
  const parts = []
  const date = state.next_due_date || state.next_due_at
  if (date) parts.push(`by ${new Date(date).toLocaleDateString()}`)
  if (state.next_due_mileage != null) parts.push(`at ${Number(state.next_due_mileage).toLocaleString()} mi`)
  if (state.next_due_hours != null) parts.push(`at ${Number(state.next_due_hours).toLocaleString()} hr`)
  if (state.next_due_cycles != null) parts.push(`at ${Number(state.next_due_cycles).toLocaleString()} cycles`)
  return parts.join(' · ') || 'Schedule pending'
}
