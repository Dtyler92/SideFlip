import { adaptItemDraftToSql, adaptItemPatchToSql, toSqlUsageDimension } from './adapters.js'
export const buildCreateMyStuffItemV2WirePayload=(values={})=>({p_item:adaptItemDraftToSql(values)})
export const buildUpdateMyStuffItemV2WirePayload=(values={})=>({p_item_id:values.itemId,p_patch:adaptItemPatchToSql(values)})
export const buildRecordMyStuffReadingV2WirePayload=(values={})=>({p_item_id:values.itemId,p_reading_type:toSqlUsageDimension(values.readingType),p_value:values.value,p_recorded_at:values.recordedAt,p_corrects_reading_id:values.correctsReadingId||null,p_correction_reason:values.correctionReason?.trim()||null,p_metadata:values.metadata||{}})

const MAINTENANCE_AXIS_FIELDS = Object.freeze({
  miles: 'normal_interval_miles',
  hours: 'normal_interval_hours',
  cycles: 'normal_interval_cycles',
})

function compactText(value) {
  if (value === undefined) return undefined
  const trimmed = String(value ?? '').trim()
  return trimmed || null
}

function finiteNumberOrNull(value) {
  if (value === null || String(value ?? '').trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function buildMaintenanceDefinition(values, { patch = false } = {}) {
  const definition = {}
  const textFields = [
    ['name', 'name'], ['description', 'description'], ['serviceCategory', 'service_category'],
    ['serviceAction', 'service_action'], ['dueSemantics', 'due_semantics'],
    ['activeProfile', 'active_profile'], ['cadenceAnchor', 'cadence_anchor'],
  ]
  for (const [input, output] of textFields) {
    if (Object.prototype.hasOwnProperty.call(values, input)) definition[output] = compactText(values[input])
  }
  if (!patch) {
    definition.service_category ??= 'other'
    definition.service_action ??= 'service'
    definition.due_semantics ??= 'whichever_first'
    definition.active_profile ??= 'normal'
    definition.cadence_anchor ??= 'last_completion'
  }
  if (Object.prototype.hasOwnProperty.call(values, 'intervals')) {
    const intervals = values.intervals || {}
    for (const [axis, field] of Object.entries(MAINTENANCE_AXIS_FIELDS)) {
      const number = finiteNumberOrNull(intervals[axis])
      if (patch || number !== null) definition[field] = number
    }
  }
  if (Object.prototype.hasOwnProperty.call(values, 'calendarMonths')) {
    const months = finiteNumberOrNull(values.calendarMonths)
    if (patch || months !== null) definition.normal_calendar_months = months
  }
  if (Object.prototype.hasOwnProperty.call(values, 'enabled')) definition.enabled = Boolean(values.enabled)
  else if (!patch) definition.enabled = true
  return definition
}

export function buildCreateMaintenanceDefinitionV2WirePayload(values = {}) {
  return {
    p_item_id: values.itemId,
    p_definition: buildMaintenanceDefinition(values),
  }
}

export function buildUpdateMaintenanceDefinitionV2WirePayload(values = {}) {
  return {
    p_definition_id: values.definitionId,
    p_definition: buildMaintenanceDefinition(values, { patch: true }),
  }
}

export function buildRecordServiceOccurrenceV2WirePayload(values = {}) {
  const service = { completed_at: values.completedAt }
  const readings = values.readings || {}
  const configured = new Set(values.configuredAxes || Object.keys(readings))
  for (const [axis, sqlAxis] of Object.entries({ miles: 'mileage', hours: 'hours', cycles: 'cycles' })) {
    if (!configured.has(axis)) continue
    const number = finiteNumberOrNull(readings[axis])
    if (number !== null) service[sqlAxis] = number
  }
  const notes = compactText(values.notes)
  if (notes) service.notes = notes
  return {
    p_item_id: values.itemId,
    p_definition_id: values.definitionId || null,
    p_service: service,
  }
}
