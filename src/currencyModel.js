export const CURRENCIES = Object.freeze([
  { code: 'USD', symbol: '$', label: 'US Dollar' },
  { code: 'CAD', symbol: 'CA$', label: 'Canadian Dollar' },
  { code: 'GBP', symbol: '£', label: 'British Pound' },
  { code: 'EUR', symbol: '€', label: 'Euro' },
  { code: 'AUD', symbol: 'A$', label: 'Australian Dollar' },
  { code: 'MXN', symbol: 'MX$', label: 'Mexican Peso' },
  { code: 'JPY', symbol: '¥', label: 'Japanese Yen' },
  { code: 'INR', symbol: '₹', label: 'Indian Rupee' },
])

export const CURRENCY_SYMBOLS = Object.freeze(Object.fromEntries(
  CURRENCIES.map(currency => [currency.code, currency.symbol]),
))

export function normalizeCurrency(currency) {
  return Object.hasOwn(CURRENCY_SYMBOLS, currency) ? currency : 'USD'
}

export function formatMoneyForCurrency(value, currency = 'USD') {
  const currencyCode = normalizeCurrency(currency)
  const numericValue = Number(value)
  const amount = Number.isFinite(numericValue) ? numericValue : 0
  const decimals = currencyCode === 'JPY' ? 0 : 2
  const formattedAmount = Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  return `${amount < 0 ? '-' : ''}${CURRENCY_SYMBOLS[currencyCode]}${formattedAmount}`
}
