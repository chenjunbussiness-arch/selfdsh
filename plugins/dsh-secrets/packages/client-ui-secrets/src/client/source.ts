/**
 * Data source of the page: the host plugin's same-origin routes.
 *
 * Reads: `GET /api/secrets/{summary,list,credentials,plugins}`. Writes:
 * `POST /api/secrets/{vault,credentials,hub}/*` with a JSON body and the
 * `x-dsh-secrets: 1` header the host requires (a cross-site form cannot send
 * it). All are served by `dsh-host-secrets` (bridge.js, manage.js) behind the
 * Harness login check; `credentials: 'same-origin'` carries the session
 * cookie. No route returns a secret value, so nothing here can show one.
 */

import type { CredentialItem, CredentialsDocument, Filter, HubStatus, ListDocument, PluginsDocument, SummaryDocument, VaultWriteResult } from './contract.ts'

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

async function getJson<T>(url: string, signal?: AbortSignal, payload?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, payload === undefined
      ? { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, signal }
      : {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json', 'content-type': 'application/json', 'x-dsh-secrets': '1' },
          body: JSON.stringify(payload),
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

/** POST one JSON body to a management route. */
function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  return getJson<T>(`${BRIDGE_BASE}${path}`, undefined, body)
}

/** Managed credential refs, presence only. */
export function fetchCredentials(signal?: AbortSignal): Promise<CredentialsDocument> {
  return getJson<CredentialsDocument>(`${BRIDGE_BASE}/credentials`, signal)
}

/** selfdsh plugins, what each needs, and the hub connection file. */
export function fetchPlugins(signal?: AbortSignal): Promise<PluginsDocument> {
  return getJson<PluginsDocument>(`${BRIDGE_BASE}/plugins`, signal)
}

/** Create or replace a vault secret (value goes in, never comes back). */
export function vaultSet(body: { name: string; value: string; description?: string; tags?: string[] }): Promise<VaultWriteResult> {
  return postJson('/vault/set', body)
}

/** Change description and/or tags. */
export function vaultDescribe(body: { name: string; description?: string; tags?: string[] }): Promise<VaultWriteResult> {
  return postJson('/vault/describe', body)
}

/** Rename a secret. */
export function vaultRename(body: { from: string; to: string; overwrite?: boolean }): Promise<unknown> {
  return postJson('/vault/rename', body)
}

/** Delete a secret. */
export function vaultDelete(name: string): Promise<unknown> {
  return postJson('/vault/delete', { name })
}

/** Store a credential in DSH's credential store. */
export function credentialSet(ref: string, value: string): Promise<CredentialItem> {
  return postJson('/credentials/set', { ref, value })
}

/** Clear a credential from DSH's credential store. */
export function credentialUnset(ref: string): Promise<CredentialItem> {
  return postJson('/credentials/unset', { ref })
}

/** Set one agent-hub connection setting (controller.env). */
export function hubSet(name: string, value: string): Promise<HubStatus> {
  return postJson('/hub/set', { name, value })
}

/** Remove one agent-hub connection setting. */
export function hubUnset(name: string): Promise<HubStatus> {
  return postJson('/hub/unset', { name })
}
