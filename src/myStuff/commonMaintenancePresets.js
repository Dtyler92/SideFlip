export const COMMON_MAINTENANCE_DISCLAIMER = 'Common starting points — check your owner’s manual.'

export const COMMON_MAINTENANCE_PRESETS = Object.freeze([
  { id:'oil-filter', name:'Oil and filter change', catalogAction:'replace', persistedAction:'service', miles:5000, months:6 },
  { id:'tire-rotation', name:'Tire rotation', catalogAction:'rotate', persistedAction:'service', miles:5000, months:6 },
  { id:'brake-inspection', name:'Brake inspection', catalogAction:'inspect', persistedAction:'inspect', miles:10000, months:12 },
  { id:'brake-fluid', name:'Brake fluid service', catalogAction:'replace', persistedAction:'service', miles:null, months:24 },
  { id:'transmission-fluid', name:'Transmission fluid service', catalogAction:'replace', persistedAction:'service', miles:60000, months:48 },
  { id:'coolant', name:'Coolant service', catalogAction:'replace', persistedAction:'service', miles:60000, months:60 },
  { id:'engine-air-filter', name:'Engine air filter', catalogAction:'replace', persistedAction:'service', miles:30000, months:36 },
  { id:'cabin-air-filter', name:'Cabin air filter', catalogAction:'replace', persistedAction:'service', miles:15000, months:12 },
  { id:'spark-plugs', name:'Spark plugs', catalogAction:'replace', persistedAction:'service', miles:60000, months:60 },
  { id:'battery-inspection', name:'Battery inspection', catalogAction:'inspect', persistedAction:'inspect', miles:null, months:12 },
  { id:'timing-belt-chain-inspection', name:'Timing belt/chain inspection', catalogAction:'inspect', persistedAction:'inspect', miles:60000, months:60 },
])

export function normalizeMaintenanceIdentity(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/&/g, ' and ')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function activeDefinitionMatchesPreset(definition = {}, preset = {}) {
  if (definition.enabled === false) return false
  return normalizeMaintenanceIdentity(definition.name) === normalizeMaintenanceIdentity(preset.name)
    && normalizeMaintenanceIdentity(definition.service_action || 'service') === normalizeMaintenanceIdentity(preset.persistedAction || 'service')
}

export function buildCommonMaintenanceDraft(preset, item = {}) {
  const supportsMiles = Array.isArray(item.measurements) && item.measurements.includes('miles')
  return {
    name:preset.name,
    description:'Common starting point only; edit it for this vehicle and check your owner’s manual.',
    serviceAction:preset.persistedAction,
    dueSemantics:'whichever_first',
    activeProfile:item.usage_profile === 'severe' ? 'severe' : 'normal',
    cadenceAnchor:'last_completion',
    intervals:{ miles:supportsMiles ? preset.miles : null, hours:null, cycles:null },
    calendarMonths:preset.months,
  }
}
