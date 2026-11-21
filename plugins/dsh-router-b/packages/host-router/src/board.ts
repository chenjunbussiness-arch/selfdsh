/**
 * Durable task board: the only source of truth about dispatched work.
 *
 * Why a file and not memory: the subagent manager's activations are
 * process-local (`resident` is a plain Map keyed by child id), so a restarted
 * harness forgets every live child and can never receive their settlement.
 * A board that lived only in memory would therefore strand exactly the tasks a
 * human most wants to see. Reads happen on demand, writes are atomic
 * (temp + rename), and a board that fails to parse is moved aside instead of
 * throwing — an unreadable board must not take the router down with it.
 *
 * Why `reported` and `verified` are separate states: a worker's closing message
 * is a report about work the worker cannot independently validate. The
 * measured failure rate of self-reported delegation success is high enough
 * (arXiv:2611.04100 reports 3 of 16 delegations recording failure as done) that
 * treating a report as truth would corrupt every downstream decision. `reported`
 * means "a claim exists"; `verified` means "an acceptance command passed".
 * Nothing in this plugin calls `reported` done.
 *
 * @module host-router/board
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Lifecycle of one task. */
export type TaskState =
  /** Accepted by the router, waiting for a worker slot. */
  | 'queued'
  /** A child session exists, but its log shows no turn yet. */
  | 'dispatched'
  /** The worker's log shows a started turn. */
  | 'running'
  /**
   * Legacy: the worker stopped under the old human-acceptance flow. Older rows
   * keep this value; the panel shows them as finished.
   */
  | 'reported'
  /** The worker (or manager) ended normally and its report was recorded. Finished. */
  | 'done'
  /** Acceptance commands passed. The only state that means done. */
  | 'verified'
  /** The worker errored or acceptance failed and no retries remain. */
  | 'failed'
  /** Needs a human decision; the router will not retry it on its own. */
  | 'blocked'
  /** Cancelled on request; a live worker was interrupted. */
  | 'cancelled'
  /**
   * The harness stopped (restart, reload) while this row was in flight. Its
   * session log is intact, so the router resumes that same session on the next
   * boot instead of starting the work over.
   */
  | 'interrupted'
  /**
   * Parked until other tasks finish: the task (or a human) found it needs a
   * prerequisite first. Its session is kept; when every row in `waitingOn` is
   * finished the router continues that same session. Holds no worker slot.
   */
  | 'suspended'

/** How a task was dispatched, so the board shows the routing level. */
export type DispatchLevel =
  /** Handed to a partition manager for decomposition. */
  | 'manager'
  /** Started by a partition manager, or by the router when the partition has none. */
  | 'worker'

/** One routed task. Flat on purpose: the tree lives in `parentId`. */
export interface RouterTask {
  readonly id: string
  /** Partition that owns it. */
  readonly partition: string
  /** Parent task id when a manager split one task into several. */
  readonly parentId?: string
  /** Short title for the board. */
  readonly subject: string
  /** The instruction handed to the child, after the partition brief. */
  readonly body: string
  readonly state: TaskState
  /** Absolute working directory given to the child. */
  readonly cwd: string
  /** Higher runs first; equal priorities run oldest first. */
  readonly priority: number
  /** Which routing level created this row. */
  readonly level: DispatchLevel
  /** How it was routed, so a human can audit the decision. */
  readonly reason: string
  /** Ordered routing evidence. */
  readonly because: readonly string[]
  /** Session id of the dispatcher; the router re-resolves it before any late dispatch. */
  readonly dispatchFrom?: string
  /** Subagent name inside the tree (`agent-2`), for `send_message`-style follow-ups. */
  readonly worker?: string
  /** Durable child session id. This is the handle for continuing the session later. */
  readonly sessionId?: string
  /** Starts so far, including the current one. */
  readonly attempts: number
  /** The worker's closing text. A claim, not proof. */
  readonly result?: string
  /**
   * What the worker said it actually did, parsed from its `--- report ---` block
   * (see `report.ts`). Absent when the worker wrote no block: the level-2
   * decision reads this as "nothing known", not as "nothing done".
   */
  readonly summary?: string
  /** Paths the worker said it changed. The level-2 decision matches on these. */
  readonly touched?: readonly string[]
  /** What the worker said is still open; absent when it said none. */
  readonly left?: string
  /** Combined acceptance output, truncated. */
  readonly verifyOutput?: string
  /** Acceptance commands that were run. */
  readonly verify?: readonly string[]
  /** Why it ended badly, when it did. */
  readonly error?: string
  /** Which routing level the closing report went to. */
  readonly reportedTo?: string
  /**
   * Token of the process that dispatched this row.
   *
   * A restart must be able to tell "this row's process is gone" from "this row is
   * mine and still in flight". Comparing tokens is the only reliable way to do
   * that from disk alone, because a live activation is process-local.
   */
  readonly runToken?: string
  /** One line written before blocking, so a human can resume cheaply. */
  readonly resumeNote?: string
  /** How many times this row's session was resumed after an interruption. */
  readonly resumes?: number
  /**
   * Task ids that must finish before this row may start. A queued row whose
   * prerequisites are still open waits in the queue; one whose prerequisite
   * failed or was cancelled is parked as `blocked` for a human.
   */
  readonly dependsOn?: readonly string[]
  /**
   * Ordered phase among siblings (rows with the same `parentId`). A row starts
   * only after every sibling with a lower stage has finished. Absent = stage 0
   * with no ordering among rows that carry no stage.
   */
  readonly stage?: number
  /** While `suspended`: the task ids it waits for. */
  readonly waitingOn?: readonly string[]
  /** Why the row was suspended, in the words of whoever suspended it. */
  readonly suspendReason?: string
  /** How many times this row was suspended so far. */
  readonly suspends?: number
  /** State the row had when it was suspended, so a resume knows whether it had finished once. */
  readonly suspendedFrom?: TaskState
  /** How many times a manager that ended with open children was woken to keep waiting. */
  readonly rewakes?: number
  /**
   * Set on a `blocked` row the router parked because a prerequisite failed:
   * the state to return to once that prerequisite is retried and finishes.
   * Only meaningful together with a non-empty `waitingOn`.
   */
  readonly blockedFrom?: 'queued' | 'suspended'
  /** A human chose to start this row without waiting for its prerequisites. */
  readonly ignoreOrder?: boolean
  /** Human remarks recorded while the task was in flight. */
  readonly notes?: readonly string[]
  /** Difficulty tier chosen before dispatch (`easy | medium | hard`). */
  readonly tier?: 'easy' | 'medium' | 'hard'
  /** How the tier was decided and why. */
  readonly tierSource?: string
  readonly tierReason?: string
  /** Model route the child was started on; absent when it inherited the dispatcher's. */
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** Durable per-partition state: the manager session identity, if one exists. */
export interface PartitionRecord {
  /** Session id of this partition's manager child. */
  readonly managerSessionId?: string
  /** Subagent name of the manager, for display. */
  readonly managerName?: string
  readonly managerUpdatedAt?: string
  /**
   * Operator switch, set by the panel's `POST /api/router/partition`.
   *
   * A disabled partition accepts no new demand and its pump starts nothing;
   * its existing rows keep the state they already have. Absent means enabled,
   * so an older board file (or a fresh install) needs no migration.
   */
  readonly disabled?: boolean
}

/** Whole-board document, as persisted. */
interface BoardDocument {
  readonly version: 1
  readonly tasks: readonly RouterTask[]
  readonly partitions: Readonly<Record<string, PartitionRecord>>
}

/** Truncation bound for stored child text; the full session log stays on disk. */
export const RESULT_LIMIT = 6_000

/** Keep the tail of long text: build errors live at the end. */
export function tail(text: string, limit = RESULT_LIMIT): string {
  return text.length <= limit ? text : `…(${String(text.length - limit)} chars dropped)\n${text.slice(-limit)}`
}

/** One-letter state marker for the compact board. */
export function mark(state: TaskState): string {
  switch (state) {
    case 'queued': return '[ ]'
    case 'dispatched': return '[>]'
    case 'running': return '[~]'
    case 'reported': return '[x]'
    case 'done': return '[x]'
    case 'verified': return '[x]'
    case 'failed': return '[!]'
    case 'blocked': return '[B]'
    case 'cancelled': return '[-]'
    case 'interrupted': return '[^]'
    case 'suspended': return '[z]'
  }
}

/** States a dispatched child can still be occupying a slot in. */
export function isOpen(state: TaskState): boolean {
  return state === 'queued' || state === 'dispatched' || state === 'running' || state === 'reported'
    || state === 'interrupted' || state === 'suspended'
}

/** States that count as "finished" for a prerequisite. */
export function isFinished(state: TaskState): boolean {
  return state === 'done' || state === 'verified' || state === 'reported'
}

/** States that can never become finished without a human (a prerequisite in one of these is dead). */
export function isDead(state: TaskState): boolean {
  return state === 'failed' || state === 'cancelled'
}

/** Order tasks for execution: priority first, then arrival. */
export function byExecutionOrder(left: RouterTask, right: RouterTask): number {
  if (left.priority !== right.priority) return right.priority - left.priority
  const at = Date.parse(left.createdAt)
  const bt = Date.parse(right.createdAt)
  if (at !== bt) return at - bt
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/** Render the board for a model or a human. */
export function summarize(
  tasks: readonly RouterTask[],
  options: { readonly partition?: string } = {},
): string {
  if (tasks.length === 0) {
    return options.partition === undefined
      ? '(board is empty)'
      : `(partition "${options.partition}" has no tasks)`
  }
  const counts = new Map<TaskState, number>()
  for (const task of tasks) counts.set(task.state, (counts.get(task.state) ?? 0) + 1)
  const tally = [...counts.entries()].map(([state, count]) => `${state}=${String(count)}`).join(' ')
  const header = `${String(tasks.length)} task(s): ${tally}. `
    + '`done` means the worker finished and its report is recorded (`reported` rows are older, also finished).'
  const rows = tasks.flatMap((task) => {
    const age = Math.max(0, Math.round((Date.now() - Date.parse(task.updatedAt)) / 1000))
    const parent = task.parentId === undefined ? '' : ` <- ${task.parentId}`
    const worker = task.worker === undefined ? '-' : task.worker
    const order = [
      task.stage === undefined ? '' : ` stage ${String(task.stage)}`,
      (task.dependsOn?.length ?? 0) === 0 ? '' : ` after ${task.dependsOn!.join(',')}`,
      task.state === 'suspended' && (task.waitingOn?.length ?? 0) > 0 ? ` waiting-on ${task.waitingOn!.join(',')}` : '',
    ].join('')
    const row = `${mark(task.state)} ${task.id} ${task.partition}/${task.level} ${worker} `
      + `p${String(task.priority)} ${task.subject}${parent}${order} (${String(age)}s)`
    // What the worker reported is what the next routing decision reads, so the
    // board shows it rather than making the caller open each row.
    const did = task.summary === undefined ? '' : `    did: ${task.summary}`
    const touched = (task.touched?.length ?? 0) === 0
      ? ''
      : `    touched: ${task.touched!.slice(0, 8).join(', ')}`
        + (task.touched!.length > 8 ? ` +${String(task.touched!.length - 8)} more` : '')
    const why = task.state === 'suspended' && task.suspendReason !== undefined ? `    suspended: ${task.suspendReason}` : ''
    return [row, did, touched, why].filter(line => line !== '')
  })
  return [header, ...rows].join('\n')
}

/** Error text on a row the harness stopped mid-flight; the session itself is intact. */
/** States after which a row does not change on its own. */
export const SETTLED: ReadonlySet<TaskState> = new Set<TaskState>(['done', 'verified', 'reported', 'failed', 'cancelled'])

export const INTERRUPTED_NOTE = 'the harness stopped while this task was in flight; its session will be resumed from its log'

/** The board file. One instance per plugin activation. */
export class TaskBoard {
  private tasks: RouterTask[] = []
  private partitions: Record<string, PartitionRecord> = {}
  /** Called after a row enters a settled state (see `SETTLED`). */
  private readonly settleListeners: ((task: RouterTask, from: TaskState) => void)[] = []

  private constructor(
    private readonly file: string,
    private readonly runToken: string | undefined,
  ) {}

  /**
   * Open or create `<dir>/board.json`.
   * @param dir - directory holding the board document.
   * @param runToken - identity of the opening process; rows dispatched by any
   *   other token are treated as orphaned. Omitted disables reconciliation, which
   *   is what a read-only viewer or a test wants.
   */
  static async open(dir: string, runToken?: string): Promise<TaskBoard> {
    const file = join(dir, 'board.json')
    await mkdir(dirname(file), { recursive: true })
    const board = new TaskBoard(file, runToken)
    await board.load()
    return board
  }

  /** Every task in insertion order. Callers sort for their own view. */
  list(): readonly RouterTask[] {
    return this.tasks
  }

  /** Tasks of one partition, in execution order. */
  inPartition(name: string): readonly RouterTask[] {
    return this.tasks.filter(task => task.partition === name).sort(byExecutionOrder)
  }

  /** Tasks created by one manager (or belonging under one parent). */
  childrenOf(id: string): readonly RouterTask[] {
    return this.tasks.filter(task => task.parentId === id)
  }

  /** One task by id. */
  get(id: string): RouterTask | undefined {
    return this.tasks.find(task => task.id === id)
  }

  /** Durable record for one partition. */
  partitionRecord(name: string): PartitionRecord {
    return this.partitions[name] ?? {}
  }

  /** Insert one task and persist before returning. */
  async add(task: RouterTask): Promise<RouterTask> {
    this.tasks = [...this.tasks, task]
    await this.flush()
    return task
  }

  /**
   * Merge a patch into one task and persist.
   * @param id - task id.
   * @param change - fields to replace.
   * @returns the updated task.
   * @throws when the id is unknown, which means two writers disagree about the board.
   */
  async patch(id: string, change: Partial<RouterTask>): Promise<RouterTask> {
    const index = this.tasks.findIndex(task => task.id === id)
    if (index < 0) throw new Error(`host-router: unknown task ${id}`)
    const previousState = this.tasks[index]!.state
    const updated: RouterTask = {
      ...this.tasks[index]!,
      ...change,
      updatedAt: new Date().toISOString(),
    }
    this.tasks = [...this.tasks.slice(0, index), updated, ...this.tasks.slice(index + 1)]
    await this.flush()
    const from = previousState
    if (SETTLED.has(updated.state) && !SETTLED.has(from)) {
      for (const listener of this.settleListeners) {
        try {
          listener(updated, from)
        } catch {
          // A listener must never fail a board write.
        }
      }
    }
    return updated
  }

  /**
   * Run `listener` each time a row enters a settled state (done, verified,
   * reported, failed, cancelled) from an unsettled one.
   * @returns a function that removes the listener.
   */
  onSettled(listener: (task: RouterTask, from: TaskState) => void): () => void {
    this.settleListeners.push(listener)
    return () => {
      const at = this.settleListeners.indexOf(listener)
      if (at >= 0) this.settleListeners.splice(at, 1)
    }
  }

  /** Merge a patch into one partition record and persist. */
  async patchPartition(name: string, change: PartitionRecord): Promise<PartitionRecord> {
    const merged: PartitionRecord = { ...this.partitionRecord(name), ...change }
    this.partitions = { ...this.partitions, [name]: merged }
    await this.flush()
    return merged
  }

  /** Append a human remark without touching state. */
  async note(id: string, text: string): Promise<RouterTask> {
    const task = this.get(id)
    if (task === undefined) throw new Error(`host-router: unknown task ${id}`)
    return await this.patch(id, { notes: [...task.notes ?? [], text] })
  }

  private async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    try {
      const parsed = JSON.parse(raw) as Partial<BoardDocument>
      if (!Array.isArray(parsed.tasks)) throw new Error('missing tasks array')
      this.tasks = parsed.tasks
      this.partitions = parsed.partitions !== null && typeof parsed.partitions === 'object'
        ? { ...parsed.partitions }
        : {}
      await this.reconcile()
    } catch {
      // Keep the bytes for forensics; starting empty beats refusing to start.
      await rename(this.file, `${this.file}.corrupt-${String(Date.now())}`).catch(() => {})
      this.tasks = []
      this.partitions = {}
    }
  }

  /**
   * Re-file rows orphaned by a dead process.
   *
   * A `running` or `dispatched` row dispatched under a different process token has
   * no live session in this process and no settlement will arrive for it. Its
   * session log is still on disk, though, so a row that has a session becomes
   * `interrupted` (the router resumes that session after boot) and a row that never
   * got one goes back to `queued` (nothing ran, so starting it is not a redo).
   * Rows carrying this process's own token are left alone: they are in flight here.
   */
  private async reconcile(): Promise<void> {
    // A tokenless open is a read-only viewer (or a test): it must not rewrite
    // another process's in-flight rows just by looking at them.
    if (this.runToken === undefined) return
    const orphaned = this.tasks.filter(task =>
      (task.state === 'running' || task.state === 'dispatched')
      && task.runToken !== this.runToken)
    if (orphaned.length === 0) return
    const now = new Date().toISOString()
    this.tasks = this.tasks.map((task): RouterTask => {
      if (task.state !== 'running' && task.state !== 'dispatched') return task
      if (task.runToken === this.runToken) return task
      return task.sessionId === undefined
        ? { ...task, state: 'queued', updatedAt: now }
        : { ...task, state: 'interrupted', error: INTERRUPTED_NOTE, updatedAt: now }
    })
    await this.flush()
  }

  /** Tail of the write chain: concurrent patches share one temp path, so writes must not overlap. */
  private writing: Promise<void> = Promise.resolve()

  private async flush(): Promise<void> {
    const run = this.writing.then(() => this.flushNow())
    this.writing = run.catch(() => {})
    await run
  }

  private async flushNow(): Promise<void> {
    const document: BoardDocument = {
      version: 1,
      tasks: this.tasks,
      partitions: this.partitions,
    }
    const temp = `${this.file}.tmp-${String(process.pid)}`
    await writeFile(temp, JSON.stringify(document, undefined, 2), 'utf8')
    try {
      await replaceFile(temp, this.file)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
  }
}

/**
 * Replace a file with its freshly written temporary sibling.
 *
 * On Windows, `rename` over a file that another process currently has open fails
 * with `EPERM` rather than replacing it. That is not a hypothetical here: the
 * board is written by the plugin and read on demand by a UI, so a reader can be
 * inside the same window. Retrying briefly keeps the atomic-replace guarantee
 * (a torn board is never observable) without turning reader contention into a
 * lost write.
 * @param from - temporary file holding the complete new document.
 * @param to - destination path.
 */
async function replaceFile(from: string, to: string): Promise<void> {
  const delays = [0, 5, 15, 40, 100, 200, 400]
  let lastError: unknown
  for (const delay of delays) {
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
    try {
      await rename(from, to)
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'EEXIST') break
    }
  }
  throw lastError
}

/** Monotonic, sortable, human-readable task id. */
export function nextTaskId(sequence: number): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return `t${stamp}-${String(sequence).padStart(3, '0')}`
}
