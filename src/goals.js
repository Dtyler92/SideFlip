const finiteNumber = value => {
  const parsed = typeof value === 'string' && value.trim() === '' ? 0 : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
const toCents = value => Math.round((finiteNumber(value) + Number.EPSILON) * 100)
const fromCents = cents => cents / 100
const goalIdOf = value => value?.goalId ?? value?.goal_id ?? null
const purchasePriceOf = value => finiteNumber(value?.purchasePrice ?? value?.purchase_price)
const salePriceOf = value => finiteNumber(value?.salePrice ?? value?.sale_price)
const outOfPocketOf = value => finiteNumber(value?.outOfPocketAmount ?? value?.out_of_pocket_amount)
const targetAmountOf = value => finiteNumber(value?.targetAmount ?? value?.target_amount)
const createdAtOf = value => value?.createdAt ?? value?.created_at

export function normalizeMoney(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error('Amount must be finite')
  return fromCents(Math.round((parsed + Number.EPSILON) * 100))
}

export function validateGoalDraft(goal = {}) {
  const name = String(goal.name || '').trim()
  const goalType = goal.goalType
  const targetItem = goalType === 'item' ? String(goal.targetItem || '').trim() : ''
  const targetAmount = Number(goal.targetAmount)
  const startingAmount = goal.startingAmount === '' || goal.startingAmount == null ? 0 : Number(goal.startingAmount)

  if (!name) throw new Error('Goal name is required')
  if (!['item', 'amount'].includes(goalType)) throw new Error('Goal type must be item or amount')
  if (goalType === 'item' && !targetItem) throw new Error('Target item is required')
  if (!Number.isFinite(targetAmount) || targetAmount <= 0) throw new Error('Target amount must be a finite amount greater than zero')
  if (!Number.isFinite(startingAmount) || startingAmount < 0) throw new Error('Starting amount must be zero or a finite positive amount')

  return {
    name,
    goalType,
    targetItem,
    targetAmount: normalizeMoney(targetAmount),
    startingAmount: normalizeMoney(startingAmount),
    description: String(goal.description || '').trim(),
  }
}

export function shouldShowGoalOnboarding(goals = []) {
  return goals.length === 0
}

export function createMutationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

export function projectInvested(project) {
  const purchase = toCents(purchasePriceOf(project))
  const expenses = (project?.expenses || []).reduce((sum, expense) => sum + toCents(expense.amount), 0)
  return fromCents(purchase + expenses)
}

export function calculateGoalSummary(goal, projects = [], ledger = goal?.ledger || goal?.goal_ledger || []) {
  const id = goal?.id
  const linkedProjects = projects.filter(project => goalIdOf(project) === id)
  const entries = ledger.filter(entry => goalIdOf(entry) === id || goalIdOf(entry) == null)
  const active = linkedProjects.filter(project => project.status === 'active')
  const sold = linkedProjects.filter(project => project.status === 'sold')
  const availableCents = entries.reduce((sum, entry) => sum + toCents(entry.amount), 0)
  const activeValueCents = active.reduce((sum, project) => sum + toCents(projectInvested(project)), 0)
  const progressValueCents = Math.max(0, availableCents + activeValueCents)
  const targetAmountCents = toCents(targetAmountOf(goal))

  const projectOutOfPocketCents = linkedProjects.reduce((sum, project) => sum + toCents(outOfPocketOf(project)), 0)
  const expenseOutOfPocketCents = linkedProjects.reduce(
    (sum, project) => sum + (project.expenses || []).reduce((expenseSum, expense) => expenseSum + toCents(expense.amount), 0),
    0,
  )
  const directPersonalContributionCents = entries
    .filter(entry => entry.type === 'personal_contribution' && finiteNumber(entry.amount) > 0)
    .reduce((sum, entry) => sum + Math.max(0, toCents(entry.amount)), 0)
  const tradeCashOutOfPocketCents = entries
    .filter(entry => entry.type === 'trade_cash_out_of_pocket' && finiteNumber(entry.amount) > 0)
    .reduce((sum, entry) => sum + Math.max(0, toCents(entry.amount)), 0)
  const outOfPocketCents = directPersonalContributionCents + projectOutOfPocketCents + expenseOutOfPocketCents
  const personalContributionsCents = outOfPocketCents + tradeCashOutOfPocketCents

  const realizedProfitCents = sold.reduce(
    (sum, project) => sum + toCents(salePriceOf(project)) - toCents(projectInvested(project)),
    0,
  )
  const grossFlippedCents = sold.reduce((sum, project) => sum + toCents(salePriceOf(project)), 0)
  const goalFundingUsedCents = entries
    .filter(entry => entry.type === 'goal_purchase')
    .reduce((sum, entry) => sum + Math.abs(toCents(entry.amount)), 0)
  const proceedsReinvestedCents = Math.max(0, goalFundingUsedCents - directPersonalContributionCents)
  const takenOutCents = entries
    .filter(entry => entry.type === 'cash_out')
    .reduce((sum, entry) => sum + Math.abs(toCents(entry.amount)), 0)

  const available = fromCents(availableCents)
  const activeValue = fromCents(activeValueCents)
  const progressValue = fromCents(progressValueCents)
  const personalContributions = fromCents(personalContributionsCents)
  const grossFlipped = fromCents(grossFlippedCents)

  return {
    available,
    activeValue,
    progressValue,
    progressPercent: targetAmountCents > 0 ? Math.min(100, Number(((progressValueCents / targetAmountCents) * 100).toFixed(1))) : 0,
    personalContributions,
    personalCashInvested: personalContributions,
    proceedsReinvested: fromCents(proceedsReinvestedCents),
    currentGoalCapital: progressValue,
    totalProjectExpenses: fromCents(expenseOutOfPocketCents),
    realizedProfit: fromCents(realizedProfitCents),
    takenOut: fromCents(takenOutCents),
    outOfPocket: fromCents(outOfPocketCents),
    grossFlipped,
    flipped: grossFlipped,
    activeCount: active.length,
    soldCount: sold.length,
  }
}

export function canCompleteGoal(goal, summary) {
  const targetCents = toCents(targetAmountOf(goal))
  return targetCents > 0 && toCents(summary?.progressValue) >= targetCents
}

export function progressColor(percent) {
  const progress = Math.max(0, Math.min(100, finiteNumber(percent))) / 100
  const start = [0xC8, 0x40, 0x2F]
  const end = [0x2D, 0x7A, 0x4F]
  const channel = index => Math.round(start[index] + ((end[index] - start[index]) * progress))
  return `#${[0, 1, 2].map(index => channel(index).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

export function isGoalLockedAfterProLoss(goal, goals = [], plan) {
  if (plan === 'pro' || goal?.status !== 'active') return false
  const oldestActive = goals
    .filter(candidate => candidate?.status === 'active')
    .slice()
    .sort((left, right) => {
      const leftTime = Date.parse(createdAtOf(left))
      const rightTime = Date.parse(createdAtOf(right))
      const safeLeftTime = Number.isFinite(leftTime) ? leftTime : Number.POSITIVE_INFINITY
      const safeRightTime = Number.isFinite(rightTime) ? rightTime : Number.POSITIVE_INFINITY
      return safeLeftTime - safeRightTime || String(left?.id || '').localeCompare(String(right?.id || ''))
    })[0]
  return Boolean(oldestActive && goal?.id !== oldestActive.id)
}

export function accessibleActiveGoalsAfterProLoss(goals = [], plan) {
  return goals.filter(goal => goal?.status === 'active' && !isGoalLockedAfterProLoss(goal, goals, plan))
}

export function calculateProjectLinkFunding(purchasePrice, goalFunding, availableTowardGoal) {
  for (const value of [purchasePrice, goalFunding, availableTowardGoal]) {
    if (!Number.isFinite(Number(value))) throw new Error('Funding amounts must be finite')
  }
  const purchaseCents = toCents(purchasePrice)
  const fromGoalCents = toCents(goalFunding)
  const availableCents = toCents(availableTowardGoal)
  if (purchaseCents < 0 || fromGoalCents < 0 || availableCents < 0) throw new Error('Funding amounts cannot be negative')
  if (fromGoalCents > purchaseCents) throw new Error('Goal funds used cannot exceed the project purchase price')
  if (fromGoalCents > availableCents) throw new Error('Goal funds used cannot exceed the amount available toward the goal')
  return {
    goalFundingAmount: fromCents(fromGoalCents),
    outOfPocketAmount: fromCents(purchaseCents - fromGoalCents),
  }
}
