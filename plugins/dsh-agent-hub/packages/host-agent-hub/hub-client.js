/**
 * Controller-side client of the standalone dsh-hub (protocol `dsh-agent/2.0`,
 * docs/DSH-HUB-PROTOCOL-v2.md section 5.2).
 *
 * Every request:
 *   - goes to `<hubUrl>/v1/ctl/<path>` (the hub listens on 7891 by default);
 *   - carries `?id=<controllerId>` as the FIRST query parameter (routing / logs);
 *   - carries the controller token in the `X-DSH-Token` header, never in the query.
 *
 * Transport: `node:https` / `node:http` `request()` (not global fetch), because
 * only `request()` accepts a per-request `ca` option. With `caFile` set, that PEM
 * is the ONLY trust anchor for the hub (self-signed hub certificate); without it
 * the system CAs are used. Plain `http://` is accepted only for loopback hosts
 * (a hub without TLS only listens on 127.0.0.1), so the token never crosses a
 * network in clear text.
 *
 * Proxy (config `proxy`, see proxy.js): `https.request` does not read
 * HTTPS_PROXY, so with `proxy: http://127.0.0.1:7890` (MYDESK: Clash / mihomo)
 * or `proxy: env` the client first opens `CONNECT <hub>:<port>` on the proxy,
 * then TLS (servername = hub host, ca = caFile) over that tunnel, and sends
 * the request on it (`createConnection`). Unset = direct. http:// hubs
 * (loopback) are never proxied. Proxy credentials never reach logs or errors.
 *
 * Token, looked up on every call (no restart needed after rotating it):
 *   1. the process environment variable named by `tokenEnv` (default DSH_HUB_TOKEN);
 *   2. otherwise the `<tokenEnv>=...` line of the `.env`-format file `envFile`
 *      (default `<DSH home>/agent-hub/controller.env`, DSH home = $DSH_HOME or ~/.dsh);
 *      a missing file is skipped silently, a file readable by group/others on POSIX
 *      gets a warning.
 *   NOT `<DSH home>/.env`: that file is DSH's own credential file, and DSH refuses
 *   to start when it sets ANY `DSH_*` variable (those may only come from the
 *   launching environment). So when `envFile` resolves to `<DSH home>/.env`
 *   (compared normalized, case-insensitively, `\` == `/`) and `tokenEnv` starts
 *   with `DSH_`, the file is NOT read and resolveConfig() warns how to migrate;
 *   with another variable name it is read, with a weaker warning.
 * The value is never logged, never part of an error message, a tool output or a
 * panel response: every message that leaves this module goes through `redact()`,
 * which masks the configured token and anything shaped like `dshc_...` / `dsha_...`.
 *
 * Failures are `HubError { status, code, message, fromHub }`:
 *   local configuration    503 hub-not-configured | hub-token-missing | hub-token-mismatch | hub-ca-unreadable
 *   network / TLS / timeout 503 hub-unreachable   (also: proxy down, CONNECT refused, TLS through the tunnel)
 *   hub answered non-2xx    the hub's status + `{error:{code,message}}` (fromHub = true)
 *   hub answered garbage    502 hub-bad-response
 *
 * @module host-agent-hub/hub-client
 */

import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readEnvFile } from './env-file.js'
import { TunnelError, openTunnel, proxySetting, resolveProxy, scrubProxy } from './proxy.js'

export const PROTOCOL = 'dsh-agent/2.0'
/** Default name of the token variable (config `tokenEnv` may change it). */
export const TOKEN_ENV = 'DSH_HUB_TOKEN'
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
export const TOKEN_HEADER = 'X-DSH-Token'
/** Same rule as the hub: `/^[a-z][a-z0-9-]{1,47}$/` (worker and controller ids). */
export const ID_RE = /^[a-z][a-z0-9-]{1,47}$/
export const POOL_RE = /^pool:[a-z][a-z0-9-]{0,47}$/
export const TASK_ID_RE = /^[A-Za-z0-9_.-]{1,96}$/
export const DEFAULT_TIMEOUT_MS = 15_000
export const MIN_TIMEOUT_MS = 1_000
export const MAX_TIMEOUT_MS = 120_000
/** Largest JSON document / output file the client accepts from the hub. */
export const MAX_JSON_BYTES = 16 * 1024 * 1024
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/** Local configuration problems: the request is never sent. */
export const CONFIG_CODES = new Set(['hub-not-configured', 'hub-token-missing', 'hub-token-mismatch', 'hub-ca-unreadable'])

/** A caller-visible failure with an HTTP status and a stable code. */
export class HubError extends Error {
  constructor(status, code, message, { fromHub = false } = {}) {
    super(message)
    // defineProperty, not assignment: works even where Error.prototype is frozen.
    Object.defineProperty(this, 'name', { value: 'HubError', configurable: true, writable: true })
    this.status = status
    this.code = code
    this.fromHub = fromHub
  }
}

const TOKEN_SHAPE_RE = /dsh[ac]_[A-Za-z0-9_-]+/g

/** Mask the configured token and anything that looks like a hub token. */
export function redact(value, token) {
  let text = String(value ?? '')
  if (typeof token === 'string' && token.length >= 8) text = text.split(token).join('***')
  return text.replace(TOKEN_SHAPE_RE, m => `${m.slice(0, 5)}***`)
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** DSH home = $DSH_HOME or ~/.dsh. */
export function dshHomeDir(env = globalThis.process?.env ?? {}, home = homedir) {
  return typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : join(home(), '.dsh')
}

/** Default envFile: `<DSH home>/agent-hub/controller.env` (a file of its own, NOT DSH's `.env`). */
export function defaultEnvFile(env = globalThis.process?.env ?? {}, home = homedir) {
  return join(dshHomeDir(env, home), 'agent-hub', 'controller.env')
}

/**
 * `<DSH home>/.env`: DSH's OWN credential file. DSH refuses to start when it sets
 * any `DSH_*` variable ("only the launching environment may set" those).
 */
export function dshCredentialsFile(env = globalThis.process?.env ?? {}, home = homedir) {
  return join(dshHomeDir(env, home), '.env')
}

/**
 * Comparable form of a path: `\` -> `/`, empty / `.` segments dropped, `..` applied,
 * no trailing separator, lower case (Windows paths are case-insensitive).
 */
export function comparablePath(path) {
  const text = String(path ?? '').trim().replace(/\\/g, '/')
  const absolute = text.startsWith('/')
  const out = []
  for (const segment of text.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length > 0 && out.at(-1) !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(segment)
  }
  return `${absolute ? '/' : ''}${out.join('/')}`.toLowerCase()
}

/** True when `path` is `<DSH home>/.env` (normalized, case-insensitive, either separator). */
export function isDshCredentialsFile(path, env = globalThis.process?.env ?? {}, home = homedir) {
  return comparablePath(path) === comparablePath(dshCredentialsFile(env, home))
}

/** DSH reserves every `DSH_*` name for the launching environment (case-insensitive, as on Windows). */
export const RESERVED_ENV_RE = /^DSH_/i

/**
 * Validate the plugin config. Never throws: returns `{ problems }` (fatal: every
 * call then fails with a clear `hub-not-configured`, but the plugin still loads)
 * and `{ warnings }` (a default was used instead).
 *
 * @param {{ hubUrl?: string, controllerId?: string, caFile?: string, timeoutMs?: number, tokenEnv?: string, envFile?: string, proxy?: string | false }} config
 * @param {{ env?: object, homedir?: () => string }} [deps]
 */
export function resolveConfig(config = {}, deps = {}) {
  const problems = []
  const warnings = []
  let base
  const rawUrl = typeof config.hubUrl === 'string' ? config.hubUrl.trim() : ''
  if (rawUrl === '') problems.push('config.hubUrl is not set (e.g. https://<hub-host>:7891)')
  else {
    try { base = new URL(rawUrl) } catch { problems.push('config.hubUrl is not a valid URL') }
    if (base !== undefined) {
      if (base.protocol !== 'https:' && base.protocol !== 'http:') problems.push('config.hubUrl must be http(s)://')
      else if (base.protocol === 'http:' && !LOOPBACK.has(base.hostname)) problems.push('config.hubUrl must use https:// unless the hub is on this machine (127.0.0.1 / localhost)')
      if (base.username !== '' || base.password !== '') problems.push('config.hubUrl must not contain credentials')
      if (base.search !== '' || base.hash !== '') problems.push('config.hubUrl must not contain a query or fragment')
    }
  }
  const controllerId = typeof config.controllerId === 'string' ? config.controllerId.trim() : ''
  if (controllerId === '') problems.push('config.controllerId is not set (e.g. dsh-cloud)')
  else if (!ID_RE.test(controllerId)) problems.push('config.controllerId must match /^[a-z][a-z0-9-]{1,47}$/')
  const caFile = typeof config.caFile === 'string' && config.caFile.trim() !== '' ? config.caFile.trim() : undefined
  if (caFile !== undefined && base?.protocol === 'http:') problems.push('config.caFile only applies to an https:// hubUrl')
  let timeoutMs = DEFAULT_TIMEOUT_MS
  if (config.timeoutMs !== undefined) {
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < MIN_TIMEOUT_MS || config.timeoutMs > MAX_TIMEOUT_MS) {
      warnings.push(`config.timeoutMs must be an integer ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}; using ${DEFAULT_TIMEOUT_MS}`)
    } else timeoutMs = config.timeoutMs
  }
  let tokenEnv = TOKEN_ENV
  if (config.tokenEnv !== undefined) {
    if (typeof config.tokenEnv !== 'string' || !ENV_NAME_RE.test(config.tokenEnv.trim())) warnings.push(`config.tokenEnv must be a variable name like ${TOKEN_ENV}; using ${TOKEN_ENV}`)
    else tokenEnv = config.tokenEnv.trim()
  }
  const homeEnv = deps.env ?? globalThis.process?.env ?? {}
  const homeFn = deps.homedir ?? homedir
  const recommendedEnvFile = defaultEnvFile(homeEnv, homeFn)
  const envFile = typeof config.envFile === 'string' && config.envFile.trim() !== ''
    ? config.envFile.trim()
    : recommendedEnvFile
  // <DSH home>/.env belongs to DSH itself: a DSH_* line there makes DSH refuse to start.
  let envFileBlocked = false
  if (isDshCredentialsFile(envFile, homeEnv, homeFn)) {
    if (RESERVED_ENV_RE.test(tokenEnv)) {
      envFileBlocked = true
      warnings.push(`config.envFile ${envFile} is DSH's own <DSH home>/.env and is NOT read for ${tokenEnv}: DSH 不允许 <DSH home>/.env 里出现 DSH_ 开头的变量（会拒绝启动）；把 ${tokenEnv} 移到 <DSH home>/agent-hub/controller.env（${recommendedEnvFile}），或改用其他变量名`)
    } else {
      warnings.push(`config.envFile ${envFile} is DSH's own <DSH home>/.env (DSH 凭据层的文件); ${tokenEnv} is read from it, but a separate file is safer: <DSH home>/agent-hub/controller.env (${recommendedEnvFile})`)
    }
  }
  const proxy = proxySetting(config.proxy)
  if (proxy.mode === 'invalid') problems.push(proxy.problem)
  else if (proxy.mode !== 'direct' && base?.protocol === 'http:') warnings.push('config.proxy is ignored: an http:// hubUrl is a loopback hub, never proxied')
  const basePath = base === undefined ? '' : base.pathname.replace(/\/+$/, '')
  return {
    ok: problems.length === 0,
    problems,
    warnings,
    tokenEnv,
    envFile,
    /** true: envFile is `<DSH home>/.env` and tokenEnv is a DSH_* name, so the file is never read. */
    envFileBlocked,
    recommendedEnvFile,
    hubUrl: base === undefined ? undefined : `${base.origin}${basePath}`,
    origin: base?.origin,
    basePath,
    secure: base?.protocol === 'https:',
    controllerId,
    caFile,
    timeoutMs,
    /** 'direct' | 'env' | 'url' (| 'invalid'); `proxy` is the masked URL, never with credentials. */
    proxyMode: proxy.mode,
    proxy: proxy.mode === 'url' ? proxy.proxy.display : proxy.mode === 'env' ? 'env' : undefined,
  }
}

/** `<tokenEnv> is not set (...)`, naming where it was looked for (no value). */
export function tokenMissingMessage(config) {
  if (config.envFileBlocked) return `${config.tokenEnv} is not set (not in the environment; ${config.envFile} is DSH's own .env and is not read for DSH_* names, use ${config.recommendedEnvFile})`
  return `${config.tokenEnv} is not set (neither in the environment nor in ${config.envFile})`
}

/** Network error codes worth naming in the message (no secrets in these). */
function describeNetworkError(error) {
  const code = typeof error?.code === 'string' ? error.code : undefined
  if (code === 'ETIMEDOUT_HUB') return 'timed out'
  if (code !== undefined && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|HOSTNAME|ALTNAME/.test(code)) return `TLS verification failed (${code}); set caFile to the hub certificate`
  return code ?? (error instanceof Error ? error.message : String(error))
}

const asList = (body, key) => {
  if (Array.isArray(body)) return body
  if (body !== null && typeof body === 'object' && Array.isArray(body[key])) return body[key]
  throw new HubError(502, 'hub-bad-response', `hub response has no ${key} list`)
}

const asObject = (body, key) => {
  const value = body !== null && typeof body === 'object' && key !== undefined && body[key] !== null && typeof body[key] === 'object' && !Array.isArray(body[key]) ? body[key] : body
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HubError(502, 'hub-bad-response', 'hub response is not a JSON object')
  return value
}

/** Drop `undefined` keys so the hub sees only what the caller set. */
const compact = obj => Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v !== undefined))

/**
 * @param {{
 *   hubUrl?: string, controllerId?: string, caFile?: string, timeoutMs?: number,
 *   env?: Record<string, string | undefined>, logger?: any,
 *   request?: (url: URL, options: object, onResponse: (res: any) => void) => any,
 *   readCa?: (path: string) => Promise<Buffer | string>,
 * }} options
 */
export function createHubClient(options = {}) {
  const env = options.env ?? globalThis.process?.env ?? {}
  const config = resolveConfig(options, { env, homedir: options.homedir })
  const logger = options.logger
  const fs = options.fs ?? { readFileSync, statSync }
  const platform = options.platform ?? globalThis.process?.platform
  const warned = new Set()
  const readCa = options.readCa ?? (path => readFile(path))
  const transport = options.request ?? ((url, opts, cb) => (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, opts, cb))
  const proxyConfig = proxySetting(options.proxy) // closure only: the parsed form holds credentials
  const tunnelDeps = options.tunnel ?? {}
  let caPromise

  /** Warn once per distinct message (never contains a value). */
  const warnOnce = (message) => {
    if (warned.has(message)) return
    warned.add(message)
    try { logger?.warn?.(`agent-hub: ${message}`) } catch { /* ignore */ }
  }

  /** `{ value, source: 'env' | 'envFile' }` or `{ value: undefined }`. Re-read on every call. */
  function lookupToken() {
    const fromEnv = env[config.tokenEnv]
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return { value: fromEnv.trim(), source: 'env' }
    if (config.envFileBlocked) return { value: undefined, source: undefined } // DSH's own .env: never read for DSH_*
    const file = readEnvFile(config.envFile, { fs, platform })
    if (file.warning !== undefined) warnOnce(file.warning)
    const fromFile = file.values[config.tokenEnv]
    if (typeof fromFile === 'string' && fromFile.trim() !== '') return { value: fromFile.trim(), source: 'envFile' }
    return { value: undefined, source: undefined }
  }
  const token = () => lookupToken().value

  /** Message text safe to show anywhere. */
  const safe = text => redact(text, token())

  /** JSON value with the configured controller token replaced (tool outputs). Worker tokens are left alone. */
  function scrub(value) {
    const secret = token()
    if (secret === undefined || secret.length < 8) return value
    let json
    try { json = JSON.stringify(value) } catch { return value }
    if (json === undefined || !json.includes(secret)) return value
    return JSON.parse(json.split(secret).join('***'))
  }

  function ensureReady() {
    if (!config.ok) throw new HubError(503, 'hub-not-configured', `agent-hub is not configured: ${config.problems.join('; ')}`)
    const value = token()
    if (value === undefined) throw new HubError(503, 'hub-token-missing', `${tokenMissingMessage(config)}: issue a controller token on the hub machine (node server.mjs controller add ${config.controllerId}) and put it into the DSH service environment or ${config.envFileBlocked ? config.recommendedEnvFile : 'that env file'} (never into <DSH home>/.env: DSH refuses to start on DSH_* lines there)`)
    if (!value.startsWith(`dshc_${config.controllerId}_`)) throw new HubError(503, 'hub-token-mismatch', `${config.tokenEnv} is not a controller token of "${config.controllerId}" (expected dshc_${config.controllerId}_...)`)
    return value
  }

  async function loadCa() {
    if (config.caFile === undefined) return undefined
    caPromise ??= Promise.resolve().then(() => readCa(config.caFile)).catch((error) => {
      caPromise = undefined // retry on the next call (file may be fixed meanwhile)
      throw new HubError(503, 'hub-ca-unreadable', `cannot read caFile ${config.caFile}: ${error?.code ?? 'error'}`)
    })
    return caPromise
  }

  /** Build `<hubUrl>/v1/<path>?id=<controllerId>&<params>`. */
  function urlFor(path, params = {}) {
    const url = new URL(`${config.basePath}/v1/${path}`, config.origin)
    url.searchParams.set('id', config.controllerId)
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
    return url
  }

  /**
   * One HTTP exchange. Resolves `{ status, headers, body: Buffer }` for ANY status;
   * rejects with `hub-unreachable` when no response arrives (refused, DNS, TLS, timeout).
   */
  function exchange(method, url, headers, payload, ca, maxBytes, extra = {}) {
    return new Promise((resolve, reject) => {
      let settled = false
      let req
      const fail = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error instanceof HubError) { reject(error); return }
        reject(new HubError(503, 'hub-unreachable', safe(`hub unreachable (${config.hubUrl}): ${describeNetworkError(error)}`)))
      }
      const timer = setTimeout(() => {
        const error = new Error('timeout')
        error.code = 'ETIMEDOUT_HUB'
        try { req?.destroy?.(error) } catch { /* ignore */ }
        fail(error)
      }, config.timeoutMs)
      timer.unref?.()
      const opts = { method, headers, timeout: config.timeoutMs, ...extra }
      if (ca !== undefined) opts.ca = ca
      try {
        req = transport(url, opts, async (res) => {
          try {
            const chunks = []
            let size = 0
            for await (const chunk of res) {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
              size += buffer.length
              if (size > maxBytes) {
                try { res.destroy?.() } catch { /* ignore */ }
                throw new HubError(502, 'hub-bad-response', `hub response exceeds ${maxBytes} bytes`)
              }
              chunks.push(buffer)
            }
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve({ status: res.statusCode, headers: res.headers ?? {}, body: Buffer.concat(chunks) })
          } catch (error) { fail(error) }
        })
        req.on?.('error', fail)
        req.on?.('timeout', () => {
          const error = new Error('timeout')
          error.code = 'ETIMEDOUT_HUB'
          try { req.destroy?.(error) } catch { /* ignore */ }
          fail(error)
        })
        if (payload !== undefined) req.write(payload)
        req.end()
      } catch (error) { fail(error) }
    })
  }

  /** Proxy for one hub URL (env mode re-reads HTTPS_PROXY / NO_PROXY on every call). */
  function routeFor(url) {
    const route = resolveProxy(proxyConfig, url, env)
    if (route.problem !== undefined) throw new HubError(503, 'hub-not-configured', `agent-hub proxy: ${route.problem}`)
    return route
  }

  /** Parse `{error:{code,message}}` of a non-2xx answer into a HubError. */
  function hubFailure(status, body) {
    let parsed
    try { parsed = JSON.parse(body.toString('utf8')) } catch { parsed = undefined }
    const err = parsed?.error
    const code = typeof err?.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(err.code) ? err.code : `http-${status}`
    const message = typeof err?.message === 'string' ? err.message.slice(0, 2000) : `hub answered HTTP ${status}`
    return new HubError(status, code, safe(message), { fromHub: true })
  }

  /**
   * Call one hub route.
   * @param {'GET'|'POST'} method
   * @param {string} path      e.g. `ctl/tasks`
   * @param {{ query?: object, body?: object, raw?: boolean, auth?: boolean }} [init]
   */
  async function call(method, path, { query, body, raw = false, auth = true } = {}) {
    let value
    if (auth) value = ensureReady()
    else if (!config.ok) throw new HubError(503, 'hub-not-configured', `agent-hub is not configured: ${config.problems.join('; ')}`)
    const ca = await loadCa()
    const url = urlFor(path, query)
    const headers = { accept: raw ? 'application/octet-stream, application/json' : 'application/json' }
    if (auth) headers[TOKEN_HEADER] = value
    let payload
    if (method === 'POST') {
      payload = Buffer.from(JSON.stringify(compact(body)), 'utf8')
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.length)
    }
    const started = Date.now()
    const route = routeFor(url)
    const extra = {}
    if (route.proxy !== undefined) {
      let socket
      try {
        socket = await openTunnel({ proxy: route.proxy, target: url, timeoutMs: config.timeoutMs, ca, deps: tunnelDeps })
      } catch (error) {
        const reason = error instanceof TunnelError ? error.message : `tunnel failed (${error?.code ?? 'error'})`
        throw new HubError(503, 'hub-unreachable', safe(scrubProxy(`hub unreachable (${config.hubUrl}) via proxy ${route.proxy.display}: ${reason}`, route.proxy)))
      }
      extra.createConnection = () => socket
    }
    const res = await exchange(method, url, headers, payload, ca, raw ? MAX_OUTPUT_BYTES : MAX_JSON_BYTES, extra)
    // Log line: method, path, status, route (masked proxy) only.
    try { logger?.debug?.(`agent-hub: ${method} /v1/${path} -> ${res.status} (${Date.now() - started} ms${route.proxy ? ` via ${route.proxy.display}` : ''})`) } catch { /* ignore */ }
    if (res.status < 200 || res.status >= 300) throw hubFailure(res.status, res.body)
    if (raw) return res.body
    const text = res.body.toString('utf8').trim()
    if (text === '') return {}
    try { return JSON.parse(text) } catch { throw new HubError(502, 'hub-bad-response', 'hub response is not JSON') }
  }

  const ctlGet = (path, query, init) => call('GET', `ctl/${path}`, { query, ...init })
  const ctlPost = (path, body) => call('POST', `ctl/${path}`, { body })

  return {
    config,
    /** True when a token is found (value never exposed). */
    hasToken: () => token() !== undefined,
    /** Where the token comes from: 'env' | 'envFile' | undefined (value never exposed). */
    tokenSource: () => lookupToken().source,
    redact: safe,
    scrub,
    call,
    /** How the hub is reached right now: `{ via: 'direct' | <masked proxy URL>, source }` (no credentials). */
    route: () => {
      if (!config.ok) return { via: 'direct', source: 'not configured' }
      const r = resolveProxy(proxyConfig, new URL(`${config.origin}/`), env)
      return { via: r.proxy?.display ?? 'direct', source: r.problem ?? r.source }
    },

    /** `GET /v1/health` (no token): `{ ok, version }`. */
    health: () => call('GET', 'health', { auth: false }),

    // --- tasks ---------------------------------------------------------------
    /** `POST /v1/ctl/dispatch` with the task fields of section 4 (+ require_online). Hub `warnings` are kept. */
    dispatch: async (task) => {
      const body = await ctlPost('dispatch', task)
      const out = { ...asObject(body, 'task') }
      const warnings = Array.isArray(body?.warnings) ? body.warnings : out.warnings
      if (Array.isArray(warnings) && warnings.length > 0) out.warnings = warnings.filter(w => typeof w === 'string').map(w => w.slice(0, 64))
      return out
    },
    /** `GET /v1/ctl/tasks?status=&agent=&workspace=&limit=` → task array. */
    listTasks: async ({ status, agent, workspace, limit } = {}) => asList(await ctlGet('tasks', { status, agent, workspace, limit }), 'tasks'),
    /** `GET /v1/ctl/task?task_id=` → task with history and result. */
    getTask: async taskId => asObject(await ctlGet('task', { task_id: taskId }), 'task'),
    /** `GET /v1/ctl/output?task_id=&name=` → Buffer. */
    readOutput: (taskId, name) => ctlGet('output', { task_id: taskId, name }, { raw: true }),
    cancel: async (taskId, reason) => asObject(await ctlPost('cancel', { task_id: taskId, reason }), 'task'),
    retry: async (taskId, agent) => asObject(await ctlPost('retry', { task_id: taskId, agent }), 'task'),

    // --- workers and enrollment ---------------------------------------------
    listAgents: async () => asList(await ctlGet('agents'), 'agents'),
    listRequests: async status => asList(await ctlGet('requests', { status }), 'requests'),
    approve: async ({ request_id, capabilities, workspaces, max_concurrency }) => asObject(await ctlPost('approve', { request_id, capabilities, workspaces, max_concurrency })),
    reject: async (requestId, reason) => asObject(await ctlPost('reject', { request_id: requestId, reason })),
    revoke: async agentId => asObject(await ctlPost('revoke', { agent_id: agentId })),
    provision: async body => asObject(await ctlPost('provision', body)),

    /** `GET /v1/ctl/overview` (for the panel). */
    overview: async () => asObject(await ctlGet('overview')),
  }
}
