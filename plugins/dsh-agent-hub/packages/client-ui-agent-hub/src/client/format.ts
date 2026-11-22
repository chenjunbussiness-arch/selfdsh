/**
 * Small, locale-aware formatting helpers for the panel.
 */

import { AGENT_STATUSES } from './contract.ts'
import type { AgentStatus, AgentView } from './contract.ts'
import type { Translate } from './locales.ts'

/** Milliseconds since an ISO time, or `undefined` when it does not parse. */
export function ageMs(iso: string | undefined, now: number = Date.now()): number | undefined {
  if (iso === undefined) return undefined
  const at = Date.parse(iso)
  return Number.isFinite(at) ? Math.max(0, now - at) : undefined
}

type Unit = 's' | 'm' | 'h' | 'd'

/** A non-negative span in its largest sensible unit (seconds < 60, minutes < 60, hours < 48, then days). */
function span(ms: number): { readonly unit: Unit; readonly n: number } {
  const s = Math.round(ms / 1000)
  if (s < 60) return { unit: 's', n: s }
  const m = Math.round(s / 60)
  if (m < 60) return { unit: 'm', n: m }
  const h = Math.round(m / 60)
  if (h < 48) return { unit: 'h', n: h }
  return { unit: 'd', n: Math.round(h / 24) }
}

const AGO: Readonly<Record<Unit, string>> = { s: 'ago.s', m: 'ago.m', h: 'ago.h', d: 'ago.d' }
const DUR: Readonly<Record<Unit, string>> = { s: 'dur.s', m: 'dur.m', h: 'dur.h', d: 'dur.d' }

/** "12 秒前" / "3 min ago"; `—` when unknown. */
export function relative(iso: string | undefined, t: Translate, now: number = Date.now()): string {
  const ms = ageMs(iso, now)
  if (ms === undefined) return t('value.none')
  const { unit, n } = span(ms)
  return t(AGO[unit], { n })
}

/** "12 分钟" / "12 min" since an ISO time (no "ago"); `—` when unknown. */
export function duration(iso: string | undefined, t: Translate, now: number = Date.now()): string {
  const ms = ageMs(iso, now)
  if (ms === undefined) return t('value.none')
  const { unit, n } = span(ms)
  return t(DUR[unit], { n })
}

/**
 * An agent's presence status. A dsh-agent/2.0 bridge sends `status`; an older
 * one only `revoked` / `online`, which map to revoked / online / offline.
 */
export function agentStatus(agent: Pick<AgentView, 'status' | 'online' | 'revoked'>): AgentStatus {
  const status = agent.status
  if (typeof status === 'string' && (AGENT_STATUSES as readonly string[]).includes(status)) return status
  if (agent.revoked === true) return 'revoked'
  return agent.online === true ? 'online' : 'offline'
}

/** Agents per status, and their total. */
export interface AgentCounts {
  readonly counts: Readonly<Record<AgentStatus, number>>
  readonly total: number
}

/**
 * Count agents per status: from the hub's `overview.agent_counts` when it is
 * there and usable, otherwise from the agent list (the pre-2.0 algorithm).
 * @param agents - the agent list.
 * @param hub - `overview.agent_counts`, if any.
 */
export function agentCounts(agents: readonly AgentView[], hub?: Partial<Record<AgentStatus, number>>): AgentCounts {
  const counts: Record<AgentStatus, number> = { online: 0, pending: 0, offline: 0, left: 0, revoked: 0 }
  let fromHub = false
  if (typeof hub === 'object' && hub !== null) {
    for (const status of AGENT_STATUSES) {
      const value = hub[status]
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        counts[status] = value
        fromHub = true
      }
    }
  }
  if (!fromHub) for (const agent of agents) counts[agentStatus(agent)] += 1
  const total = AGENT_STATUSES.reduce((sum, status) => sum + counts[status], 0)
  return { counts, total }
}

/** Online first, then pending, offline, left, revoked; the hub's order within each. */
export function sortAgents(agents: readonly AgentView[]): AgentView[] {
  const rank = (agent: AgentView): number => AGENT_STATUSES.indexOf(agentStatus(agent))
  return agents.map((agent, index) => ({ agent, index }))
    .sort((left, right) => rank(left.agent) - rank(right.agent) || left.index - right.index)
    .map(item => item.agent)
}

/**
 * Heartbeat text of one agent: "最后心跳 12 秒前" (or just "12 秒前" with
 * `labelled` false) while it is around; "离线 5 分钟" once it is offline or
 * left (counted from `left_at` when known, else from the last heartbeat);
 * "从未心跳" without any heartbeat.
 */
export function presence(agent: AgentView, t: Translate, now: number = Date.now(), labelled: boolean = true): string {
  const status = agentStatus(agent)
  if (status === 'offline' || status === 'left') {
    const since = status === 'left' ? (agent.left_at ?? agent.last_seen) : agent.last_seen
    if (since === undefined) return t('agent.never')
    return t('presence.offline', { time: duration(since, t, now) })
  }
  if (agent.last_seen === undefined) return t('agent.never')
  const time = relative(agent.last_seen, t, now)
  return labelled ? t('presence.seen', { time }) : time
}

/** "in 12 min" / "已过期" for a lease deadline. */
export function until(iso: string | undefined, t: Translate, now: number = Date.now()): string {
  if (iso === undefined) return t('value.none')
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return t('value.none')
  const s = Math.round((at - now) / 1000)
  if (s <= 0) return t('lease.expired')
  if (s < 60) return t('in.s', { n: s })
  const m = Math.round(s / 60)
  if (m < 60) return t('in.m', { n: m })
  return t('in.h', { n: Math.round(m / 60) })
}

/** Full local date-time for a tooltip. */
export function absolute(iso: string | undefined): string {
  if (iso === undefined) return ''
  const at = Date.parse(iso)
  return Number.isFinite(at) ? new Date(at).toLocaleString() : iso
}

/** `HH:MM:SS` local clock. */
export function clock(ms: number | undefined): string {
  if (ms === undefined) return ''
  const d = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/** 0..1 → "42%". */
export function percent(progress: number | undefined): string | undefined {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return undefined
  return `${String(Math.round(Math.min(1, Math.max(0, progress)) * 100))}%`
}

/** 1234 → "1.2 KB". */
export function bytes(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  if (value < 1024) return `${String(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}
