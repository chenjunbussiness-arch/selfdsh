/**
 * Panel state: one snapshot object, replaced on every change so
 * `useSyncExternalStore` sees a new reference exactly when something changed.
 *
 * The controller owns data and I/O. It starts on the real bridge and, when the
 * bridge cannot be read, serves the sample source and says so (`origin`), then
 * keeps retrying the bridge so the badge disappears as soon as it is reachable.
 */

import type { EgressSource, EgressState, ExitInput } from './contract.ts'

/** What the panel renders. */
export interface PanelState {
  readonly data: EgressState | null
  readonly origin: 'host' | 'mock'
  readonly status: 'loading' | 'ready'
  /** Last failure of the bridge read, kept while sample data is shown. */
  readonly bridgeError?: string
  /** Exit ids with a probe in flight. */
  readonly probing: readonly string[]
  /** Result of the last action, shown as a toast line. */
  readonly notice?: { readonly kind: 'ok' | 'error'; readonly text: string }
}

const INITIAL: PanelState = { data: null, origin: 'mock', status: 'loading', probing: [] }

/** Bridge between the sources and the React view. */
export class EgressController {
  private state: PanelState = INITIAL
  private readonly listeners = new Set<() => void>()
  private active: EgressSource
  private mock: EgressSource | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  /**
   * @param host - the real bridge source.
   * @param makeMock - builds the sample source on first need.
   * @param pollMs - bridge refresh interval; 0 disables polling (tests, preview).
   */
  constructor(
    private readonly host: EgressSource,
    private readonly makeMock: () => EgressSource,
    private readonly pollMs = 15_000,
  ) {
    this.active = host
  }

  /** Current state; stable between changes. */
  getSnapshot = (): PanelState => this.state

  /**
   * Subscribe to state changes.
   * @param listener - change callback.
   * @returns unsubscribe.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private set(patch: Partial<PanelState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  /** First read, then poll. */
  start(): () => void {
    void this.refresh()
    if (this.pollMs > 0) this.timer = setInterval(() => { void this.refresh(true) }, this.pollMs)
    return () => { this.dispose() }
  }

  /** Stop polling and drop listeners. */
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.listeners.clear()
  }

  /**
   * Read the state, preferring the real bridge.
   * @param quiet - true for background polls: do not flash the loading state.
   */
  async refresh(quiet = false): Promise<void> {
    if (!quiet && this.state.data === null) this.set({ status: 'loading' })
    try {
      const data = await this.host.load()
      this.active = this.host
      const { bridgeError: _drop, ...rest } = this.state
      this.state = rest
      this.set({ data, origin: 'host', status: 'ready' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (this.active === this.host || this.mock === undefined) {
        this.mock ??= this.makeMock()
        this.active = this.mock
        this.set({ data: await this.mock.load(), origin: 'mock', status: 'ready', bridgeError: message })
      } else {
        this.set({ bridgeError: message })
      }
    }
  }

  /** Run one write and fold its answer (or error) into the state. */
  private async act(run: () => Promise<EgressState>, okText: string): Promise<boolean> {
    try {
      const data = await run()
      this.set({ data, notice: { kind: 'ok', text: okText } })
      return true
    } catch (error) {
      this.set({ notice: { kind: 'error', text: error instanceof Error ? error.message : String(error) } })
      return false
    }
  }

  /** Clear the toast line. */
  dismissNotice(): void {
    const { notice: _drop, ...rest } = this.state
    this.state = rest
    this.set({})
  }

  /**
   * Create or update an exit.
   * @param input - form values.
   * @returns whether the write was accepted.
   */
  saveExit(input: ExitInput, okText: string): Promise<boolean> {
    return this.act(() => this.active.putExit(input), okText)
  }

  /** Delete an exit. */
  removeExit(id: string, okText: string): Promise<boolean> {
    return this.act(() => this.active.deleteExit(id), okText)
  }

  /** Bind a host (or `*`, the default exit) to an exit; `null` unbinds. */
  bind(host: string, exit: string | null, okText: string): Promise<boolean> {
    return this.act(() => this.active.putBinding(host, exit), okText)
  }

  /** Probe one exit and show the result in its row. */
  async probe(id: string): Promise<void> {
    if (this.state.probing.includes(id)) return
    this.set({ probing: [...this.state.probing, id] })
    try {
      const { state } = await this.active.probe(id)
      this.set({ data: state })
    } catch (error) {
      this.set({ notice: { kind: 'error', text: error instanceof Error ? error.message : String(error) } })
    } finally {
      this.set({ probing: this.state.probing.filter(entry => entry !== id) })
    }
  }
}
