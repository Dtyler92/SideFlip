const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const DUE_STATES = new Set(['due', 'overdue'])
// Use the owned browser-storage prefix so account cleanup removes this state.
const OPT_IN_KEY = 'sideflip_maintenance_reminders_opt_in_v1'
const NOTICE_PREFIX = 'sideflip_maintenance_reminders_notified_v1_'
const GENERIC_NOTICE = Object.freeze({
  title: 'Maintenance reminder',
  body: 'A maintenance task is due in My Stuff.',
  tag: 'sideflip-maintenance-reminder',
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

function currentReading(schedule, item) {
  const currentUsage = item?.currentUsage && typeof item.currentUsage === 'object' ? item.currentUsage : {}
  const trackingType = schedule?.tracking_type
    || (schedule?.next_due_mileage != null ? 'mileage' : schedule?.next_due_hours != null ? 'hours' : null)
  if (trackingType === 'mileage') return finite(currentUsage.miles ?? item?.current_mileage)
  if (trackingType === 'hours') return finite(currentUsage.hours ?? item?.current_hours)
  return null
}

/** Classify a legacy maintenance schedule for visible in-app treatment. */
export function classifyMaintenanceReminder(schedule, item = {}, now = new Date()) {
  if (!schedule || schedule.enabled === false || schedule.deleted_at) return 'unknown'
  const trackingType = schedule.tracking_type
    || (schedule.next_due_mileage != null ? 'mileage' : schedule.next_due_hours != null ? 'hours' : schedule.next_due_at ? 'calendar' : null)
  if (trackingType === 'calendar') {
    const due = dateOnly(schedule.next_due_at || schedule.next_due_date)
    const today = localToday(now)
    if (!due || !today) return 'unknown'
    return due === today ? 'due' : due < today ? 'overdue' : 'upcoming'
  }
  if (trackingType !== 'mileage' && trackingType !== 'hours') return 'unknown'
  const due = finite(trackingType === 'mileage'
    ? schedule.next_due_value ?? schedule.next_due_mileage
    : schedule.next_due_value ?? schedule.next_due_hours)
  const current = currentReading(schedule, item)
  if (due == null || current == null) return 'unknown'
  return current === due ? 'due' : current > due ? 'overdue' : 'upcoming'
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

  async function notifyIfDue({ schedule, item = {}, now = new Date() } = {}) {
    const dueState = classifyMaintenanceReminder(schedule, item, now)
    if (!DUE_STATES.has(dueState)) return { status: 'not-due', dueState }
    if (!storage?.getItem || !storage?.setItem || !NotificationApi) return { status: 'unavailable', dueState }
    try {
      if (storage.getItem(OPT_IN_KEY) !== 'granted') return { status: 'consent-required', dueState }
      if (NotificationApi.permission !== 'granted') return { status: 'permission-denied', dueState }
      const id = String(schedule?.id ?? '').trim()
      const digest = id && await opaqueKey(`sideflip:maintenance-reminder:v1:${id}`, cryptoApi)
      if (!digest) return { status: 'unavailable', dueState }
      const key = `${NOTICE_PREFIX}${digest}`
      const fingerprint = `${dueState}:${dateOnly(schedule.next_due_at) || finite(schedule.next_due_value)}`
      if (storage.getItem(key) === fingerprint) return { status: 'already-notified', dueState }
      new NotificationApi(GENERIC_NOTICE.title, { body: GENERIC_NOTICE.body, tag: GENERIC_NOTICE.tag, renotify: false })
      storage.setItem(key, fingerprint)
      return { status: 'notified', dueState }
    } catch {
      return { status: 'unavailable', dueState }
    }
  }

  return { requestPermission, notifyIfDue }
}

export const MAINTENANCE_REMINDER_COPY = Object.freeze({
  title: GENERIC_NOTICE.title,
  body: GENERIC_NOTICE.body,
  backgroundDisclaimer: 'No background notification guarantee. Due and overdue maintenance always remains visible in SideFlip.',
})
