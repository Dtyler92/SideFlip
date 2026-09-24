const DEFINITION_AXES = Object.freeze([
  ['miles', ['normal_interval_miles', 'severe_interval_miles', 'first_interval_miles']],
  ['hours', ['normal_interval_hours', 'severe_interval_hours', 'first_interval_hours']],
  ['cycles', ['normal_interval_cycles', 'severe_interval_cycles', 'first_interval_cycles']],
  ['calendar', ['normal_calendar_months', 'severe_calendar_months', 'first_calendar_months']],
])

const DUE_STATE_DIMENSIONS = Object.freeze([
  { field: 'next_due_at', measurement: null, usage: null },
  { field: 'next_due_mileage', measurement: 'miles', usage: 'miles' },
  { field: 'next_due_hours', measurement: 'hours', usage: 'hours' },
  { field: 'next_due_cycles', measurement: 'cycles', usage: 'cycles' },
])

const DISPLAYABLE_DUE_STATUSES = new Set(['overdue', 'due_now', 'due_soon', 'upcoming'])

const hasFiniteValue = value => value !== null
  && value !== undefined
  && value !== ''
  && Number.isFinite(Number(value))

export function getMaintenanceDefinitionAxes(definition = {}) {
  return DEFINITION_AXES
    .filter(([, fields]) => fields.some(field => definition[field] !== null && definition[field] !== undefined))
    .map(([axis]) => axis)
}

export function canCompleteMaintenanceDefinition(definition, item = {}) {
  const measurements = Array.isArray(item?.measurements) ? item.measurements : []
  return getMaintenanceDefinitionAxes(definition)
    .every(axis => axis === 'calendar' || measurements.includes(axis))
}

export function filterActiveDueStates(rows, item = {}) {
  if (!Array.isArray(rows)) return []
  const measurements = Array.isArray(item?.measurements) ? item.measurements : []
  const usage = item?.currentUsage && typeof item.currentUsage === 'object' ? item.currentUsage : {}

  return rows.filter(row => {
    if (!row || typeof row !== 'object' || !DISPLAYABLE_DUE_STATUSES.has(row.due_status)) return false
    const dimensions = DUE_STATE_DIMENSIONS.filter(({ field }) => row[field] !== null && row[field] !== undefined)
    if (dimensions.length === 0) return false
    return dimensions.every(({ field, measurement, usage: usageKey }) => {
      if (field === 'next_due_at') {
        return typeof row[field] === 'string'
          && row[field].trim() !== ''
          && Number.isFinite(Date.parse(row[field]))
      }
      return hasFiniteValue(row[field])
        && measurements.includes(measurement)
        && hasFiniteValue(usage[usageKey])
    })
  })
}

export function dueStateLabel(state) {
  if (state === 'overdue') return 'Overdue'
  if (state === 'due') return 'Due now'
  if (state === 'upcoming') return 'Upcoming'
  return 'Not calculated'
}
