/**
 * The one document a UI needs: every task, its worker session, and that
 * worker's own todo list.
 *
 * Why it is derived from the session log rather than from the board alone:
 *
 * - A worker is an ordinary Session, and `dsh-tool-todo`'s `todo_write` appends
 *   `todo/write` events to it (`{ todos: [{ content, status }] }`, last write
 *   wins, reset at each `turn/start`). That log is the only authority for "how
 *   far along is this worker", and it survives the worker's own process.
 * - The board cannot know whether a dispatched child ever started, and a
 *   settled child's activation handle is gone after a restart. Folding the log
 *   answers both: the first `turn/start` promotes `dispatched` to `running`, and
 *   a final `turn/end` with `reason.kind === 'completed'` and no live agent
 *   settles the row as `reported` — the same claim the activation handle would
 *   have produced, recovered from durable evidence.
 *
 * `readSession` is exact-read only: it does not make a cold session live and it
 * does not attach a second writer, so reading is safe while a worker runs.
 *
 * @module host-router/snapshot
 */

import type { RouterTask, TaskState } from './board.ts'
import type { GroupProgress } from './order.ts'
import type { Partition } from './config.ts'
import type { LoggerService, SessionEventLike, SessionQueryService } from './types.ts'

/** One worker todo item, exactly as `dsh-tool-todo` records it. */
export interface TodoItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** The worker's current list plus its completion ratio. */
export interface TodoProgress {
  /** Latest whole-list snapshot, or `null` before the worker's first write. */
  readonly todos: readonly TodoItem[] | null
  /** Items marked `completed`. */
  readonly done: number
  /** Total items in the latest list. */
  readonly total: number
  /** The item currently marked `in_progress`, when exactly one is. */
  readonly current?: string
  /** Human-readable ratio, `3/7`. */
  readonly ratio: string
}

/** What the log says about one worker session. */
export interface WorkerLogFacts {
  /** Whether the child ever started a turn. */
  readonly started: boolean
  /** Whether the last turn ended, and why. */
  readonly endedWith?: string
  /** The last assistant text, bounded. */
  readonly lastAssistant?: string
  readonly todos: TodoProgress
  /** Live activity read from the log, independent of whether the model keeps its checklist. */
  readonly activity: LogActivity
}

/** How busy a worker's log says it is. */
export interface LogActivity {
  /** Number of `tool/call` events so far. */
  readonly toolCalls: number
  /** Latest tool call: name plus a short argument summary. */
  readonly lastTool?: string
  /** ISO time of the last event in the log. */
  readonly lastActivityAt?: string
  /** ISO time of the first `turn/start`: when the worker actually began. */
  readonly startedAt?: string
}

/**
 * Short summary of one tool call: the tool name plus a command head or a path.
 * @param name - tool name.
 * @param rawArguments - the call's arguments, a JSON string or an object.
 * @returns e.g. `bash ls -la /srv/…` or `read /srv/x.ts`.
 */
export function toolSummary(name: string, rawArguments: unknown): string {
  let args: Record<string, unknown> = {}
  if (typeof rawArguments === 'string') {
    try {
      const parsed: unknown = JSON.parse(rawArguments)
      if (parsed !== null && typeof parsed === 'object') args = parsed as Record<string, unknown>
    } catch {
      // not JSON: name only
    }
  } else if (rawArguments !== null && typeof rawArguments === 'object') {
    args = rawArguments as Record<string, unknown>
  }
  let detail: string | undefined
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'subject', 'partition']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') {
      detail = value
      break
    }
  }
  if (detail === undefined) return name
  const flat = detail.replace(/\s+/g, ' ').trim()
  return `${name} ${flat.length > 60 ? `${flat.slice(0, 60)}…` : flat}`
}

/** Fold tool-call activity out of a log. */
export function foldActivity(events: readonly SessionEventLike[]): LogActivity {
  let toolCalls = 0
  let lastTool: string | undefined
  let startedAt: string | undefined
  let lastTime = 0
  for (const event of events) {
    if (typeof event.time === 'number' && event.time > lastTime) lastTime = event.time
    if (event.type === 'turn/start' && startedAt === undefined && typeof event.time === 'number') {
      startedAt = new Date(event.time).toISOString()
    }
    if (event.type === 'tool/call') {
      toolCalls += 1
      const data = event.data as { name?: unknown; arguments?: unknown } | undefined
      if (typeof data?.name === 'string') lastTool = toolSummary(data.name, data.arguments)
    }
  }
  return {
    toolCalls,
    ...lastTool === undefined ? {} : { lastTool },
    ...lastTime === 0 ? {} : { lastActivityAt: new Date(lastTime).toISOString() },
    ...startedAt === undefined ? {} : { startedAt },
  }
}

/** One task as the UI sees it. */
export interface TaskView {
  readonly id: string
  readonly partition: string
  readonly subject: string
  readonly state: TaskState
  readonly level: 'manager' | 'worker'
  readonly priority: number
  readonly attempts: number
  readonly parentId?: string
  /** How the router decided this task's partition (`explicit` / `files` / `auto` / `default`). */
  readonly reason: string
  /** Ordered routing evidence, so a human can audit the decision. */
  readonly because: readonly string[]
  /** Durable worker session id: the key for a session panel or a follow-up. */
  readonly sessionId?: string
  /** Subagent name inside the tree. */
  readonly worker?: string
  /** Coarse progress derived from the state machine, 0..1. */
  readonly progress: number
  /** Worker todo progress, when the worker wrote a list. */
  readonly todos: TodoProgress
  /** Log-derived activity (tool calls, last tool, last event time), present once a log was read. */
  readonly activity?: LogActivity
  readonly result?: string
  readonly verifyOutput?: string
  readonly error?: string
  /** Why a `blocked` row is parked (`task_control block` value). */
  readonly resumeNote?: string
  /** Explicit prerequisites (`depends_on`). */
  readonly dependsOn?: readonly string[]
  /** Ordered phase among siblings. */
  readonly stage?: number
  /** A queued row held back by its order: the open prerequisites it waits for. */
  readonly waitingFor?: readonly string[]
  /** A suspended row: why, and what it waits for. */
  readonly suspendReason?: string
  readonly waitingOn?: readonly string[]
  /** Root task of the request this row belongs to. */
  readonly rootId?: string
  /** Difficulty tier chosen before dispatch (`easy | medium | hard`). */
  readonly tier?: 'easy' | 'medium' | 'hard'
  /** How the tier was decided and why. */
  readonly tierSource?: string
  readonly tierReason?: string
  /** Model route the child was started on; absent when it inherited the dispatcher's. */
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  /** 改派: the row that took this one over, and the row this one took over. */
  readonly reassignedTo?: string
  readonly reassignedFrom?: string
  /** Pull request this row published. */
  readonly pr?: { readonly number: number; readonly url: string; readonly provider: string }
  readonly createdAt: string
  readonly updatedAt: string
}

/** Whole-board view returned in one call. */
export interface RouterSnapshot {
  /** Schema marker; bump when a field changes meaning. */
  readonly version: 1
  readonly generatedAt: string
  /** Aggregate counts by state, so a badge needs no second call. */
  readonly counts: Readonly<Record<string, number>>
  /** Per-partition rollup, so a partition list needs no second call. */
  readonly partitions: readonly {
    readonly name: string
    readonly dir: string
    readonly workers: number
    readonly live: number
    readonly queued: number
  }[]
  readonly tasks: readonly TaskView[]
  /** Progress per request (root task). */
  readonly groups?: readonly GroupProgress[]
  /** Recent progress notices, newest first. */
  readonly notices?: readonly { readonly at: string; readonly text: string }[]
}

/** Coarse progress per state; the UI shows a bar, the todo ratio refines it. */
const STATE_PROGRESS: Readonly<Record<TaskState, number>> = {
  queued: 0,
  dispatched: 0.1,
  running: 0.4,
  reported: 1,
  done: 1,
  verified: 1,
  failed: 1,
  blocked: 1,
  cancelled: 1,
  interrupted: 0.4,
  suspended: 0.5,
}

/** Fold `todo/write` events into the worker's latest list. */
export function foldTodos(events: readonly SessionEventLike[]): TodoProgress {
  let todos: readonly TodoItem[] | null = null
  for (const event of events) {
    // The tool registers `turn/start` as a reset, so a new turn cannot inherit a
    // finished list from the previous one.
    if (event.type === 'turn/start') todos = null
    if (event.type === 'todo/write') {
      const raw = (event.data as { todos?: unknown } | undefined)?.todos
      if (Array.isArray(raw)) {
        todos = raw.flatMap((item): TodoItem[] => {
          if (item === null || typeof item !== 'object') return []
          const candidate = item as { content?: unknown; status?: unknown }
          if (typeof candidate.content !== 'string') return []
          const status = candidate.status
          if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return []
          return [{ content: candidate.content, status }]
        })
      }
    }
  }
  const done = todos?.filter(item => item.status === 'completed').length ?? 0
  const total = todos?.length ?? 0
  const active = todos?.find(item => item.status === 'in_progress')
  return {
    todos,
    done,
    total,
    ...active === undefined ? {} : { current: active.content },
    ratio: `${String(done)}/${String(total)}`,
  }
}

/** Fold the turn boundaries and the last assistant text out of a worker log. */
export function foldWorkerLog(events: readonly SessionEventLike[]): WorkerLogFacts {
  let started = false
  let endedWith: string | undefined
  let lastAssistant: string | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      started = true
      endedWith = undefined
      continue
    }
    if (event.type === 'assistant/message') {
      const blocks = (event.data as { message?: { content?: unknown } } | undefined)?.message?.content
      if (Array.isArray(blocks)) {
        const text = blocks.flatMap((block): string[] => {
          if (block === null || typeof block !== 'object') return []
          const candidate = block as { type?: unknown; text?: unknown }
          return candidate.type === 'text' && typeof candidate.text === 'string' ? [candidate.text] : []
        }).join('\n').trim()
        if (text !== '') lastAssistant = text
      }
      continue
    }
    if (event.type === 'turn/end') {
      const kind = (event.data as { reason?: { kind?: unknown } } | undefined)?.reason?.kind
      endedWith = typeof kind === 'string' ? kind : 'unknown'
    }
  }
  return {
    started,
    ...endedWith === undefined ? {} : { endedWith },
    ...lastAssistant === undefined ? {} : { lastAssistant },
    todos: foldTodos(events),
    activity: foldActivity(events),
  }
}

/** What `buildSnapshot` needs from the host. */
export interface SnapshotDeps {
  readonly board: {
    list(): readonly RouterTask[]
    inPartition(name: string): readonly RouterTask[]
  }
  readonly partitions: readonly Partition[]
  readonly sessionQuery: SessionQueryService | undefined
  readonly logger: LoggerService
  /** Whether this process still holds the child (and will close the row itself). */
  readonly isLive: (task: RouterTask) => boolean
  /** Read a log at most once per cache window. */
  readonly readLog: (sessionId: string) => Promise<readonly SessionEventLike[]>
  /** Open prerequisites of a queued row, or undefined when it may start. */
  readonly waitingFor?: (task: RouterTask) => readonly string[] | undefined
  /** Root task id of a row. */
  readonly rootOf?: (task: RouterTask) => string
  /** Per-request progress, computed after corrections. */
  readonly progress?: () => readonly GroupProgress[]
  /** Recent notices. */
  readonly notices?: () => readonly { readonly at: string; readonly text: string }[]
  /** Persist a state correction discovered while folding. */
  readonly correctState?: (task: RouterTask, change: { state: TaskState; result?: string; error?: string }) => Promise<void>
}

/** Cache one worker log for a short window; a poll of N tasks must not cost N full reads. */
export function createLogReader(
  sessionQuery: SessionQueryService | undefined,
  logger: LoggerService,
  ttlMs = 3_000,
): (sessionId: string) => Promise<readonly SessionEventLike[]> {
  const cache = new Map<string, { at: number; events: readonly SessionEventLike[] }>()
  return async (sessionId) => {
    const hit = cache.get(sessionId)
    const now = Date.now()
    if (hit !== undefined && now - hit.at < ttlMs) return hit.events
    if (sessionQuery === undefined) return []
    try {
      const read = await sessionQuery.readSession(sessionId)
      cache.set(sessionId, { at: now, events: read.events })
      if (cache.size > 256) {
        // Bound the cache: drop the oldest half rather than grow without limit.
        const ordered = [...cache.entries()].sort((left, right) => left[1].at - right[1].at)
        for (const [key] of ordered.slice(0, ordered.length - 128)) cache.delete(key)
      }
      return read.events
    } catch (error) {
      logger.warn(`host-router: could not read session ${sessionId}: ${String(error)}`)
      cache.set(sessionId, { at: now, events: [] })
      return []
    }
  }
}

/**
 * Folded facts of settled rows (`done` / `reported`), keyed by session id and
 * remembered with the row's `updatedAt`. A settled worker's log no longer
 * changes while the row stays as it is, so re-reading every finished log on
 * each poll made one board request cost seconds per finished task. Any row
 * change (resume, retry, verify) bumps `updatedAt` and forces a fresh read.
 */
const settledFacts = new Map<string, { readonly stamp: string; readonly facts: WorkerLogFacts }>()
const SETTLED_FACTS_MAX = 1024

/** Log reads in flight at once while building one snapshot. */
const READ_CONCURRENCY = 8

/** Build one task view, folding the worker log when the row has a session. */
async function viewOf(task: RouterTask, deps: SnapshotDeps): Promise<TaskView> {
  let facts: WorkerLogFacts | undefined
  // The view must reflect the state this pass just proved, not the stale row.
  let state: TaskState = task.state
  if (task.sessionId !== undefined && (task.state === 'running' || task.state === 'dispatched' || task.state === 'reported' || task.state === 'done')) {
    const settled = task.state === 'reported' || task.state === 'done'
    const stamp = `${task.state}@${task.updatedAt}`
    const hit = settled ? settledFacts.get(task.sessionId) : undefined
    if (hit !== undefined && hit.stamp === stamp) {
      facts = hit.facts
    } else {
      facts = foldWorkerLog(await deps.readLog(task.sessionId))
      if (settled) {
        settledFacts.set(task.sessionId, { stamp, facts })
        if (settledFacts.size > SETTLED_FACTS_MAX) {
          const oldest = settledFacts.keys().next().value
          if (oldest !== undefined) settledFacts.delete(oldest)
        }
      }
    }
    // Log-derived corrections: the row is the projection, the log is the truth.
    if (task.state === 'dispatched' && facts.started) {
      await deps.correctState?.(task, { state: 'running' })
      state = 'running'
    } else if (task.state === 'running' && !deps.isLive(task) && facts.endedWith !== undefined) {
      const failed = facts.endedWith !== 'completed'
      await deps.correctState?.(task, {
        state: failed ? 'failed' : 'done',
        ...failed ? { error: `worker ended with "${facts.endedWith}"` } : {},
        ...facts.lastAssistant === undefined ? {} : { result: facts.lastAssistant },
      })
      state = failed ? 'failed' : 'done'
    }
  }
  const todos = facts?.todos ?? { todos: null, done: 0, total: 0, ratio: '0/0' }
  const waitingFor = state === 'queued' ? deps.waitingFor?.(task) : undefined
  // With a todo list, the ratio is a finer signal than the state bar.
  const progress = state === 'running' && todos.total > 0
    ? Math.max(STATE_PROGRESS.running, 0.4 + 0.5 * (todos.done / todos.total))
    : STATE_PROGRESS[state]
  return {
    id: task.id,
    partition: task.partition,
    subject: task.subject,
    state,
    level: task.level,
    priority: task.priority,
    attempts: task.attempts,
    reason: task.reason,
    because: task.because,
    ...task.parentId === undefined ? {} : { parentId: task.parentId },
    ...task.sessionId === undefined ? {} : { sessionId: task.sessionId },
    ...task.worker === undefined ? {} : { worker: task.worker },
    progress,
    todos,
    ...facts === undefined ? {} : { activity: facts.activity },
    ...task.result === undefined ? {} : { result: task.result },
    ...task.verifyOutput === undefined ? {} : { verifyOutput: task.verifyOutput },
    ...task.error === undefined ? {} : { error: task.error },
    ...task.resumeNote === undefined ? {} : { resumeNote: task.resumeNote },
    ...(task.dependsOn?.length ?? 0) === 0 ? {} : { dependsOn: task.dependsOn! },
    ...task.stage === undefined ? {} : { stage: task.stage },
    ...waitingFor === undefined || waitingFor.length === 0 ? {} : { waitingFor },
    ...task.state !== 'suspended' || task.suspendReason === undefined ? {} : { suspendReason: task.suspendReason },
    ...task.state !== 'suspended' || (task.waitingOn?.length ?? 0) === 0 ? {} : { waitingOn: task.waitingOn! },
    ...deps.rootOf === undefined ? {} : { rootId: deps.rootOf(task) },
    ...task.tier === undefined ? {} : { tier: task.tier },
    ...task.tierSource === undefined ? {} : { tierSource: task.tierSource },
    ...task.tierReason === undefined ? {} : { tierReason: task.tierReason },
    ...task.provider === undefined ? {} : { provider: task.provider },
    ...task.model === undefined ? {} : { model: task.model },
    ...task.reasoningEffort === undefined ? {} : { reasoningEffort: task.reasoningEffort },
    ...task.reassignedTo === undefined ? {} : { reassignedTo: task.reassignedTo },
    ...task.reassignedFrom === undefined ? {} : { reassignedFrom: task.reassignedFrom },
    ...task.pr === undefined ? {} : { pr: task.pr },
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

/**
 * Build the whole snapshot in one pass.
 *
 * One call answers "what is running, what finished, how far along is each
 * worker" — the UI must not need a call per task, and must not need to know that
 * a worker's progress lives in a different session.
 * @param deps - board, partitions, log reader, and state corrections.
 * @param filter - optional partition scope.
 * @returns the snapshot document.
 */
export async function buildSnapshot(
  deps: SnapshotDeps,
  filter: { readonly partition?: string } = {},
): Promise<RouterSnapshot> {
  const tasks = filter.partition === undefined
    ? deps.board.list()
    : deps.board.inPartition(filter.partition)
  // Bounded parallel reads; order of `views` still follows `tasks`.
  const views: TaskView[] = new Array<TaskView>(tasks.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++
      views[index] = await viewOf(tasks[index]!, deps)
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, tasks.length) }, lane))
  const counts: Record<string, number> = {}
  for (const view of views) counts[view.state] = (counts[view.state] ?? 0) + 1
  const partitions = deps.partitions
    .filter(partition => filter.partition === undefined || partition.name === filter.partition)
    .map((partition) => {
      const scoped = views.filter(view => view.partition === partition.name)
      return {
        name: partition.name,
        dir: partition.dir,
        workers: partition.slots,
        live: scoped.filter(view => view.state === 'running' || view.state === 'dispatched').length,
        queued: scoped.filter(view => view.state === 'queued').length,
      }
    })
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    counts,
    partitions,
    tasks: views,
    ...deps.progress === undefined ? {} : { groups: deps.progress() },
    ...deps.notices === undefined ? {} : { notices: deps.notices() },
  }
}
