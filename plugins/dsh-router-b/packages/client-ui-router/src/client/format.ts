/**
 * Small formatting helpers shared by the panel's views.
 */

/**
 * Human-readable age of an ISO timestamp.
 * @param iso - timestamp to describe.
 * @param now - reference time, injectable for tests and deterministic renders.
 * @returns a short relative label such as `刚刚`, `6 分钟前`, `2 小时前`.
 */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (iso === undefined) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 45) return '刚刚'
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} 小时前`
  return `${Math.round(seconds / 86_400)} 天前`
}

/**
 * Clock time of an ISO timestamp, for the header stamp.
 * @param iso - timestamp.
 * @returns `HH:MM:SS`, or an empty string when the value is not a timestamp.
 */
export function clockTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(undefined, { hour12: false })
}

/**
 * Elapsed seconds as a compact duration.
 * @param seconds - duration in seconds.
 * @returns `44s`, `5m18s`, or an empty string when absent.
 */
export function duration(seconds: number | undefined): string {
  if (seconds === undefined) return ''
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`
}

/**
 * Human-readable byte size.
 * @param bytes - size in bytes.
 * @returns `4.2 KB`, `812 B`, or an empty string when absent.
 */
export function bytes(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
