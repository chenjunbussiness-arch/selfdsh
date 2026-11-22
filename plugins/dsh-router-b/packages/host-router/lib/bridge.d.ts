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
import type { TaskState } from './board.ts';
import type { GroupProgress } from './order.ts';
import type { RouterSnapshot } from './snapshot.ts';
import type { LoggerService, WebRouteLike } from './types.ts';
/** Path prefix every bridge route lives under. */
export declare const BRIDGE_BASE = "/api/router";
/** `GET` → the board document. */
export declare const BOARD_PATH = "/api/router/board";
/** `POST` → publish demands. */
export declare const PUBLISH_PATH = "/api/router/publish";
/** `POST` → record a human verification decision. */
export declare const VERIFY_PATH = "/api/router/verify";
/** `POST` → run one `task_control` action (`resume`, `block`) on a task. */
export declare const CONTROL_PATH = "/api/router/control";
/** `POST` → enable or disable one partition. */
export declare const PARTITION_PATH = "/api/router/partition";
/** `GET` → the 作战室 anchor session id (created or resumed on demand). */
export declare const ANCHOR_PATH = "/api/router/anchor";
/** `GET` → server-sent change notifications. */
export declare const EVENTS_PATH = "/api/router/events";
/** `GET` → tier settings + model options; `POST` → save tier settings. */
export declare const TIERS_PATH = "/api/router/tiers";
/** `GET ?partition=&path=` → one directory level of a partition (names only, never contents). */
export declare const FILES_PATH = "/api/router/files";
/** `GET|POST|DELETE` one partition's memory (notes and recent work). */
export declare const MEMORY_PATH = "/api/router/memory";
export declare const APPROVALS_PATH = "/api/router/approvals";
export declare const AUDIT_PATH = "/api/router/audit";
export declare const LIVE_PATH = "/api/router/live";
export declare const REASSIGN_PATH = "/api/router/reassign";
export declare const BATCH_PATH = "/api/router/batch";
/**
 * The panel's five states.
 *
 * Kept in lockstep with the client's `src/client/contract.ts`, which is the
 * authority; this copy exists so the host package imports no client module.
 */
export type UiTaskState = 'queued' | 'running' | 'reported' | 'verified' | 'rejected';
/** Which of the panel's four tabs a task belongs to. */
export type UiBucket = 'active' | 'up-next' | 'scheduled' | 'resolved';
/** Whether a worker currently occupies capacity. */
export type UiPresence = 'online' | 'busy' | 'offline' | 'released';
/**
 * One credential reference's presence, for the panel's API-key block.
 *
 * The shape is the client's `CredentialView` (`docs/CONTRACT.md`, contract.ts):
 * a reference name, a display label, and presence/writability facts. No value
 * is ever part of it — `credentials.describe` does not return one.
 */
export interface UiCredentialView {
    /** Credential reference name, e.g. `DEEPSEEK_API_KEY`. */
    readonly ref: string;
    /** Display name for the row. */
    readonly label?: string;
    /** Whether a value is currently stored. */
    readonly configured: boolean;
    /**
     * Coarse origin of the stored value.
     *
     * The provider's own layer ids are finer (`env`, `file`, `project-env`,
     * `user-env`), so they are normalised onto the four values the panel draws.
     */
    readonly source?: 'file' | 'env' | 'unset' | 'unknown';
    /** Whether `credentials.set`/`unset` would currently be accepted. */
    readonly writable?: boolean;
}
/** One checklist entry, identical to the native `todo/write` payload item. */
export interface UiTodoItem {
    readonly content: string;
    readonly status: 'pending' | 'in_progress' | 'completed';
}
/** The folded progress of a worker's checklist. */
export interface UiTodoProgress {
    readonly done: number;
    readonly total: number;
    readonly ratio: string;
    readonly current?: string;
}
/** One worker or manager in a partition's roster. */
export interface UiWorkerView {
    readonly id: string;
    readonly name: string;
    readonly presence: UiPresence;
    readonly sessionId?: string;
    readonly activity?: string;
    readonly elapsedSeconds?: number;
}
/** The manager responsible for routing inside one partition. */
export interface UiManagerView {
    readonly id: string;
    readonly name: string;
    readonly presence: UiPresence;
    readonly dispatched: number;
    readonly awaitingVerification: number;
}
/** One partition, as the panel's left column and roster render it. */
export interface UiPartitionView {
    readonly id: string;
    readonly name: string;
    /** The built-in 快任务 group: jobs outside every workspace, on the fast model, with its own slots. */
    readonly quick?: boolean;
    /** Absolute partition root. `repo` is the client contract's name for the same value. */
    readonly repo: string;
    /** Same absolute root, under the name the rail's subtitle reads. */
    readonly path: string;
    /** Operator switch, persisted in the board document. */
    readonly enabled: boolean;
    /** Configured concurrency. */
    readonly workerCount: number;
    /** Worker rows currently holding a slot. */
    readonly liveWorkers: number;
    /** Queued rows waiting for a slot. */
    readonly queuedCount: number;
    /** Rows whose worker self-reported and no verifier has ruled yet. */
    readonly unreviewedCount: number;
    /** Suspended rows. */
    readonly suspendedCount?: number;
    /** Membership globs, so the workspace page can show the partition's rules. */
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
    /** One-line description from the config, when given. */
    readonly description?: string;
    /** Configuration problems found at boot (missing root, nesting). */
    readonly problems?: readonly {
        readonly level: 'error' | 'warning';
        readonly message: string;
    }[];
    /** Every row this partition owns. */
    readonly taskCount: number;
    readonly manager: UiManagerView;
    readonly workers: readonly UiWorkerView[];
}
/** One task, as the panel's task list and detail pane render it. */
export interface UiTaskView {
    readonly id: string;
    readonly title: string;
    readonly partitionId: string;
    /** The task's host state, preserved verbatim so nothing is collapsed away. */
    readonly hostState: TaskState;
    readonly state: UiTaskState;
    /** The panel tab this task belongs to; derived from `state`, not stored. */
    readonly bucket: UiBucket;
    readonly todos: readonly UiTodoItem[];
    readonly todoProgress: UiTodoProgress;
    /** Tool calls the worker made so far, read from its log. */
    readonly toolCalls?: number;
    /** Latest tool call: name plus a short argument summary. */
    readonly lastTool?: string;
    /** ISO time of the worker log's last event. */
    readonly lastActivityAt?: string;
    /** ISO time the worker actually started (first turn), else absent. */
    readonly startedAt?: string;
    /** Coarse progress 0..1 from the state machine, refined by the todo ratio. */
    readonly progress: number;
    readonly updatedAt: string;
    readonly requestedAt: string;
    readonly reportedAt?: string;
    readonly verifiedAt?: string;
    readonly attempt: number;
    readonly level: 'manager' | 'worker';
    /** The task this one was dispatched under (a worker's manager row). */
    readonly parentId?: string;
    readonly priority: number;
    /** The subagent's name in the tree, when it had one. */
    readonly workerId?: string;
    /** The worker's Harness Session; also the key for its live `todos` projection. */
    readonly workerSessionId?: string;
    readonly rejectionReason?: string;
    readonly result?: string;
    readonly verifyOutput?: string;
    readonly error?: string;
    /** Why a `blocked` row is parked: the `value` of `task_control block`. */
    readonly resumeNote?: string;
    /** Explicit prerequisites and ordered phase. */
    readonly dependsOn?: readonly string[];
    readonly stage?: number;
    /** A queued row held back by its order: the open prerequisites. */
    readonly waitingFor?: readonly string[];
    /** A suspended row: why, and what it waits for. */
    readonly suspendReason?: string;
    readonly waitingOn?: readonly string[];
    /** Root task of the request this row belongs to. */
    readonly rootId?: string;
    /** Difficulty tier chosen before dispatch (`easy | medium | hard`). */
    readonly tier?: 'easy' | 'medium' | 'hard';
    /** How the tier was decided and why. */
    readonly tierSource?: string;
    readonly tierReason?: string;
    /** Model route the child was started on; absent when it inherited the dispatcher's. */
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
    /** 改派 links and the published pull request. */
    readonly reassignedTo?: string;
    readonly reassignedFrom?: string;
    readonly pr?: {
        readonly number: number;
        readonly url: string;
        readonly provider: string;
    };
}
/** One demand and the task it produced. */
export interface UiDemandView {
    readonly id: string;
    /** The router's one-line title for the demand. */
    readonly text: string;
    readonly publishedAt: string;
    readonly partitionId?: string;
    readonly routingReason?: string;
    readonly taskIds: readonly string[];
}
/** The whole document the panel reads in one request. */
export interface UiBoardSnapshot {
    /** Bumped when a field changes meaning; additive fields do not bump it. */
    readonly version: 2;
    readonly fetchedAt: string;
    readonly partitions: readonly UiPartitionView[];
    readonly tasks: readonly UiTaskView[];
    readonly demands: readonly UiDemandView[];
    /** Rows per host state, so a badge needs no second pass. */
    readonly counts: Readonly<Record<string, number>>;
    /** Rows per panel tab. */
    readonly buckets: Readonly<Record<UiBucket, number>>;
    /** Credential presence only — never a value. */
    readonly credentials: readonly UiCredentialView[];
    /** Always `host` here: only the client's sample data is labelled otherwise. */
    readonly origin: 'host';
    readonly staleSince?: string;
    /** Progress per request (root task). */
    readonly groups?: readonly GroupProgress[];
    /** Recent progress notices, newest first. */
    readonly notices?: readonly {
        readonly at: string;
        readonly text: string;
    }[];
}
/** One routing outcome inside a publish response. */
export interface PublishRouted {
    readonly text: string;
    readonly partitionId?: string;
    readonly reason?: string;
}
/** What a publish call answers. */
export interface PublishResult {
    readonly accepted: number;
    readonly routed: readonly PublishRouted[];
    /** The 作战室 session the demands were posted into. */
    readonly anchorSessionId?: string;
}
/** The host state → panel state table. Total: every host state has a row. */
export declare const STATE_TO_UI: Readonly<Record<TaskState, UiTaskState>>;
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
export declare const BUCKET_OF_STATE: Readonly<Record<UiTaskState, UiBucket>>;
/** A failed HTTP call, carrying the status and the stable error code the client prints. */
export declare class BridgeError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
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
export declare function credentialSourceOf(raw: unknown): 'file' | 'env' | 'unset' | 'unknown';
/** One partition's static facts, as the bridge needs them. */
export interface PartitionSource {
    readonly name: string;
    readonly dir: string;
    readonly slots: number;
    readonly managerEnabled: boolean;
    /** The built-in 快任务 partition. */
    readonly quick?: boolean;
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
    readonly description?: string;
}
/** Everything the routes need from the plugin. Injected so the routes stay pure I/O. */
export interface BridgeDeps {
    readonly logger: LoggerService;
    readonly partitions: readonly PartitionSource[];
    /** Whether a partition's durable row is currently enabled. */
    readonly isEnabled: (name: string) => boolean;
    /** Build (and persist) the host snapshot. */
    readonly snapshot: () => Promise<RouterSnapshot>;
    /** Post demand texts into the 作战室 anchor conversation. */
    readonly publish: (texts: readonly string[]) => Promise<PublishResult>;
    /** Create or resume the anchor and return its session id. */
    readonly anchor?: () => Promise<{
        sessionId: string;
        title: string;
    }>;
    /** Record a human verification decision. */
    readonly verify: (taskId: string, verdict: 'verified' | 'rejected', note: string | undefined) => Promise<{
        id: string;
        state: TaskState;
    }>;
    /** Run one `task_control` action from the panel; absent means the route answers 404. */
    readonly control?: (taskId: string, action: string, value: string | undefined, extra?: {
        readonly prerequisite?: string;
        readonly waitFor?: readonly string[];
    }) => Promise<{
        id: string;
        state: TaskState;
        text: string;
    }>;
    /** One directory level of a partition; absent means the route answers 404. */
    readonly files?: (partition: string, path: string | undefined) => Promise<unknown>;
    /**
     * Outlets and the wider control surface: the approval queue, the audit log,
     * a worker's live output, reassigning a task, and batch actions. Absent means
     * these routes answer 404.
     */
    readonly desk?: {
        readonly approvals: () => Promise<unknown>;
        readonly decide: (id: string, decision: 'approve' | 'reject', note: string | undefined) => Promise<unknown>;
        readonly audit: (limit: number) => Promise<unknown>;
        readonly live: (taskId: string, after: number) => Promise<unknown>;
        readonly reassign: (input: {
            readonly taskId: string;
            readonly partition?: string;
            readonly model?: {
                readonly provider: string;
                readonly model: string;
                readonly reasoningEffort?: string;
            };
            readonly keepProgress: boolean;
            readonly note?: string;
        }) => Promise<unknown>;
        readonly batch: (taskIds: readonly string[], action: string, value: string | undefined) => Promise<unknown>;
    };
    /** Partition memory; absent means the route answers 404. */
    readonly memory?: {
        readonly read: (partition: string) => Promise<unknown>;
        readonly addNote: (partition: string, text: string) => Promise<unknown>;
        readonly removeNote: (partition: string, id: string) => Promise<unknown>;
    };
    /** Partition configuration problems found at boot. */
    readonly problems?: () => readonly {
        readonly partition: string;
        readonly level: 'error' | 'warning';
        readonly message: string;
    }[];
    /** Flip a partition's operator switch. */
    readonly setPartitionState: (name: string, enabled: boolean) => Promise<{
        id: string;
        enabled: boolean;
    }>;
    /** Credential presence by reference; never values. */
    readonly credentials: () => Promise<readonly UiCredentialView[]>;
    /** File whose mtime moves on every board write: the SSE change signal. */
    readonly changeFile: string;
    /** Difficulty-tier model settings; absent means the route answers 404. */
    readonly tiers?: {
        readonly read: () => Promise<unknown>;
        readonly write: (body: Record<string, unknown>) => Promise<unknown>;
    };
}
/**
 * Fold the host snapshot into the panel's document.
 *
 * Pure apart from the clock, so the mapping can be asserted in a test without a
 * harness, a socket, or a browser.
 * @param input - host snapshot plus the facts the snapshot does not carry.
 * @returns the document `GET /api/router/board` answers with.
 */
export declare function boardDocument(input: {
    readonly snapshot: RouterSnapshot;
    readonly partitions: readonly PartitionSource[];
    readonly isEnabled: (name: string) => boolean;
    readonly credentials: readonly UiCredentialView[];
    /** Partition configuration problems found at boot. */
    readonly problems?: readonly {
        readonly partition: string;
        readonly level: 'error' | 'warning';
        readonly message: string;
    }[];
    /** Clock override, for tests. */
    readonly now?: number;
}): UiBoardSnapshot;
/**
 * Build the bridge's routes.
 *
 * Pure construction: registering them (and disposing them) belongs to the
 * plugin activation, so a test can drive each handler with a fake exchange.
 * @param deps - what the handlers act on.
 * @returns one route per endpoint, in path order.
 */
export declare function createRoutes(deps: BridgeDeps): readonly WebRouteLike[];
