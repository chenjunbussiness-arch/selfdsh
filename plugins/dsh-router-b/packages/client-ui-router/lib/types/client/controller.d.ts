/**
 * Panel state: one snapshot object, replaced on every change so
 * `useSyncExternalStore` sees a new reference exactly when something changed.
 *
 * The controller owns data and I/O only. Filtering, expansion and the composer
 * draft are view state and stay in React, so a re-render never depends on the
 * controller's identity.
 */
import type { BoardSnapshot, PublishResult, TaskState } from './contract.ts';
import type { BoardSource } from './source.ts';
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
    /** Clear the publish banner after the view has shown it. */
    clearPublishNotice(): void;
}
