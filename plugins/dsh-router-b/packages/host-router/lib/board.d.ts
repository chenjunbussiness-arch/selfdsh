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
/** Lifecycle of one task. */
export type TaskState = 
/** Accepted by the router, waiting for a worker slot. */
'queued'
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
 | 'suspended';
/** How a task was dispatched, so the board shows the routing level. */
export type DispatchLevel = 
/** Handed to a partition manager for decomposition. */
'manager'
/** Started by a partition manager, or by the router when the partition has none. */
 | 'worker';
/** One routed task. Flat on purpose: the tree lives in `parentId`. */
export interface RouterTask {
    readonly id: string;
    /** Partition that owns it. */
    readonly partition: string;
    /** Parent task id when a manager split one task into several. */
    readonly parentId?: string;
    /** Short title for the board. */
    readonly subject: string;
    /** The instruction handed to the child, after the partition brief. */
    readonly body: string;
    readonly state: TaskState;
    /** Absolute working directory given to the child. */
    readonly cwd: string;
    /** Higher runs first; equal priorities run oldest first. */
    readonly priority: number;
    /** Which routing level created this row. */
    readonly level: DispatchLevel;
    /** How it was routed, so a human can audit the decision. */
    readonly reason: string;
    /** Ordered routing evidence. */
    readonly because: readonly string[];
    /** Session id of the dispatcher; the router re-resolves it before any late dispatch. */
    readonly dispatchFrom?: string;
    /** Subagent name inside the tree (`agent-2`), for `send_message`-style follow-ups. */
    readonly worker?: string;
    /** Durable child session id. This is the handle for continuing the session later. */
    readonly sessionId?: string;
    /** Starts so far, including the current one. */
    readonly attempts: number;
    /** The worker's closing text. A claim, not proof. */
    readonly result?: string;
    /**
     * What the worker said it actually did, parsed from its `--- report ---` block
     * (see `report.ts`). Absent when the worker wrote no block: the level-2
     * decision reads this as "nothing known", not as "nothing done".
     */
    readonly summary?: string;
    /** Paths the worker said it changed. The level-2 decision matches on these. */
    readonly touched?: readonly string[];
    /** What the worker said is still open; absent when it said none. */
    readonly left?: string;
    /** Combined acceptance output, truncated. */
    readonly verifyOutput?: string;
    /** Acceptance commands that were run. */
    readonly verify?: readonly string[];
    /** Why it ended badly, when it did. */
    readonly error?: string;
    /** Which routing level the closing report went to. */
    readonly reportedTo?: string;
    /**
     * Token of the process that dispatched this row.
     *
     * A restart must be able to tell "this row's process is gone" from "this row is
     * mine and still in flight". Comparing tokens is the only reliable way to do
     * that from disk alone, because a live activation is process-local.
     */
    readonly runToken?: string;
    /** One line written before blocking, so a human can resume cheaply. */
    readonly resumeNote?: string;
    /** How many times this row's session was resumed after an interruption. */
    readonly resumes?: number;
    /**
     * Task ids that must finish before this row may start. A queued row whose
     * prerequisites are still open waits in the queue; one whose prerequisite
     * failed or was cancelled is parked as `blocked` for a human.
     */
    readonly dependsOn?: readonly string[];
    /**
     * Ordered phase among siblings (rows with the same `parentId`). A row starts
     * only after every sibling with a lower stage has finished. Absent = stage 0
     * with no ordering among rows that carry no stage.
     */
    readonly stage?: number;
    /** While `suspended`: the task ids it waits for. */
    readonly waitingOn?: readonly string[];
    /** Why the row was suspended, in the words of whoever suspended it. */
    readonly suspendReason?: string;
    /** How many times this row was suspended so far. */
    readonly suspends?: number;
    /** State the row had when it was suspended, so a resume knows whether it had finished once. */
    readonly suspendedFrom?: TaskState;
    /** How many times a manager that ended with open children was woken to keep waiting. */
    readonly rewakes?: number;
    /**
     * Set on a `blocked` row the router parked because a prerequisite failed:
     * the state to return to once that prerequisite is retried and finishes.
     * Only meaningful together with a non-empty `waitingOn`.
     */
    readonly blockedFrom?: 'queued' | 'suspended';
    /** A human chose to start this row without waiting for its prerequisites. */
    readonly ignoreOrder?: boolean;
    /** Model a human picked for this row (改派 / 换模型重跑); wins over tiers. */
    readonly routeOverride?: {
        readonly provider: string;
        readonly model: string;
        readonly reasoningEffort?: string;
    };
    /** The row that took this one's work over, and the row this one took over. */
    readonly reassignedTo?: string;
    readonly reassignedFrom?: string;
    /** Pull request this row published, if any. */
    readonly pr?: {
        readonly number: number;
        readonly url: string;
        readonly provider: string;
    };
    /** Human remarks recorded while the task was in flight. */
    readonly notes?: readonly string[];
    /** Difficulty tier chosen before dispatch (`easy | medium | hard`). */
    readonly tier?: 'easy' | 'medium' | 'hard';
    /** How the tier was decided and why. */
    readonly tierSource?: string;
    readonly tierReason?: string;
    /** Model route the child was started on; absent when it inherited the dispatcher's. */
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}
/** Durable per-partition state: the manager session identity, if one exists. */
export interface PartitionRecord {
    /** Session id of this partition's manager child. */
    readonly managerSessionId?: string;
    /** Subagent name of the manager, for display. */
    readonly managerName?: string;
    readonly managerUpdatedAt?: string;
    /**
     * Operator switch, set by the panel's `POST /api/router/partition`.
     *
     * A disabled partition accepts no new demand and its pump starts nothing;
     * its existing rows keep the state they already have. Absent means enabled,
     * so an older board file (or a fresh install) needs no migration.
     */
    readonly disabled?: boolean;
}
/** Truncation bound for stored child text; the full session log stays on disk. */
export declare const RESULT_LIMIT = 6000;
/** Keep the tail of long text: build errors live at the end. */
export declare function tail(text: string, limit?: number): string;
/** One-letter state marker for the compact board. */
export declare function mark(state: TaskState): string;
/** States a dispatched child can still be occupying a slot in. */
export declare function isOpen(state: TaskState): boolean;
/** States that count as "finished" for a prerequisite. */
export declare function isFinished(state: TaskState): boolean;
/** States that can never become finished without a human (a prerequisite in one of these is dead). */
export declare function isDead(state: TaskState): boolean;
/** Order tasks for execution: priority first, then arrival. */
export declare function byExecutionOrder(left: RouterTask, right: RouterTask): number;
/** Render the board for a model or a human. */
export declare function summarize(tasks: readonly RouterTask[], options?: {
    readonly partition?: string;
}): string;
/** Error text on a row the harness stopped mid-flight; the session itself is intact. */
/** States after which a row does not change on its own. */
export declare const SETTLED: ReadonlySet<TaskState>;
export declare const INTERRUPTED_NOTE = "the harness stopped while this task was in flight; its session will be resumed from its log";
/** The board file. One instance per plugin activation. */
export declare class TaskBoard {
    private readonly file;
    private readonly runToken;
    private tasks;
    private partitions;
    /** Called after a row enters a settled state (see `SETTLED`). */
    private readonly settleListeners;
    private constructor();
    /**
     * Open or create `<dir>/board.json`.
     * @param dir - directory holding the board document.
     * @param runToken - identity of the opening process; rows dispatched by any
     *   other token are treated as orphaned. Omitted disables reconciliation, which
     *   is what a read-only viewer or a test wants.
     */
    static open(dir: string, runToken?: string): Promise<TaskBoard>;
    /** Every task in insertion order. Callers sort for their own view. */
    list(): readonly RouterTask[];
    /** Tasks of one partition, in execution order. */
    inPartition(name: string): readonly RouterTask[];
    /** Tasks created by one manager (or belonging under one parent). */
    childrenOf(id: string): readonly RouterTask[];
    /** One task by id. */
    get(id: string): RouterTask | undefined;
    /** Durable record for one partition. */
    partitionRecord(name: string): PartitionRecord;
    /** Insert one task and persist before returning. */
    add(task: RouterTask): Promise<RouterTask>;
    /**
     * Merge a patch into one task and persist.
     * @param id - task id.
     * @param change - fields to replace.
     * @returns the updated task.
     * @throws when the id is unknown, which means two writers disagree about the board.
     */
    patch(id: string, change: Partial<RouterTask>): Promise<RouterTask>;
    /**
     * Run `listener` each time a row enters a settled state (done, verified,
     * reported, failed, cancelled) from an unsettled one.
     * @returns a function that removes the listener.
     */
    onSettled(listener: (task: RouterTask, from: TaskState) => void): () => void;
    /** Merge a patch into one partition record and persist. */
    patchPartition(name: string, change: PartitionRecord): Promise<PartitionRecord>;
    /** Append a human remark without touching state. */
    note(id: string, text: string): Promise<RouterTask>;
    private load;
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
    private reconcile;
    /** Tail of the write chain: concurrent patches share one temp path, so writes must not overlap. */
    private writing;
    private flush;
    private flushNow;
}
/** Monotonic, sortable, human-readable task id. */
export declare function nextTaskId(sequence: number): string;
