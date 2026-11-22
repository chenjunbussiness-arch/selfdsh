/**
 * Data source of the page: the host plugin's same-origin read-only routes.
 *
 * `GET /api/secrets/summary` and `GET /api/secrets/list` are served by
 * `dsh-host-secrets` on `ctx.webServer` (see packages/host-secrets/bridge.js)
 * behind the Harness login check. `credentials: 'same-origin'` carries the Web
 * shell's session cookie. Both are reads; this module never sends a body.
 */

import type { Filter, ListDocument, SummaryDocument } from './contract.ts'

/** Where the host bridge lives. Mirrors `BRIDGE_BASE` in host-secrets/bridge.js. */
export const BRIDGE_BASE = '/api/secrets'
export const SUMMARY_PATH = `${BRIDGE_BASE}/summary`
export const LIST_PATH = `${BRIDGE_BASE}/list`

/** A failed request, with the HTTP status when there was one. */
export class BridgeError extends Error {
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'BridgeError'
    this.status = status
  }
}

/** `{ error: { message } }` → message, or `undefined`. */
function errorMessageOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const error = (body as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return undefined
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : undefined
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal,
    })
  } catch (error) {
    throw new BridgeError(error instanceof Error ? error.message : String(error))
  }
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
    const plain = body === undefined && text.trim() !== '' && text.length < 200 ? text.trim() : undefined
    throw new BridgeError(errorMessageOf(body) ?? plain ?? `HTTP ${String(response.status)}`, response.status)
  }
  if (typeof body !== 'object' || body === null) throw new BridgeError('empty response', response.status)
  return body as T
}

/** Read the vault status and tag counts. */
export function fetchSummary(signal?: AbortSignal): Promise<SummaryDocument> {
  return getJson<SummaryDocument>(SUMMARY_PATH, signal)
}

/** Read the (filtered) metadata list. */
export function fetchList(filter: Filter, signal?: AbortSignal): Promise<ListDocument> {
  const params = new URLSearchParams()
  if (filter.tag !== undefined && filter.tag !== '') params.set('tag', filter.tag)
  if (filter.query !== undefined && filter.query.trim() !== '') params.set('query', filter.query.trim())
  const query = params.toString()
  return getJson<ListDocument>(query === '' ? LIST_PATH : `${LIST_PATH}?${query}`, signal)
}
