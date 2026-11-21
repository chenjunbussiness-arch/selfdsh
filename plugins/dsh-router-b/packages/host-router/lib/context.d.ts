/**
 * Prompt-side context pressure of one session, computed from its own log.
 *
 * The harness already publishes this number: `tokenMeter.contextPressure(session)`
 * returns `{ pressureTokens, contextWindow }`, folded by the `contextPressure`
 * session projection. That service takes a live `Session`, though, and the
 * router's interesting case is a worker that has *settled* — the row is
 * `reported` and its session is no longer live. Reading the log is the only
 * source that covers both, so this module reproduces the one field the router
 * needs from the same events the projection folds:
 *
 * - the newest `assistant/message` (or `assistant/attempt`) that carries a
 *   usage sample;
 * - prompt side only: `inputTokens + cacheReadTokens + cacheWriteTokens`, which
 *   is exactly `pressureFrom()` in `token-meter/src/usage-projection.ts:78-79`.
 *
 * Deliberately not reproduced: `projectedTokens` (sample plus untransmitted
 * surface movement). That number answers "how big will the next request be",
 * which needs the surface fold; the router only needs "how big was the last
 * request", and that is what the log states plainly.
 *
 * @module host-router/context
 */
import type { SessionEventLike } from './types.ts';
/** The prompt-side fields of one provider usage report. */
export interface UsageLike {
    readonly inputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
}
/**
 * Prompt-side tokens the session's last request held.
 *
 * Scans backwards so the newest sample wins and an old turn cannot inflate the
 * answer. A log with no usage yet (a brand-new child, or a provider that reports
 * no usage) yields undefined rather than a zero, because "unknown" and "empty"
 * must not share a value: the caller's ceiling check treats them differently.
 * @param events - the session's durable events in seq order.
 * @returns prompt tokens of the last reported request, or undefined.
 */
export declare function pressureTokensOf(events: readonly SessionEventLike[]): number | undefined;
/** One line a human (or the model) can act on, e.g. `~287k`. */
export declare function formatTokens(tokens: number): string;
