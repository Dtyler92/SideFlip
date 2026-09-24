export const MAINTENANCE_PRESET_DISCLAIMER = 'Common starting points — check your owner’s manual.'

export const MAINTENANCE_PRESETS = Object.freeze([
  { id: 'oil-filter', name: 'Oil and filter change', catalogAction: 'replace', persistedAction: 'service', miles: 5000, months: 6 },
  { id: 'tire-rotation', name: 'Tire rotation', catalogAction: 'rotate', persistedAction: 'service', miles: 5000, months: 6 },
  { id: 'brake-inspection', name: 'Brake inspection', catalogAction: 'inspect', persistedAction: 'inspect', miles: 10000, months: 12 },
  { id: 'brake-fluid', name: 'Brake fluid service', catalogAction: 'replace', persistedAction: 'service', miles: null, months: 24 },
  { id: 'transmission-fluid', name: 'Transmission fluid service', catalogAction: 'replace', persistedAction: 'service', miles: 60000, months: 48 },
  { id: 'coolant', name: 'Coolant service', catalogAction: 'replace', persistedAction: 'service', miles: 60000, months: 60 },
  { id: 'engine-air-filter', name: 'Engine air filter', catalogAction: 'replace', persistedAction: 'service', miles: 30000, months: 36 },
  { id: 'cabin-air-filter', name: 'Cabin air filter', catalogAction: 'replace', persistedAction: 'service', miles: 15000, months: 12 },
  { id: 'spark-plugs', name: 'Spark plugs', catalogAction: 'replace', persistedAction: 'service', miles: 60000, months: 60 },
  { id: 'battery-inspection', name: 'Battery inspection', catalogAction: 'inspect', persistedAction: 'inspect', miles: null, months: 12 },
  { id: 'timing-belt-chain-inspection', name: 'Timing belt/chain inspection', catalogAction: 'inspect', persistedAction: 'inspect', miles: 60000, months: 60 },
  { id: 'fuel-filter', name: 'Fuel filter', catalogAction: 'replace', persistedAction: 'service', miles: 30000, months: 36 },
])

export function presetTaskDraft(preset, item) {
  const tracksMiles = (item.usage_dimensions || []).includes('mileage')
  return {
    name: preset.name,
    action: preset.persistedAction,
    intervalMiles: tracksMiles && preset.miles != null ? String(preset.miles) : '',
    intervalHours: '', intervalCycles: '', intervalMonths: String(preset.months),
    lastServiceDate: '', lastServiceMileage: '', lastServiceHours: '', lastServiceCycles: '',
    currentMileage: tracksMiles ? String(item.effective_current_mileage ?? item.current_mileage ?? '') : '',
  }
}
