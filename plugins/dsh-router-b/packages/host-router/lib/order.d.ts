/**
 * Task ordering: which queued rows may start now, which must wait, and which
 * can never start without a human.
 *
 * Two ways to say "this after that", both stored on the row:
 *
 * - `dependsOn`: explicit task ids. The row starts once every one of them is
 *   finished (`done`, `verified`, or the older `reported`).
 * - `stage`: an ordered phase among siblings (same `parentId`). A row starts
 *   once every sibling with a lower stage is finished. This is what a manager
 *   uses for "1, 2, 3 first, then 4, 5, 6": stage 1 for the first three,
 *   stage 2 for the rest, without having to copy task ids around.
 *
 * A prerequisite that `failed` or was `cancelled` will never finish on its own,
 * so a row waiting on one is "dead": the router parks it as `blocked` with a
 * note naming the prerequisite instead of leaving it queued forever.
 *
 * Pure functions only, so the rules can be asserted without a harness.
 *
 * @module host-router/order
 */
import type { RouterTask } from './board.ts';
/** Whether one row may start now. */
export type Gate = {
    readonly kind: 'ready';
}
/** Waiting on these still-open rows. */
 | {
    readonly kind: 'wait';
    readonly on: readonly string[];
}
/** A prerequisite failed, was cancelled, or does not exist: needs a human. */
 | {
    readonly kind: 'dead';
    readonly on: readonly string[];
    readonly reason: string;
};
/** The row ids that must finish before `task` may start, explicit and stage-derived. */
export declare function prerequisitesOf(task: RouterTask, all: readonly RouterTask[]): readonly string[];
/**
 * Decide whether `task` may start.
 * @param task - the row to check (normally `queued`).
 * @param all - every row on the board.
 */
export declare function gateOf(task: RouterTask, all: readonly RouterTask[]): Gate;
/** Gate on an explicit list of prerequisite ids. */
export declare function gateOfIds(ids: readonly string[], all: readonly RouterTask[]): Gate;
/**
 * Which rows a suspended row is still waiting for.
 * @returns `ready` when every `waitingOn` row is finished.
 */
export declare function suspendGateOf(task: RouterTask, all: readonly RouterTask[]): Gate;
/**
 * Validate the prerequisites a new row asks for.
 * @returns an error sentence, or undefined when they are acceptable.
 */
export declare function dependencyError(dependsOn: readonly string[] | undefined, all: readonly RouterTask[]): string | undefined;
/** One request's family: its root row and every row under it. */
export interface GroupProgress {
    readonly rootId: string;
    readonly subject: string;
    readonly total: number;
    readonly finished: number;
    readonly running: number;
    /** Queued rows that are held back by an unfinished prerequisite. */
    readonly waiting: number;
    readonly suspended: number;
    readonly failed: number;
    /** Every row is in a final state (finished, failed, cancelled). */
    readonly complete: boolean;
}
/** Root ancestor of one row (itself when it has no parent on the board). */
export declare function rootOf(task: RouterTask, byId: ReadonlyMap<string, RouterTask>): RouterTask;
/**
 * Roll rows up by request: one entry per root row, counting the root's
 * descendants (workers) rather than the root itself when it has any, because
 * "3/6 done" is what a person means by progress.
 */
export declare function groupProgress(all: readonly RouterTask[]): readonly GroupProgress[];
/** One line for a person: `3/6 完成，1 个运行中，2 个等前置`. */
export declare function progressLine(group: GroupProgress): string;
