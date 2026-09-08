import { centsToAmount, projectProfitCents } from './projectParity.js'

const number = value => Number(value) || 0
const storedAmountToCents = value => {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0
}
const salePrice = project => project?.salePrice ?? project?.sale_price
const laborHours = expense => expense?.laborHours ?? expense?.labor_hours

export function calculatePortfolioMetrics(projects = []) {
  const sold = projects.filter(project => project?.status === 'sold')
  const totalProfitCents = sold.reduce((sum, project) => sum + (projectProfitCents(project) || 0), 0)
  const totalRevenueCents = sold.reduce((sum, project) => sum + storedAmountToCents(salePrice(project)), 0)
  const trackedLabor = sold
    .map(project => ({
      project,
      hours: (project.expenses || []).reduce((total, expense) => total + number(laborHours(expense)), 0),
    }))
    .filter(item => item.hours > 0)
  const laborProfitCents = trackedLabor.reduce((sum, item) => sum + (projectProfitCents(item.project) || 0), 0)
  const totalLaborHours = trackedLabor.reduce((sum, item) => sum + item.hours, 0)
  const totalProfit = centsToAmount(totalProfitCents)

  return {
    totalProfit,
    totalRevenue: centsToAmount(totalRevenueCents),
    avgProfit: sold.length > 0 ? totalProfit / sold.length : 0,
    totalLaborHours,
    hourlyEarnings: totalLaborHours > 0 ? centsToAmount(laborProfitCents) / totalLaborHours : null,
  }
}

export function formatLaborHours(hours) {
  return number(hours).toLocaleString('en-US', { maximumFractionDigits: 2 })
}
