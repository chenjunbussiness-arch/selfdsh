/**
 * Number and date formatting for the sidebar panel.
 *
 * The shell's own `formatTokens` lives inside `dsh-client-ui-chat` and is not an
 * exported module-table entry, so the same 10-line shape is repeated here with
 * the panel's locale-free suffixes (K/M/B are the composer pill's style too).
 */

/** Compact token count: 517 / 12.2K / 1.4M / 1.1B. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1e9) return `${trim(value / 1e9)}B`
  if (value >= 1e6) return `${trim(value / 1e6)}M`
  if (value >= 1e3) return `${trim(value / 1e3)}K`
  return String(Math.round(value))
}

/** One decimal, but drop a trailing `.0`. */
function trim(value: number): string {
  const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(1)
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}

/** Share of today as a percentage; tiny slices stay visible as `<1%`. */
export function formatPercent(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%'
  const percent = share * 100
  if (percent >= 99.5) return '100%'
  if (percent < 1) return '<1%'
  return `${Math.round(percent)}%`
}

/** `2026-11-19` → `11-19`. */
export function shortDate(date: string): string {
  return date.length >= 10 ? date.slice(5) : date
}

/** `2026-11-19T23:58:01.000+08:00` → `23:58`. */
export function timeOfDay(iso: string): string {
  const at = iso.indexOf('T')
  return at >= 0 ? iso.slice(at + 1, at + 6) : iso
}

/** Strip the provider prefix so a narrow row still shows the model name. */
export function shortModel(model: string): string {
  const slash = model.lastIndexOf('/')
  return slash >= 0 && slash < model.length - 1 ? model.slice(slash + 1) : model
}

/** Shift a `YYYY-MM-DD` date by whole days without touching the local timezone. */
export function shiftDate(date: string, deltaDays: number): string {
  const parts = date.split('-').map(Number)
  const year = parts[0] ?? 1970
  const month = parts[1] ?? 1
  const day = parts[2] ?? 1
  return new Date(Date.UTC(year, month - 1, day) + deltaDays * 86_400_000).toISOString().slice(0, 10)
}
