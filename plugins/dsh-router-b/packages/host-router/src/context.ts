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

import type { SessionEventLike } from './types.ts'

/** The prompt-side fields of one provider usage report. */
export interface UsageLike {
  readonly inputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** Accept a usage object only when it carries at least one numeric prompt field. */
function asUsage(value: unknown): UsageLike | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  const fields = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const
  if (!fields.some(field => typeof candidate[field] === 'number')) return undefined
  return candidate as UsageLike
}

/**
 * The usage sample one event reports, if any.
 *
 * A settled message carries it as `data.usage`; a streaming attempt carries the
 * last chunk that has one. Both spellings appear in the durable log depending on
 * whether the attempt settled, so both are read.
 * @param event - one durable session event.
 * @returns the usage report, or undefined when the event carries none.
 */
function usageOf(event: SessionEventLike): UsageLike | undefined {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  if (event.data === undefined || typeof event.data !== 'object') return undefined
  const data = event.data as { readonly usage?: unknown; readonly stream?: unknown }
  const direct = asUsage(data.usage)
  if (direct !== undefined) return direct
  if (!Array.isArray(data.stream)) return undefined
  for (let index = data.stream.length - 1; index >= 0; index--) {
    const chunk = data.stream[index] as { readonly usage?: unknown } | undefined
    const found = asUsage(chunk?.usage)
    if (found !== undefined) return found
  }
  return undefined
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
export function pressureTokensOf(events: readonly SessionEventLike[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const usage = usageOf(events[index]!)
    if (usage === undefined) continue
    return (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  }
  return undefined
}

/** One line a human (or the model) can act on, e.g. `~287k`. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const thousands = Math.round(tokens / 1000)
  return `~${String(thousands)}k`
}
