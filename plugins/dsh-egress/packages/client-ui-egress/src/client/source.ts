/**
 * Sources for the panel: the host's HTTP bridge, and in-memory sample data.
 *
 * The bridge is same-origin (`/api/egress/*`, mounted by `packages/host-egress`
 * on the Web server), so the browser needs no new transport and no credential of
 * its own. Writes send `application/json`, which a cross-origin page cannot do
 * without a CORS preflight the server never grants.
 */

import type { EgressSource, EgressState, ExitInput, ProbeResult } from './contract.ts'
import { createMockSource } from './mock.ts'

/** Where the host's bridge lives. Mirrors `BRIDGE_BASE` in the host package. */
export const BRIDGE_BASE = '/api/egress'

/** Options for {@link createHttpSource}. */
export interface HttpSourceOptions {
  readonly base?: string
  /** Test seam. */
  readonly fetchImpl?: typeof fetch
}

/**
 * Call one bridge endpoint and decode its JSON answer.
 * @param doFetch - fetch implementation.
 * @param url - absolute or same-origin URL.
 * @param init - request init.
 * @returns the decoded body.
 * @throws {Error} with the bridge's own message on a non-2xx answer.
 */
async function call(doFetch: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  const response = await doFetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const text = await response.text()
  let body: unknown
  try { body = text === '' ? undefined : JSON.parse(text) } catch { body = undefined }
  if (!response.ok) {
    const error = (body as { error?: { message?: unknown } } | undefined)?.error
    const message = typeof error?.message === 'string' ? error.message : `HTTP ${String(response.status)}`
    throw new Error(message)
  }
  return body
}

/** The JSON headers every write carries. */
const JSON_HEADERS = { 'content-type': 'application/json' } as const

/**
 * Narrow a decoded body to a state document.
 * @param body - decoded JSON.
 * @returns the state.
 */
function asState(body: unknown): EgressState {
  const candidate = body as Partial<EgressState> | undefined
  if (candidate === undefined || candidate.version !== 1 || !Array.isArray(candidate.exits) || !Array.isArray(candidate.bindings)) {
    throw new Error('the egress bridge answered with something that is not a state document')
  }
  return candidate as EgressState
}

/**
 * Build the source that talks to the host's HTTP bridge.
 * @param options - base path and test fetch.
 * @returns the source.
 */
export function createHttpSource(options: HttpSourceOptions = {}): EgressSource {
  const base = options.base ?? BRIDGE_BASE
  const doFetch = (): typeof fetch => {
    const impl = options.fetchImpl ?? globalThis.fetch
    if (typeof impl !== 'function') throw new Error('this environment has no fetch(); the egress bridge is unreachable')
    return impl.bind(globalThis)
  }
  return {
    origin: 'host',
    async load() {
      return asState(await call(doFetch(), `${base}/state`, { method: 'GET' }))
    },
    async putExit(input: ExitInput) {
      return asState(await call(doFetch(), `${base}/exit`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(input) }))
    },
    async deleteExit(id: string) {
      return asState(await call(doFetch(), `${base}/exit?id=${encodeURIComponent(id)}`, { method: 'DELETE' }))
    },
    async putBinding(host: string, exit: string | null) {
      return asState(await call(doFetch(), `${base}/binding`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ host, exit }) }))
    },
    async probe(id: string) {
      const body = await call(doFetch(), `${base}/probe`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ id }) }) as
        { result?: ProbeResult; state?: unknown } | undefined
      if (body?.result === undefined) throw new Error('the egress bridge answered a probe without a result')
      return { result: body.result, state: asState(body.state) }
    },
  }
}

/** The pair the controller works with: the real bridge and the sample fallback. */
export function defaultSources(): { readonly host: EgressSource; readonly mock: () => EgressSource } {
  return { host: createHttpSource(), mock: () => createMockSource() }
}
