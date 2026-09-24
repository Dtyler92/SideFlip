export const DEAL_RATING_THRESHOLDS = Object.freeze({
  great: Object.freeze({ minRoiPct: 50, minProfit: 200 }),
  good: Object.freeze({ minRoiPct: 25, minProfit: 100 }),
  marginal: Object.freeze({ minRoiPct: 10, minProfit: 50 }),
})
export const MINIMUM_OFFER_LIST_PRICE_RATIO = 0.92
export const MAX_CURRENCY_AMOUNT = 1_000_000_000
export const MAX_ROI_PERCENT = 500
export const MAX_PLATFORM_FEE_PERCENT = 99.99

const finite = value => {
  const number = typeof value === 'string' ? Number(value.trim()) : Number(value)
  return Number.isFinite(number) ? number : 0
}
const round = (value, places = 2) => {
  const factor = 10 ** places
  return Math.round((value + Number.EPSILON) * factor) / factor
}
const toCents = value => Math.round(Math.min(MAX_CURRENCY_AMOUNT, Math.max(0, finite(value))) * 100)
const fromCents = value => round(value / 100)
const amount = value => fromCents(toCents(value))
const percent = value => Math.min(MAX_PLATFORM_FEE_PERCENT, Math.max(0, finite(value)))
const percentOfCents = (cents, pct) => Math.round(cents * percent(pct) / 100)

function grossUpCents(netCents, pct) {
  const feePct = percent(pct)
  let cents = Math.max(0, Math.floor(netCents / (1 - feePct / 100)))
  while (cents - percentOfCents(cents, feePct) < netCents) cents += 1
  while (cents > 0 && cents - 1 - percentOfCents(cents - 1, feePct) >= netCents) cents -= 1
  return cents
}

export const normalizeCurrencyAmount = amount

export function rateDeal({ expectedProfit, roiPct, totalInvestment = null }, thresholds = DEAL_RATING_THRESHOLDS) {
  const profit = finite(expectedProfit)
  const roi = roiPct == null ? null : finite(roiPct)
  const zeroCost = totalInvestment != null && toCents(totalInvestment) === 0
  if (profit < 0) return { dealRating: 'LOSS', ratingTone: 'negative', ratingExplanation: 'This deal is projected to lose money based on your estimates.' }
  if (profit === 0) return { dealRating: 'LOW MARGIN', ratingTone: 'caution', ratingExplanation: 'This deal is projected to break even, leaving no cushion for surprises.' }
  if (zeroCost) return { dealRating: 'GREAT FLIP', ratingTone: 'strong', ratingExplanation: 'No cost basis is entered, so ROI is unavailable; the positive projected profit makes this a strong opportunity if the estimates hold.' }
  if (roi >= thresholds.great.minRoiPct && profit >= thresholds.great.minProfit) return { dealRating: 'GREAT FLIP', ratingTone: 'strong', ratingExplanation: 'This deal appears to have a strong projected return based on your estimates.' }
  if (roi >= thresholds.good.minRoiPct && profit >= thresholds.good.minProfit) return { dealRating: 'GOOD FLIP', ratingTone: 'positive', ratingExplanation: 'This deal appears to have a solid projected return based on your estimates.' }
  if (roi >= thresholds.marginal.minRoiPct && profit >= thresholds.marginal.minProfit) return { dealRating: 'MARGINAL', ratingTone: 'caution', ratingExplanation: 'This deal may work, but the projected cushion is limited.' }
  return { dealRating: 'LOW MARGIN', ratingTone: 'caution', ratingExplanation: `This deal misses the minimum ${thresholds.marginal.minRoiPct}% ROI or ${thresholds.marginal.minProfit} profit threshold.` }
}

export function analyzeDeal(input = {}) {
  const purchaseCents = toCents(input.purchasePrice)
  const expenseCents = ['repairsMaterials', 'parts', 'fuelTravel', 'shippingCost', 'otherExpenses'].reduce((sum, key) => sum + toCents(input[key]), 0)
  const totalInvestmentCents = purchaseCents + expenseCents
  const saleCents = toCents(input.expectedSellingPrice)
  const platformCents = percentOfCents(saleCents, input.platformFeePct)
  const fixedSellingCents = toCents(input.sellerPaidShipping) + toCents(input.salesTaxOtherFees)
  const sellingCents = platformCents + fixedSellingCents
  const profitCents = saleCents - totalInvestmentCents - sellingCents
  const roiPct = totalInvestmentCents > 0 ? round(profitCents / totalInvestmentCents * 100) : null
  const profitMarginPct = saleCents > 0 ? round(profitCents / saleCents * 100) : null
  const maximumPurchaseCents = saleCents - expenseCents - sellingCents - toCents(input.desiredMinimumProfit)
  const core = {
    totalInvestment: fromCents(totalInvestmentCents), expectedRevenue: fromCents(saleCents),
    platformFees: fromCents(platformCents), totalSellingCosts: fromCents(sellingCents),
    expectedProfit: fromCents(profitCents), profitMarginPct, roiPct,
    breakEvenSellingPrice: fromCents(grossUpCents(totalInvestmentCents + fixedSellingCents, input.platformFeePct)),
    maximumPurchasePrice: fromCents(Math.max(0, maximumPurchaseCents)),
  }
  return { ...core, ...rateDeal({ ...core, totalInvestment: core.totalInvestment }) }
}

export function quickDealCheck(input = {}) {
  const expectedInvestmentCents = toCents(input.askingPrice) + toCents(input.estimatedRepairs)
  const resaleCents = toCents(input.expectedResaleValue)
  const profitCents = resaleCents - expectedInvestmentCents
  const roiPct = expectedInvestmentCents > 0 ? round(profitCents / expectedInvestmentCents * 100) : null
  const expectedProfit = fromCents(profitCents)
  return {
    expectedInvestment: fromCents(expectedInvestmentCents), expectedProfit, roiPct,
    maximumBuyPrice: fromCents(Math.max(0, resaleCents - toCents(input.estimatedRepairs) - toCents(input.desiredMinimumProfit))),
    ...rateDeal({ expectedProfit, roiPct, totalInvestment: fromCents(expectedInvestmentCents) }),
  }
}

export function calculateListPrice(input = {}) {
  const totalCents = toCents(input.totalInvested)
  const fixedCents = toCents(input.sellerPaidShipping) + toCents(input.additionalSellingCosts)
  const targetCents = input.targetMode === 'roi'
    ? Math.round(totalCents * Math.min(MAX_ROI_PERCENT, Math.max(0, finite(input.targetValue))) / 100)
    : toCents(input.targetValue)
  const listCents = grossUpCents(totalCents + fixedCents + targetCents, input.platformFeePct)
  const feeCents = percentOfCents(listCents, input.platformFeePct)
  const profitCents = listCents - feeCents - fixedCents - totalCents
  const breakEvenCents = grossUpCents(totalCents + fixedCents, input.platformFeePct)
  const ratioCents = Math.round(listCents * MINIMUM_OFFER_LIST_PRICE_RATIO)
  const minimumCents = Math.max(breakEvenCents, ratioCents)
  const minimumFeeCents = percentOfCents(minimumCents, input.platformFeePct)
  const minimumProfitCents = minimumCents - minimumFeeCents - fixedCents - totalCents
  return {
    targetProfit: fromCents(targetCents), recommendedListPrice: fromCents(listCents), suggestedMinimumOffer: fromCents(minimumCents),
    minimumOfferExpectedProfit: fromCents(minimumProfitCents), minimumOfferExpectedRoiPct: totalCents > 0 ? round(minimumProfitCents / totalCents * 100) : null,
    minimumOfferBasis: minimumCents === breakEvenCents && breakEvenCents > ratioCents ? 'break_even' : 'negotiation_floor',
    minimumOfferTargetComparison: minimumProfitCents < targetCents ? 'below' : minimumProfitCents > targetCents ? 'above' : 'equal',
    expectedProfit: fromCents(profitCents), expectedRoiPct: totalCents > 0 ? round(profitCents / totalCents * 100) : null,
    expectedPlatformFee: fromCents(feeCents), breakEvenPrice: fromCents(breakEvenCents),
  }
}

export function calculateMaximumBuyPrice(input = {}) {
  const saleCents = toCents(input.expectedSellingPrice)
  const nonPurchaseCents = toCents(input.nonPurchaseExpenses)
  const fixedCents = toCents(input.sellerPaidShipping) + toCents(input.otherSellingCosts)
  const feeCents = percentOfCents(saleCents, input.platformFeePct)
  const raw = saleCents - nonPurchaseCents - fixedCents - feeCents - toCents(input.desiredMinimumProfit)
  return { maximumPurchasePrice: fromCents(Math.max(0, raw)), platformFees: fromCents(feeCents), totalSellingCosts: fromCents(feeCents + fixedCents), feasible: raw >= 0 }
}

export function calculateProfit(input = {}) {
  const investedCents = toCents(input.totalInvested)
  const saleCents = toCents(input.sellingPrice)
  const platformCents = percentOfCents(saleCents, input.platformFeePct)
  const fixedCents = toCents(input.sellerPaidShipping) + toCents(input.additionalSellingCosts)
  const sellingCents = platformCents + fixedCents
  const profitCents = saleCents - investedCents - sellingCents
  return {
    platformFees: fromCents(platformCents), totalSellingCosts: fromCents(sellingCents), expectedProfit: fromCents(profitCents),
    profitMarginPct: saleCents > 0 ? round(profitCents / saleCents * 100) : null,
    roiPct: investedCents > 0 ? round(profitCents / investedCents * 100) : null,
    breakEvenPrice: fromCents(grossUpCents(investedCents + fixedCents, input.platformFeePct)),
  }
}

/** Returns detached form values; editing them never mutates the source Project. */
export function projectAnalysisDraft(project = {}) {
  const expenses = Array.isArray(project.expenses) ? project.expenses : []
  const bucket = { repairsMaterials: 0, parts: 0, fuelTravel: 0, shippingCost: 0, otherExpenses: 0 }
  for (const expense of expenses) {
    const category = String(expense?.category || '').toLowerCase()
    const value = amount(expense?.amount)
    if (category === 'parts') bucket.parts += value
    else if (['supplies', 'materials', 'repair', 'maintenance', 'labor'].includes(category)) bucket.repairsMaterials += value
    else if (['transport', 'travel', 'fuel'].includes(category)) bucket.fuelTravel += value
    else if (category === 'shipping') bucket.shippingCost += value
    else bucket.otherExpenses += value
  }
  for (const key of Object.keys(bucket)) bucket[key] = round(bucket[key])
  const purchasePrice = amount(project.purchasePrice ?? project.purchase_price)
  const totalInvested = round(purchasePrice + Object.values(bucket).reduce((sum, value) => sum + value, 0))
  return { projectId: project.id || null, itemName: String(project.title || ''), purchasePrice, ...bucket, totalInvested }
}
