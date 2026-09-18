// Deal analyzer labor math.
//
// Pure, dependency-free. The deal analyzer is a pre-purchase estimate: the user
// has not bought anything yet, so nothing here touches Supabase, projects, or
// the goal ledger. Estimated hours are never persisted as tracked labor
// (expenses.labor_hours) — that column means work actually performed.

const QUARTER = 0.25

/**
 * Round an hours input UP to the next quarter hour.
 * Returns null for blank, zero, negative, or non-finite input.
 * Matches the native laborModel.roundLaborHours contract so the estimate the
 * user sees is identical on every platform.
 */
export function roundUpQuarterHours(value) {
  const hours = Number(value)
  if (!Number.isFinite(hours) || hours <= 0) return null
  return Math.ceil(hours / QUARTER - 1e-9) * QUARTER
}

/**
 * Effective pay per hour for a deal. Negative profit yields a negative rate —
 * a bad deal should look bad, not be hidden.
 * Returns null when hours are unknown, so callers can render "—" instead of
 * implying the work is free.
 */
export function calculateHourlyPay({ profit, hours } = {}) {
  const h = roundUpQuarterHours(hours)
  if (h === null) return null
  const p = Number(profit)
  if (!Number.isFinite(p)) return null
  return p / h
}

/** Profit needed to earn `hourlyRate` for `hours` of work. */
export function calculateRequiredProfit({ hours, hourlyRate } = {}) {
  const h = roundUpQuarterHours(hours)
  const rate = Number(hourlyRate)
  if (h === null || !Number.isFinite(rate) || rate <= 0) return null
  return h * rate
}

/**
 * List price that nets `profit` on top of `invested` after platform fees.
 * A fee of 100% or more can never net a profit, so it returns null rather
 * than dividing by zero and reporting an infinite price.
 */
export function calculateListPrice({ invested, profit, feePct } = {}) {
  const inv = Number(invested)
  const target = Number(profit)
  const fee = Number(feePct) || 0
  if (!Number.isFinite(inv) || !Number.isFinite(target)) return null
  if (fee >= 100 || fee < 0) return null
  return fee > 0 ? (inv + target) / (1 - fee / 100) : inv + target
}

/**
 * Full deal analysis.
 *
 * Inputs may be raw strings from text fields. `estimatedHours` and
 * `targetHourlyRate` are optional: without them the result is the original
 * price/profit/ROI analysis and every labor field is null.
 */
export function analyzeDeal({
  invested,
  targetPct,
  feePct,
  estimatedHours,
  targetHourlyRate,
} = {}) {
  const inv = Number(invested) || 0
  const pct = Number(targetPct) || 0
  const fee = Number(feePct) || 0

  const targetProfit = inv * (pct / 100)
  const listPrice = calculateListPrice({ invested: inv, profit: targetProfit, feePct: fee })
  const profit = listPrice === null ? null : listPrice * (1 - fee / 100) - inv
  const roi = inv > 0 && profit !== null ? (profit / inv) * 100 : null

  const hours = roundUpQuarterHours(estimatedHours)
  const hourlyPay = profit === null ? null : calculateHourlyPay({ profit, hours })
  const requiredProfit = calculateRequiredProfit({ hours, hourlyRate: targetHourlyRate })
  const requiredListPrice =
    requiredProfit === null
      ? null
      : calculateListPrice({ invested: inv, profit: requiredProfit, feePct: fee })

  return {
    listPrice,
    profit,
    roi,
    hours,
    hourlyPay,
    requiredProfit,
    requiredListPrice,
    // null (not false) when there is nothing to compare, so the UI can stay
    // silent instead of claiming the deal failed a target the user never set.
    meetsTarget:
      hourlyPay === null || requiredProfit === null || profit === null
        ? null
        : profit >= requiredProfit,
  }
}
