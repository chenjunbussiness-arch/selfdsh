/**
 * Where the board's data comes from.
 *
 * The panel never talks to the network itself: it reads one {@link BoardSource}.
 * Three implementations exist —
 *
 * - `createHttpSource` — the real path. It calls the host plugin's same-origin
 *   HTTP bridge (`/api/router/*`, mounted by `packages/host-router` on
 *   `ctx.webServer`), which answers the panel's document, accepts demands, and
 *   records verification verdicts. No Harness Remote is involved: the bridge is
 *   ordinary HTTP because the Web shell is served by the same web server, so a
 *   relative `fetch` needs no new transport and no Typert declaration.
 * - `createHostSource` — the Remote surface (`ctx.remote.router`) this file was
 *   originally written against. Kept because it is the documented contract in
 *   `docs/CONTRACT.md` and because a Host that later publishes that Remote keeps
 *   working; the router bundle does not publish one today.
 * - `createMockSource` — built-in sample data, used when the Host half is not
 *   installed or has never answered. The panel labels itself `mock` so nobody
 *   mistakes the demo for live state.
 *
 * Swapping the source is one line in `index.ts`; nothing in the view knows which
 * one it is reading.
 */
import type { BoardSnapshot, PublishResult, TaskState } from './contract.ts';
import { createMockSource } from './mock.ts';
/** The one seam between the view and the router. */
export interface BoardSource {
    /** Whether this source is live Host data or built-in sample data. */
    readonly origin: 'host' | 'mock';
    /**
     * Read one consistent board snapshot.
     * @returns the snapshot the panel renders.
     */
    read(): Promise<BoardSnapshot>;
    /**
     * Publish one or more demands; the router assigns partitions.
     * @param demands - raw demand text, one entry per line the user submitted.
     * @returns what the router accepted and where it routed each demand.
     */
    publish(demands: readonly string[]): Promise<PublishResult>;
    /**
     * Record a verification decision on a reported task.
     * @param taskId - the task being judged.
     * @param verdict - `verified` accepts, `rejected` sends it back.
     * @param note - why it was rejected.
     */
    verify(taskId: string, verdict: Extract<TaskState, 'verified' | 'rejected'>, note?: string): Promise<void>;
    /**
     * Observe Host-side changes.
     * @param listener - called whenever the board may have changed.
     * @returns unsubscribe.
     */
    subscribe(listener: () => void): () => void;
}
/** The Remote surface the Host half is expected to expose (`ctx.remote.router`). */
export interface RouterRemoteLike {
    board(): Promise<{
        ok: true;
        value: unknown;
    } | {
        ok: false;
        error: {
            code: string;
            message: string;
        };
    }>;
    publish(request: {
        demands: readonly string[];
    }): Promise<{
        ok: true;
        value: unknown;
    } | {
        ok: false;
        error: {
            code: string;
            message: string;
        };
    }>;
    verify(request: {
        taskId: string;
        verdict: 'verified' | 'rejected';
        note?: string;
    }): Promise<{
        ok: true;
        value: unknown;
    } | {
        ok: false;
        error: {
            code: string;
            message: string;
        };
    }>;
}
/**
 * Narrow an unknown wire value into a board snapshot without trusting its shape.
 * A Host that drifts from the contract yields `undefined` rather than a crash in
 * the middle of a render.
 * @param value - decoded wire value.
 * @returns the snapshot, or undefined when the payload is not one.
 */
export declare function asBoardSnapshot(value: unknown): BoardSnapshot | undefined;
/**
 * Build the source that talks to the Host router bundle.
 * @param remote - `ctx.remote.router` from the client Context.
 * @param subscribeChanges - Host change feed (`ctx.remote.$on('router/changed', …)`).
 * @returns a live BoardSource.
 */
export declare function createHostSource(remote: RouterRemoteLike, subscribeChanges: (listener: () => void) => () => void): BoardSource;
/**
 * Where the Host's HTTP bridge lives.
 *
 * Mirrors `BRIDGE_BASE` in `packages/host-router/src/bridge.ts`; the two are
 * deployed together, so this constant is the whole coupling.
 */
export declare const BRIDGE_BASE = "/api/router";
/** Options for {@link createHttpSource}. */
export interface HttpSourceOptions {
    /** Bridge prefix; defaults to {@link BRIDGE_BASE}. */
    readonly base?: string;
    /**
     * Source rendered while the Host has never answered.
     *
     * A panel that has never reached the Host is a labelled demo, not a blank
     * column — the same rule the Remote path had. Once a live read has succeeded
     * this is never consulted again: a stale real board is shown as stale, never
     * silently replaced by sample data.
     */
    readonly fallback?: BoardSource;
    /** Injected for a test; defaults to the global `fetch`. */
    readonly fetchImpl?: typeof fetch;
}
/**
 * Build the source that talks to the Host's HTTP bridge.
 * @param options - bridge prefix, sample fallback, and a test `fetch`.
 * @returns a live BoardSource.
 */
export declare function createHttpSource(options?: HttpSourceOptions): BoardSource;
/**
 * The write actions the panel's rail offers, over the same bridge.
 *
 * Deliberately minimal: a control whose Host action does not exist here is left
 * out of the object, which the view renders as "not wired" instead of pretending.
 * @param options - bridge prefix and a test `fetch`.
 * @returns the actions the bridge implements.
 */
export declare function createHttpActions(options?: {
    readonly base?: string;
    readonly fetchImpl?: typeof fetch;
}): {
    setPartitionEnabled(partitionId: string, enabled: boolean): Promise<void>;
};
/**
 * Pick the source for this client: the Host's HTTP bridge, which itself falls
 * back to labelled sample data until the Host answers.
 *
 * The factory parameter stays for a Host that publishes a Remote: when it is
 * supplied the caller's source wins, so nothing about the Remote path is lost.
 * @param factory - returns a source when the caller has one (a Remote).
 * @returns the source to read.
 */
export declare function resolveSource(factory: (() => BoardSource) | undefined): BoardSource;
export { createMockSource };
