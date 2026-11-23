/**
 * Management routes for the secrets page: write the vault, DSH's own
 * credential store and the agent-hub connection file from a logged-in browser.
 *
 *   POST /api/secrets/vault/set          {name, value, description?, tags?}
 *   POST /api/secrets/vault/describe     {name, description?, tags?}
 *   POST /api/secrets/vault/rename       {from, to, overwrite?}
 *   POST /api/secrets/vault/delete       {name}
 *   GET  /api/secrets/credentials        presence of the managed credential refs
 *   POST /api/secrets/credentials/set    {ref, value}
 *   POST /api/secrets/credentials/unset  {ref}
 *   GET  /api/secrets/plugins            selfdsh plugins, installed?, what each needs
 *   POST /api/secrets/hub/set            {name, value}  (agent-hub controller.env)
 *   POST /api/secrets/hub/unset          {name}
 *
 * "Write and use, never read" still holds: a value goes in and never comes
 * back. Vault writes run the very same `secret_*` tool definitions (same
 * validation, same lock, same log line). Credential answers carry presence and
 * source only (the provider's `masked` hint is dropped). The one file value
 * that is shown is a non-secret connection setting (hub URL / proxy), so the
 * hub address can be changed here when the server's address moves.
 *
 * Every POST must be `application/json`, carry `x-dsh-secrets: 1` (a header a
 * cross-site form cannot send) and, when the browser sends `Origin`, come from
 * this host. Bodies are capped at 64 KiB.
 *
 * @module dsh-host-secrets/manage
 */

import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { BRIDGE_BASE, classifyLoadError, keyConfigured } from './bridge.js'

export const VAULT_SET_PATH = `${BRIDGE_BASE}/vault/set`
export const VAULT_DESCRIBE_PATH = `${BRIDGE_BASE}/vault/describe`
export const VAULT_RENAME_PATH = `${BRIDGE_BASE}/vault/rename`
export const VAULT_DELETE_PATH = `${BRIDGE_BASE}/vault/delete`
export const CREDENTIALS_PATH = `${BRIDGE_BASE}/credentials`
export const CREDENTIALS_SET_PATH = `${BRIDGE_BASE}/credentials/set`
export const CREDENTIALS_UNSET_PATH = `${BRIDGE_BASE}/credentials/unset`
export const PLUGINS_PATH = `${BRIDGE_BASE}/plugins`
export const HUB_SET_PATH = `${BRIDGE_BASE}/hub/set`
export const HUB_UNSET_PATH = `${BRIDGE_BASE}/hub/unset`

/** Request header every write must carry. */
export const WRITE_HEADER = 'x-dsh-secrets'
const MAX_BODY_BYTES = 64 * 1024
const MAX_CREDENTIAL_BYTES = 8 * 1024
const REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Credential refs the page manages by default (who uses them is in CATALOG). */
export const DEFAULT_CREDENTIAL_REFS = ['DEEPSEEK_API_KEY', 'EXA_API_KEY', 'GITHUB_TOKEN', 'GITEA_TOKEN']

/** agent-hub controller.env keys the page edits; `secret` ones are write-only. */
export const HUB_KEYS = [
  { key: 'DSH_HUB_URL', secret: false, required: true },
  { key: 'DSH_HUB_TOKEN', secret: true, required: true },
  { key: 'DSH_HUB_PROXY', secret: false, required: false },
]

/**
 * selfdsh plugins and what each needs. `credential` = DSH credential store,
 * `hub` = agent-hub controller.env, `vault-key` = this vault's master key.
 */
export const CATALOG = [
  { id: 'dsh-router-b', needs: [
    { key: 'DEEPSEEK_API_KEY', kind: 'credential', required: true },
    { key: 'EXA_API_KEY', kind: 'credential', required: false },
    { key: 'GITHUB_TOKEN', kind: 'credential', required: false },
    { key: 'GITEA_TOKEN', kind: 'credential', required: false },
  ] },
  { id: 'dsh-agent-hub', needs: HUB_KEYS.map(({ key, required }) => ({ key, kind: 'hub', required })) },
  { id: 'dsh-secrets', needs: [{ key: 'DSH_SECRETS_PASSPHRASE', kind: 'vault-key', required: true }] },
  { id: 'dsh-egress', needs: [] },
  { id: 'dsh-vpn', needs: [] },
  { id: 'dsh-token-stats', needs: [] },
]

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

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

const messageOf = error => (error instanceof Error ? error.message : String(error))

/** Reject anything a cross-site page could send. */
function assertSameSiteWrite(req) {
  const headers = req.headers ?? {}
  if (headers[WRITE_HEADER] !== '1') throw new HttpError(403, 'forbidden', `writes need the ${WRITE_HEADER}: 1 header`)
  if (!/^application\/json\b/i.test(String(headers['content-type'] ?? ''))) throw new HttpError(415, 'unsupported-media-type', 'send application/json')
  const origin = headers.origin
  if (origin !== undefined && origin !== 'null') {
    let host
    try { host = new URL(origin).host } catch { host = undefined }
    if (host === undefined || host !== headers.host) throw new HttpError(403, 'forbidden', 'cross-origin write refused')
  } else if (origin === 'null') {
    throw new HttpError(403, 'forbidden', 'cross-origin write refused')
  }
}

/** Read and parse a JSON object body (≤ 64 KiB). */
export async function readJsonBody(req) {
  if (req.body !== undefined) return req.body // test seam and pre-parsed bodies
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'too-large', `body is larger than ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, 'bad-json', 'body is not JSON') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'bad-json', 'body must be a JSON object')
  return value
}

/** A route answering one method; errors become `{error: {code, message}}`. */
function route(path, method, logger, answer) {
  return {
    kind: 'exact',
    path,
    async handler(req, res) {
      if (req.method !== method) {
        sendJson(res, 405, { error: { code: 'method-not-allowed', message: `use ${method}` } }, { allow: method })
        return
      }
      try {
        let body
        if (method === 'POST') {
          assertSameSiteWrite(req)
          body = await readJsonBody(req)
        }
        sendJson(res, 200, await answer(body))
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { error: { code: error.code, message: error.message } })
          return
        }
        const message = messageOf(error)
        const locked = classifyLoadError(error)
        if (locked.state === 'locked') {
          sendJson(res, 409, { error: { code: 'vault-locked', message } })
          return
        }
        logger?.warn?.(`dsh-secrets: ${path} refused: ${message}`)
        sendJson(res, 400, { error: { code: 'rejected', message } })
      }
    },
  }
}

// --- env file (controller.env) -------------------------------------------------

/** Quote a value for the agent-hub `.env` reader (quoted values are literal). */
export function envLine(key, value) {
  if (/[\r\n\0]/.test(value)) throw new HttpError(400, 'bad-value', 'value must be one line')
  if (value.trim() === '') throw new HttpError(400, 'bad-value', 'value is empty; use unset')
  if (!value.includes('"')) return `${key}="${value}"`
  if (!value.includes("'")) return `${key}='${value}'`
  throw new HttpError(400, 'bad-value', 'value cannot contain both quote characters')
}

const keyOfLine = (line) => {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
  return match === null ? undefined : match[1]
}

/** Parse the same subset the agent-hub reader accepts (last definition wins). */
export function parseEnvText(text) {
  const out = Object.create(null)
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const key = keyOfLine(raw)
    if (key === undefined) continue
    let value = raw.slice(raw.indexOf('=') + 1).trim()
    const quote = value[0]
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1)
      if (end < 0) continue
      value = value.slice(1, end)
    } else if (value.startsWith('#')) {
      value = ''
    } else {
      const hash = value.search(/\s#/)
      if (hash >= 0) value = value.slice(0, hash).trimEnd()
    }
    out[key] = value
  }
  return out
}

async function readText(path) {
  try { return await readFile(path, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Replace (or with `value === undefined` remove) every line defining `key`,
 * keeping all other lines; written atomically at mode 0600 in a 0700 dir.
 */
export async function writeEnvKey(path, key, value) {
  const text = (await readText(path)) ?? ''
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/)
  const next = []
  let placed = false
  for (const line of lines) {
    if (keyOfLine(line) !== key) { next.push(line); continue }
    if (value !== undefined && !placed) { next.push(envLine(key, value)); placed = true }
  }
  if (value !== undefined && !placed) next.push(envLine(key, value))
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  const handle = await open(temp, 'w', 0o600)
  try {
    await handle.writeFile(next.length === 0 ? '' : `${next.join('\n')}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try { await rename(temp, path) } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

// --- profiles ------------------------------------------------------------------

/** `--profile NAME` / `--profile=NAME` of this process, if any. */
export function profileFromArgv(argv = process.argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile' && typeof argv[i + 1] === 'string') return argv[i + 1]
    if (typeof arg === 'string' && arg.startsWith('--profile=')) return arg.slice('--profile='.length)
  }
  return undefined
}

/** Bundles listed by each profile under `<home>/profiles` (only the running one when known). */
export async function readProfiles(home, running = profileFromArgv()) {
  const root = join(home, 'profiles')
  let names
  if (running !== undefined && /^[A-Za-z0-9._-]+$/.test(running)) names = [running]
  else {
    try { names = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() } catch { names = [] }
  }
  const profiles = []
  for (const name of names) {
    let bundles = []
    try {
      const json = JSON.parse(await readFile(join(root, name, 'package.json'), 'utf8'))
      const listed = json?.dsh?.profile?.bundles
      if (Array.isArray(listed)) bundles = listed.filter(entry => typeof entry === 'string')
    } catch { /* missing or broken profile: listed with no bundles */ }
    profiles.push({ name, running: name === running, bundles })
  }
  return profiles
}

// --- routes --------------------------------------------------------------------

/**
 * @param {{ vault: import('./vault.js').Vault, tools: any[], config: any, logger?: any, credentials: () => any }} deps
 *   `credentials` reads DSH's `credentials` service at request time (may be undefined).
 */
export function createManageRoutes({ vault, tools, config, logger, credentials }) {
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const runTool = (name, args) => byName.get(name).execute(args, { signal: AbortSignal.timeout(30_000) })
  const pickArgs = (body, keys) => Object.fromEntries(keys.filter(key => body[key] !== undefined).map(key => [key, body[key]]))
  const managedRefs = [...new Set([...DEFAULT_CREDENTIAL_REFS, ...config.manageCredentialRefs])]
  const hubKeys = new Map(HUB_KEYS.map(entry => [entry.key, entry]))
  const log = (message) => { try { logger?.info?.(message) } catch { /* ignore */ } }

  const service = () => {
    let found
    try { found = credentials() } catch { found = undefined }
    return found !== undefined && typeof found?.describe === 'function' ? found : undefined
  }

  const describeRef = async (ref) => {
    const store = service()
    if (store === undefined) return { ref, configured: false, source: 'unknown', writable: false }
    try {
      const info = await store.describe(ref)
      // `masked` is dropped on purpose: no part of a value leaves this module.
      return { ref, configured: info?.configured === true, source: typeof info?.source === 'string' ? info.source : null, writable: info?.writable === true }
    } catch {
      return { ref, configured: false, source: 'unknown', writable: false }
    }
  }

  const requireRef = (raw) => {
    if (typeof raw !== 'string' || !REF_RE.test(raw)) throw new HttpError(400, 'bad-ref', 'ref must be an environment-variable name')
    if (!managedRefs.includes(raw)) throw new HttpError(403, 'unmanaged-ref', `${raw} is not managed here (config manageCredentialRefs)`)
    return raw
  }

  const hubStatus = async () => {
    let values = Object.create(null)
    let exists = false
    let error
    try {
      const text = await readText(config.hubEnvFile)
      if (text !== undefined) { exists = true; values = parseEnvText(text) }
    } catch (failure) { error = failure?.code ?? 'error' }
    const items = HUB_KEYS.map(({ key, secret, required }) => {
      const fromEnv = typeof process.env[key] === 'string' && process.env[key].trim() !== ''
      const fromFile = typeof values[key] === 'string' && values[key].trim() !== ''
      return {
        key,
        secret,
        required,
        configured: fromEnv || fromFile,
        source: fromEnv ? 'env' : fromFile ? 'file' : null,
        // The process environment wins over the file in agent-hub; say so.
        shadowed: fromEnv && fromFile,
        ...secret ? {} : { value: fromFile ? values[key].trim() : fromEnv ? process.env[key].trim() : null },
      }
    })
    return { file: config.hubEnvFile, exists, ...error === undefined ? {} : { error }, items }
  }

  return [
    route(VAULT_SET_PATH, 'POST', logger, body => runTool('secret_set', pickArgs(body, ['name', 'value', 'description', 'tags']))),
    route(VAULT_DESCRIBE_PATH, 'POST', logger, body => runTool('secret_describe', pickArgs(body, ['name', 'description', 'tags']))),
    route(VAULT_RENAME_PATH, 'POST', logger, body => runTool('secret_rename', pickArgs(body, ['from', 'to', 'overwrite']))),
    route(VAULT_DELETE_PATH, 'POST', logger, body => runTool('secret_delete', pickArgs(body, ['name']))),

    route(CREDENTIALS_PATH, 'GET', logger, async () => ({
      generatedAt: new Date().toISOString(),
      available: service() !== undefined,
      items: await Promise.all(managedRefs.map(describeRef)),
    })),
    route(CREDENTIALS_SET_PATH, 'POST', logger, async (body) => {
      const ref = requireRef(body.ref)
      const value = body.value
      if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, 'bad-value', 'value must be a non-empty string')
      if (Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_BYTES) throw new HttpError(400, 'bad-value', `value is larger than ${MAX_CREDENTIAL_BYTES} bytes`)
      const store = service()
      if (store === undefined || typeof store.set !== 'function') throw new HttpError(503, 'no-credential-store', 'this DSH has no credential store mounted')
      await store.set(ref, value)
      log(`dsh-secrets: page stored credential ${ref}`)
      return describeRef(ref)
    }),
    route(CREDENTIALS_UNSET_PATH, 'POST', logger, async (body) => {
      const ref = requireRef(body.ref)
      const store = service()
      if (store === undefined || typeof store.unset !== 'function') throw new HttpError(503, 'no-credential-store', 'this DSH has no credential store mounted')
      await store.unset(ref)
      log(`dsh-secrets: page cleared credential ${ref}`)
      return describeRef(ref)
    }),

    route(PLUGINS_PATH, 'GET', logger, async () => {
      const profiles = await readProfiles(config.dshHome)
      const credentialsByRef = new Map((await Promise.all(managedRefs.map(describeRef))).map(entry => [entry.ref, entry]))
      const hub = await hubStatus()
      const hubByKey = new Map(hub.items.map(entry => [entry.key, entry]))
      const vaultKey = await keyConfigured(vault)
      const plugins = CATALOG.map(({ id, needs }) => {
        const inProfiles = profiles.filter(profile => profile.bundles.includes(id)).map(profile => profile.name)
        return {
          id,
          installed: inProfiles.length > 0,
          profiles: inProfiles,
          needs: needs.map((need) => {
            if (need.kind === 'credential') {
              const status = credentialsByRef.get(need.key)
              return { ...need, configured: status?.configured === true, source: status?.source ?? null }
            }
            if (need.kind === 'hub') {
              const status = hubByKey.get(need.key)
              return { ...need, configured: status?.configured === true, source: status?.source ?? null }
            }
            return { ...need, configured: vaultKey, source: vault.keySource }
          }),
        }
      })
      return {
        generatedAt: new Date().toISOString(),
        profiles: profiles.map(({ name, running }) => ({ name, running })),
        credentialStore: service() !== undefined,
        hub,
        plugins,
      }
    }),
    route(HUB_SET_PATH, 'POST', logger, async (body) => {
      const key = body.name
      if (typeof key !== 'string' || !hubKeys.has(key)) throw new HttpError(400, 'bad-name', `name must be one of ${HUB_KEYS.map(entry => entry.key).join(', ')}`)
      if (typeof body.value !== 'string') throw new HttpError(400, 'bad-value', 'value must be a string')
      const value = body.value.trim()
      // Same grammar agent-hub accepts: hub = http(s) URL; proxy = off/direct/env words or an http:// URL.
      const proxyWord = key === 'DSH_HUB_PROXY' && /^(off|none|direct|false|no|env|system)$/i.test(value)
      if ((key === 'DSH_HUB_URL' || key === 'DSH_HUB_PROXY') && !proxyWord) {
        let url
        try { url = new URL(value) } catch { throw new HttpError(400, 'bad-value', `${key} must be a URL`) }
        const schemes = key === 'DSH_HUB_URL' ? ['http:', 'https:'] : ['http:']
        if (!schemes.includes(url.protocol)) throw new HttpError(400, 'bad-value', `${key} must start with ${schemes.join(' or ').replace(/:/g, '://')}`)
        if (url.username !== '' || url.password !== '') throw new HttpError(400, 'bad-value', `${key} must not carry a user name or password`)
      }
      await writeEnvKey(config.hubEnvFile, key, value)
      log(`dsh-secrets: page set ${key} in ${config.hubEnvFile}`)
      return hubStatus()
    }),
    route(HUB_UNSET_PATH, 'POST', logger, async (body) => {
      const key = body.name
      if (typeof key !== 'string' || !hubKeys.has(key)) throw new HttpError(400, 'bad-name', `name must be one of ${HUB_KEYS.map(entry => entry.key).join(', ')}`)
      if (await readText(config.hubEnvFile) !== undefined) await writeEnvKey(config.hubEnvFile, key, undefined)
      log(`dsh-secrets: page removed ${key} from ${config.hubEnvFile}`)
      return hubStatus()
    }),
  ]
}

