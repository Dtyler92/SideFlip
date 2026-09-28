import { useEffect, useMemo, useRef, useState } from 'react'
import { createBrowserMaintenanceReminderRuntime, dueStateLabel, visibleMaintenanceReminders } from '../myStuff/reminders.js'

function scheduleLabel(schedule) {
  return schedule.name || schedule.task_name || schedule.title || 'Maintenance task'
}

function dueDescription(schedule) {
  const values = []
  const dueDate = schedule.next_due_date || schedule.next_due_at
  if (dueDate) values.push(`Due ${String(dueDate).slice(0, 10)}`)
  const mileage = schedule.next_due_mileage ?? (schedule.tracking_type === 'mileage' ? schedule.next_due_value : null)
  const hours = schedule.next_due_hours ?? (schedule.tracking_type === 'hours' ? schedule.next_due_value : null)
  const cycles = schedule.next_due_cycles ?? (schedule.tracking_type === 'cycles' ? schedule.next_due_value : null)
  if (mileage != null) values.push(`${Number(mileage).toLocaleString()} mi`)
  if (hours != null) values.push(`${Number(hours).toLocaleString()} hr`)
  if (cycles != null) values.push(`${Number(cycles).toLocaleString()} cycles`)
  return values.join(' · ') || 'Due threshold unavailable'
}

export default function MaintenanceReminderPanel({ schedules = [], item = {}, now, runtime: suppliedRuntime }) {
  const fallbackRuntime = useRef(null)
  if (!fallbackRuntime.current) fallbackRuntime.current = createBrowserMaintenanceReminderRuntime()
  const runtime = suppliedRuntime || fallbackRuntime.current
  const [permissionState, setPermissionState] = useState('idle')
  const lifecycleController = useRef(null)
  const due = useMemo(() => visibleMaintenanceReminders(schedules, item, now || new Date()), [schedules, item, now])

  useEffect(() => {
    const controller = new AbortController()
    lifecycleController.current = controller
    let active = true
    Promise.all(due.map(schedule => runtime.notifyIfDue({ schedule, item, now: now || new Date(), signal:controller.signal })))
      .then(results => { if (active && results.some(result => result.status === 'notified')) setPermissionState('notified') })
      .catch(() => {})
    return () => { active = false; controller.abort(); if (lifecycleController.current === controller) lifecycleController.current = null }
  }, [due, item, now, runtime])

  async function enableAlerts() {
    const controller = lifecycleController.current
    setPermissionState('requesting')
    const result = await runtime.requestPermission()
    if (!controller || controller.signal.aborted) {
      if (lifecycleController.current) setPermissionState('idle')
      return
    }
    setPermissionState(result.status)
    if (result.status === 'granted') {
      await Promise.all(due.map(schedule => runtime.notifyIfDue({ schedule, item, now: now || new Date(), signal:controller.signal })))
    }
  }

  return <section className="mystuff-card" aria-labelledby="maintenance-reminders-heading">
    <div className="mystuff-section-heading">
      <h2 id="maintenance-reminders-heading">Maintenance reminders</h2>
      <button type="button" className="mystuff-link" onClick={enableAlerts} disabled={permissionState === 'requesting'}>
        {permissionState === 'requesting' ? 'Requesting…' : 'Enable browser alerts'}
      </button>
    </div>
    <p className="mystuff-help">Due and overdue items always appear here while you use SideFlip. Browser alerts use generic private wording and require your permission. No background notification guarantee.</p>
    {permissionState === 'denied' && <p className="field-error" role="status">Browser alerts are blocked. You can still use the in-app reminder list.</p>}
    {permissionState === 'unavailable' && <p className="mystuff-help" role="status">Browser alerts are unavailable. You can still use the in-app reminder list.</p>}
    {due.length ? <ul className="mystuff-history">{due.map(schedule => <li key={schedule.id}>
      <div className="mystuff-history-row"><span><strong>{scheduleLabel(schedule)}</strong><small>{dueDescription(schedule)}</small></span><strong>{dueStateLabel(schedule.dueState)}</strong></div>
    </li>)}</ul> : <p className="mystuff-help">No maintenance is due right now.</p>}
  </section>
}
