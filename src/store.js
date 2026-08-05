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
  { value: 'motorcycle', label: '🏍️ Motorcycle' },
  { value: 'atv', label: '🏎️ ATV / Powersports' },
  { value: 'boat', label: '⛵ Boat' },
  { value: 'bicycle', label: '🚲 Bicycle / E-Bike' },
  { value: 'watch', label: '⌚ Watch' },
  { value: 'electronics', label: '📱 Electronics' },
  { value: 'gaming', label: '🎮 Gaming / Console' },
  { value: 'tool', label: '🔧 Tool / Equipment' },
  { value: 'exercise', label: '💪 Exercise Equipment' },
  { value: 'instrument', label: '🎸 Musical Instrument' },
  { value: 'furniture', label: '🪑 Furniture' },
  { value: 'other', label: '📦 Other' },
]

export const EXPENSE_CATEGORIES = [
  { value: 'parts', label: '🔩 Parts', icon: '🔩' },
  { value: 'supplies', label: '🧰 Supplies', icon: '🧰' },
  { value: 'labor', label: '👷 Labor / Service', icon: '👷' },
  { value: 'transport', label: '🚚 Transport', icon: '🚚' },
  { value: 'fees', label: '💳 Fees', icon: '💳' },
  { value: 'other', label: '📦 Other', icon: '📦' },
]

export function categoryIcon(value) {
  return CATEGORIES.find(c => c.value === value)?.label?.split(' ')[0] || '📦'
}

export function expenseIcon(value) {
  return EXPENSE_CATEGORIES.find(c => c.value === value)?.icon || '📦'
}

// Which extra fields to show per category
export function getExtraFields(category) {
  const hasVin    = ['car', 'motorcycle', 'atv'].includes(category)
  const hasHull   = ['boat'].includes(category)
  const hasEngine = ['car', 'mower', 'boat', 'motorcycle', 'atv'].includes(category)
  const hasModel  = ['car', 'mower', 'boat', 'motorcycle', 'atv', 'bicycle',
                     'electronics', 'gaming', 'tool', 'exercise', 'instrument'].includes(category)
  return { hasEngine, hasVin, hasHull, hasModel }
}
