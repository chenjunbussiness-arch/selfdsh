/**
 * The redacted state document served to the panel and to the status tool.
 *
 * Nothing in here can carry a credential: an exit exposes `hasAuth` and a URL
 * whose userinfo is `***:***`, and there is no field a password could travel in.
 *
 * @module host-egress/state
 */

import type { EgressRuntime, RingEntry } from './dispatch.ts'
import type { ProbeRecord, StoredExit } from './store.ts'
import { DIRECT_ID, redactedUrl, validateHost } from './validate.ts'

/** One exit as the panel sees it. */
export interface ExitView {
  readonly id: string
  readonly name: string
  readonly type: 'direct' | 'http' | 'https' | 'socks5'
  readonly builtin: boolean
  readonly host?: string
  readonly port?: number
  readonly hasAuth: boolean
  /** `type://[***:***@]host:port`, or `direct`. */
  readonly url: string
  readonly lastProbe?: ProbeRecord
}

/** One row of the binding table. */
export interface BindingView {
  /** Target host, or `*` for the default exit. */
  readonly host: string
  /** Label of the model provider that uses this host, when known. */
  readonly provider?: string
  /** Exit the host currently uses. */
  readonly exit: string
  /** `binding` when set explicitly, `default` when it follows the default exit. */
  readonly source: 'binding' | 'default'
  readonly lastSeen?: string
}

/** The whole document. */
export interface EgressState {
  readonly version: 1
  readonly origin: 'host'
  readonly fetchedAt: string
  readonly exits: readonly ExitView[]
  readonly defaultExit: string
  readonly bindings: readonly BindingView[]
  /** How a change takes effect, and whether the hook is healthy. */
  readonly apply: {
    readonly mode: 'instant' | 'restart'
    readonly hookActive: boolean
    readonly undici: { readonly ok: boolean; readonly version?: string; readonly error?: string }
    /** Set when the config file is unusable and every non-loopback request is blocked. */
    readonly corrupt?: string
    readonly restartHint: string
  }
  readonly recent: readonly RingEntry[]
  readonly probeEndpoint: string
}

/** Fixed restart hint shown when the mode is `restart`. The plugin never restarts anything itself. */
export const RESTART_HINT = 'systemctl restart dsh-web'

/**
 * Turn a stored exit into its redacted view.
 * @param exit - stored exit.
 * @param probe - last probe, if any.
 * @returns the view.
 */
export function exitView(exit: StoredExit, probe: ProbeRecord | undefined): ExitView {
  return {
    id: exit.id,
    name: exit.name,
    type: exit.type,
    builtin: false,
    host: exit.host,
    port: exit.port,
    hasAuth: exit.auth !== undefined,
    url: redactedUrl(exit.type, exit.host, exit.port, exit.auth !== undefined),
    ...probe === undefined ? {} : { lastProbe: probe },
  }
}

/**
 * Build the state document.
 * @param runtime - the live runtime.
 * @param hookActive - whether `globalThis.fetch` is still our function.
 * @param extraHosts - provider hosts from the plugin config, host → label.
 * @returns the document.
 */
export function buildState(runtime: EgressRuntime, hookActive: boolean, extraHosts: ReadonlyMap<string, string>): EgressState {
  const snapshot = runtime.store.snapshot()
  const config = snapshot.config
  const exits: ExitView[] = [
    {
      id: DIRECT_ID, name: 'direct', type: 'direct', builtin: true, hasAuth: false, url: 'direct',
      ...config.probes[DIRECT_ID] === undefined ? {} : { lastProbe: config.probes[DIRECT_ID] },
    },
    ...config.exits.map(exit => exitView(exit, config.probes[exit.id])),
  ]
  const seen = new Map(runtime.seenHosts().map(entry => [entry.host, entry.at]))
  const hosts = new Set<string>([...extraHosts.keys(), ...Object.keys(config.bindings), ...seen.keys()])
  const rows: BindingView[] = [...hosts].sort().map((host) => {
    const bound = config.bindings[host]
    const provider = extraHosts.get(host)
    const lastSeen = seen.get(host)
    return {
      host,
      ...provider === undefined ? {} : { provider },
      exit: bound ?? config.defaultExit,
      source: bound === undefined ? 'default' : 'binding',
      ...lastSeen === undefined ? {} : { lastSeen },
    }
  })
  const undici = runtime.undiciStatus()
  return {
    version: 1,
    origin: 'host',
    fetchedAt: new Date().toISOString(),
    exits,
    defaultExit: config.defaultExit,
    bindings: rows,
    apply: {
      mode: hookActive ? 'instant' : 'restart',
      hookActive,
      undici: { ok: undici.ok, ...undici.version === undefined ? {} : { version: undici.version }, ...undici.error === undefined ? {} : { error: undici.error } },
      ...snapshot.corrupt === undefined ? {} : { corrupt: snapshot.corrupt },
      restartHint: RESTART_HINT,
    },
    recent: runtime.recent(),
    probeEndpoint: runtime.probeUrl,
  }
}

/**
 * Collect `host → label` from the configured providers.
 * @param providers - plugin config providers.
 * @returns the map; entries whose URL is not http(s) are skipped.
 */
export function providerHosts(providers: readonly { readonly name: string; readonly baseURL: string }[] | undefined): Map<string, string> {
  const map = new Map<string, string>()
  for (const provider of providers ?? []) {
    try {
      const url = new URL(provider.baseURL)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      map.set(validateHost(url.hostname), provider.name)
    } catch { /* a bad entry is skipped, not fatal */ }
  }
  return map
}

/**
 * One-paragraph status for the agent tool. Redacted by construction.
 * @param state - the state document.
 * @returns plain text.
 */
export function statusText(state: EgressState): string {
  const lines = [
    `Egress (${state.apply.mode === 'instant' ? 'changes apply immediately' : 'hook not active: restart dsh-web'}); default exit: ${state.defaultExit}.`,
    ...state.apply.corrupt === undefined ? [] : [`WARNING: config unreadable, non-loopback requests are blocked: ${state.apply.corrupt}`],
    'Exits:',
    ...state.exits.map((exit) => {
      const probe = exit.lastProbe === undefined ? 'not probed' : exit.lastProbe.ok ? `ok ${exit.lastProbe.ip ?? ''} ${String(exit.lastProbe.ms ?? '')}ms` : `failed: ${exit.lastProbe.error ?? ''}`
      return `- ${exit.id}: ${exit.url} (${probe})`
    }),
    'Bindings:',
    ...state.bindings.map(row => `- ${row.host}${row.provider === undefined ? '' : ` [${row.provider}]`} -> ${row.exit}${row.source === 'default' ? ' (default)' : ''}`),
  ]
  return lines.join('\n')
}