/**
 * Sample data and an in-memory source that behaves like the bridge.
 *
 * Used when the host bridge is unreachable (the panel then says "Sample data")
 * and by the preview. It applies the same rules the host does (an exit that is
 * still bound cannot be deleted, a new exit starts unprobed) so the panel's
 * flows can be exercised without a server. Probing is simulated: an exit whose
 * host contains `dead` or `down` fails with a connection error, every other one
 * answers with a made-up documentation-range IP.
 */

import type { BindingView, EgressSource, EgressState, ExitInput, ExitView, ProbeResult, RingEntry } from './contract.ts'

/** Minutes ago, as an ISO time. */
const ago = (minutes: number, now: number): string => new Date(now - minutes * 60_000).toISOString()

/**
 * Build the sample document.
 * @param now - clock, ms.
 * @returns state with three custom exits, two bindings and a short request log.
 */
export function sampleState(now: number = Date.now()): EgressState {
  const exits: ExitView[] = [
    { id: 'direct', name: 'direct', type: 'direct', builtin: true, hasAuth: false, url: 'direct' },
    {
      id: 'tokyo', name: 'Tokyo', type: 'socks5', builtin: false, host: 'jp-1.proxy.example.net', port: 1080, hasAuth: true,
      url: 'socks5://***:***@jp-1.proxy.example.net:1080',
      lastProbe: { ok: true, ip: '198.51.100.23', ms: 184, at: ago(3, now) },
    },
    {
      id: 'hk-http', name: 'HK relay', type: 'http', builtin: false, host: 'hk-relay.example.net', port: 3128, hasAuth: false,
      url: 'http://hk-relay.example.net:3128',
      lastProbe: { ok: false, error: 'ECONNREFUSED connect ECONNREFUSED 203.0.113.8:3128', ms: 41, at: ago(12, now) },
    },
    {
      id: 'us-https', name: 'US secure', type: 'https', builtin: false, host: 'us-2.proxy.example.net', port: 8443, hasAuth: true,
      url: 'https://***:***@us-2.proxy.example.net:8443',
    },
  ]
  const bindings: BindingView[] = [
    { host: 'api.commandcode.ai', provider: 'commandecode', exit: 'tokyo', source: 'binding', lastSeen: ago(1, now) },
    { host: 'api.deepseek.com', provider: 'deepseek', exit: 'direct', source: 'default', lastSeen: ago(55, now) },
    { host: 'mcp.example.org', exit: 'direct', source: 'default' },
  ]
  const recent: RingEntry[] = [
    { at: ago(1, now), host: 'api.commandcode.ai', exit: 'tokyo', exitName: 'Tokyo', ok: true },
    { at: ago(1.4, now), host: 'api.commandcode.ai', exit: 'tokyo', exitName: 'Tokyo', ok: true },
    { at: ago(9, now), host: 'api.commandcode.ai', exit: 'hk-http', exitName: 'HK relay', ok: false, error: 'ECONNREFUSED connect ECONNREFUSED 203.0.113.8:3128' },
    { at: ago(55, now), host: 'api.deepseek.com', exit: 'direct', exitName: 'direct', ok: true },
  ]
  return {
    version: 1, origin: 'mock', fetchedAt: new Date(now).toISOString(), exits, defaultExit: 'direct', bindings, recent,
    apply: { mode: 'instant', hookActive: true, undici: { ok: true, version: '8.11.2' }, restartHint: 'systemctl restart dsh-web' },
    probeEndpoint: 'https://ifconfig.me/ip',
  }
}

/** Options for the in-memory source. */
export interface MockOptions {
  /** Start from this state instead of {@link sampleState}. */
  readonly initial?: EgressState
  /** Delay of a simulated probe, ms. */
  readonly probeDelayMs?: number
}

/**
 * An in-memory source with the bridge's rules.
 * @param options - initial state and probe delay.
 * @returns the source; `origin` is `mock`.
 */
export function createMockSource(options: MockOptions = {}): EgressSource {
  let state = options.initial ?? sampleState()
  const delay = options.probeDelayMs ?? 700
  const wait = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
  const maskedUrl = (input: ExitInput, hasAuth: boolean): string => `${input.type}://${hasAuth ? '***:***@' : ''}${input.host}:${String(input.port)}`
  const set = (next: Partial<EgressState>): EgressState => {
    state = { ...state, ...next, fetchedAt: new Date().toISOString() }
    return state
  }
  const rebuildBindings = (bound: Record<string, string>): BindingView[] => state.bindings.map((row) => {
    const exit = bound[row.host]
    return exit === undefined ? { ...row, exit: state.defaultExit, source: 'default' as const } : { ...row, exit, source: 'binding' as const }
  })
  return {
    origin: 'mock',
    load: () => Promise.resolve(state),
    putExit(input) {
      const existing = input.id === undefined ? undefined : state.exits.find(exit => exit.id === input.id)
      const hasAuth = input.clearAuth === true ? false : (input.username !== undefined && input.username !== '') || (existing?.hasAuth ?? false)
      const id = existing?.id ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      const next: ExitView = {
        id, name: input.name, type: input.type, builtin: false, host: input.host, port: input.port, hasAuth, url: maskedUrl(input, hasAuth),
      }
      const exits = existing === undefined ? [...state.exits, next] : state.exits.map(exit => (exit.id === id ? next : exit))
      return Promise.resolve(set({ exits }))
    },
    deleteExit(id) {
      const users = state.bindings.filter(row => row.exit === id && row.source === 'binding').map(row => row.host)
      if (state.defaultExit === id) users.push('* (default)')
      if (users.length > 0) return Promise.reject(new Error(`exit "${id}" is still used by ${users.join(', ')}; rebind them first`))
      return Promise.resolve(set({ exits: state.exits.filter(exit => exit.id !== id) }))
    },
    putBinding(host, exit) {
      if (host === '*') return Promise.resolve(set({ defaultExit: exit ?? 'direct', bindings: state.bindings.map(row => (row.source === 'default' ? { ...row, exit: exit ?? 'direct' } : row)) }))
      const bound: Record<string, string> = {}
      for (const row of state.bindings) if (row.source === 'binding') bound[row.host] = row.exit
      if (exit === null) delete bound[host]
      else bound[host] = exit
      const known = state.bindings.some(row => row.host === host)
      const base: BindingView[] = known ? [...state.bindings] : [...state.bindings, { host, exit: state.defaultExit, source: 'default' }]
      state = { ...state, bindings: base }
      return Promise.resolve(set({ bindings: rebuildBindings(bound) }))
    },
    async probe(id) {
      await wait(delay)
      const exit = state.exits.find(candidate => candidate.id === id)
      const down = /dead|down/.test(exit?.host ?? '') || exit?.id === 'hk-http'
      const at = new Date().toISOString()
      const result: ProbeResult = down
        ? { ok: false, ms: 52, error: `ECONNREFUSED connect ECONNREFUSED ${exit?.host ?? '?'}:${String(exit?.port ?? 0)}`, at }
        : { ok: true, ip: id === 'direct' ? '203.0.113.50' : '198.51.100.23', ms: id === 'direct' ? 96 : 184, at }
      return { result, state: set({ exits: state.exits.map(candidate => (candidate.id === id ? { ...candidate, lastProbe: result } : candidate)) }) }
    },
  }
}
