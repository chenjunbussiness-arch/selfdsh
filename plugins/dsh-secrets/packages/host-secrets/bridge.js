/**
 * Same-origin, read-only HTTP bridge for the secrets dashboard
 * (`dsh-client-ui-secrets`).
 *
 *   GET /api/secrets/summary                  vault status + counts per tag
 *   GET /api/secrets/list[?tag=&query=]       value-free metadata of every entry
 *
 * "Write and use, never read" (DESIGN.md) holds here too:
 *
 * - only GET; no request body is read and nothing is ever written;
 * - every item goes through `item()` from tools.js, the same projection
 *   `secret_list` returns: name, description, tags, fingerprint (8 hex of
 *   sha256), length, createdAt / updatedAt / metaUpdatedAt. No value, no prefix
 *   or suffix of a value, no encoded form, no key material;
 * - decryption is `Vault#load()` from vault.js; nothing here re-implements it;
 * - filtering is `filterNames()` from tools.js, so the page and `secret_list`
 *   agree on what a tag / keyword matches;
 * - error messages come from vault.js, whose messages never carry a value.
 *
 * A missing vault is an empty list (200), not an error. A vault that cannot be
 * opened (no master key, wrong passphrase, bad permissions) is also a 200 with
 * `vault.state` saying why and `items: []`, so the page can explain instead of
 * failing. Only an unexpected exception becomes a 500.
 *
 * The routes are registered on `ctx.webServer` and wrapped by `requireLogin`,
 * exactly like dsh-token-stats does (see that bridge for why the wrapper is
 * needed: a plugin route outranks the connection's own `/api` prefix check).
 *
 * @module dsh-host-secrets/bridge
 */

import { DECRYPT_FAILED } from './vault.js'
import { filterNames, item } from './tools.js'

/** Path prefix this bundle owns. */
export const BRIDGE_BASE = '/api/secrets'

/** Vault status, counts and tags. */
export const SUMMARY_PATH = `${BRIDGE_BASE}/summary`

/** Filterable metadata list. */
export const LIST_PATH = `${BRIDGE_BASE}/list`

/** Longest accepted `tag` / `query` parameter (code points). */
export const MAX_FILTER_CHARS = 256

/** Write one JSON response. */
function sendJson(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  res.end(body)
}

/** `{ error: { code, message } }` with the given status. */
function sendError(res, status, code, message, extraHeaders) {
  sendJson(res, status, { error: { code, message } }, extraHeaders)
}

/** Error → message, never a stack. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Classify a `Vault#load()` failure. Messages come from vault.js and name at
 * most a path or an environment-variable name, never a value or key material.
 * @param {unknown} error
 * @returns {{ state: 'locked' | 'error', code: string, message: string }}
 */
export function classifyLoadError(error) {
  const message = messageOf(error)
  if (message.startsWith('master key missing')) return { state: 'locked', code: 'key-missing', message }
  if (message === DECRYPT_FAILED) return { state: 'locked', code: 'decrypt-failed', message }
  if (message.startsWith('keyfile ')) return { state: 'locked', code: 'key-invalid', message }
  if (message.startsWith('key derivation failed')) return { state: 'locked', code: 'key-invalid', message }
  if (/^vault uses kdf/.test(message)) return { state: 'locked', code: 'key-source-mismatch', message }
  return { state: 'error', code: 'vault-unreadable', message }
}

/**
 * Whether master key material is available right now (env var set / keyfile
 * readable). The material is zeroed immediately and never leaves this function.
 * @param {import('./vault.js').Vault} vault
 */
export async function keyConfigured(vault) {
  try {
    const material = await vault.keyMaterial()
    material.fill(0)
    return true
  } catch {
    return false
  }
}

/**
 * Read the vault once and return its value-free view.
 *
 * `entries` (which holds plaintext values for the duration of this call) is
 * only ever passed to `item()` / `filterNames()` and is dropped on return.
 *
 * @param {import('./vault.js').Vault} vault
 * @returns {Promise<{ vault: object, entries: Record<string, any> }>}
 */
export async function readVault(vault) {
  const base = {
    path: vault.path,
    keySource: vault.keySource,
    keyConfigured: await keyConfigured(vault),
  }
  if (!(await vault.exists())) {
    return { vault: { ...base, state: 'missing', exists: false, unlocked: false }, entries: Object.create(null) }
  }
  try {
    const { entries } = await vault.load()
    return { vault: { ...base, state: 'unlocked', exists: true, unlocked: true }, entries }
  } catch (error) {
    const { state, code, message } = classifyLoadError(error)
    return { vault: { ...base, state, exists: true, unlocked: false, error: { code, message } }, entries: Object.create(null) }
  }
}

/**
 * Optional string filter from the query string: absent or empty → undefined.
 * @returns {{ ok: true, value: string | undefined } | { ok: false, message: string }}
 */
function filterParam(url, key) {
  const raw = url.searchParams.get(key)
  if (raw === null) return { ok: true, value: undefined }
  const value = raw.trim()
  if (value === '') return { ok: true, value: undefined }
  if ([...value].length > MAX_FILTER_CHARS) return { ok: false, message: `${key} is longer than ${MAX_FILTER_CHARS} characters` }
  return { ok: true, value }
}

/** Value-free projection of a set of names; full description (it is metadata, not a secret). */
function itemsOf(entries, names) {
  return names.map(name => item(name, entries[name], { fullDescription: true }))
}

/**
 * Build the summary document.
 * @param {import('./vault.js').Vault} vault
 */
export async function buildSummary(vault) {
  const { vault: status, entries } = await readVault(vault)
  const names = Object.keys(entries)
  const counts = new Map()
  let untagged = 0
  let lastUpdatedAt = null
  let lastMetaUpdatedAt = null
  for (const name of names) {
    const entry = entries[name]
    if (entry.tags.length === 0) untagged += 1
    for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    if (lastUpdatedAt === null || entry.updatedAt > lastUpdatedAt) lastUpdatedAt = entry.updatedAt
    if (lastMetaUpdatedAt === null || entry.metaUpdatedAt > lastMetaUpdatedAt) lastMetaUpdatedAt = entry.metaUpdatedAt
  }
  const tags = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([tag, count]) => ({ tag, count }))
  return {
    generatedAt: new Date().toISOString(),
    vault: status,
    total: names.length,
    untagged,
    tags,
    lastUpdatedAt,
    lastMetaUpdatedAt,
  }
}

/**
 * Build the list document.
 * @param {import('./vault.js').Vault} vault
 * @param {{ tag?: string, query?: string }} filter
 */
export async function buildList(vault, filter = {}) {
  const { vault: status, entries } = await readVault(vault)
  const names = filterNames(entries, filter)
  return {
    generatedAt: new Date().toISOString(),
    vault: status,
    filter: { tag: filter.tag ?? null, query: filter.query ?? null },
    total: Object.keys(entries).length,
    matched: names.length,
    items: itemsOf(entries, names),
  }
}

/** A GET-only route around `answer(url)`. */
function getRoute(path, logger, answer) {
  return {
    kind: 'exact',
    path,
    async handler(req, res) {
      if (req.method !== 'GET') {
        sendError(res, 405, 'method-not-allowed', 'read-only: use GET', { allow: 'GET' })
        return
      }
      let url
      try {
        url = new URL(req.url ?? path, 'http://localhost')
      } catch {
        sendError(res, 400, 'bad-url', 'malformed request URL')
        return
      }
      try {
        const result = await answer(url)
        if (result.error !== undefined) sendError(res, 400, 'bad-request', result.error)
        else sendJson(res, 200, result.body)
      } catch (error) {
        logger?.warn?.(`dsh-secrets: dashboard ${path} failed: ${messageOf(error)}`)
        sendError(res, 500, 'internal', messageOf(error))
      }
    },
  }
}

/**
 * Build the routes to mount.
 * @param {{ vault: import('./vault.js').Vault, logger?: any }} deps
 * @returns {ReadonlyArray<{ kind: 'exact', path: string, handler: Function }>} routes to register.
 */
export function createRoutes({ vault, logger }) {
  return [
    getRoute(SUMMARY_PATH, logger, async () => ({ body: await buildSummary(vault) })),
    getRoute(LIST_PATH, logger, async (url) => {
      const tag = filterParam(url, 'tag')
      if (!tag.ok) return { error: tag.message }
      const query = filterParam(url, 'query')
      if (!query.ok) return { error: query.message }
      return { body: await buildList(vault, { tag: tag.value, query: query.value }) }
    }),
  ]
}

/**
 * Wrap a route so it answers only a logged-in browser (same check as
 * dsh-token-stats' bridge).
 *
 * `dsh-client-connection` checks the login cookie on its `/api` prefix route,
 * but `/api/secrets/*` is a longer match, so the web server picks it first and
 * that check never runs. This puts the same check back.
 *
 * @param {{ kind: string, path: string, handler: Function }} route - the bridge route.
 * @param {() => ({ requestRejection?: (req: import('node:http').IncomingMessage) => number | undefined } | undefined)} connection - reads the `connection` service at request time.
 * @returns {{ kind: string, path: string, handler: Function }} the guarded route (401/403 from the connection, 503 when it is not up).
 */
export function requireLogin(route, connection) {
  return {
    ...route,
    handler: async (req, res) => {
      let check
      try { check = connection() } catch { check = undefined }
      const rejection = typeof check?.requestRejection === 'function' ? check.requestRejection(req) : 503
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(rejection === 401 ? 'unauthorized' : rejection === 403 ? 'forbidden' : 'login service unavailable')
        return
      }
      await route.handler(req, res)
    },
  }
}
