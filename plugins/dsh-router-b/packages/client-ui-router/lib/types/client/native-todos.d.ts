/**
 * Reading each worker's checklist from the Harness itself.
 *
 * A worker is a subagent Session, and `dsh-tool-todo` already publishes the
 * `todos` projection for every Session (key `todos`, `wire.view` on the Host, so
 * the Client receives the finished value — no Remote, no folding). The Session
 * list snapshot the Client already holds carries those finished values per
 * Session under `projectionsBySession`, which is how a panel can show a *worker's*
 * checklist rather than only the focused Session's.
 *
 * Two consequences of the Host's own definition drive this module:
 *
 *  1. the projection is reset to `null` on `turn/start`, so it describes the
 *     CURRENT turn only. A finished task whose next turn has begun reads `null`;
 *  2. therefore a task's historical checklist has to come from the Session log's
 *     `todo/write` events, which is the Host half's job (see `docs/CONTRACT.md`).
 *
 * So: live value from the projection when it exists, Host-supplied snapshot as
 * the fallback. Never the other way round — a projection read is always fresher
 * than a value that travelled through a task payload.
 */
import type { TodoItem } from './contract.ts';
/** One Session's projection block inside the Session list snapshot. */
export interface ProjectionsBySessionEntry {
    /** `ready` once the Host has sent values for this Session. */
    readonly state?: string;
    /** Finished projection values by key (`todos`, `subagentCatalog`, …). */
    readonly values?: Record<string, unknown>;
}
/** The slice of `SessionListState` this module reads. */
export interface SessionListSnapshot {
    /** Projection blocks keyed by Session id. */
    readonly projectionsBySession?: Record<string, ProjectionsBySessionEntry | undefined>;
}
/** The slice of `ctx.sessions` this module reads. */
export interface SessionsFace {
    readonly list: {
        getSnapshot(): SessionListSnapshot;
        subscribe(listener: () => void): () => void;
    };
    /**
     * Ask the Host for this Session's projection values without opening it.
     * @param sessionId - the Session to refresh.
     */
    refreshProjections?(sessionId: string): Promise<void>;
}
/**
 * Observable used when no Session service is available (standalone preview).
 * A constant snapshot keeps `useSyncExternalStore` correct.
 */
export declare const NO_SESSIONS: SessionsFace;
/**
 * Narrow one projection block's `todos` value.
 *
 * The Host value is `TodoItem[] | null`; anything else is drift from the
 * contract and is treated as "not available" rather than rendered blindly.
 * @param value - raw projection value.
 * @returns the checklist, or undefined when the value is not one.
 */
export declare function asTodos(value: unknown): TodoItem[] | undefined;
/**
 * Read one Session's current checklist out of a list snapshot.
 * @param snapshot - the Session list snapshot.
 * @param sessionId - the worker Session to read.
 * @returns its checklist, or undefined when the Host has not sent one.
 */
export declare function todosOf(snapshot: SessionListSnapshot, sessionId: string | undefined): TodoItem[] | undefined;
