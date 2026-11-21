/**
 * The HTTP bridge between the durable router and the Web client.
 *
 * Why HTTP and not a Remote: the board's truth lives in this process, but the
 * panel runs in the browser. `ctx.webServer` is the supported seam that both
 * halves already share — the Web shell is served by it, so a same-origin
 * `fetch('/api/router/board')` needs no new transport, no Typert declaration,
 * and no authenticated hop of its own. Route registration is
 * `webServer.register(route)` (`@deepseek-ai/dsh-host-webserver/src/index.ts:445`
 * in the running 0.2.2-rc.3 build); a route carries a `handler` that owns the
 * `node:http` exchange, which is why SSE is possible at all
 * (`WebRoute`, same file `:52-58`).
 *
 * Two documents meet here and only this file knows both:
 *
 * - the router's own snapshot (`./snapshot.ts`), whose states are
 *   `queued | dispatched | running | reported | verified | failed | blocked | cancelled`;
 * - the panel's contract (five states, four tabs), which is narrower.
 *
 * The mapping is total and lossless: every row keeps its host state in
 * `hostState`, so nothing is collapsed away. In particular `reported` never
 * becomes `verified` — the whole point of the two-state design
 * (`./board.ts:12-18`) survives the translation.
 *
 * @module host-router/bridge
 */

import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { TaskState } from './board.ts'
import type { GroupProgress } from './order.ts'
import type { RouterSnapshot, TaskView } from './snapshot.ts'
import type { LoggerService, WebRouteLike } from './types.ts'

/** Path prefix every bridge route lives under. */
export const BRIDGE_BASE = '/api/router'

/** `GET` → the board document. */
export const BOARD_PATH = `${BRIDGE_BASE}/board`
/** `POST` → publish demands. */
export const PUBLISH_PATH = `${BRIDGE_BASE}/publish`
/** `POST` → record a human verification decision. */
export const VERIFY_PATH = `${BRIDGE_BASE}/verify`
/** `POST` → run one `task_control` action (`resume`, `block`) on a task. */
export const CONTROL_PATH = `${BRIDGE_BASE}/control`
/** `POST` → enable or disable one partition. */
export const PARTITION_PATH = `${BRIDGE_BASE}/partition`
/** `GET` → the 作战室 anchor session id (created or resumed on demand). */
export const ANCHOR_PATH = `${BRIDGE_BASE}/anchor`
/** `GET` → server-sent change notifications. */
export const EVENTS_PATH = `${BRIDGE_BASE}/events`
/** `GET` → tier settings + model options; `POST` → save tier settings. */
export const TIERS_PATH = `${BRIDGE_BASE}/tiers`
/** `GET ?partition=&path=` → one directory level of a partition (names only, never contents). */
export const FILES_PATH = `${BRIDGE_BASE}/files`
/** `GET|POST|DELETE` one partition's memory (notes and recent work). */
export const MEMORY_PATH = `${BRIDGE_BASE}/memory`
export const APPROVALS_PATH = `${BRIDGE_BASE}/approvals`
export const AUDIT_PATH = `${BRIDGE_BASE}/audit`
export const LIVE_PATH = `${BRIDGE_BASE}/live`
export const REASSIGN_PATH = `${BRIDGE_BASE}/reassign`
export const BATCH_PATH = `${BRIDGE_BASE}/batch`

/** Request body ceiling: demands and verdicts are small by construction. */
const MAX_BODY_BYTES = 256 * 1024
/** Most demands one publish call may carry. */
const MAX_DEMANDS = 64
/** How many bytes of the change file's timestamp the SSE route compares. */
const EVENTS_POLL_MS = 1_500
/** SSE keep-alive interval; comment frames keep idle proxies from closing. */
const EVENTS_BEAT_MS = 20_000
/**
 * Longest one stream stays open before the server ends it.
 *
 * The panel reconnects on its own (`retry: 3000`), so this costs one round trip
 * every half hour and bounds what an abandoned browser tab can leave behind: an
 * open response plus a poller watching the board file.
 */
const EVENTS_MAX_LIFETIME_MS = 30 * 60 * 1_000

/**
 * The panel's five states.
 *
 * Kept in lockstep with the client's `src/client/contract.ts`, which is the
 * authority; this copy exists so the host package imports no client module.
 */
export type UiTaskState = 'queued' | 'running' | 'reported' | 'verified' | 'rejected'

/** Which of the panel's four tabs a task belongs to. */
export type UiBucket = 'active' | 'up-next' | 'scheduled' | 'resolved'

/** Whether a worker currently occupies capacity. */
export type UiPresence = 'online' | 'busy' | 'offline' | 'released'

/**
 * One credential reference's presence, for the panel's API-key block.
 *
 * The shape is the client's `CredentialView` (`docs/CONTRACT.md`, contract.ts):
 * a reference name, a display label, and presence/writability facts. No value
 * is ever part of it — `credentials.describe` does not return one.
 */
export interface UiCredentialView {
  /** Credential reference name, e.g. `DEEPSEEK_API_KEY`. */
  readonly ref: string
  /** Display name for the row. */
  readonly label?: string
  /** Whether a value is currently stored. */
  readonly configured: boolean
  /**
   * Coarse origin of the stored value.
   *
   * The provider's own layer ids are finer (`env`, `file`, `project-env`,
   * `user-env`), so they are normalised onto the four values the panel draws.
   */
  readonly source?: 'file' | 'env' | 'unset' | 'unknown'
  /** Whether `credentials.set`/`unset` would currently be accepted. */
  readonly writable?: boolean
}

/** One checklist entry, identical to the native `todo/write` payload item. */
export interface UiTodoItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** The folded progress of a worker's checklist. */
export interface UiTodoProgress {
  readonly done: number
  readonly total: number
  readonly ratio: string
  readonly current?: string
}

/** One worker or manager in a partition's roster. */
export interface UiWorkerView {
  readonly id: string
  readonly name: string
  readonly presence: UiPresence
  readonly sessionId?: string
  readonly activity?: string
  readonly elapsedSeconds?: number
}

/** The manager responsible for routing inside one partition. */
export interface UiManagerView {
  readonly id: string
  readonly name: string
  readonly presence: UiPresence
  readonly dispatched: number
  readonly awaitingVerification: number
}

/** One partition, as the panel's left column and roster render it. */
export interface UiPartitionView {
  readonly id: string
  readonly name: string
  /** Absolute partition root. `repo` is the client contract's name for the same value. */
  readonly repo: string
  /** Same absolute root, under the name the rail's subtitle reads. */
  readonly path: string
  /** Operator switch, persisted in the board document. */
  readonly enabled: boolean
  /** Configured concurrency. */
  readonly workerCount: number
  /** Worker rows currently holding a slot. */
  readonly liveWorkers: number
  /** Queued rows waiting for a slot. */
  readonly queuedCount: number
  /** Rows whose worker self-reported and no verifier has ruled yet. */
  readonly unreviewedCount: number
  /** Suspended rows. */
  readonly suspendedCount?: number
  /** Membership globs, so the workspace page can show the partition's rules. */
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
  /** One-line description from the config, when given. */
  readonly description?: string
  /** Configuration problems found at boot (missing root, nesting). */
  readonly problems?: readonly { readonly level: 'error' | 'warning'; readonly message: string }[]
  /** Every row this partition owns. */
  readonly taskCount: number
  readonly manager: UiManagerView
  readonly workers: readonly UiWorkerView[]
}

/** One task, as the panel's task list and detail pane render it. */
export interface UiTaskView {
  readonly id: string
  readonly title: string
  readonly partitionId: string
  /** The task's host state, preserved verbatim so nothing is collapsed away. */
  readonly hostState: TaskState
  readonly state: UiTaskState
  /** The panel tab this task belongs to; derived from `state`, not stored. */
  readonly bucket: UiBucket
  readonly todos: readonly UiTodoItem[]
  readonly todoProgress: UiTodoProgress
  /** Tool calls the worker made so far, read from its log. */
  readonly toolCalls?: number
  /** Latest tool call: name plus a short argument summary. */
  readonly lastTool?: string
  /** ISO time of the worker log's last event. */
  readonly lastActivityAt?: string
  /** ISO time the worker actually started (first turn), else absent. */
  readonly startedAt?: string
  /** Coarse progress 0..1 from the state machine, refined by the todo ratio. */
  readonly progress: number
  readonly updatedAt: string
  readonly requestedAt: string
  readonly reportedAt?: string
  readonly verifiedAt?: string
  readonly attempt: number
  readonly level: 'manager' | 'worker'
  /** The task this one was dispatched under (a worker's manager row). */
  readonly parentId?: string
  readonly priority: number
  /** The subagent's name in the tree, when it had one. */
  readonly workerId?: string
  /** The worker's Harness Session; also the key for its live `todos` projection. */
  readonly workerSessionId?: string
  readonly rejectionReason?: string
  readonly result?: string
  readonly verifyOutput?: string
  readonly error?: string
  /** Why a `blocked` row is parked: the `value` of `task_control block`. */
  readonly resumeNote?: string
  /** Explicit prerequisites and ordered phase. */
  readonly dependsOn?: readonly string[]
  readonly stage?: number
  /** A queued row held back by its order: the open prerequisites. */
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
  /** 改派 links and the published pull request. */
  readonly reassignedTo?: string
  readonly reassignedFrom?: string
  readonly pr?: { readonly number: number; readonly url: string; readonly provider: string }
}

/** One demand and the task it produced. */
export interface UiDemandView {
  readonly id: string
  /** The router's one-line title for the demand. */
  readonly text: string
  readonly publishedAt: string
  readonly partitionId?: string
  readonly routingReason?: string
  readonly taskIds: readonly string[]
}

/** The whole document the panel reads in one request. */
export interface UiBoardSnapshot {
  /** Bumped when a field changes meaning; additive fields do not bump it. */
  readonly version: 2
  readonly fetchedAt: string
  readonly partitions: readonly UiPartitionView[]
  readonly tasks: readonly UiTaskView[]
  readonly demands: readonly UiDemandView[]
  /** Rows per host state, so a badge needs no second pass. */
  readonly counts: Readonly<Record<string, number>>
  /** Rows per panel tab. */
  readonly buckets: Readonly<Record<UiBucket, number>>
  /** Credential presence only — never a value. */
  readonly credentials: readonly UiCredentialView[]
  /** Always `host` here: only the client's sample data is labelled otherwise. */
  readonly origin: 'host'
  readonly staleSince?: string
  /** Progress per request (root task). */
  readonly groups?: readonly GroupProgress[]
  /** Recent progress notices, newest first. */
  readonly notices?: readonly { readonly at: string; readonly text: string }[]
}

/** One routing outcome inside a publish response. */
export interface PublishRouted {
  readonly text: string
  readonly partitionId?: string
  readonly reason?: string
}

/** What a publish call answers. */
export interface PublishResult {
  readonly accepted: number
  readonly routed: readonly PublishRouted[]
  /** The 作战室 session the demands were posted into. */
  readonly anchorSessionId?: string
}

/** The host state → panel state table. Total: every host state has a row. */
export const STATE_TO_UI: Readonly<Record<TaskState, UiTaskState>> = {
  // Accepted, waiting for a worker slot: still the dispatch lane.
  queued: 'queued',
  // A child session exists but its log shows no turn yet. The panel has no
  // separate word for that, and "running" is the honest reading: a worker holds
  // it.
  dispatched: 'running',
  running: 'running',
  // The worker's own claim. NOT verified — the panel keeps its own lane for it.
  // No human acceptance step: a normal end is finished. `reported` is the
  // pre-`done` spelling of the same outcome on older rows.
  reported: 'verified',
  done: 'verified',
  verified: 'verified',
  // The worker errored, or acceptance failed: the panel's "sent back" state,
  // which keeps the reason and the attempt count.
  failed: 'rejected',
  // Parked on a human decision. Nothing runs, nothing finished: it is next up
  // again once someone decides.
  blocked: 'queued',
  // Cancelled on request. Terminal, and never done — the panel's "sent back"
  // state is the closest fit, and `hostState` still says `cancelled`.
  cancelled: 'rejected',
  // Stopped by a restart and waiting to be resumed from its own log: still work
  // in progress, not a result.
  interrupted: 'running',
  // Parked until a prerequisite finishes: next up again, like a blocked row.
  suspended: 'queued',
}

/**
 * The panel state → tab table.
 *
 * Deliberately a function of the *panel* state rather than of the host state:
 * the tab strip only ever sees five values, so one table decides placement and
 * there is no second place for them to disagree.
 *
 * `scheduled` has no producer today: the router dispatches as soon as a slot is
 * free and has no scheduler, so no row can be "not due yet". The value stays in
 * the union because the panel's tab exists.
 */
export const BUCKET_OF_STATE: Readonly<Record<UiTaskState, UiBucket>> = {
  queued: 'up-next',
  running: 'active',
  reported: 'active',
  verified: 'resolved',
  rejected: 'resolved',
}

/** A failed HTTP call, carrying the status and the stable error code the client prints. */
export class BridgeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'BridgeError'
  }
}

/**
 * Normalise a credential provider's source layer onto the panel's four values.
 *
 * The local provider reports finer layers — `env`, `file`, `project-env`,
 * `user-env` (`@deepseek-ai/dsh-credentials/src/index.ts:121`) — while the panel
 * draws an origin badge with four states. Anything unrecognised reads as
 * `unknown` rather than being forced into a wrong badge.
 * @param raw - the provider's source string, if it supplied one.
 * @returns the panel's coarser value.
 */
export function credentialSourceOf(raw: unknown): 'file' | 'env' | 'unset' | 'unknown' {
  if (typeof raw !== 'string' || raw.trim() === '') return 'unknown'
  const text = raw.trim().toLowerCase()
  if (text === 'unset' || text === 'none' || text === 'absent') return 'unset'
  if (text.includes('file')) return 'file'
  if (text.includes('env')) return 'env'
  return 'unknown'
}

/** One partition's static facts, as the bridge needs them. */
export interface PartitionSource {
  readonly name: string
  readonly dir: string
  readonly slots: number
  readonly managerEnabled: boolean
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
  readonly description?: string
}

/** Everything the routes need from the plugin. Injected so the routes stay pure I/O. */
export interface BridgeDeps {
  readonly logger: LoggerService
  readonly partitions: readonly PartitionSource[]
  /** Whether a partition's durable row is currently enabled. */
  readonly isEnabled: (name: string) => boolean
  /** Build (and persist) the host snapshot. */
  readonly snapshot: () => Promise<RouterSnapshot>
  /** Post demand texts into the 作战室 anchor conversation. */
  readonly publish: (texts: readonly string[]) => Promise<PublishResult>
  /** Create or resume the anchor and return its session id. */
  readonly anchor?: () => Promise<{ sessionId: string; title: string }>
  /** Record a human verification decision. */
  readonly verify: (
    taskId: string,
    verdict: 'verified' | 'rejected',
    note: string | undefined,
  ) => Promise<{ id: string; state: TaskState }>
  /** Run one `task_control` action from the panel; absent means the route answers 404. */
  readonly control?: (
    taskId: string,
    action: string,
    value: string | undefined,
    extra?: { readonly prerequisite?: string; readonly waitFor?: readonly string[] },
  ) => Promise<{ id: string; state: TaskState; text: string }>
  /** One directory level of a partition; absent means the route answers 404. */
  readonly files?: (partition: string, path: string | undefined) => Promise<unknown>
  /**
   * Outlets and the wider control surface: the approval queue, the audit log,
   * a worker's live output, reassigning a task, and batch actions. Absent means
   * these routes answer 404.
   */
  readonly desk?: {
    readonly approvals: () => Promise<unknown>
    readonly decide: (id: string, decision: 'approve' | 'reject', note: string | undefined) => Promise<unknown>
    readonly audit: (limit: number) => Promise<unknown>
    readonly live: (taskId: string, after: number) => Promise<unknown>
    readonly reassign: (input: {
      readonly taskId: string
      readonly partition?: string
      readonly model?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
      readonly keepProgress: boolean
      readonly note?: string
    }) => Promise<unknown>
    readonly batch: (taskIds: readonly string[], action: string, value: string | undefined) => Promise<unknown>
  }
  /** Partition memory; absent means the route answers 404. */
  readonly memory?: {
    readonly read: (partition: string) => Promise<unknown>
    readonly addNote: (partition: string, text: string) => Promise<unknown>
    readonly removeNote: (partition: string, id: string) => Promise<unknown>
  }
  /** Partition configuration problems found at boot. */
  readonly problems?: () => readonly { readonly partition: string; readonly level: 'error' | 'warning'; readonly message: string }[]
  /** Flip a partition's operator switch. */
  readonly setPartitionState: (name: string, enabled: boolean) => Promise<{ id: string; enabled: boolean }>
  /** Credential presence by reference; never values. */
  readonly credentials: () => Promise<readonly UiCredentialView[]>
  /** File whose mtime moves on every board write: the SSE change signal. */
  readonly changeFile: string
  /** Difficulty-tier model settings; absent means the route answers 404. */
  readonly tiers?: {
    readonly read: () => Promise<unknown>
    readonly write: (body: Record<string, unknown>) => Promise<unknown>
  }
}

/** The worker id a row's worker appears under in the roster. */
function workerIdOf(task: TaskView): string {
  return `w:${task.id}`
}

/** Whether a row's worker is still occupying a slot. */
function isOccupying(task: TaskView): boolean {
  return task.state === 'dispatched' || task.state === 'running'
}

/**
 * Build the roster for one partition.
 *
 * The router has no long-lived worker entity — a worker *is* a task's child
 * session — so the roster is derived, and each derivation is stated:
 *
 * - a row holding a slot becomes `busy` (it will release the slot when it settles);
 * - a row whose worker self-reported becomes `released`: the capacity is already
 *   back (a reported row holds no slot, `./index.ts` `holdsSlot`), and the panel
 *   must not draw it as "still burning a machine";
 * - every remaining slot becomes an `online` (idle, dispatchable) worker.
 *
 * `offline` is never emitted: the router has no reachability probe, and claiming
 * a worker is unreachable without evidence would be a guess.
 * @param partition - static partition facts.
 * @param scoped - the partition's task rows.
 * @param now - clock for the elapsed-time estimate, in milliseconds.
 * @returns the roster in a stable order.
 */
function rosterOf(
  partition: PartitionSource,
  scoped: readonly TaskView[],
  now: number,
): readonly UiWorkerView[] {
  const busy = scoped.filter(isOccupying)
  const reported = scoped.filter(task => task.state === 'reported' || task.state === 'done')
  const workers: UiWorkerView[] = []
  for (const task of busy) {
    const startedAt = Date.parse(task.createdAt)
    workers.push({
      id: workerIdOf(task),
      name: task.worker ?? `worker-${String(workers.length + 1)}`,
      presence: 'busy',
      activity: task.subject,
      ...task.sessionId === undefined ? {} : { sessionId: task.sessionId },
      ...Number.isFinite(startedAt) ? { elapsedSeconds: Math.max(0, Math.round((now - startedAt) / 1000)) } : {},
    })
  }
  for (const task of reported) {
    workers.push({
      id: workerIdOf(task),
      name: task.worker ?? `worker-${String(workers.length + 1)}`,
      presence: 'released',
      ...task.sessionId === undefined ? {} : { sessionId: task.sessionId },
    })
  }
  // `slots === 0` means no cap: there is no fixed set of idle seats to draw, so none are.
  for (let slot = busy.length; slot < partition.slots; slot++) {
    workers.push({
      id: `w:${partition.name}:slot-${String(slot + 1)}`,
      name: `worker-${String(slot + 1)}`,
      presence: 'online',
    })
  }
  return workers
}

/**
 * Translate one host row into the panel's task shape.
 * @param task - the folded host row.
 * @returns the panel task; `hostState` retains everything the mapping narrows.
 */
function taskOf(task: TaskView): UiTaskView {
  const state = STATE_TO_UI[task.state]
  const holdsRoster = isOccupying(task) || task.state === 'reported' || task.state === 'done'
  const active = task.todos.current
  return {
    id: task.id,
    title: task.subject,
    partitionId: task.partition,
    hostState: task.state,
    state,
    bucket: BUCKET_OF_STATE[state],
    todos: task.todos.todos ?? [],
    todoProgress: {
      done: task.todos.done,
      total: task.todos.total,
      ratio: task.todos.ratio,
      ...active === undefined ? {} : { current: active },
    },
    progress: task.progress,
    updatedAt: task.updatedAt,
    requestedAt: task.createdAt,
    // The board keeps one timestamp per row; it is the report time while the
    // row sits in `reported` and the acceptance time while it sits in `verified`.
    ...task.state === 'reported' || task.state === 'done' ? { reportedAt: task.updatedAt } : {},
    ...task.state === 'verified' || task.state === 'done' || task.state === 'reported' ? { verifiedAt: task.updatedAt } : {},
    // The host counts starts from zero (nobody has started it yet); the panel
    // counts attempts from one.
    attempt: Math.max(1, task.attempts),
    level: task.level,
    ...task.parentId === undefined ? {} : { parentId: task.parentId },
    priority: task.priority,
    ...task.activity === undefined ? {} : {
      toolCalls: task.activity.toolCalls,
      ...task.activity.lastTool === undefined ? {} : { lastTool: task.activity.lastTool },
      ...task.activity.lastActivityAt === undefined ? {} : { lastActivityAt: task.activity.lastActivityAt },
      ...task.activity.startedAt === undefined ? {} : { startedAt: task.activity.startedAt },
    },
    ...holdsRoster ? { workerId: workerIdOf(task) } : {},
    ...task.sessionId === undefined ? {} : { workerSessionId: task.sessionId },
    ...state === 'rejected' ? { rejectionReason: task.error ?? 'acceptance did not pass' } : {},
    ...task.result === undefined ? {} : { result: task.result },
    ...task.verifyOutput === undefined ? {} : { verifyOutput: task.verifyOutput },
    ...task.error === undefined ? {} : { error: task.error },
    ...task.resumeNote === undefined ? {} : { resumeNote: task.resumeNote },
    ...task.dependsOn === undefined ? {} : { dependsOn: task.dependsOn },
    ...task.stage === undefined ? {} : { stage: task.stage },
    ...task.waitingFor === undefined ? {} : { waitingFor: task.waitingFor },
    ...task.suspendReason === undefined ? {} : { suspendReason: task.suspendReason },
    ...task.waitingOn === undefined ? {} : { waitingOn: task.waitingOn },
    ...task.rootId === undefined ? {} : { rootId: task.rootId },
    ...task.tier === undefined ? {} : { tier: task.tier },
    ...task.tierSource === undefined ? {} : { tierSource: task.tierSource },
    ...task.tierReason === undefined ? {} : { tierReason: task.tierReason },
    ...task.provider === undefined ? {} : { provider: task.provider },
    ...task.model === undefined ? {} : { model: task.model },
    ...task.reasoningEffort === undefined ? {} : { reasoningEffort: task.reasoningEffort },
    ...task.reassignedTo === undefined ? {} : { reassignedTo: task.reassignedTo },
    ...task.reassignedFrom === undefined ? {} : { reassignedFrom: task.reassignedFrom },
    ...task.pr === undefined ? {} : { pr: task.pr },
  }
}

/** Newest first, with the id as a tie-break so the order is stable. */
function byNewest(left: { readonly updatedAt: string; readonly id: string }, right: { readonly updatedAt: string; readonly id: string }): number {
  const at = Date.parse(left.updatedAt)
  const bt = Date.parse(right.updatedAt)
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0
}

/**
 * Fold the host snapshot into the panel's document.
 *
 * Pure apart from the clock, so the mapping can be asserted in a test without a
 * harness, a socket, or a browser.
 * @param input - host snapshot plus the facts the snapshot does not carry.
 * @returns the document `GET /api/router/board` answers with.
 */
export function boardDocument(input: {
  readonly snapshot: RouterSnapshot
  readonly partitions: readonly PartitionSource[]
  readonly isEnabled: (name: string) => boolean
  readonly credentials: readonly UiCredentialView[]
  /** Partition configuration problems found at boot. */
  readonly problems?: readonly { readonly partition: string; readonly level: 'error' | 'warning'; readonly message: string }[]
  /** Clock override, for tests. */
  readonly now?: number
}): UiBoardSnapshot {
  const now = input.now ?? Date.now()
  const tasks = input.snapshot.tasks.map(taskOf).sort(byNewest)
  const buckets: Record<UiBucket, number> = { active: 0, 'up-next': 0, scheduled: 0, resolved: 0 }
  for (const task of tasks) buckets[task.bucket] += 1

  const partitions: UiPartitionView[] = input.partitions.map((partition) => {
    const scopedTasks = input.snapshot.tasks.filter(task => task.partition === partition.name)
    const scopedViews = tasks.filter(task => task.partitionId === partition.name)
    return {
      id: partition.name,
      name: partition.name,
      repo: partition.dir,
      path: partition.dir,
      enabled: input.isEnabled(partition.name),
      workerCount: partition.slots,
      liveWorkers: scopedViews.filter(task => task.state === 'running').length,
      queuedCount: scopedViews.filter(task => task.state === 'queued').length,
      // No human acceptance step: nothing waits on the user.
      unreviewedCount: 0,
      suspendedCount: scopedViews.filter(task => task.hostState === 'suspended').length,
      taskCount: scopedViews.length,
      ...partition.include === undefined ? {} : { include: partition.include },
      ...partition.exclude === undefined ? {} : { exclude: partition.exclude },
      ...partition.description === undefined ? {} : { description: partition.description },
      problems: (input.problems ?? [])
        .filter(problem => problem.partition === partition.name)
        .map(problem => ({ level: problem.level, message: problem.message })),
      manager: {
        id: `mgr:${partition.name}`,
        // A partition without a manager seat is routed by the router itself;
        // naming it `router` says so instead of inventing an agent.
        name: partition.managerEnabled ? 'manager' : 'router',
        presence: scopedTasks.some(task => task.level === 'manager' && isOccupying(task)) ? 'busy' : 'online',
        dispatched: scopedViews.filter(task => task.level === 'worker').length,
        awaitingVerification: 0,
      },
      workers: rosterOf(partition, scopedTasks, now),
    }
  })

  // The router has no demand queue: it resolves a partition at enqueue time, so
  // a demand never waits unrouted. The flow is therefore derived one row per
  // root task, and `taskIds` is exact rather than reconstructed.
  const demands: UiDemandView[] = input.snapshot.tasks
    .filter(task => task.parentId === undefined)
    .map((task) => ({
      id: `dmd:${task.id}`,
      text: task.subject,
      publishedAt: task.createdAt,
      partitionId: task.partition,
      routingReason: `${task.reason}: ${task.because.join('; ')}`,
      taskIds: [task.id],
    }))
    .sort((left, right) => byNewest(
      { updatedAt: left.publishedAt, id: left.id },
      { updatedAt: right.publishedAt, id: right.id },
    ))

  return {
    version: 2,
    fetchedAt: new Date(now).toISOString(),
    partitions,
    tasks,
    demands,
    counts: input.snapshot.counts,
    buckets,
    credentials: input.credentials,
    origin: 'host',
    ...input.snapshot.groups === undefined ? {} : { groups: input.snapshot.groups },
    ...input.snapshot.notices === undefined ? {} : { notices: input.snapshot.notices },
  }
}

/** Answer one exchange with JSON. */
function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Answer a wrong method, naming the one route that exists. */
function sendMethodNotAllowed(res: ServerResponse, allow: string): void {
  res.writeHead(405, { allow, 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: { code: 'method-not-allowed', message: `use ${allow}` } }))
}

/**
 * Read one JSON request body, bounded.
 *
 * The `application/json` content type is required, exactly as the shipped
 * `dsh-host-open-in-app` routes require it
 * (`…/dsh-host-open-in-app/src/index.ts:250-256`): a browser then has to
 * preflight a cross-origin POST, so a random page cannot drive the router
 * without the server ever opting in.
 * @param req - the request.
 * @returns the decoded body.
 * @throws {BridgeError} 415 for a wrong content type, 413 when too large, 400 when unparseable.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
  if (essence !== 'application/json') {
    throw new BridgeError(415, 'unsupported-media-type', 'content-type must be application/json')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new BridgeError(413, 'body-too-large', `request body exceeds ${String(MAX_BODY_BYTES)} bytes`)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') throw new BridgeError(400, 'bad-request', 'request body is empty')
  try {
    return JSON.parse(text)
  } catch {
    throw new BridgeError(400, 'bad-request', 'request body is not JSON')
  }
}

/** Narrow a decoded body to a plain object. */
function objectOf(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BridgeError(400, 'bad-request', `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

/** Wrap a handler so a throw becomes a JSON error instead of a dropped socket. */
function guard(
  deps: BridgeDeps,
  label: string,
  run: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      await run(req, res)
    } catch (error) {
      const failure = error instanceof BridgeError
        ? error
        : new BridgeError(500, 'internal', error instanceof Error ? error.message : String(error))
      if (!(error instanceof BridgeError)) {
        deps.logger.warn(`host-router: ${label} failed: ${String(error)}`)
      }
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendJson(res, failure.status, { error: { code: failure.code, message: failure.message } })
    }
  }
}

/** `GET /api/router/board`. */
async function boardRoute(req: IncomingMessage, res: ServerResponse, deps: BridgeDeps): Promise<void> {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res, 'GET')
    return
  }
  const [snapshot, credentials] = await Promise.all([deps.snapshot(), deps.credentials()])
  sendJson(res, 200, boardDocument({
    snapshot,
    partitions: deps.partitions,
    isEnabled: deps.isEnabled,
    credentials,
    ...deps.problems === undefined ? {} : { problems: deps.problems() },
  }))
}

/** `POST /api/router/publish` with `{ demands: string[] }`. */
async function publishRoute(req: IncomingMessage, res: ServerResponse, deps: BridgeDeps): Promise<void> {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, 'POST')
    return
  }
  const body = objectOf(await readJsonBody(req), 'body')
  const raw = body.demands
  if (!Array.isArray(raw)) throw new BridgeError(400, 'bad-request', 'demands must be an array of strings')
  if (raw.length > MAX_DEMANDS) throw new BridgeError(400, 'bad-request', `at most ${String(MAX_DEMANDS)} demands per call`)
  const texts = raw.map((entry, index) => {
    if (typeof entry !== 'string') throw new BridgeError(400, 'bad-request', `demands[${String(index)}] must be a string`)
    return entry.trim()
  }).filter(text => text !== '')
  if (texts.length === 0) throw new BridgeError(400, 'bad-request', 'demands holds no non-empty text')
  sendJson(res, 200, await deps.publish(texts))
}

/** `GET /api/router/anchor`: the 作战室 session id. */
async function anchorRoute(req: IncomingMessage, res: ServerResponse, deps: BridgeDeps): Promise<void> {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res, 'GET')
    return
  }
  if (deps.anchor === undefined) throw new BridgeError(404, 'not-found', 'this router has no anchor session')
  sendJson(res, 200, await deps.anchor())
}

/** `POST /api/router/verify` with `{ taskId, verdict, note? }`. */
async function verifyRoute(req: IncomingMessage, res: ServerResponse, deps: BridgeDeps): Promise<void> {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, 'POST')
    return
  }
  const body = objectOf(await readJsonBody(req), 'body')
  if (typeof body.taskId !== 'string' || body.taskId.trim() === '') {
    throw new BridgeError(400, 'bad-request', 'taskId must be a non-empty string')
  }
  const verdict = body.verdict
  if (verdict !== 'verified' && verdict !== 'rejected') {
    throw new BridgeError(400, 'bad-request', 'verdict must be "verified" or "rejected"')
  }
  if (body.note !== undefined && typeof body.note !== 'string') {
    throw new BridgeError(400, 'bad-request', 'note must be a string when present')
  }
  const updated = await deps.verify(body.taskId.trim(), verdict, body.note as string | undefined)
  sendJson(res, 200, { ok: true, task: updated })
}

/** `POST /api/router/control` with `{ taskId, action, value? }`. */
async function controlRoute(req: IncomingMessage, res: ServerResponse, deps: BridgeDeps): Promise<void> {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, 'POST')
    return
  }
  if (deps.control === undefined) throw new BridgeError(404, 'not-found', 'task control is not available')
  const body = objectOf(await readJsonBody(req), 'body')
  if (typeof body.taskId !== 'string' || body.taskId.trim() === '') {
    throw new BridgeError(400, 'bad-request', 'taskId must be a non-empty string')
  }
  if (typeof body.action !== 'string' || body.action.trim() === '') {
    throw new BridgeError(400, 'bad-request', 'action must be a non-empty string')
  }
  if (body.value !== undefined && typeof body.value !== 'string') {
    throw new BridgeError(400, 'bad-request', 'value must be a string when present')
  }
  if (body.prerequisite !== undefined && typeof body.prerequisite !== 'string') {
    throw new BridgeError(400, 'bad-request', 'prerequisite must be a string when present')
  }
  if (body.waitFor !== undefined && (!Array.isArray(body.waitFor) || body.waitFor.some(id => typeof id !== 'string'))) {
    throw new BridgeError(400, 'bad-request', 'waitFor must be an array of task ids when present')
  }
  const prerequisite = typeof body.prerequisite === 'string' && body.prerequisite.trim() !== '' ? body.prerequisite.trim() : undefined
  const waitFor = Array.isArray(body.waitFor) ? (body.waitFor as string[]).map(id => id.trim()).filter(id => id !== '') : undefined
  const updated = await deps.control(body.taskId.trim(), body.action.trim(), body.value as string | undefined, {
    ...prerequisite === undefined ? {} : { prerequisite },
    ...waitFor === undefined || waitFor.length === 0 ? {} : { waitFor },
  })
  sendJson(res, 200, { ok: true, task: { id: updated.id, state: updated.state }, text: updated.text })
}

/** `POST /api/router/partition` with `{ id, enabled }`. */
async function partitionRoute(req: IncomingMessage, res: ServerResponse, deps: BridgeDeps): Promise<void> {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, 'POST')
    return
  }
  const body = objectOf(await readJsonBody(req), 'body')
  if (typeof body.id !== 'string' || body.id.trim() === '') {
    throw new BridgeError(400, 'bad-request', 'id must be a non-empty string')
  }
  if (typeof body.enabled !== 'boolean') throw new BridgeError(400, 'bad-request', 'enabled must be a boolean')
  const updated = await deps.setPartitionState(body.id.trim(), body.enabled)
  sendJson(res, 200, { ok: true, partition: updated })
}

/** `GET|POST /api/router/tiers` — difficulty-tier model routes. */
async function tiersRoute(req: IncomingMessage, res: ServerResponse, deps: BridgeDeps): Promise<void> {
  if (deps.tiers === undefined) throw new BridgeError(404, 'not-found', 'tier settings are not available')
  if (req.method === 'GET') {
    sendJson(res, 200, await deps.tiers.read())
    return
  }
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, 'GET, POST')
    return
  }
  const body = objectOf(await readJsonBody(req), 'body')
  sendJson(res, 200, await deps.tiers.write(body))
}

/** `GET /api/router/files?partition=<name>&path=<relative dir>`. */
async function filesRoute(req: IncomingMessage, res: ServerResponse, deps: BridgeDeps): Promise<void> {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res, 'GET')
    return
  }
  if (deps.files === undefined) throw new BridgeError(404, 'not-found', 'the workspace listing is not available')
  const url = new URL(req.url ?? '/', 'http://router.invalid')
  const partition = url.searchParams.get('partition')?.trim() ?? ''
  if (partition === '') throw new BridgeError(400, 'bad-request', 'partition is required')
  const path = url.searchParams.get('path') ?? undefined
  sendJson(res, 200, await deps.files(partition, path))
}

/**
 * `GET /api/router/memory?partition=<name>` — notes, recent work, sessions.
 * `POST` `{ partition, text }` adds a note; `DELETE ?partition=&id=` removes one.
 */
async function memoryRoute(req: IncomingMessage, res: ServerResponse, deps: BridgeDeps): Promise<void> {
  if (deps.memory === undefined) throw new BridgeError(404, 'not-found', 'partition memory is not available')
  const url = new URL(req.url ?? '/', 'http://router.invalid')
  if (req.method === 'GET') {
    const partition = url.searchParams.get('partition')?.trim() ?? ''
    if (partition === '') throw new BridgeError(400, 'bad-request', 'partition is required')
    sendJson(res, 200, await deps.memory.read(partition))
    return
  }
  if (req.method === 'POST') {
    const body = objectOf(await readJsonBody(req), 'body')
    if (typeof body['partition'] !== 'string' || body['partition'].trim() === '') {
      throw new BridgeError(400, 'bad-request', 'partition must be a non-empty string')
    }
    if (typeof body['text'] !== 'string' || body['text'].trim() === '') {
      throw new BridgeError(400, 'bad-request', 'text must be a non-empty string')
    }
    sendJson(res, 200, await deps.memory.addNote(body['partition'].trim(), body['text']))
    return
  }
  if (req.method === 'DELETE') {
    const partition = url.searchParams.get('partition')?.trim() ?? ''
    const id = url.searchParams.get('id')?.trim() ?? ''
    if (partition === '' || id === '') throw new BridgeError(400, 'bad-request', 'partition and id are required')
    sendJson(res, 200, await deps.memory.removeNote(partition, id))
    return
  }
  sendMethodNotAllowed(res, 'GET, POST, DELETE')
}

/** Run a desk call; an ordinary error is a refused action (409), not a server fault. */
async function deskCall(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof BridgeError) throw error
    throw new BridgeError(409, 'conflict', error instanceof Error ? error.message : String(error))
  }
}

/** `GET /api/router/approvals` lists; `POST {id, decision, note?}` approves or rejects one. */
async function approvalsRoute(req: IncomingMessage, res: ServerResponse, deps: BridgeDeps): Promise<void> {
  const desk = deps.desk
  if (desk === undefined) throw new BridgeError(404, 'not-found', 'approvals are not available')
  if (req.method === 'GET') {
    sendJson(res, 200, await desk.approvals())
    return
  }
  if (req.method === 'POST') {
    const body = objectOf(await readJsonBody(req), 'body')
    const id = typeof body['id'] === 'string' ? body['id'].trim() : ''
    if (id === '') throw new BridgeError(400, 'bad-request', 'id must be a non-empty string')
    if (body['decision'] !== 'approve' && body['decision'] !== 'reject') {
      throw new BridgeError(400, 'bad-request', 'decision must be "approve" or "reject"')
    }
    if (body['note'] !== undefined && typeof body['note'] !== 'string') throw new BridgeError(400, 'bad-request', 'note must be a string')
    const decision = body['decision']
    sendJson(res, 200, await deskCall(() => desk.decide(id, decision, body['note'] as string | undefined)))
    return
  }
  sendMethodNotAllowed(res, 'GET, POST')
}

/** `GET /api/router/audit?limit=` — newest audit lines. */
async function auditRoute(req: IncomingMessage, res: ServerResponse, deps: BridgeDeps): Promise<void> {
  if (deps.desk === undefined) throw new BridgeError(404, 'not-found', 'audit is not available')
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res, 'GET')
    return
  }
  const url = new URL(req.url ?? '/', 'http://router.invalid')
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '100') || 100))
  sendJson(res, 200, await deps.desk.audit(limit))
}

/** `GET /api/router/live?taskId=&after=` — a worker's output since segment `after`. */
async function liveRoute(req: IncomingMessage, res: ServerResponse, deps: BridgeDeps): Promise<void> {
  const desk = deps.desk
  if (desk === undefined) throw new BridgeError(404, 'not-found', 'live output is not available')
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res, 'GET')
    return
  }
  const url = new URL(req.url ?? '/', 'http://router.invalid')
  const taskId = url.searchParams.get('taskId')?.trim() ?? ''
  if (taskId === '') throw new BridgeError(400, 'bad-request', 'taskId is required')
  const after = Number(url.searchParams.get('after') ?? '-1')
  sendJson(res, 200, await deskCall(() => desk.live(taskId, Number.isFinite(after) ? after : -1)))
}

/** `POST /api/router/reassign {taskId, partition?, model?, keepProgress?, note?}`. */
async function reassignRoute(req: IncomingMessage, res: ServerResponse, deps: BridgeDeps): Promise<void> {
  const desk = deps.desk
  if (desk === undefined) throw new BridgeError(404, 'not-found', 'reassign is not available')
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, 'POST')
    return
  }
  const body = objectOf(await readJsonBody(req), 'body')
  const taskId = typeof body['taskId'] === 'string' ? body['taskId'].trim() : ''
  if (taskId === '') throw new BridgeError(400, 'bad-request', 'taskId must be a non-empty string')
  if (body['partition'] !== undefined && typeof body['partition'] !== 'string') throw new BridgeError(400, 'bad-request', 'partition must be a string')
  let model: { provider: string; model: string; reasoningEffort?: string } | undefined
  if (body['model'] !== undefined && body['model'] !== null) {
    const raw = objectOf(body['model'], 'model')
    if (typeof raw['provider'] !== 'string' || typeof raw['model'] !== 'string') {
      throw new BridgeError(400, 'bad-request', 'model must be {provider, model, reasoningEffort?}')
    }
    model = {
      provider: raw['provider'], model: raw['model'],
      ...typeof raw['reasoningEffort'] === 'string' ? { reasoningEffort: raw['reasoningEffort'] } : {},
    }
  }
  const partition = typeof body['partition'] === 'string' && body['partition'].trim() !== '' ? body['partition'].trim() : undefined
  const note = typeof body['note'] === 'string' && body['note'].trim() !== '' ? body['note'].trim() : undefined
  sendJson(res, 200, await deskCall(() => desk.reassign({
    taskId,
    ...partition === undefined ? {} : { partition },
    ...model === undefined ? {} : { model },
    keepProgress: body['keepProgress'] !== false,
    ...note === undefined ? {} : { note },
  })))
}

/** `POST /api/router/batch {taskIds, action, value?}` — one action over many rows. */
async function batchRoute(req: IncomingMessage, res: ServerResponse, deps: BridgeDeps): Promise<void> {
  const desk = deps.desk
  if (desk === undefined) throw new BridgeError(404, 'not-found', 'batch actions are not available')
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, 'POST')
    return
  }
  const body = objectOf(await readJsonBody(req), 'body')
  const ids = body['taskIds']
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || ids.some(id => typeof id !== 'string' || id.trim() === '')) {
    throw new BridgeError(400, 'bad-request', 'taskIds must be 1..200 task ids')
  }
  if (typeof body['action'] !== 'string' || body['action'].trim() === '') throw new BridgeError(400, 'bad-request', 'action is required')
  if (body['value'] !== undefined && typeof body['value'] !== 'string') throw new BridgeError(400, 'bad-request', 'value must be a string')
  const action = body['action'].trim()
  sendJson(res, 200, await deskCall(() => desk.batch([...new Set((ids as string[]).map(id => id.trim()))], action, body['value'] as string | undefined)))
}

/**
 * `GET /api/router/events` — server-sent change notifications.
 *
 * The payload carries no board data on purpose: the panel re-reads
 * `/api/router/board` itself, so one signal cannot disagree with the document
 * it is announcing. The signal is the board file's mtime, which moves on every
 * write (`TaskBoard.flush`), so a change made by any path — a tool, a settlement,
 * this bridge — produces exactly one event.
 *
 * A client that cannot keep the stream open is expected to fall back to polling;
 * the client half does that.
 */
function eventsRoute(req: IncomingMessage, res: ServerResponse, deps: BridgeDeps): void {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res, 'GET')
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    // nginx-style buffers would hold every frame; the shell is served directly,
    // but the header costs nothing and stops a deployment surprise.
    'x-accel-buffering': 'no',
  })

  let closed = false
  let poll: NodeJS.Timeout | undefined
  let beat: NodeJS.Timeout | undefined
  let expiry: NodeJS.Timeout | undefined

  function close(): void {
    if (closed) return
    closed = true
    if (poll !== undefined) clearInterval(poll)
    if (beat !== undefined) clearInterval(beat)
    if (expiry !== undefined) clearTimeout(expiry)
    if (!res.writableEnded) {
      try {
        res.end()
      } catch {
        // The peer is already gone; nothing left to close.
      }
    }
  }

  function write(frame: string): void {
    if (closed || res.writableEnded || res.destroyed) return
    try {
      res.write(frame)
    } catch {
      close()
    }
  }

  // A reconnecting EventSource waits this long; the panel's own poll is slower.
  write('retry: 3000\n\n')
  write('event: hello\ndata: {}\n\n')

  let lastStamp = 0
  const check = async (): Promise<void> => {
    try {
      const info = await stat(deps.changeFile)
      if (lastStamp !== 0 && info.mtimeMs !== lastStamp) {
        write(`event: changed\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`)
      }
      lastStamp = info.mtimeMs
    } catch {
      // The board file does not exist until the first write: no change to report.
      lastStamp = 0
    }
  }

  void check()
  poll = setInterval(() => { void check() }, EVENTS_POLL_MS)
  beat = setInterval(() => { write(': ping\n\n') }, EVENTS_BEAT_MS)
  expiry = setTimeout(close, EVENTS_MAX_LIFETIME_MS)
  // Timers must not keep the process alive on their own.
  poll.unref()
  beat.unref()
  expiry.unref()
  req.on('close', close)
  res.on('close', close)
  res.on('error', close)
}

/**
 * Build the bridge's routes.
 *
 * Pure construction: registering them (and disposing them) belongs to the
 * plugin activation, so a test can drive each handler with a fake exchange.
 * @param deps - what the handlers act on.
 * @returns one route per endpoint, in path order.
 */
export function createRoutes(deps: BridgeDeps): readonly WebRouteLike[] {
  return [
    { kind: 'exact', path: BOARD_PATH, handler: guard(deps, BOARD_PATH, (req, res) => boardRoute(req, res, deps)) },
    { kind: 'exact', path: PUBLISH_PATH, handler: guard(deps, PUBLISH_PATH, (req, res) => publishRoute(req, res, deps)) },
    { kind: 'exact', path: ANCHOR_PATH, handler: guard(deps, ANCHOR_PATH, (req, res) => anchorRoute(req, res, deps)) },
    { kind: 'exact', path: VERIFY_PATH, handler: guard(deps, VERIFY_PATH, (req, res) => verifyRoute(req, res, deps)) },
    { kind: 'exact', path: CONTROL_PATH, handler: guard(deps, CONTROL_PATH, (req, res) => controlRoute(req, res, deps)) },
    { kind: 'exact', path: PARTITION_PATH, handler: guard(deps, PARTITION_PATH, (req, res) => partitionRoute(req, res, deps)) },
    { kind: 'exact', path: TIERS_PATH, handler: guard(deps, TIERS_PATH, (req, res) => tiersRoute(req, res, deps)) },
    { kind: 'exact', path: FILES_PATH, handler: guard(deps, FILES_PATH, (req, res) => filesRoute(req, res, deps)) },
    { kind: 'exact', path: APPROVALS_PATH, handler: guard(deps, APPROVALS_PATH, (req, res) => approvalsRoute(req, res, deps)) },
    { kind: 'exact', path: AUDIT_PATH, handler: guard(deps, AUDIT_PATH, (req, res) => auditRoute(req, res, deps)) },
    { kind: 'exact', path: LIVE_PATH, handler: guard(deps, LIVE_PATH, (req, res) => liveRoute(req, res, deps)) },
    { kind: 'exact', path: REASSIGN_PATH, handler: guard(deps, REASSIGN_PATH, (req, res) => reassignRoute(req, res, deps)) },
    { kind: 'exact', path: BATCH_PATH, handler: guard(deps, BATCH_PATH, (req, res) => batchRoute(req, res, deps)) },
    { kind: 'exact', path: MEMORY_PATH, handler: guard(deps, MEMORY_PATH, (req, res) => memoryRoute(req, res, deps)) },
    { kind: 'exact', path: EVENTS_PATH, handler: guard(deps, EVENTS_PATH, async (req, res) => { eventsRoute(req, res, deps) }) },
  ]
}
