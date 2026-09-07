export const MONTHLY_PRICE = 12.99
export const ANNUAL_PRICE = 99.99
export const ANNUAL_MONTHLY_EQUIV = '8.33'
export const SAVINGS_PCT = Math.round((1 - ANNUAL_PRICE / (MONTHLY_PRICE * 12)) * 100)
