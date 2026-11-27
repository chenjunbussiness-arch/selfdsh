/**
 * Daily quotas per agent: tokens and cost (from what the agent reports), plus tasks and
 * minutes (which the hub counts itself). An agent over any of its limits takes no new
 * task until the day turns; its stage goes to the next agent that can do it.
 *
 * hub.json:
 *
 *   "quota": {
 *     "utcOffsetMinutes": 480,          // when "today" starts (480 = UTC+8); default 0
 *     "warnAt": 0.8,                    // one 作战室 notice when a limit is this full
 *     "agents": {
 *       "agy-mydesk": { "tokensPerDay": 3000000, "costPerDay": 5 },
 *       "cc-mydesk":  { "tokensPerDay": 2000000, "tasksPerDay": 30, "minutesPerDay": 480 }
 *     }
 *   }
 *
 * Tokens and cost only count what the agent reported (`usage` on submit_result, or
 * POST /v1/usage from the headless runner). An agent that never reports is held only by
 * tasksPerDay / minutesPerDay; `usage_reported: false` in its numbers says so.
 *
 * @module dsh-hub/quota
 */

const AGENT_RE = /^[a-z][a-z0-9-]{1,47}$/
export const LIMIT_KEYS = Object.freeze({ tokensPerDay: 'tokens', costPerDay: 'cost', tasksPerDay: 'tasks', minutesPerDay: 'minutes' })
/** Days of usage kept per agent. */
export const USAGE_DAYS = 8

/** hub.json `quota` -> { utcOffsetMinutes, warnAt, agents }. Throws an Error with a hub.json message. */
export function quotaOf(raw) {
  if (raw === undefined || raw === null) return { utcOffsetMinutes: 0, warnAt: 0.8, agents: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('hub.json: quota must be an object')
  const offset = raw.utcOffsetMinutes ?? 0
  if (!Number.isInteger(offset) || offset < -720 || offset > 840) throw new Error('hub.json: quota.utcOffsetMinutes must be -720..840')
  const warnAt = raw.warnAt ?? 0.8
  if (typeof warnAt !== 'number' || !(warnAt > 0 && warnAt <= 1)) throw new Error('hub.json: quota.warnAt must be a number in (0, 1]')
  const agents = raw.agents ?? {}
  if (typeof agents !== 'object' || Array.isArray(agents) || agents === null) throw new Error('hub.json: quota.agents must be an object of { agent id: limits }')
  const out = {}
  for (const [id, limits] of Object.entries(agents)) {
    if (!AGENT_RE.test(id)) throw new Error(`hub.json: quota.agents: "${id}" is not an agent id`)
    if (typeof limits !== 'object' || Array.isArray(limits) || limits === null) throw new Error(`hub.json: quota.agents.${id} must be an object`)
    const l = {}
    for (const [key, value] of Object.entries(limits)) {
      if (!Object.hasOwn(LIMIT_KEYS, key)) throw new Error(`hub.json: quota.agents.${id}.${key} is unknown (use ${Object.keys(LIMIT_KEYS).join(', ')})`)
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`hub.json: quota.agents.${id}.${key} must be a number > 0`)
      l[LIMIT_KEYS[key]] = value
    }
    out[id] = l
  }
  return { utcOffsetMinutes: offset, warnAt, agents: out }
}

/** The day (YYYY-MM-DD) a moment falls on, in the quota's time zone. */
export function usageDay(now, utcOffsetMinutes = 0) {
  return new Date(now + utcOffsetMinutes * 60_000).toISOString().slice(0, 10)
}

const count = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

/**
 * A reported usage (any of the common shapes: Claude / OpenAI style token fields,
 * `total_tokens`, `cost_usd` / `total_cost_usd`) -> { tokens, cost, input_tokens, ... },
 * or undefined when it says nothing usable. Tokens = total_tokens when given, else
 * input + output + cache writes (cache reads are kept, not counted: they are cheap).
 */
export function usageOf(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const input = count(raw.input_tokens)
  const output = count(raw.output_tokens)
  const cacheWrite = count(raw.cache_creation_input_tokens)
  const cacheRead = count(raw.cache_read_input_tokens ?? raw.cached_input_tokens)
  const total = count(raw.total_tokens)
  const cost = count(raw.cost_usd ?? raw.total_cost_usd)
  const tokens = total ?? (input === undefined && output === undefined && cacheWrite === undefined ? undefined : (input ?? 0) + (output ?? 0) + (cacheWrite ?? 0))
  if (tokens === undefined && cost === undefined) return undefined
  const out = { tokens: Math.round(tokens ?? 0), cost: cost === undefined ? 0 : Math.round(cost * 1e6) / 1e6 }
  if (input !== undefined) out.input_tokens = Math.round(input)
  if (output !== undefined) out.output_tokens = Math.round(output)
  if (cacheWrite !== undefined) out.cache_creation_input_tokens = Math.round(cacheWrite)
  if (cacheRead !== undefined) out.cache_read_input_tokens = Math.round(cacheRead)
  if (typeof raw.model === 'string') out.model = raw.model.slice(0, 64)
  return out
}

/**
 * How full each limit is: { over, used, limits, fraction: { tokens: 0.82, ... } }.
 * `used` is one day of { tokens, cost, tasks, minutes }.
 */
export function quotaState(limits, used) {
  const u = { tokens: used?.tokens ?? 0, cost: used?.cost ?? 0, tasks: used?.tasks ?? 0, minutes: (used?.ms ?? 0) / 60_000 }
  const fraction = {}
  let over = false
  for (const [key, limit] of Object.entries(limits ?? {})) {
    fraction[key] = Math.round((u[key] / limit) * 1000) / 1000
    if (u[key] >= limit) over = true
  }
  return { over, used: u, limits: { ...(limits ?? {}) }, fraction }
}
