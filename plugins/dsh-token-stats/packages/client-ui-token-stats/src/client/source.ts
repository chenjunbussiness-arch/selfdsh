/**
 * Data source of the panel: the host plugin's same-origin read-only route.
 *
 * `GET /api/token-stats/summary` is served by `dsh-host-token-stats` on
 * `ctx.webServer` (see packages/host-token-stats/bridge.js). `credentials:
 * 'same-origin'` carries the Web shell's session cookie; `force=1` only asks the
 * host to re-stat the session tree before answering (still a read).
 */

import type { Summary } from './contract.ts'

/** Where the host bridge lives. Mirrors `BRIDGE_BASE` in host-token-stats. */
export const SUMMARY_PATH = '/api/token-stats/summary'

/** `{ error: { message } }` → message, or `undefined`. */
function errorMessageOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const error = (body as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return undefined
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : undefined
}

/**
 * Read the usage document.
 * @param force - ask the host to bypass its freshness window and re-stat the sessions.
 * @returns the aggregated summary.
 */
export async function fetchSummary(force = false): Promise<Summary> {
  const url = force ? `${SUMMARY_PATH}?force=1` : SUMMARY_PATH
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  })
  const text = await response.text()
  let body: unknown
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
  }
  if (!response.ok) {
    throw new Error(errorMessageOf(body) ?? `HTTP ${String(response.status)}`)
  }
  if (typeof body !== 'object' || body === null) throw new Error('empty response')
  return body as Summary
}
