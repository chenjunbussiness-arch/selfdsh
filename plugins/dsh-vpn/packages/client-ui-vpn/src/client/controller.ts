/**
 * State holder for the page: one snapshot, a poll loop and the write actions.
 *
 * `getSnapshot` returns a new object exactly when something changed, so it works
 * as the store of `useSyncExternalStore`.
 */

import type { ProfileInput, VpnSnapshot } from './contract.ts'
import type { VpnSource } from './source.ts'

/** What the view renders. */
export interface VpnPageState {
  readonly snapshot?: VpnSnapshot
  readonly loading: boolean
  /** Last failed read, shown until the next successful one. */
  readonly error?: string
  /** An action (save / connect / disconnect / delete) is in flight. */
  readonly busy: boolean
}

/** Result of an action: `undefined` on success, else the message to show. */
export type ActionResult = string | undefined

/** Poll interval by connection state, in ms. */
function intervalFor(snapshot: VpnSnapshot | undefined): number {
  if (snapshot === undefined) return 3000
  if (snapshot.status.status === 'connecting') return 1200
  if (snapshot.status.status === 'connected') return 4000
  return 8000
}

/** The controller. */
export class VpnController {
  private state: VpnPageState = { loading: true, busy: false }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private unsubscribe: (() => void) | undefined
  private disposed = false
  private generation = 0

  constructor(private readonly source: VpnSource) {}

  getSnapshot = (): VpnPageState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private set(next: Partial<VpnPageState>): void {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) listener()
  }

  /** Read once and schedule the next read. */
  async load(): Promise<void> {
    const generation = ++this.generation
    try {
      const snapshot = await this.source.read()
      if (this.disposed || generation !== this.generation) return
      this.state = { ...this.state, snapshot, loading: false, busy: this.state.busy }
      delete (this.state as { error?: string }).error
      for (const listener of this.listeners) listener()
    } catch (error) {
      if (this.disposed || generation !== this.generation) return
      this.set({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.disposed) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.load() }, intervalFor(this.state.snapshot))
  }

  /** Start reading and listening to the source. */
  start(): void {
    this.disposed = false
    this.unsubscribe = this.source.subscribe(() => { void this.load() })
    void this.load()
  }

  /** Stop timers and listeners. */
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.unsubscribe?.()
  }

  private async act(run: () => Promise<unknown>): Promise<ActionResult> {
    this.set({ busy: true })
    try {
      await run()
      await this.load()
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    } finally {
      this.set({ busy: false })
    }
  }

  save(input: ProfileInput): Promise<ActionResult> {
    return this.act(() => this.source.save(input))
  }

  remove(id: string): Promise<ActionResult> {
    return this.act(() => this.source.remove(id))
  }

  connect(id: string): Promise<ActionResult> {
    return this.act(() => this.source.connect(id))
  }

  disconnect(): Promise<ActionResult> {
    return this.act(() => this.source.disconnect())
  }
}
