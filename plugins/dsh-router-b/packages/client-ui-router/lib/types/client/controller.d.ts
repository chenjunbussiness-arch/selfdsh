/**
 * Panel state: one snapshot object, replaced on every change so
 * `useSyncExternalStore` sees a new reference exactly when something changed.
 *
 * The controller owns data and I/O only. Filtering, expansion and the composer
 * draft are view state and stay in React, so a re-render never depends on the
 * controller's identity.
 */
import type { BoardSnapshot, PublishResult, TaskState } from './contract.ts';
import type { BoardSource, ControlAction, ControlExtra } from './source.ts';
import type { FileListingView, MemoryNoteView, PartitionMemoryView } from './contract.ts';
import type { ApprovalsView, ApprovalView, AuditEntryView, BatchAction, BatchResultView, LiveView, ModelChoiceView, ReassignInput, ReassignResult } from './contract.ts';
/** What the panel renders. */
export interface RouterPanelState {
    /** The last successful read, or `null` before the first one. */
    readonly board: BoardSnapshot | null;
    /** Read lifecycle. */
    readonly status: 'idle' | 'loading' | 'ready' | 'error';
    /** Last read or action failure, already human-readable. */
    readonly error?: string;
    /** True while a publish request is in flight. */
    readonly publishing: boolean;
    /** Last publish outcome, cleared when the composer is edited again. */
    readonly lastPublish?: PublishResult;
}
/** Bridge between the board source and the React view. */
export declare class RouterBoardController {
    private readonly source;
    private readonly onChange?;
    private state;
    private readonly listeners;
    private inFlight;
    private disposed;
    /**
     * @param source - the board source this panel reads.
     * @param onChange - called after the source reports a Host-side change.
     */
    constructor(source: BoardSource, onChange?: (() => void) | undefined);
    /** Attach to the source's change feed once, for the controller's lifetime. */
    start(): () => void;
    /** Current state; stable between changes. */
    getSnapshot: () => RouterPanelState;
    /**
     * Subscribe to state changes.
     * @param listener - change callback.
     * @returns unsubscribe.
     */
    subscribe: (listener: () => void) => (() => void);
    /** Stop accepting results from in-flight reads. */
    dispose(): void;
    private emit;
    /**
     * Read the board.
     *
     * Concurrent calls join the in-flight read: a burst of change events must not
     * become a burst of Host round-trips.
     * @returns completion of the read.
     */
    load(): Promise<void>;
    /**
     * Publish demands, then re-read so the new tasks appear.
     * @param demands - one entry per submitted line.
     * @returns the routing result, or undefined on failure.
     */
    publish(demands: readonly string[]): Promise<PublishResult | undefined>;
    /**
     * Record a verification decision and re-read.
     * @param taskId - the reported task.
     * @param verdict - accept or send back.
     * @param note - rejection reason shown on the card.
     */
    verify(taskId: string, verdict: Extract<TaskState, 'verified' | 'rejected'>, note?: string): Promise<void>;
    /** Whether the source can run `task_control` actions at all. */
    get canControl(): boolean;
    /**
     * Run one `task_control` action, then re-read the board.
     *
     * `cancel` / `cancel_tree` move the rows to 已取消 the same way.
     * `resume` is applied optimistically: the row is moved to `running` in the
     * local snapshot before the request, so it leaves 已暂停 at once. A fresh read
     * (not a join of an older in-flight one) follows a success; a failure restores
     * the snapshot taken before the optimistic patch and re-reads.
     * @param taskId - the task.
     * @param action - the `task_control` action.
     * @param value - its optional `value`.
     * @returns undefined on success, else the human-readable failure.
     */
    control(taskId: string, action: ControlAction, value?: string, extra?: ControlExtra): Promise<string | undefined>;
    /** Whether the source can list partition files (the 工作区 page). */
    get canListFiles(): boolean;
    /**
     * List one directory level of one partition.
     * @throws {Error} when the source cannot list files or the Host refuses.
     */
    listFiles(partition: string, path: string): Promise<FileListingView>;
    /** Whether the source can read partition memory. */
    get canReadMemory(): boolean;
    /** Read one partition's memory. */
    readMemory(partition: string): Promise<PartitionMemoryView>;
    /** Add a note to one partition's memory. */
    addMemoryNote(partition: string, text: string): Promise<MemoryNoteView>;
    /** Remove a note from one partition's memory. */
    removeMemoryNote(partition: string, id: string): Promise<void>;
    /** Whether the source has the approval queue. */
    get canApprove(): boolean;
    /** Whether the source streams worker output. */
    get canReadLive(): boolean;
    /** Whether the source can move a task to another partition or model. */
    get canReassign(): boolean;
    /** Whether the source takes batch actions. */
    get canBatch(): boolean;
    /** Pending and recent approvals. */
    readApprovals(): Promise<ApprovalsView>;
    /** Approve (runs once) or reject one approval, then re-read the board. */
    decideApproval(id: string, decision: 'approve' | 'reject', note?: string): Promise<ApprovalView>;
    /** Newest audit lines. */
    readAudit(limit?: number): Promise<readonly AuditEntryView[]>;
    /** A worker's output since segment `after`. */
    readLive(taskId: string, after?: number): Promise<LiveView>;
    /** Models offered by the runtime. */
    listModels(): Promise<readonly ModelChoiceView[]>;
    /** 改派 / 换模型, then re-read the board. */
    reassign(input: ReassignInput): Promise<ReassignResult>;
    /** One action over many rows, then re-read the board. */
    batch(taskIds: readonly string[], action: BatchAction, value?: string): Promise<BatchResultView>;
    /** Clear the publish banner after the view has shown it. */
    clearPublishNotice(): void;
}
