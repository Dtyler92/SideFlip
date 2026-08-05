const number = value => Number(value) || 0
const goalIdOf = value => value?.goalId ?? value?.goal_id ?? null
const purchasePriceOf = value => number(value?.purchasePrice ?? value?.purchase_price)
const salePriceOf = value => number(value?.salePrice ?? value?.sale_price)
const outOfPocketOf = value => number(value?.outOfPocketAmount ?? value?.out_of_pocket_amount)
const targetAmountOf = value => number(value?.targetAmount ?? value?.target_amount)

export function shouldShowGoalOnboarding(goals = []) {
  return goals.length === 0
}

export function createMutationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

export function projectInvested(project) {
  return purchasePriceOf(project) + (project?.expenses || []).reduce((sum, expense) => sum + number(expense.amount), 0)
}

export function calculateGoalSummary(goal, projects = [], ledger = []) {
  const id = goal?.id
  const linkedProjects = projects.filter(project => goalIdOf(project) === id)
  const entries = ledger.filter(entry => goalIdOf(entry) === id)
  const active = linkedProjects.filter(project => project.status === 'active')
  const sold = linkedProjects.filter(project => project.status === 'sold')
  const available = entries.reduce((sum, entry) => sum + number(entry.amount), 0)
  const activeValue = active.reduce((sum, project) => sum + projectInvested(project), 0)
  const progressValue = Math.max(0, available + activeValue)
  const targetAmount = targetAmountOf(goal)

  const personalContributions = linkedProjects.reduce((sum, project) => {
    const expenses = (project.expenses || []).reduce((total, expense) => total + number(expense.amount), 0)
    return sum + outOfPocketOf(project) + expenses
  }, 0) + entries
    .filter(entry => ['personal_contribution', 'trade_cash_out_of_pocket'].includes(entry.type))
    .reduce((sum, entry) => sum + Math.max(0, number(entry.amount)), 0)

  const realizedProfit = sold.reduce((sum, project) => sum + salePriceOf(project) - projectInvested(project), 0)
  const totalProjectExpenses = linkedProjects.reduce((sum, project) => sum + (project.expenses || []).reduce((total, expense) => total + number(expense.amount), 0), 0)
  const goalFundingUsed = entries.filter(entry => entry.type === 'goal_purchase').reduce((sum, entry) => sum + Math.abs(number(entry.amount)), 0)
  const personalGoalCapital = entries.filter(entry => entry.type === 'personal_contribution').reduce((sum, entry) => sum + Math.max(0, number(entry.amount)), 0)
  const proceedsReinvested = Math.max(0, goalFundingUsed - personalGoalCapital)
  const takenOut = entries
    .filter(entry => entry.type === 'cash_out')
    .reduce((sum, entry) => sum + Math.abs(number(entry.amount)), 0)

  return {
    available,
    activeValue,
    progressValue,
    progressPercent: targetAmount > 0 ? Math.min(100, Number(((progressValue / targetAmount) * 100).toFixed(1))) : 0,
    personalContributions,
    personalCashInvested: personalContributions,
    proceedsReinvested,
    currentGoalCapital: progressValue,
    totalProjectExpenses,
    realizedProfit,
    takenOut,
    activeCount: active.length,
    soldCount: sold.length,
  }
}

export function splitSaleProceeds(salePrice, keepAmount) {
  const sale = number(salePrice)
  const keep = number(keepAmount)
  if (sale < 0 || keep < 0 || keep > sale) {
    throw new Error('Amount kept must be between zero and the sale price')
  }
  const entries = [{ type: 'sale_proceeds', amount: sale }]
  const cashOut = sale - keep
  if (cashOut > 0) entries.push({ type: 'cash_out', amount: -cashOut })
  return entries
}

export function calculateTradeBasis({ tradeCredit, cashDirection = 'none', cashAmount = 0 }) {
  const credit = number(tradeCredit)
  const cash = number(cashAmount)
  if (credit < 0 || cash < 0) throw new Error('Trade values cannot be negative')
  if (cashDirection === 'paid') return credit + cash
  if (cashDirection === 'received') return Math.max(0, credit - cash)
  return credit
}

export function calculateProjectLinkFunding(purchasePrice, goalFunding, availableTowardGoal) {
  const purchase = number(purchasePrice)
  const fromGoal = number(goalFunding)
  const available = number(availableTowardGoal)
  if (purchase < 0 || fromGoal < 0) throw new Error('Funding amounts cannot be negative')
  if (fromGoal > purchase) throw new Error('Goal funds used cannot exceed the project purchase price')
  if (fromGoal > available) throw new Error('Goal funds used cannot exceed the amount available toward the goal')
  return {
    goalFundingAmount: fromGoal,
    outOfPocketAmount: purchase - fromGoal,
  }
}
