/**
 * The router board's data contract, as the Web client expects it.
 *
 * This file is the single authority for what the panel renders. The Host-side
 * plugin (`packages/host-router`) is expected to produce these values — see
 * `docs/CONTRACT.md` for the exact Remote surface and the reasons behind each
 * field.
 *
 * Two states are deliberately NOT collapsed:
 *
 *   `reported`  the worker says it is done.
 *   `verified`  a verifier says the work is acceptable.
 *
 * A worker's self-report is not evidence: in 16 real delegations recorded in
 * arXiv:2611.04100 three were logged as done while the work had failed. So the
 * board renders `reported` as its own lane ("待验收") and never advances a task
 * to `verified` on the strength of a self-report.
 *
 * Additions for the three-column layout are all OPTIONAL, so an existing Host
 * that produces the v1 payload keeps working unchanged:
 *
 *   `PartitionView.enabled`       the rail's 启用/停用 switch state
 *   `TaskView.scheduledFor`       moves a queued task from 待派 to 排程
 *   `BoardSnapshot.credentials`   the rail's API-key status rows
 *
 * Absent means "the Host does not report it", and every view says so rather than
 * inventing a value.
 */

/** Where a task sits in its lifecycle. */
export type TaskState =
  /** Accepted by the router but not handed to a worker yet. */
  | 'queued'
  /** A worker holds it and is working. */
  | 'running'
  /** The worker self-reported completion. Awaiting verification — NOT done. */
  | 'reported'
  /** A verifier accepted the result. */
  | 'verified'
  /** Verification failed; the task goes back for another attempt. */
  | 'rejected'

/**
 * Which tab of the task panel a task renders in.
 *
 * A task's tab is derived from {@link TaskState} and nothing else, so the strip
 * and the cards cannot disagree:
 *
 * | state | bucket |
 * |---|---|
 * | `queued` | `up-next` |
 * | `running` | `active` |
 * | `reported` | `active` — awaiting verification is work in progress |
 * | `verified` | `resolved` |
 * | `rejected` | `resolved` — failed or sent back, either way closed |
 *
 * `scheduled` (not due yet) has no producer today: the router dispatches as soon
 * as a slot frees and keeps no timer, so nothing can be waiting for a clock. The
 * value exists so the tab can be added without a contract change.
 */
export type TaskBucket =
  /** Running, including a worker that self-reported and awaits a verdict. */
  | 'active'
  /** Queued for dispatch. */
  | 'up-next'
  /** Reserved: no host producer yet. */
  | 'scheduled'
  /** Done, failed, or sent back. */
  | 'resolved'

/**
 * The host board's own, wider state vocabulary.
 *
 * The five-state {@link TaskState} is a projection of these. Keeping the original
 * on the wire (in {@link TaskView.hostState}) is what lets a view say "cancelled"
 * or "blocked" without the bridge having to invent a sixth state for the panel.
 */
export type HostTaskState =
  /** Accepted by the router, waiting for a worker slot. */
  | 'queued'
  /** A child session exists but its log shows no turn yet. */
  | 'dispatched'
  /** The worker's log shows a started turn. */
  | 'running'
  /** The worker stopped and its claim was recorded; unverified. */
  | 'reported'
  /** Acceptance commands passed, or a human accepted the result. */
  | 'verified'
  /** The worker errored, or acceptance failed. */
  | 'failed'
  /** Parked on a human decision. */
  | 'blocked'
  /** Cancelled on request. */
  | 'cancelled'
  /** The harness restarted mid-flight; the router resumes this session from its log. */
  | 'interrupted'
  /** Put aside until a prerequisite finishes; the router wakes it again. */
  | 'suspended'

/**
 * One entry of a worker's checklist.
 *
 * Mirrors the Host's `todo/write` payload exactly (`@deepseek-ai/dsh-tool-todo`,
 * `TodoItem`), so the Host may forward the native `todos` projection verbatim
 * and the panel needs no translation layer.
 */
export interface TodoItem {
  /** Short imperative line shown in the UI. */
  content: string
  /** Lifecycle state; parallel work may mark several `in_progress`. */
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * Whether a worker currently occupies capacity.
 *
 * `released` exists so an idle worker is distinguishable from a busy one: a
 * released worker holds no machine, so the roster never implies that an idle
 * worker is still consuming a slot.
 */
export type WorkerPresence =
  /** Idle and available for dispatch. */
  | 'online'
  /** Executing a task right now. */
  | 'busy'
  /** Known but not reachable; its tasks are not progressing. */
  | 'offline'
  /** Finished a task, capacity given back, waiting to be asked again. */
  | 'released'

/** A worker managed by a partition's manager. */
export interface WorkerView {
  /** Stable id used by task assignments. */
  readonly id: string
  /** Display name, e.g. `worker-1` or a model name. */
  readonly name: string
  /** Capacity state; drives the roster dot and the copy of each idle worker. */
  readonly presence: WorkerPresence
  /** The Harness Session this worker runs in, when one is bound. */
  readonly sessionId?: string
  /** Short one-line description of what it is doing, if anything. */
  readonly activity?: string
  /** How long the current task has been running, in seconds. */
  readonly elapsedSeconds?: number
}

/** The manager that routes demands inside one partition. */
export interface ManagerView {
  /** Stable id. */
  readonly id: string
  /** Display name; defaults to the partition's manager role name. */
  readonly name: string
  /** `busy` while it is dispatching or verifying. */
  readonly presence: WorkerPresence
  /** How many tasks it has routed in this snapshot's window. */
  readonly dispatched: number
  /** How many results are waiting for its verification. */
  readonly awaitingVerification: number
}

/** One file partition: a namespace of work with its own manager and workers. */
export interface PartitionView {
  /** Stable id; also the routing key a demand lands on. */
  readonly id: string
  /** Display name, e.g. `rca-ab-test`. */
  readonly name: string
  /** Repository or workspace root this partition owns, for the roster subtitle. */
  readonly repo?: string
  /**
   * Whether the router currently dispatches into this partition.
   *
   * Absent means "not reported" and the rail treats it as enabled, which is the
   * only safe reading: hiding live work behind an assumed-off switch would be
   * worse than showing a switch that is sometimes wrong. `false` renders the row
   * muted and labelled 已停用.
   */
  readonly enabled?: boolean
  /** Absolute partition root, for the rail's subtitle. Same value as {@link repo}. */
  readonly path?: string
  /** Configured worker concurrency for this partition. */
  readonly workerCount?: number
  /** Tasks whose worker self-reported and nobody has ruled on yet — the rail's badge. */
  readonly unreviewedCount?: number
  /** The routing manager. */
  readonly manager: ManagerView
  /** Workers this manager can hand tasks to. */
  readonly workers: readonly WorkerView[]
  /** Suspended rows in this partition. */
  readonly suspendedCount?: number
  /** Include globs (relative to the root); absent means everything. */
  readonly include?: readonly string[]
  /** Exclude globs (relative to the root). */
  readonly exclude?: readonly string[]
  /** One-line description from the config. */
  readonly description?: string
  /** Configuration problems the Host found at boot. */
  readonly problems?: readonly PartitionProblemView[]
}

/** One partition configuration problem a person should fix. */
export interface PartitionProblemView {
  readonly level: 'error' | 'warning'
  readonly message: string
}

/**
 * One credential the board may report on, for the rail's API-key block.
 *
 * The Host fills this from `ctx.credentials.describe(refs)`, which by design
 * never returns a value — only whether one exists, where it came from, and
 * whether it can be written. That is exactly what the rail shows; the panel is
 * never a place a secret is displayed.
 */
export interface CredentialView {
  /** Credential reference name, e.g. `DEEPSEEK_API_KEY` (`/^[A-Za-z_][A-Za-z0-9_]*$/`). */
  readonly ref: string
  /** Human provider name for the row; falls back to the ref when absent. */
  readonly label?: string
  /** Whether a value is currently stored. */
  readonly configured: boolean
  /** Where the resolved value came from, when the Host knows. */
  readonly source?: 'file' | 'env' | 'unset' | 'unknown'
  /** Whether `credentials.set`/`unset` would be accepted. */
  readonly writable?: boolean
}

/** One task on the board. */
export interface TaskView {
  /** Stable id; the handle for verify/retry actions. */
  readonly id: string
  /** One-line demand-derived title. */
  readonly title: string
  /** Partition this task was routed to. */
  readonly partitionId: string
  /** Worker currently assigned, when one is. */
  readonly workerId?: string
  /** Lifecycle state (see {@link TaskState}); `reported` ≠ `verified`. */
  readonly state: TaskState
  /**
   * The worker's checklist — "what is this made of, and how far did it get".
   * Same shape as the native `todos` projection; empty when the worker has not
   * written one yet.
   */
  readonly todos: readonly TodoItem[]
  /** ISO timestamp of the last state change. */
  readonly updatedAt: string
  /** ISO timestamp when the worker self-reported; absent before that. */
  readonly reportedAt?: string
  /** ISO timestamp when verification passed; absent unless `verified`. */
  readonly verifiedAt?: string
  /** ISO timestamp when the demand that produced this task was published. */
  readonly requestedAt?: string
  /** Attempt number, starting at 1; >1 after a rejection. */
  readonly attempt?: number
  /** Why verification refused the result; present on `rejected`. */
  readonly rejectionReason?: string
  /**
   * The Host's own note on why a task closed without passing.
   *
   * A failure carries the worker's error text here (`worker ended with stopReason
   * "aborted"`, `cancelled: …`, `rejected by operator: …`), so the panel can tell
   * an interrupted task from a bad result — a difference the five task states
   * cannot express. Absent means "the Host reported no reason".
   */
  readonly error?: string
  /**
   * Why a `blocked` row is parked: the Host's `task_control block` writes its
   * `value` into the board row's `resumeNote`. Absent when the Host does not
   * forward it; the panel then falls back to {@link error}.
   */
  readonly resumeNote?: string
  /** Harness Session of the executing worker, so the panel can offer "open". */
  readonly workerSessionId?: string
  /** Artifacts the worker produced, offered for download. */
  readonly artifacts?: readonly ArtifactRef[]
  /**
   * ISO timestamp this task is scheduled to start at, when the router deferred it.
   *
   * A task carrying it while still `queued` is listed under 排程 (Scheduled) on
   * the board instead of 待派 (Up next): deferred work is not waiting on a
   * worker, it is waiting on the clock. Absent means "not scheduled".
   */
  readonly scheduledFor?: string
  /** Routing level the host recorded: `manager` dispatches, `worker` executes. */
  readonly level?: 'manager' | 'worker'
  /** Task this one was dispatched under (a worker's manager row). */
  readonly parentId?: string
  /**
   * Which board tab this task belongs to, when the Host says so explicitly.
   *
   * Derived from {@link state} alone (see {@link TaskBucket}), so a view may
   * compute it instead; the Host sends it anyway so the two cannot drift.
   */
  readonly bucket?: TaskBucket
  /**
   * The Host board's own state, before projection onto {@link TaskState}.
   *
   * `state` narrows eight host states onto five panel states, so a view that
   * wants to distinguish `blocked` from `queued`, or `cancelled` from `failed`,
   * reads this. Absent on sample data.
   */
  readonly hostState?: HostTaskState
  /** Tool calls the worker made so far, read from its log by the Host. */
  readonly toolCalls?: number
  /** Latest tool call: name plus a short argument summary. */
  readonly lastTool?: string
  /** ISO time of the worker log's last event. */
  readonly lastActivityAt?: string
  /** ISO time the worker actually started (its first turn). */
  readonly startedAt?: string
  /**
   * The worker's folded checklist progress, when the Host folded a log.
   *
   * `todos` is the list itself; this is the count and the current step, so a
   * card can render "3/7 · 跑 go vet" without walking the array.
   */
  readonly todoProgress?: {
    readonly done: number
    readonly total: number
    readonly ratio: string
    readonly current?: string
  }
  /** Explicit prerequisites: task ids that must finish first. */
  readonly dependsOn?: readonly string[]
  /** Ordered phase among siblings; a lower stage finishes first. */
  readonly stage?: number
  /** A queued row held back by these unfinished prerequisites. */
  readonly waitingFor?: readonly string[]
  /** A suspended row: why it was put aside. */
  readonly suspendReason?: string
  /** A suspended (or dependency-blocked) row: what it waits for. */
  readonly waitingOn?: readonly string[]
  /** The request (root task) this row belongs to. */
  readonly rootId?: string
}

/** Progress of one request: its root task and the rows under it. */
export interface GroupProgressView {
  readonly rootId: string
  readonly subject: string
  readonly total: number
  readonly finished: number
  readonly running: number
  readonly waiting: number
  readonly suspended: number
  readonly failed: number
  readonly complete: boolean
}

/** One progress notice the router sent to the war room. */
export interface NoticeView {
  readonly at: string
  readonly text: string
}

/** One entry of a workspace listing (`GET /api/router/files`). */
export interface FileEntryView {
  readonly name: string
  /** Path relative to the partition root, `/`-separated. */
  readonly path: string
  readonly kind: 'dir' | 'file' | 'link'
  readonly size?: number
  readonly modifiedAt?: string
  /** Whether the partition's include/exclude rules put it in scope. */
  readonly inScope: boolean
}

/** One directory level of one partition. */
export interface FileListingView {
  readonly partition: string
  readonly root: string
  readonly path: string
  readonly entries: readonly FileEntryView[]
  readonly omitted: number
  readonly include: readonly string[]
  readonly exclude: readonly string[]
}

/** One standing fact a partition remembers. */
export interface MemoryNoteView {
  readonly id: string
  readonly at: string
  readonly text: string
  /** Who wrote it: the partition's manager, a human from the panel, or the router. */
  readonly by: 'manager' | 'human' | 'router'
  readonly taskId?: string
}

/** One finished task in a partition's work log. */
export interface WorkEntryView {
  readonly at: string
  readonly taskId: string
  readonly rootId?: string
  readonly level: 'manager' | 'worker'
  readonly subject: string
  readonly state: string
  readonly summary?: string
  readonly touched?: readonly string[]
  readonly left?: string
  readonly error?: string
  readonly sessionId?: string
  readonly model?: string
}

/** One worker session of a partition. */
export interface SessionRefView {
  readonly taskId: string
  readonly sessionId: string
  readonly state: string
  readonly subject: string
  readonly updatedAt: string
  readonly summary?: string
}

/** What a partition's manager knows: `GET /api/router/memory?partition=`. */
export interface PartitionMemoryView {
  readonly partition: string
  readonly notes: readonly MemoryNoteView[]
  /** Newest first, at most 60. */
  readonly log: readonly WorkEntryView[]
  readonly logTotal: number
  /** Worker sessions, newest first. */
  readonly sessions: readonly SessionRefView[]
  readonly manager: {
    readonly enabled: boolean
    /** `strongest | hard | saved | inherit`. */
    readonly source: string
    readonly route?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  }
}

/** A produced file the user may download. */
export interface ArtifactRef {
  /** Display file name. */
  readonly name: string
  /** `dsh-resource://` address the host resolves, or a plain path when local. */
  readonly address: string
  /** Byte size when known. */
  readonly bytes?: number
}

/** One published demand and how the router placed it. */
export interface DemandView {
  /** Stable id. */
  readonly id: string
  /** The raw text the user published. */
  readonly text: string
  /** ISO timestamp of publication. */
  readonly publishedAt: string
  /** Partition the router chose, once routed. */
  readonly partitionId?: string
  /** Why the router chose that partition; shown on hover. */
  readonly routingReason?: string
  /** Tasks this demand produced. */
  readonly taskIds: readonly string[]
}

/** Everything the panel renders in one consistent read. */
export interface BoardSnapshot {
  /** ISO timestamp of this snapshot, shown as "updated …". */
  readonly fetchedAt: string
  /** Partitions in roster order. */
  readonly partitions: readonly PartitionView[]
  /** Tasks, newest activity first within a state. */
  readonly tasks: readonly TaskView[]
  /** Demands still awaiting routing. */
  readonly demands: readonly DemandView[]
  /**
   * Where the snapshot came from, so the panel can say so honestly:
   * `host` = the router Remote answered; `mock` = built-in sample data.
   */
  readonly origin: 'host' | 'mock'
  /** Set when a live Host read failed and the panel fell back to last-known data. */
  readonly staleSince?: string
  /**
   * Credentials the rail's API-key block reports on. Optional: a Host that does
   * not describe credentials simply leaves the block with nothing to say, and
   * the rail says so instead of guessing.
   */
  readonly credentials?: readonly CredentialView[]
  /** Progress per request, when the Host computes it. */
  readonly groups?: readonly GroupProgressView[]
  /** Recent progress notices, newest first. */
  readonly notices?: readonly NoticeView[]
}

/**
 * What the panel may ask the Host to do that is not a board read.
 *
 * Every member is optional on purpose. The panel is one client half of a
 * two-half plugin: a Host that has not implemented an action yet must still get
 * a working board, so a missing member renders the control as "not wired" and
 * says so when it is pressed, instead of pretending the action happened. Values
 * are supplied by the client entry (`src/client/index.ts`) from the Remotes it
 * can see; nothing here is a Remote call by itself.
 */
export interface HostActions {
  /**
   * Read credential status. Resolves to one row per requested ref; throws when
   * the Host refuses.
   * @param refs - credential reference names to describe.
   */
  readonly readCredentials?: (refs: readonly string[]) => Promise<readonly CredentialView[]>
  /**
   * Store one credential literal.
   * @param ref - credential reference name.
   * @param value - the literal to store (sent up only; never read back).
   * @returns a refusal message, or undefined once stored.
   */
  readonly writeCredential?: (ref: string, value: string) => Promise<string | undefined>
  /**
   * Turn dispatch into one partition on or off.
   * @param partitionId - the partition to switch.
   * @param enabled - the state to apply.
   */
  readonly setPartitionEnabled?: (partitionId: string, enabled: boolean) => Promise<void>
  /**
   * Create an empty partition.
   * @param name - display name for the new partition.
   */
  readonly createPartition?: (name: string) => Promise<void>
}

/** Result of publishing one or more demands. */
export interface PublishResult {
  /** Demands the router accepted. */
  readonly accepted: number
  /** Per-demand routing decisions, in input order. */
  readonly routed: readonly { readonly text: string; readonly partitionId?: string; readonly reason?: string }[]
}
