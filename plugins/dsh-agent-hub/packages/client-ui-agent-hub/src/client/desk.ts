/**
 * The 调度台's grouping rules, kept apart from React so they can be tested on
 * their own (tests/desk.test.mjs runs this file with Node's type stripping).
 *
 * Everything here reads the hub's rows as they come from the admin routes:
 *   - tasks fall into five lanes: 排队 → 已领取 → 进行中 → 等你回复 → 已结束;
 *   - agents are grouped by the DSH profile they belong to, dormant ones apart;
 *   - DSH's own partition workers (`dsh-self/<profile>/<partition>`) are not hub
 *     agents, so they are derived from the local tasks they hold;
 *   - tasks DSH took over itself (fallback) are listed with the reason.
 */

import type { AgentView, HistoryEvent, TaskRow, TaskStage } from './contract.ts'

/** Lanes of the task list, in display order. */
export type Lane = 'queued' | 'claimed' | 'running' | 'waiting' | 'ended'

export const LANES: readonly Lane[] = ['queued', 'claimed', 'running', 'waiting', 'ended']

/** Executor id prefix of DSH's own partition workers. */
export const SELF_PREFIX = 'dsh-self'

/** The lane a task belongs in. A task that asks for an answer waits on you whatever its status. */
export function laneOf(task: Pick<TaskRow, 'status' | 'stage' | 'result'>): Lane {
  const finished = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'dead'
  const asks = task.stage === 'needs_input' || (task.result?.needs_input !== undefined && task.result.needs_input !== '')
  if (asks && (!finished || task.result?.status === 'partial')) return 'waiting'
  if (finished) return 'ended'
  if (task.status === 'pending') return 'queued'
  if (task.status === 'accepted') return 'claimed'
  return 'running'
}

/** Tasks per lane, newest activity first inside a lane. */
export function lanesOf(tasks: readonly TaskRow[]): Record<Lane, TaskRow[]> {
  const out: Record<Lane, TaskRow[]> = { queued: [], claimed: [], running: [], waiting: [], ended: [] }
  for (const task of tasks) out[laneOf(task)].push(task)
  const at = (task: TaskRow): string => task.updated_at ?? task.finished_at ?? task.created_at
  for (const lane of LANES) out[lane].sort((a, b) => at(b).localeCompare(at(a)))
  // Queued work reads best oldest first: that is the order it will be taken.
  out.queued.reverse()
  return out
}

/** One group of agents under a DSH profile (or under the machine when no profile was given). */
export interface AgentGroup {
  readonly key: string
  /** `profile`: a DSH profile name; `node`: only a machine name was given; `none`: neither. */
  readonly kind: 'profile' | 'node' | 'none'
  readonly agents: readonly AgentView[]
}

/**
 * Live agents grouped by profile (groups sorted by name, the unlabelled group
 * last), and the dormant ones apart.
 */
export function agentGroups(agents: readonly AgentView[]): { groups: AgentGroup[]; dormant: AgentView[] } {
  const live = new Map<string, { kind: AgentGroup['kind']; agents: AgentView[] }>()
  const dormant: AgentView[] = []
  for (const agent of agents) {
    if (agent.dormant === true || agent.revoked) {
      dormant.push(agent)
      continue
    }
    const kind: AgentGroup['kind'] = agent.dsh_profile !== undefined && agent.dsh_profile !== '' ? 'profile'
      : agent.node !== undefined && agent.node !== '' ? 'node' : 'none'
    const key = kind === 'profile' ? agent.dsh_profile ?? '' : kind === 'node' ? agent.node ?? '' : ''
    const id = `${kind}:${key}`
    const slot = live.get(id) ?? { kind, agents: [] }
    slot.agents.push(agent)
    live.set(id, slot)
  }
  const rank = { profile: 0, node: 1, none: 2 } as const
  const groups = [...live.entries()]
    .map(([id, slot]) => ({ key: id.slice(id.indexOf(':') + 1), kind: slot.kind, agents: slot.agents }))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.key.localeCompare(b.key))
  return { groups, dormant }
}

/** A DSH partition worker, seen through the local tasks it holds. */
export interface SelfWorker {
  /** `dsh-self/<profile>/<partition>`. */
  readonly id: string
  readonly profile: string | undefined
  readonly partition: string | undefined
  /** Its unfinished tasks. */
  readonly tasks: readonly TaskRow[]
  /** Unfinished tasks whose DSH has not reported for a while. */
  readonly quiet: number
}

/** Split `dsh-self/<profile>/<partition>`; anything else gives no parts. */
export function selfParts(id: string): { profile?: string; partition?: string } {
  const parts = id.split('/')
  if (parts[0] !== SELF_PREFIX) return {}
  return { profile: parts[1] === '' ? undefined : parts[1], partition: parts.slice(2).join('/') || undefined }
}

/** DSH's own workers that hold unfinished local tasks, by profile then partition. */
export function selfWorkers(tasks: readonly TaskRow[]): Map<string, SelfWorker[]> {
  const byId = new Map<string, TaskRow[]>()
  for (const task of tasks) {
    if (task.origin?.kind !== 'local' || laneOf(task) === 'ended') continue
    const id = task.origin.executor ?? task.assigned_to ?? SELF_PREFIX
    byId.set(id, [...(byId.get(id) ?? []), task])
  }
  const out = new Map<string, SelfWorker[]>()
  for (const [id, held] of [...byId.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const { profile, partition } = selfParts(id)
    const worker: SelfWorker = { id, profile: profile ?? held[0]?.dsh_profile, partition, tasks: held, quiet: held.filter(task => task.quiet === true).length }
    const key = worker.profile ?? ''
    out.set(key, [...(out.get(key) ?? []), worker])
  }
  return out
}

/** Why DSH ran a task itself, from its fallback history entry. */
export type FallbackReason = 'nobody-online' | 'waited-out' | 'other'

/** Tasks DSH took over (not the ones it registered as its own from the start). */
export function fallbackTasks(tasks: readonly TaskRow[]): TaskRow[] {
  return tasks.filter(task => task.origin?.kind !== 'local' && task.fallback_by !== undefined && task.fallback_by !== '')
}

/** Read the reason out of a `fallback` history message (the hub writes it in English). */
export function fallbackReason(history: readonly HistoryEvent[]): FallbackReason | undefined {
  const entry = [...history].reverse().find(event => event.event === 'fallback')
  if (entry === undefined) return undefined
  const text = entry.message ?? ''
  if (/no worker .*online/i.test(text)) return 'nobody-online'
  if (/nobody took it in time/i.test(text)) return 'waited-out'
  return 'other'
}

/**
 * Timeline of a task, newest first: every entry with something to say. A
 * `progress` entry without a stage or message (an old client's keep-alive)
 * is left out, and a run of plain steps with the same message keeps one.
 */
export function timeline(history: readonly HistoryEvent[]): HistoryEvent[] {
  const out: HistoryEvent[] = []
  for (const event of history) {
    const empty = (event.message === undefined || event.message === '') && event.stage === undefined
    if (event.event === 'progress' && empty) continue
    const last = out.at(-1)
    if (last !== undefined && event.event === 'progress' && last.event === 'progress' && event.stage === last.stage && event.message === last.message) continue
    out.push(event)
  }
  return out.reverse()
}

/** Stage of a task worth naming on its row. */
export function stageOf(task: Pick<TaskRow, 'stage' | 'status'>): TaskStage | undefined {
  if (task.status === 'completed' || task.status === 'cancelled') return undefined
  return task.stage
}
