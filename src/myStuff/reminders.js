const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const DUE_STATES = new Set(['due', 'overdue'])
// Use the owned browser-storage prefix so account cleanup removes this state.
const OPT_IN_KEY = 'sideflip_maintenance_reminders_opt_in_v1'
const NOTICE_PREFIX = 'sideflip_maintenance_reminders_notified_v1_'
const INDEX_PREFIX = 'sideflip_maintenance_reminders_item_v1_'
const activeNotifications = new Map()
const GENERIC_NOTICE = Object.freeze({
  title: 'Maintenance reminder',
  body: 'A maintenance task is due in My Stuff.',
})

function dateOnly(value) {
  const candidate = String(value ?? '').slice(0, 10)
  const match = DATE_PATTERN.exec(candidate)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (year < 1900 || year > 2200 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return candidate
}

function localToday(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return null
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function finite(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function currentReadingForAxis(axis, item) {
  const currentUsage = item?.currentUsage && typeof item.currentUsage === 'object' ? item.currentUsage : {}
  if (axis === 'mileage') return finite(currentUsage.miles ?? item?.current_mileage)
  if (axis === 'hours') return finite(currentUsage.hours ?? item?.current_hours)
  if (axis === 'cycles') return finite(currentUsage.cycles ?? item?.current_cycles)
  return null
}

const AXIS_FIELDS = Object.freeze({
  mileage: { due:'next_due_mileage', intervals:['normal_interval_miles','severe_interval_miles','first_interval_miles'] },
  hours: { due:'next_due_hours', intervals:['normal_interval_hours','severe_interval_hours','first_interval_hours'] },
  cycles: { due:'next_due_cycles', intervals:['normal_interval_cycles','severe_interval_cycles','first_interval_cycles'] },
  calendar: { due:'next_due_date', intervals:['normal_calendar_months','severe_calendar_months','first_calendar_months'] },
})

const AXIS_ALIASES = Object.freeze({ miles:'mileage', mileage:'mileage', hours:'hours', cycles:'cycles', calendar:'calendar', date:'calendar' })

function configuredAxes(schedule) {
  const axes = new Set()
  const explicit = schedule?.configuredAxes ?? schedule?.configured_axes
  if (Array.isArray(explicit)) {
    for (const value of explicit) if (AXIS_ALIASES[value]) axes.add(AXIS_ALIASES[value])
  }
  for (const [axis, value] of Object.entries(AXIS_FIELDS)) {
    if (value.intervals.some(field => schedule?.[field] != null)) axes.add(axis)
  }
  const tracking = AXIS_ALIASES[schedule?.tracking_type]
  if (!axes.size && tracking) axes.add(tracking)
  if (!axes.size) {
    for (const [axis, value] of Object.entries(AXIS_FIELDS)) {
      if (schedule?.[value.due] != null || (axis === 'calendar' && schedule?.next_due_at != null)) axes.add(axis)
    }
  }
  return [...axes]
}

function axisDueState(axis, schedule, item, now) {
  if (axis === 'calendar') {
    const due = dateOnly(schedule.next_due_date || schedule.next_due_at)
    const today = localToday(now)
    if (!due || !today) return 'unknown'
    return due === today ? 'due' : due < today ? 'overdue' : 'upcoming'
  }
  const field = AXIS_FIELDS[axis].due
  const due = finite(schedule[field] ?? (schedule.tracking_type === axis ? schedule.next_due_value : null))
  const current = currentReadingForAxis(axis, item)
  if (due == null || current == null) return 'unknown'
  return current === due ? 'due' : current > due ? 'overdue' : 'upcoming'
}

/** Classify a maintenance schedule using every configured due axis. */
export function classifyMaintenanceReminder(schedule, item = {}, now = new Date()) {
  if (!schedule || schedule.enabled === false || schedule.deleted_at) return 'unknown'
  const axes = configuredAxes(schedule)
  if (!axes.length) return 'unknown'
  const states = axes.map(axis => axisDueState(axis, schedule, item, now))
  if (schedule.due_semantics === 'all') {
    if (states.includes('unknown')) return 'unknown'
    if (states.every(state => state === 'overdue')) return 'overdue'
    if (states.every(state => state === 'due' || state === 'overdue')) return 'due'
    return 'upcoming'
  }
  if (states.includes('overdue')) return 'overdue'
  if (states.includes('due')) return 'due'
  if (states.includes('upcoming')) return 'upcoming'
  return 'unknown'
}

export function dueStateLabel(state) {
  if (state === 'overdue') return 'Overdue'
  if (state === 'due') return 'Due now'
  if (state === 'upcoming') return 'Upcoming'
  return 'Not calculated'
}

export function visibleMaintenanceReminders(schedules = [], item = {}, now = new Date()) {
  if (!Array.isArray(schedules)) return []
  const priority = { overdue: 0, due: 1 }
  return schedules
    .map(schedule => ({ ...schedule, dueState: classifyMaintenanceReminder(schedule, item, now) }))
    .filter(schedule => DUE_STATES.has(schedule.dueState))
    .sort((left, right) => priority[left.dueState] - priority[right.dueState])
}

async function opaqueKey(value, cryptoApi) {
  try {
    if (!cryptoApi?.subtle?.digest || typeof TextEncoder !== 'function') return null
    const bytes = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(String(value)))
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

/**
 * Best-effort foreground browser notifications. This deliberately does not
 * claim background delivery; service-worker push requires separate server
 * infrastructure and consent.
 */
export function createBrowserMaintenanceReminderRuntime({
  NotificationApi = globalThis.Notification,
  storage = globalThis.localStorage,
  cryptoApi = globalThis.crypto,
} = {}) {
  const scheduleGenerations = new Map()
  const itemGenerations = new Map()
  const rawScheduleKey = (itemId, scheduleId) => `${String(itemId || '').trim()}\u0000${String(scheduleId || '').trim()}`
  const generation = (map, key) => map.get(key) || 0
  const invalidate = (map, key) => map.set(key, generation(map, key) + 1)

  async function identity(itemId, scheduleId) {
    const normalizedItem = String(itemId || '').trim()
    const normalizedSchedule = String(scheduleId || '').trim()
    if (!normalizedItem || !normalizedSchedule) return null
    const [itemDigest, noticeDigest] = await Promise.all([
      opaqueKey(`sideflip:maintenance-reminder:item:v1:${normalizedItem}`, cryptoApi),
      opaqueKey(`sideflip:maintenance-reminder:v1:${normalizedItem}:${normalizedSchedule}`, cryptoApi),
    ])
    if (!itemDigest || !noticeDigest) return null
    return { indexKey:`${INDEX_PREFIX}${itemDigest}`, noticeKey:`${NOTICE_PREFIX}${noticeDigest}`, tag:`sideflip-maintenance-reminder-${noticeDigest.slice(0, 24)}` }
  }

  function readIndex(key) {
    try {
      const value = JSON.parse(storage?.getItem?.(key) || '[]')
      return Array.isArray(value) ? value.filter(row => row && typeof row.noticeKey === 'string' && typeof row.tag === 'string') : []
    } catch { return [] }
  }

  function remember(details) {
    const rows = readIndex(details.indexKey).filter(row => row.noticeKey !== details.noticeKey)
    rows.push({ noticeKey:details.noticeKey, tag:details.tag })
    storage.setItem(details.indexKey, JSON.stringify(rows.slice(-500)))
  }

  function closeNotice(tag) {
    try { activeNotifications.get(tag)?.close?.() } catch { /* best effort */ }
    activeNotifications.delete(tag)
  }

  async function requestPermission() {
    if (!NotificationApi?.requestPermission || !storage?.setItem) return { status: 'unavailable' }
    try {
      const permission = await NotificationApi.requestPermission()
      const status = permission === 'granted' ? 'granted' : 'denied'
      storage.setItem(OPT_IN_KEY, status)
      return { status }
    } catch {
      return { status: 'unavailable' }
    }
  }

  async function notifyIfDue({ schedule, item = {}, now = new Date(), signal } = {}) {
    const dueState = classifyMaintenanceReminder(schedule, item, now)
    if (!DUE_STATES.has(dueState)) return { status: 'not-due', dueState }
    if (!storage?.getItem || !storage?.setItem || !NotificationApi) return { status: 'unavailable', dueState }
    try {
      if (storage.getItem(OPT_IN_KEY) !== 'granted') return { status: 'consent-required', dueState }
      if (NotificationApi.permission !== 'granted') return { status: 'permission-denied', dueState }
      const itemId = item?.id || schedule?.item_id
      const scheduleId = schedule?.id
      const itemKey = String(itemId || '').trim()
      const scheduleKey = rawScheduleKey(itemId, scheduleId)
      const itemGeneration = generation(itemGenerations, itemKey)
      const scheduleGeneration = generation(scheduleGenerations, scheduleKey)
      const details = await identity(itemId, scheduleId)
      if (!details) return { status: 'unavailable', dueState }
      if (signal?.aborted || generation(itemGenerations, itemKey) !== itemGeneration || generation(scheduleGenerations, scheduleKey) !== scheduleGeneration) return { status:'cancelled', dueState }
      const fingerprint = `${dueState}:${dateOnly(schedule.next_due_date || schedule.next_due_at) || ''}:${finite(schedule.next_due_value) ?? ''}:${finite(schedule.next_due_mileage) ?? ''}:${finite(schedule.next_due_hours) ?? ''}:${finite(schedule.next_due_cycles) ?? ''}`
      if (storage.getItem(details.noticeKey) === fingerprint) return { status: 'already-notified', dueState }
      const notice = new NotificationApi(GENERIC_NOTICE.title, { body: GENERIC_NOTICE.body, tag: details.tag, renotify: false })
      if (notice) activeNotifications.set(details.tag, notice)
      storage.setItem(details.noticeKey, fingerprint)
      remember(details)
      return { status: 'notified', dueState }
    } catch {
      return { status: 'unavailable', dueState }
    }
  }

  async function cancelSchedule({ itemId, scheduleId } = {}) {
    if (!storage?.removeItem) return { status:'unavailable' }
    invalidate(scheduleGenerations, rawScheduleKey(itemId, scheduleId))
    const details = await identity(itemId, scheduleId)
    if (!details) return { status:'unavailable' }
    storage.removeItem(details.noticeKey)
    closeNotice(details.tag)
    const remaining = readIndex(details.indexKey).filter(row => row.noticeKey !== details.noticeKey)
    if (remaining.length) storage.setItem(details.indexKey, JSON.stringify(remaining))
    else storage.removeItem(details.indexKey)
    return { status:'cancelled' }
  }

  async function cancelItem(itemId) {
    if (!storage?.removeItem) return { status:'unavailable' }
    const normalizedItem = String(itemId || '').trim()
    invalidate(itemGenerations, normalizedItem)
    const itemDigest = normalizedItem && await opaqueKey(`sideflip:maintenance-reminder:item:v1:${normalizedItem}`, cryptoApi)
    if (!itemDigest) return { status:'unavailable' }
    const indexKey = `${INDEX_PREFIX}${itemDigest}`
    for (const row of readIndex(indexKey)) {
      storage.removeItem(row.noticeKey)
      closeNotice(row.tag)
    }
    storage.removeItem(indexKey)
    return { status:'cancelled' }
  }

  return { requestPermission, notifyIfDue, cancelSchedule, cancelItem }
}

export const MAINTENANCE_REMINDER_COPY = Object.freeze({
  title: GENERIC_NOTICE.title,
  body: GENERIC_NOTICE.body,
  backgroundDisclaimer: 'No background notification guarantee. Due and overdue maintenance always remains visible in SideFlip.',
})
