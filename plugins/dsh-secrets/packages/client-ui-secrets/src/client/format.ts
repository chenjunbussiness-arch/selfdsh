/** Small display helpers. No value ever reaches this module: only metadata. */

function pad(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value)
}

/** `2026-11-22 17:05` in the browser's local time, or `—` for an unparsable stamp. */
export function formatDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—'
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return '—'
  const date = new Date(time)
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `17:05:09` local time. */
export function formatClock(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—'
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return '—'
  const date = new Date(time)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Relative age bucket for the update column: a unit key plus a count. */
export function ageOf(iso: string, now = Date.now()): { unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'; count: number } {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return { unit: 'now', count: 0 }
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 60) return { unit: 'now', count: 0 }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return { unit: 'minutes', count: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { unit: 'hours', count: hours }
  const days = Math.floor(hours / 24)
  if (days < 31) return { unit: 'days', count: days }
  const months = Math.floor(days / 30)
  if (months < 12) return { unit: 'months', count: months }
  return { unit: 'years', count: Math.floor(days / 365) }
}
