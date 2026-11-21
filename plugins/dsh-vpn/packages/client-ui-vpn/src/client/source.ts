/**
 * Where the page's data comes from.
 *
 * The page never talks to the network itself: it reads one {@link VpnSource}.
 *
 * - `createHttpSource` calls the host plugin's same-origin bridge (`/api/vpn/*`,
 *   mounted by `packages/host-vpn` on `ctx.webServer`), like dsh-client-ui-router.
 * - `createMockSource` (./mock.ts) is sample data. The HTTP source falls back to
 *   it for READS only, until a live read has succeeded; the page then shows the
 *   "sample data" badge. Actions never fall back: pressing Connect against a
 *   bridge that is not there must fail loudly, not pretend.
 */

import type { LogLine, ProfileInput, ProfileView, StatusView, VpnSnapshot } from './contract.ts'
import { createMockSource } from './mock.ts'

/** The one seam between the view and the host. */
export interface VpnSource {
  readonly origin: 'host' | 'mock'
  read(): Promise<VpnSnapshot>
  save(input: ProfileInput): Promise<ProfileView>
  remove(id: string): Promise<void>
  connect(id: string): Promise<void>
  disconnect(): Promise<void>
  /** Observe changes the source itself knows about (the mock); the HTTP source relies on polling. */
  subscribe(listener: () => void): () => void
}

/** Where the host bridge lives. Mirrors `BRIDGE_BASE` in host-vpn. */
export const BRIDGE_BASE = '/api/vpn'

/** Options for {@link createHttpSource}. */
export interface HttpSourceOptions {
  readonly base?: string
  readonly fallback?: VpnSource
  readonly fetchImpl?: typeof fetch
}

/** Pull `{ error: { code, message } }` out of a decoded body. */
function errorMessageOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const error = (body as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return undefined
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : undefined
}

/** Call one endpoint and decode its JSON answer; a non-2xx status throws the bridge's own message. */
async function requestJson(doFetch: typeof fetch, url: string, init?: RequestInit): Promise<unknown> {
  const response = await doFetch(url, { credentials: 'same-origin', ...init })
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
    throw new Error(errorMessageOf(body) ?? (text.trim() === '' ? response.statusText : `HTTP ${String(response.status)}`))
  }
  return body
}

/** JSON headers and body. */
function jsonBody(method: string, value: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value ?? {}) }
}

/** Narrow the status document without trusting its shape. */
function asStatus(value: unknown): StatusView {
  if (typeof value !== 'object' || value === null || typeof (value as { status?: unknown }).status !== 'string') {
    throw new Error('GET /api/vpn/status returned a payload that is not a status document')
  }
  return value as StatusView
}

/**
 * Build the source that talks to the host bridge.
 * @param options - bridge prefix, sample fallback and a test `fetch`.
 * @returns a live source.
 */
export function createHttpSource(options: HttpSourceOptions = {}): VpnSource {
  const base = options.base ?? BRIDGE_BASE
  const doFetch = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
  let live = false
  const need = (): typeof fetch => {
    if (doFetch === undefined) throw new Error('this environment has no fetch(); the VPN bridge is unreachable')
    return doFetch
  }
  return {
    origin: 'host',
    async read() {
      try {
        const f = need()
        const [status, profiles, logs] = await Promise.all([
          requestJson(f, `${base}/status`),
          requestJson(f, `${base}/profiles`),
          requestJson(f, `${base}/logs?limit=200`),
        ])
        live = true
        return {
          fetchedAt: new Date().toISOString(),
          status: asStatus(status),
          profiles: ((profiles as { profiles?: ProfileView[] }).profiles ?? []),
          logs: ((logs as { lines?: LogLine[] }).lines ?? []),
          origin: 'host',
        }
      } catch (error) {
        if (live || options.fallback === undefined) throw error
        const sample = await options.fallback.read()
        return { ...sample, staleSince: new Date().toISOString() }
      }
    },
    async save(input) {
      const body = await requestJson(need(), `${base}/profile`, jsonBody('PUT', input))
      return (body as { profile: ProfileView }).profile
    },
    async remove(id) {
      await requestJson(need(), `${base}/profile?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } })
    },
    async connect(id) {
      await requestJson(need(), `${base}/connect`, jsonBody('POST', { id }))
    },
    async disconnect() {
      await requestJson(need(), `${base}/disconnect`, jsonBody('POST', {}))
    },
    subscribe() {
      return () => {}
    },
  }
}

/** The source this client uses: the host bridge with a labelled sample fallback. */
export function resolveSource(): VpnSource {
  return createHttpSource({ fallback: createMockSource('connected') })
}

export { createMockSource }
