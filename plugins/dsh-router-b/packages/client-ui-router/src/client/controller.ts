/**
 * Panel state: one snapshot object, replaced on every change so
 * `useSyncExternalStore` sees a new reference exactly when something changed.
 *
 * The controller owns data and I/O only. Filtering, expansion and the composer
 * draft are view state and stay in React, so a re-render never depends on the
 * controller's identity.
 */

import type { BoardSnapshot, PublishResult, TaskState } from './contract.ts'
import type { BoardSource, ControlAction } from './source.ts'

/** What the panel renders. */
export interface RouterPanelState {
  /** The last successful read, or `null` before the first one. */
  readonly board: BoardSnapshot | null
  /** Read lifecycle. */
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  /** Last read or action failure, already human-readable. */
  readonly error?: string
  /** True while a publish request is in flight. */
  readonly publishing: boolean
  /** Last publish outcome, cleared when the composer is edited again. */
  readonly lastPublish?: PublishResult
}

const INITIAL: RouterPanelState = { board: null, status: 'idle', publishing: false }

/** Bridge between the board source and the React view. */
export class RouterBoardController {
  private state: RouterPanelState = INITIAL
  private readonly listeners = new Set<() => void>()
  private inFlight: Promise<void> | null = null
  private disposed = false

  /**
   * @param source - the board source this panel reads.
   * @param onChange - called after the source reports a Host-side change.
   */
  constructor(
    private readonly source: BoardSource,
    private readonly onChange?: () => void,
  ) {}

  /** Attach to the source's change feed once, for the controller's lifetime. */
  start(): () => void {
    return this.source.subscribe(() => {
      if (this.disposed) return
      this.onChange?.()
      void this.load()
    })
  }

  /** Current state; stable between changes. */
  getSnapshot = (): RouterPanelState => this.state

  /**
   * Subscribe to state changes.
   * @param listener - change callback.
   * @returns unsubscribe.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Stop accepting results from in-flight reads. */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }

  private emit(next: RouterPanelState): void {
    if (this.disposed) return
    this.state = next
    for (const listener of this.listeners) listener()
  }

  /**
   * Read the board.
   *
   * Concurrent calls join the in-flight read: a burst of change events must not
   * become a burst of Host round-trips.
   * @returns completion of the read.
   */
  async load(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight
    this.emit({ ...this.state, status: this.state.board === null ? 'loading' : this.state.status })
    this.inFlight = (async () => {
      try {
        const board = await this.source.read()
        this.emit({ ...this.state, board, status: 'ready', error: undefined })
      } catch (error) {
        this.emit({
          ...this.state,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        this.inFlight = null
      }
    })()
    return this.inFlight
  }

  /**
   * Publish demands, then re-read so the new tasks appear.
   * @param demands - one entry per submitted line.
   * @returns the routing result, or undefined on failure.
   */
  async publish(demands: readonly string[]): Promise<PublishResult | undefined> {
    if (demands.length === 0) return undefined
    this.emit({ ...this.state, publishing: true, error: undefined })
    try {
      const result = await this.source.publish(demands)
      const board = await this.source.read()
      this.emit({ ...this.state, board, status: 'ready', publishing: false, lastPublish: result })
      return result
    } catch (error) {
      this.emit({
        ...this.state,
        publishing: false,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  /**
   * Record a verification decision and re-read.
   * @param taskId - the reported task.
   * @param verdict - accept or send back.
   * @param note - rejection reason shown on the card.
   */
  async verify(taskId: string, verdict: Extract<TaskState, 'verified' | 'rejected'>, note?: string): Promise<void> {
    try {
      await this.source.verify(taskId, verdict, note)
      const board = await this.source.read()
      this.emit({ ...this.state, board, status: 'ready', error: undefined })
    } catch (error) {
      this.emit({ ...this.state, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Whether the source can run `task_control` actions at all. */
  get canControl(): boolean {
    return typeof this.source.control === 'function'
  }

  /**
   * Run one `task_control` action, then re-read the board.
   *
   * `resume` is applied optimistically: the row is moved to `running` in the
   * local snapshot before the request, so it leaves 已挂起 at once. A fresh read
   * (not a join of an older in-flight one) follows a success; a failure restores
   * the snapshot taken before the optimistic patch and re-reads.
   * @param taskId - the task.
   * @param action - the `task_control` action.
   * @param value - its optional `value`.
   * @returns undefined on success, else the human-readable failure.
   */
  async control(taskId: string, action: ControlAction, value?: string): Promise<string | undefined> {
    const source = this.source
    if (source.control === undefined) return 'task_control is not wired on this source'
    const before = this.state.board
    if (action === 'resume' && before !== null) {
      this.emit({
        ...this.state,
        board: {
          ...before,
          tasks: before.tasks.map(task => task.id !== taskId ? task : {
            ...task, state: 'running' as const, hostState: 'running' as const, resumeNote: undefined,
          }),
        },
      })
    }
    try {
      await source.control(taskId, action, value)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (before !== null) this.emit({ ...this.state, board: before })
      void this.load()
      return message
    }
    try {
      if (this.inFlight !== null) await this.inFlight
      const board = await source.read()
      this.emit({ ...this.state, board, status: 'ready', error: undefined })
    } catch {
      // The action itself succeeded; the next poll or change event re-reads.
    }
    return undefined
  }

  /** Clear the publish banner after the view has shown it. */
  clearPublishNotice(): void {
    if (this.state.lastPublish === undefined) return
    this.emit({ ...this.state, lastPublish: undefined })
  }
}
