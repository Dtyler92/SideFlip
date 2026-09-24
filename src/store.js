// ── Calculation & formatting helpers ──────────────────────────

export function getTotalInvested(project) {
  const parts = project.expenses.reduce((sum, e) => sum + Number(e.amount), 0)
  return (Number(project.purchasePrice) || 0) + parts
}

export function getProfit(project) {
  if (project.salePrice === null || project.salePrice === undefined) return null
  return Number(project.salePrice) - getTotalInvested(project)
}

export function parseSalePrice(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null
  const salePrice = Number(value)
  return Number.isFinite(salePrice) && salePrice >= 0 ? salePrice : null
}

export function calculateRealizedROI(projects) {
  const soldProjects = projects.filter(project => project.status === 'sold')
  const soldCostBasis = soldProjects.reduce((sum, project) => sum + getTotalInvested(project), 0)
  if (soldProjects.length === 0 || soldCostBasis <= 0) return null

  const realizedProfit = soldProjects.reduce((sum, project) => sum + getProfit(project), 0)
  return (realizedProfit / soldCostBasis) * 100
}

export function fmt(num) {
  return '$' + Number(num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export const CATEGORIES = [
  { value: 'mower', label: '🚜 Lawn Mower' },
  { value: 'car', label: '🚗 Car' },
  { value: 'truck', label: '🛻 Truck' },
  { value: 'motorcycle', label: '🏍️ Motorcycle' },
  { value: 'atv', label: '🏎️ ATV / Powersports' },
  { value: 'side_by_side', label: '🏁 Side-by-side' },
  { value: 'trailer', label: '🚛 Trailer' },
  { value: 'rv', label: '🚐 RV' },
  { value: 'boat', label: '⛵ Boat' },
  { value: 'airplane', label: '✈️ Airplane' },
  { value: 'bicycle', label: '🚲 Bicycle / E-Bike' },
  { value: 'watch', label: '⌚ Watch' },
  { value: 'electronics', label: '📱 Electronics' },
  { value: 'gaming', label: '🎮 Gaming / Console' },
  { value: 'tool', label: '🔧 Tool / Equipment' },
  { value: 'exercise', label: '💪 Exercise Equipment' },
  { value: 'instrument', label: '🎸 Musical Instrument' },
  { value: 'furniture', label: '🪑 Furniture' },
  { value: 'house', label: '🏠 Home Improvement' },
  { value: 'other', label: '📦 Other' },
]

const CATEGORY_VALUES = new Set(CATEGORIES.map(category => category.value))
const PROJECT_CATEGORY_ALIASES = Object.freeze({
  'lawn mower': 'mower',
  lawnmower: 'mower',
  automobile: 'car',
  automotive: 'car',
  'atv powersports': 'atv',
  powersports: 'atv',
  'side by side': 'side_by_side',
  sxs: 'side_by_side',
  'recreational vehicle': 'rv',
  'bicycle e bike': 'bicycle',
  'e bike': 'bicycle',
  ebike: 'bicycle',
  'gaming console': 'gaming',
  'tool equipment': 'tool',
  'exercise equipment': 'exercise',
  'musical instrument': 'instrument',
  'house project': 'house',
  'home improvement': 'house',
})

function normalizeProjectCategory(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  const canonical = key.replace(/ /g, '_')
  return CATEGORY_VALUES.has(canonical) ? canonical : PROJECT_CATEGORY_ALIASES[key] || canonical
}

export const EXPENSE_CATEGORIES = [
  { value: 'parts', label: '🔩 Parts', icon: '🔩' },
  { value: 'supplies', label: '🧰 Supplies', icon: '🧰' },
  { value: 'labor', label: '👷 Labor / Service', icon: '👷' },
  { value: 'transport', label: '🚚 Transport', icon: '🚚' },
  { value: 'fees', label: '💳 Fees', icon: '💳' },
  { value: 'other', label: '📦 Other', icon: '📦' },
]

export function categoryIcon(value) {
  const category = normalizeProjectCategory(value)
  return CATEGORIES.find(c => c.value === category)?.label?.split(' ')[0] || '📦'
}

// before_photo / after_photo are additive fields. photo remains the legacy main image.
export function getProjectPhotoPair(project = {}) {
  const afterPhoto = project.afterPhoto || project.after_photo || null
  const explicitBeforePhoto = project.beforePhoto || project.before_photo || null
  return {
    beforePhoto: explicitBeforePhoto || (afterPhoto ? null : project.photo || null),
    afterPhoto,
  }
}

export function shouldDeleteReplacedProjectPhoto(project = {}, replacedSlot, previousPhoto) {
  if (!previousPhoto) return false
  const { beforePhoto, afterPhoto } = getProjectPhotoPair(project)
  const retainedPhotos = [
    replacedSlot === 'before' ? afterPhoto : beforePhoto,
    ...(Array.isArray(project.photos) ? project.photos : []),
  ]
  return !retainedPhotos.includes(previousPhoto)
}

export function expenseIcon(value) {
  return EXPENSE_CATEGORIES.find(c => c.value === value)?.icon || '📦'
}

// Which extra fields to show per category
export function getExtraFields(category) {
  const normalized = normalizeProjectCategory(category)
  const hasVehicleDetails = ['car', 'truck', 'motorcycle', 'atv', 'side_by_side', 'trailer', 'rv'].includes(normalized)
  const hasVin = hasVehicleDetails
  const hasHull = normalized === 'boat'
  const hasEngine = hasVehicleDetails || ['mower', 'boat', 'airplane'].includes(normalized)
  // Android exposes model and serial identification for every selected category.
  // Keep it available for unknown legacy values so existing identifiers remain visible.
  const hasModel = Boolean(normalized)
  return { hasEngine, hasVin, hasHull, hasModel, hasVehicleDetails }
}
