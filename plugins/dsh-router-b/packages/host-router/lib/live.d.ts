/**
 * Live output of one worker: its session log cut into segments a person can
 * scan while the worker runs.
 *
 * One segment per tool call (the command and what it printed), one per
 * assistant message, one per turn end. A segment is marked as an error when the
 * tool reported one or its output reads like a failure, so the panel can paint
 * it red and offer 停止 / 改派 right there.
 *
 * @module host-router/live
 */
import type { SessionEventLike } from './types.ts';
/** One block of live output. */
export interface LiveSegment {
    /** Sequence number of the event that opened the segment; stable across reads. */
    readonly seq: number;
    readonly kind: 'command' | 'message' | 'end';
    /** The tool and its arguments, `assistant`, or the turn-end reason. */
    readonly title: string;
    readonly body: string;
    readonly error: boolean;
    /** Epoch ms of the opening event. */
    readonly at: number;
    /** A command still waiting for its result. */
    readonly running?: boolean;
}
/**
 * Cut a session log into live segments.
 * @param events - the session log, oldest first.
 * @param after - only segments whose `seq` is greater (incremental reads).
 * @param last - keep at most this many segments from the end.
 */
export declare function liveSegments(events: readonly SessionEventLike[], after?: number, last?: number): LiveSegment[];
