/**
 * Panel state: one snapshot object, replaced on every change so
 * `useSyncExternalStore` sees a new reference exactly when something changed.
 *
 * The controller owns data and I/O. It starts on the real bridge and, when the
 * bridge cannot be read, serves the sample source and says so (`origin`), then
 * keeps retrying the bridge so the badge disappears as soon as it is reachable.
 */
import type { EgressSource, EgressState, ExitInput } from './contract.ts';
/** What the panel renders. */
export interface PanelState {
    readonly data: EgressState | null;
    readonly origin: 'host' | 'mock';
    readonly status: 'loading' | 'ready';
    /** Last failure of the bridge read, kept while sample data is shown. */
    readonly bridgeError?: string;
    /** Exit ids with a probe in flight. */
    readonly probing: readonly string[];
    /** Result of the last action, shown as a toast line. */
    readonly notice?: {
        readonly kind: 'ok' | 'error';
        readonly text: string;
    };
}
/** Bridge between the sources and the React view. */
export declare class EgressController {
    private readonly host;
    private readonly makeMock;
    private readonly pollMs;
    private state;
    private readonly listeners;
    private active;
    private mock;
    private timer;
    private disposed;
    /**
     * @param host - the real bridge source.
     * @param makeMock - builds the sample source on first need.
     * @param pollMs - bridge refresh interval; 0 disables polling (tests, preview).
     */
    constructor(host: EgressSource, makeMock: () => EgressSource, pollMs?: number);
    /** Current state; stable between changes. */
    getSnapshot: () => PanelState;
    /**
     * Subscribe to state changes.
     * @param listener - change callback.
     * @returns unsubscribe.
     */
    subscribe: (listener: () => void) => (() => void);
    private set;
    /** First read, then poll. */
    start(): () => void;
    /** Stop polling and drop listeners. */
    dispose(): void;
    /**
     * Read the state, preferring the real bridge.
     * @param quiet - true for background polls: do not flash the loading state.
     */
    refresh(quiet?: boolean): Promise<void>;
    /** Run one write and fold its answer (or error) into the state. */
    private act;
    /** Clear the toast line. */
    dismissNotice(): void;
    /**
     * Create or update an exit.
     * @param input - form values.
     * @returns whether the write was accepted.
     */
    saveExit(input: ExitInput, okText: string): Promise<boolean>;
    /** Delete an exit. */
    removeExit(id: string, okText: string): Promise<boolean>;
    /** Bind a host (or `*`, the default exit) to an exit; `null` unbinds. */
    bind(host: string, exit: string | null, okText: string): Promise<boolean>;
    /** Probe one exit and show the result in its row. */
    probe(id: string): Promise<void>;
}
