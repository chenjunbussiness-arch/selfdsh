/**
 * The request hook: choose an exit per target host, send through it, and fail
 * closed.
 *
 * Why `globalThis.fetch`: the pi-ai OpenAI-completions provider builds a new
 * OpenAI client for every request and that client resolves `fetch` at
 * construction (`openai/internal/shims.js getDefaultFetch`), so replacing the
 * global affects the very next model request and no restart is needed. See
 * `docs/RESEARCH.md`.
 *
 * The rules, in the order they are applied to one request:
 *
 * 1. A non-http(s) URL is none of this module's business and is passed on.
 * 2. A loopback target is passed on: it never leaves the machine, and routing
 *    the Web UI's own traffic through a proxy would loop.
 * 3. The target host picks an exit: its binding, else the default exit.
 * 4. `direct` means the process's own transport (the fetch that was installed
 *    before this hook). Anything else goes through an undici dispatcher built
 *    for that exit.
 * 5. If the exit is missing, the config is unreadable, the dispatcher cannot be
 *    built, or the proxy fails, the request REJECTS. There is no code path from
 *    "a proxy exit failed" to "connect directly".
 *
 * @module host-egress/dispatch
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { isIP } from 'node:net'

import type { ProbeRecord, StoredExit } from './store.ts'
import { EgressStore } from './store.ts'
import { DIRECT_ID, ValidationError, hostPort, isLoopbackHost, scrub } from './validate.ts'

/** The only endpoint a probe ever contacts. Fixed in code, never user-supplied. */
export const PROBE_URL = 'https://ifconfig.me/ip'
/** Probe timeout in milliseconds. */
export const PROBE_TIMEOUT_MS = 8_000
/** Connect timeout toward a proxy. */
const PROXY_CONNECT_TIMEOUT_MS = 10_000
/** Size of the recent-requests ring. */
export const RING_SIZE = 100
/** How many distinct hosts are remembered for the binding table. */
const SEEN_LIMIT = 64

/** Why a request did not leave. Carries the exit so the message can name it. */
export class EgressError extends Error {
  constructor(
    message: string,
    readonly exitId: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options)
    this.name = 'EgressError'
  }
}

/** The part of undici this module uses. */
export interface UndiciLike {
  fetch(input: string, init?: Record<string, unknown>): Promise<Response>
  ProxyAgent: new (options: Record<string, unknown>) => DispatcherLike
  Socks5ProxyAgent?: new (url: string, options: Record<string, unknown>) => DispatcherLike
}

/** What an undici dispatcher offers that we call. */
export interface DispatcherLike {
  close(): Promise<void>
}

/** A loaded undici and where it came from. */
export interface LoadedUndici {
  readonly module: UndiciLike
  readonly source: string
  readonly version?: string
}

/**
 * Load undici without importing it statically.
 *
 * The server's profile does not depend on undici; it is reachable only through
 * dsh-web's `NODE_PATH` (`@deepseek-ai/dsh-http-proxy` pulls it in). A CJS
 * `require` honours `NODE_PATH`, an ESM `import` does not, hence `createRequire`.
 * @param explicit - optional absolute path to an undici `index.js`.
 * @returns the module.
 * @throws {Error} when no usable undici is found.
 */
export function loadUndici(explicit?: string): LoadedUndici {
  const require = createRequire(import.meta.url)
  const candidates = [...explicit === undefined || explicit === '' ? [] : [explicit], 'undici']
  const failures: string[] = []
  for (const spec of candidates) {
    try {
      const module = require(spec) as UndiciLike
      if (typeof module.fetch !== 'function' || typeof module.ProxyAgent !== 'function') throw new Error('missing fetch/ProxyAgent')
      let version: string | undefined
      try {
        const pkgPath = spec === 'undici' ? 'undici/package.json' : join(dirname(spec), 'package.json')
        version = (require(pkgPath) as { version?: string }).version
      } catch { /* version is informational */ }
      return { module, source: spec, ...version === undefined ? {} : { version } }
    } catch (error) {
      failures.push(`${spec}: ${error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)}`)
    }
  }
  throw new Error(`undici is not available (${failures.join('; ')})`)
}

/** One line of the recent-requests ring. */
export interface RingEntry {
  readonly at: string
  /** Target host (no port); never a path, header or body. */
  readonly host: string
  readonly exit: string
  readonly exitName: string
  readonly ok: boolean
  readonly error?: string
}

/** The decision for one host. */
export type Resolution =
  | { readonly kind: 'direct' }
  | { readonly kind: 'proxy'; readonly exit: StoredExit }
  | { readonly kind: 'blocked'; readonly exitId: string; readonly reason: string }

/** Runtime construction options. */
export interface RuntimeOptions {
  readonly store: EgressStore
  /** The fetch that was installed before the hook: what `direct` uses. */
  readonly directFetch: typeof fetch
  /** Lazy undici loader; defaults to {@link loadUndici}. */
  readonly loadUndici?: () => LoadedUndici
  readonly undiciPath?: string
  /** Host → provider label, for display only. */
  readonly providers?: ReadonlyMap<string, string>
  /** Test seams; the plugin never sets these. */
  readonly testing?: {
    /** Route loopback targets through the exit too (default: loopback passes straight through). */
    readonly proxyLoopback?: boolean
    /** TLS options for the target connection (e.g. a test CA). */
    readonly requestTls?: Record<string, unknown>
    /** Replace the probe endpoint. */
    readonly probeUrl?: string
  }
}

/**
 * Describe a failure in one short, secret-free line.
 * @param error - thrown value.
 * @param secrets - literal values to mask.
 * @returns text such as `ECONNREFUSED connect ECONNREFUSED 127.0.0.1:9`.
 */
export function describeError(error: unknown, secrets: readonly string[] = []): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && !parts.includes(code)) parts.push(code)
    if (current.name === 'TimeoutError') parts.push('timeout')
    if (current.message !== '' && current.message !== 'fetch failed') parts.push(current.message)
    current = (current as { cause?: unknown }).cause
  }
  const text = parts.join(' ').trim()
  return scrub(text === '' ? 'network error' : text, secrets).slice(0, 200)
}

/** Whether a thrown value is an abort the caller asked for. */
function isAbort(error: unknown, signal: AbortSignal | null | undefined): boolean {
  if (signal?.aborted === true && !(signal.reason instanceof Error && signal.reason.name === 'TimeoutError')) return true
  return error instanceof Error && error.name === 'AbortError'
}

/** Request-shaped input (a `Request`), tested structurally to survive cross-realm classes. */
function isRequestLike(value: unknown): value is Request {
  return typeof value === 'object' && value !== null && typeof (value as { url?: unknown }).url === 'string'
    && typeof (value as { method?: unknown }).method === 'string' && typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function'
}

/** Per-exit state of the dispatcher cache. */
interface CachedDispatcher {
  readonly fingerprint: string
  readonly dispatcher: DispatcherLike
}

/** Decides, sends and records. One instance per plugin activation. */
export class EgressRuntime {
  private undici: LoadedUndici | undefined
  private undiciError: string | undefined
  private readonly dispatchers = new Map<string, CachedDispatcher>()
  private readonly ring: RingEntry[] = []
  private readonly seen = new Map<string, string>()

  constructor(private readonly options: RuntimeOptions) {}

  /** The store behind this runtime. */
  get store(): EgressStore { return this.options.store }

  /** Provider labels by host. */
  get providers(): ReadonlyMap<string, string> { return this.options.providers ?? new Map() }

  /** The probe endpoint in force. */
  get probeUrl(): string { return this.options.testing?.probeUrl ?? PROBE_URL }

  /** Newest first. */
  recent(): readonly RingEntry[] { return [...this.ring].reverse() }

  /** Hosts seen on the wire, newest first, with their last-seen time. */
  seenHosts(): readonly { readonly host: string; readonly at: string }[] {
    return [...this.seen.entries()].map(([host, at]) => ({ host, at })).sort((a, b) => b.at.localeCompare(a.at))
  }

  /** What loading undici did: ok/version/error. Loads lazily on first call. */
  undiciStatus(): { readonly ok: boolean; readonly version?: string; readonly source?: string; readonly error?: string } {
    const loaded = this.tryUndici()
    return loaded === undefined
      ? { ok: false, error: this.undiciError ?? 'not loaded' }
      : { ok: true, source: loaded.source, ...loaded.version === undefined ? {} : { version: loaded.version } }
  }

  /** Close every cached dispatcher. */
  dispose(): void {
    for (const cached of this.dispatchers.values()) void cached.dispatcher.close().catch(() => undefined)
    this.dispatchers.clear()
  }

  /**
   * Pick the exit for one host.
   * @param host - target host name, lower-case.
   * @returns direct, a proxy exit, or blocked with the reason.
   */
  resolve(host: string): Resolution {
    const snapshot = this.options.store.snapshot()
    if (snapshot.corrupt !== undefined) {
      return { kind: 'blocked', exitId: '?', reason: `the egress config is unreadable (${scrub(snapshot.corrupt)}); fix or delete ${this.options.store.file}` }
    }
    const config = snapshot.config
    const id = config.bindings[host] ?? config.defaultExit
    if (id === DIRECT_ID) return { kind: 'direct' }
    const exit = config.exits.find(candidate => candidate.id === id)
    if (exit === undefined) return { kind: 'blocked', exitId: id, reason: `exit "${id}" does not exist` }
    return { kind: 'proxy', exit }
  }

  /** Load undici once; remember the failure so every request reports it the same way. */
  private tryUndici(): LoadedUndici | undefined {
    if (this.undici !== undefined) return this.undici
    if (this.undiciError !== undefined) return undefined
    try {
      this.undici = (this.options.loadUndici ?? (() => loadUndici(this.options.undiciPath)))()
    } catch (error) {
      this.undiciError = error instanceof Error ? error.message : String(error)
    }
    return this.undici
  }

  /** Build or reuse the dispatcher of one exit; a changed exit gets a new one. */
  private dispatcherFor(exit: StoredExit): DispatcherLike {
    const fingerprint = JSON.stringify([exit.type, exit.host, exit.port, exit.auth?.username ?? '', exit.auth?.password ?? ''])
    const cached = this.dispatchers.get(exit.id)
    if (cached?.fingerprint === fingerprint) return cached.dispatcher
    const loaded = this.tryUndici()
    if (loaded === undefined) throw new Error(`undici is not available: ${this.undiciError ?? 'unknown'}`)
    const requestTls = this.options.testing?.requestTls
    let dispatcher: DispatcherLike
    if (exit.type === 'socks5') {
      if (loaded.module.Socks5ProxyAgent === undefined) throw new Error('this undici has no Socks5ProxyAgent (need undici >= 7.x with SOCKS5 support)')
      dispatcher = new loaded.module.Socks5ProxyAgent(`socks5://${hostPort(exit.host, exit.port)}`, {
        connectTimeout: PROXY_CONNECT_TIMEOUT_MS,
        ...exit.auth === undefined ? {} : { username: exit.auth.username, password: exit.auth.password },
        ...requestTls === undefined ? {} : { requestTls },
      })
    } else {
      dispatcher = new loaded.module.ProxyAgent({
        uri: `${exit.type}://${hostPort(exit.host, exit.port)}`,
        connectTimeout: PROXY_CONNECT_TIMEOUT_MS,
        ...exit.auth === undefined ? {} : { token: `Basic ${Buffer.from(`${exit.auth.username}:${exit.auth.password}`).toString('base64')}` },
        ...requestTls === undefined ? {} : { requestTls },
      })
    }
    if (cached !== undefined) void cached.dispatcher.close().catch(() => undefined)
    this.dispatchers.set(exit.id, { fingerprint, dispatcher })
    return dispatcher
  }

  /** Forget the dispatcher of a deleted exit. */
  forget(id: string): void {
    const cached = this.dispatchers.get(id)
    if (cached === undefined) return
    this.dispatchers.delete(id)
    void cached.dispatcher.close().catch(() => undefined)
  }

  private record(entry: Omit<RingEntry, 'at'>): void {
    const at = new Date().toISOString()
    this.ring.push({ at, ...entry })
    if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE)
    this.seen.delete(entry.host)
    this.seen.set(entry.host, at)
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.keys().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
  }

  /**
   * The replacement for `globalThis.fetch`.
   * @param input - URL, URL string or Request.
   * @param init - fetch options.
   * @returns the response.
   * @throws {EgressError} when the chosen exit cannot carry the request.
   */
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    let url: URL
    try {
      url = new URL(isRequestLike(input) ? input.url : String(input))
    } catch {
      return this.options.directFetch(input, init)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return this.options.directFetch(input, init)
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (isLoopbackHost(host) && this.options.testing?.proxyLoopback !== true) return this.options.directFetch(input, init)

    const decision = this.resolve(host)
    if (decision.kind === 'blocked') {
      const message = `Egress blocked the request to ${host}: ${decision.reason}. No direct connection was attempted.`
      this.record({ host, exit: decision.exitId, exitName: decision.exitId, ok: false, error: decision.reason.slice(0, 160) })
      throw new EgressError(message, decision.exitId)
    }
    if (decision.kind === 'direct') {
      try {
        const response = await this.options.directFetch(input, init)
        this.record({ host, exit: DIRECT_ID, exitName: 'direct', ok: true })
        return response
      } catch (error) {
        if (!isAbort(error, init?.signal)) this.record({ host, exit: DIRECT_ID, exitName: 'direct', ok: false, error: describeError(error) })
        throw error
      }
    }
    const { exit } = decision
    const secrets = exit.auth === undefined ? [] : [exit.auth.username, exit.auth.password]
    try {
      const response = await this.viaProxy(exit, url, input, init)
      this.record({ host, exit: exit.id, exitName: exit.name, ok: true })
      return response
    } catch (error) {
      const signal = init?.signal ?? (isRequestLike(input) ? input.signal : undefined)
      if (isAbort(error, signal)) throw error
      const detail = describeError(error, secrets)
      this.record({ host, exit: exit.id, exitName: exit.name, ok: false, error: detail })
      throw new EgressError(
        `Egress "${exit.name}" (${exit.type} ${hostPort(exit.host, exit.port)}) could not carry the connection to ${host}: ${detail}. `
        + 'The request was stopped and was not retried directly.',
        exit.id,
        // No `cause`: callers (the OpenAI SDK -> DSH) show the root cause of the chain, and with the raw
        // network error attached the user saw only "ECONNREFUSED ..." instead of this message.
        // `detail` above already carries the error code and text.
      )
    }
  }

  /** Send one request through a proxy exit with undici's own fetch. */
  private async viaProxy(exit: StoredExit, url: URL, input: string | URL | Request, init: RequestInit | undefined): Promise<Response> {
    const dispatcher = this.dispatcherFor(exit)
    const undici = this.tryUndici()
    if (undici === undefined) throw new Error('undici is not available')
    const options: Record<string, unknown> = { dispatcher }
    if (isRequestLike(input)) {
      options['method'] = input.method
      options['headers'] = [...new Headers(input.headers).entries()]
      options['redirect'] = input.redirect
      if (input.signal) options['signal'] = input.signal
      if (input.method !== 'GET' && input.method !== 'HEAD') options['body'] = Buffer.from(await input.arrayBuffer())
    }
    if (init !== undefined) {
      const { headers, ...rest } = init
      Object.assign(options, rest)
      if (headers !== undefined) options['headers'] = [...new Headers(headers).entries()]
      if (typeof (init.body as { getReader?: unknown } | null | undefined)?.getReader === 'function') options['duplex'] = 'half'
    }
    return undici.module.fetch(url.href, options)
  }

  /**
   * Probe one exit: one GET of the fixed endpoint through it.
   * @param id - `direct` or a stored exit id.
   * @returns the stored probe record.
   * @throws {ValidationError} `not-found` when the id is unknown.
   */
  async probe(id: string): Promise<ProbeRecord> {
    const config = this.options.store.snapshot().config
    const exit = id === DIRECT_ID ? undefined : config.exits.find(candidate => candidate.id === id)
    if (id !== DIRECT_ID && exit === undefined) throw new ValidationError('not-found', `no exit "${id}"`)
    const secrets = exit?.auth === undefined ? [] : [exit.auth.username, exit.auth.password]
    const started = Date.now()
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
    let record: ProbeRecord
    try {
      const url = new URL(this.probeUrl)
      const response = exit === undefined
        ? await this.options.directFetch(url.href, { signal, headers: { accept: 'text/plain' } })
        : await this.viaProxy(exit, url, url.href, { signal, headers: { accept: 'text/plain' } })
      const text = (await response.text()).trim().slice(0, 100)
      const ms = Date.now() - started
      if (!response.ok) record = { ok: false, ms, error: `HTTP ${String(response.status)} from the probe endpoint`, at: new Date().toISOString() }
      else if (isIP(text) === 0) record = { ok: false, ms, error: 'the probe endpoint did not answer with an IP address', at: new Date().toISOString() }
      else record = { ok: true, ip: text, ms, at: new Date().toISOString() }
    } catch (error) {
      const detail = describeError(error, secrets)
      record = { ok: false, ms: Date.now() - started, error: detail === 'timeout' || /timeout/.test(detail) ? `timeout after ${String(PROBE_TIMEOUT_MS / 1000)}s` : detail, at: new Date().toISOString() }
    }
    await this.options.store.mutate((draft) => {
      if (id === DIRECT_ID || draft.exits.some(candidate => candidate.id === id)) draft.probes[id] = record
    }).catch(() => undefined)
    return record
  }
}

/** Key under which the installed hook is shared across plugin reloads. */
const HOLDER = Symbol.for('dsh-egress.holder')

interface Holder {
  readonly original: typeof fetch
  readonly fn: typeof fetch
  runtime: EgressRuntime
}

/** What `installHook` reports. */
export interface HookHandle {
  readonly runtime: EgressRuntime
  /** True while `globalThis.fetch` is still our function. */
  isActive(): boolean
}

/**
 * Install the hook on `globalThis.fetch`.
 *
 * Idempotent across plugin reloads: when our function is already installed, only
 * the runtime behind it is replaced, so the chain never grows and the original
 * fetch is never lost. The hook is deliberately never removed on dispose: a
 * deactivated plugin that restored the original fetch would silently turn every
 * proxied host into a direct connection.
 * @param make - builds the runtime from the fetch `direct` must use.
 * @returns the handle.
 */
export function installHook(make: (original: typeof fetch) => EgressRuntime): HookHandle {
  const scope = globalThis as unknown as { fetch: typeof fetch; [HOLDER]?: Holder }
  const prior = scope[HOLDER]
  if (prior !== undefined && scope.fetch === prior.fn) {
    const runtime = make(prior.original)
    prior.runtime.dispose()
    prior.runtime = runtime
    return { runtime, isActive: () => scope.fetch === prior.fn }
  }
  const original = scope.fetch
  const runtime = make(original)
  const holder: Holder = {
    original,
    runtime,
    fn: function egressFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      return holder.runtime.fetch(input, init)
    } as typeof fetch,
  }
  scope.fetch = holder.fn
  scope[HOLDER] = holder
  return { runtime, isActive: () => scope.fetch === holder.fn }
}