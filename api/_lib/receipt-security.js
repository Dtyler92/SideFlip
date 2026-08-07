const MAX_ITEMS = 50
const MAX_DESCRIPTION_LENGTH = 160
const VALID_CATEGORIES = new Set(['parts', 'supplies', 'labor', 'transport', 'fees', 'other'])

export function sanitizeReceiptItems(items) {
  if (!Array.isArray(items)) return []
  return items
    .filter(item => typeof item?.description === 'string' && Number.isFinite(Number(item.amount)) && Number(item.amount) > 0)
    .slice(0, MAX_ITEMS)
    .map(item => ({
      description: item.description.trim().slice(0, MAX_DESCRIPTION_LENGTH),
      amount: Number(Number(item.amount).toFixed(2)),
      category: VALID_CATEGORIES.has(item.category) ? item.category : 'parts',
    }))
    .filter(item => item.description)
}

export function createPerUserReceiptLimiter({ maxRequests, windowMs, maxConcurrent, now = () => Date.now() }) {
  const requests = new Map()
  const active = new Map()

  return {
    acquire(userId) {
      const timestamp = now()
      const hits = (requests.get(userId) || []).filter(hit => timestamp - hit < windowMs)
      if (hits.length >= maxRequests) return { allowed: false, reason: 'rate' }
      if ((active.get(userId) || 0) >= maxConcurrent) return { allowed: false, reason: 'concurrent' }

      hits.push(timestamp)
      requests.set(userId, hits)
      active.set(userId, (active.get(userId) || 0) + 1)
      let released = false
      return {
        allowed: true,
        release() {
          if (released) return
          released = true
          const next = (active.get(userId) || 1) - 1
          if (next > 0) active.set(userId, next)
          else active.delete(userId)
        },
      }
    },
  }
}
