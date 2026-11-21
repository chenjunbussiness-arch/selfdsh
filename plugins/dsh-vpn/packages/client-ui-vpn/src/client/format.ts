/** Small formatting helpers. */

/** `3725` → `1h 02m 05s`. */
export function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (value: number): string => String(value).padStart(2, '0')
  return h > 0 ? `${String(h)}h ${two(m)}m ${two(s)}s` : m > 0 ? `${String(m)}m ${two(s)}s` : `${String(s)}s`
}

/** `2026-11-19T07:01:02.000Z` → local `15:01:02`. */
export function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}
