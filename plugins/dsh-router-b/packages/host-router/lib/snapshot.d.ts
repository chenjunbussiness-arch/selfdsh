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
import type { RouterTask, TaskState } from './board.ts';
import type { Partition } from './config.ts';
import type { LoggerService, SessionEventLike, SessionQueryService } from './types.ts';
/** One worker todo item, exactly as `dsh-tool-todo` records it. */
export interface TodoItem {
    readonly content: string;
    readonly status: 'pending' | 'in_progress' | 'completed';
}
/** The worker's current list plus its completion ratio. */
export interface TodoProgress {
    /** Latest whole-list snapshot, or `null` before the worker's first write. */
    readonly todos: readonly TodoItem[] | null;
    /** Items marked `completed`. */
    readonly done: number;
    /** Total items in the latest list. */
    readonly total: number;
    /** The item currently marked `in_progress`, when exactly one is. */
    readonly current?: string;
    /** Human-readable ratio, `3/7`. */
    readonly ratio: string;
}
/** What the log says about one worker session. */
export interface WorkerLogFacts {
    /** Whether the child ever started a turn. */
    readonly started: boolean;
    /** Whether the last turn ended, and why. */
    readonly endedWith?: string;
    /** The last assistant text, bounded. */
    readonly lastAssistant?: string;
    readonly todos: TodoProgress;
    /** Live activity read from the log, independent of whether the model keeps its checklist. */
    readonly activity: LogActivity;
}
/** How busy a worker's log says it is. */
export interface LogActivity {
    /** Number of `tool/call` events so far. */
    readonly toolCalls: number;
    /** Latest tool call: name plus a short argument summary. */
    readonly lastTool?: string;
    /** ISO time of the last event in the log. */
    readonly lastActivityAt?: string;
    /** ISO time of the first `turn/start`: when the worker actually began. */
    readonly startedAt?: string;
}
/**
 * Short summary of one tool call: the tool name plus a command head or a path.
 * @param name - tool name.
 * @param rawArguments - the call's arguments, a JSON string or an object.
 * @returns e.g. `bash ls -la /srv/…` or `read /srv/x.ts`.
 */
export declare function toolSummary(name: string, rawArguments: unknown): string;
/** Fold tool-call activity out of a log. */
export declare function foldActivity(events: readonly SessionEventLike[]): LogActivity;
/** One task as the UI sees it. */
export interface TaskView {
    readonly id: string;
    readonly partition: string;
    readonly subject: string;
    readonly state: TaskState;
    readonly level: 'manager' | 'worker';
    readonly priority: number;
    readonly attempts: number;
    readonly parentId?: string;
    /** How the router decided this task's partition (`explicit` / `files` / `auto` / `default`). */
    readonly reason: string;
    /** Ordered routing evidence, so a human can audit the decision. */
    readonly because: readonly string[];
    /** Durable worker session id: the key for a session panel or a follow-up. */
    readonly sessionId?: string;
    /** Subagent name inside the tree. */
    readonly worker?: string;
    /** Coarse progress derived from the state machine, 0..1. */
    readonly progress: number;
    /** Worker todo progress, when the worker wrote a list. */
    readonly todos: TodoProgress;
    /** Log-derived activity (tool calls, last tool, last event time), present once a log was read. */
    readonly activity?: LogActivity;
    readonly result?: string;
    readonly verifyOutput?: string;
    readonly error?: string;
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
/** Whole-board view returned in one call. */
export interface RouterSnapshot {
    /** Schema marker; bump when a field changes meaning. */
    readonly version: 1;
    readonly generatedAt: string;
    /** Aggregate counts by state, so a badge needs no second call. */
    readonly counts: Readonly<Record<string, number>>;
    /** Per-partition rollup, so a partition list needs no second call. */
    readonly partitions: readonly {
        readonly name: string;
        readonly dir: string;
        readonly workers: number;
        readonly live: number;
        readonly queued: number;
    }[];
    readonly tasks: readonly TaskView[];
}
/** Fold `todo/write` events into the worker's latest list. */
export declare function foldTodos(events: readonly SessionEventLike[]): TodoProgress;
/** Fold the turn boundaries and the last assistant text out of a worker log. */
export declare function foldWorkerLog(events: readonly SessionEventLike[]): WorkerLogFacts;
/** What `buildSnapshot` needs from the host. */
export interface SnapshotDeps {
    readonly board: {
        list(): readonly RouterTask[];
        inPartition(name: string): readonly RouterTask[];
    };
    readonly partitions: readonly Partition[];
    readonly sessionQuery: SessionQueryService | undefined;
    readonly logger: LoggerService;
    /** Whether this process still holds the child (and will close the row itself). */
    readonly isLive: (task: RouterTask) => boolean;
    /** Read a log at most once per cache window. */
    readonly readLog: (sessionId: string) => Promise<readonly SessionEventLike[]>;
    /** Persist a state correction discovered while folding. */
    readonly correctState?: (task: RouterTask, change: {
        state: TaskState;
        result?: string;
        error?: string;
    }) => Promise<void>;
}
/** Cache one worker log for a short window; a poll of N tasks must not cost N full reads. */
export declare function createLogReader(sessionQuery: SessionQueryService | undefined, logger: LoggerService, ttlMs?: number): (sessionId: string) => Promise<readonly SessionEventLike[]>;
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
export declare function buildSnapshot(deps: SnapshotDeps, filter?: {
    readonly partition?: string;
}): Promise<RouterSnapshot>;
