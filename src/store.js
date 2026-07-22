// Local storage helpers — no backend needed for V1
const STORAGE_KEY = 'flipledger_projects'

export function getProjects() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
  } catch { return [] }
}

export function saveProjects(projects) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects))
}

export function getProject(id) {
  return getProjects().find(p => p.id === id) || null
}

export function createProject(data) {
  const projects = getProjects()
  const project = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'active', // active | sold
    expenses: [],
    salePrice: null,
    soldAt: null,
    ...data
  }
  projects.unshift(project)
  saveProjects(projects)
  return project
}

export function updateProject(id, updates) {
  const projects = getProjects().map(p => p.id === id ? { ...p, ...updates } : p)
  saveProjects(projects)
}

export function deleteProject(id) {
  saveProjects(getProjects().filter(p => p.id !== id))
}

export function addExpense(projectId, expense) {
  const projects = getProjects().map(p => {
    if (p.id !== projectId) return p
    return {
      ...p,
      expenses: [...p.expenses, {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        ...expense
      }]
    }
  })
  saveProjects(projects)
}

export function deleteExpense(projectId, expenseId) {
  const projects = getProjects().map(p => {
    if (p.id !== projectId) return p
    return { ...p, expenses: p.expenses.filter(e => e.id !== expenseId) }
  })
  saveProjects(projects)
}

export function getTotalInvested(project) {
  const parts = project.expenses.reduce((sum, e) => sum + Number(e.amount), 0)
  return (Number(project.purchasePrice) || 0) + parts
}

export function getProfit(project) {
  if (!project.salePrice) return null
  return Number(project.salePrice) - getTotalInvested(project)
}

export function getROI(project) {
  const invested = getTotalInvested(project)
  const profit = getProfit(project)
  if (!profit || !invested) return null
  return ((profit / invested) * 100).toFixed(1)
}

export function fmt(num) {
  return '$' + Number(num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export const CATEGORIES = [
  { value: 'mower', label: '🌿 Lawn Mower' },
  { value: 'watch', label: '⌚ Watch' },
  { value: 'car', label: '🚗 Car' },
  { value: 'boat', label: '⛵ Boat' },
  { value: 'tool', label: '🔧 Tool / Equipment' },
  { value: 'electronics', label: '📱 Electronics' },
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
