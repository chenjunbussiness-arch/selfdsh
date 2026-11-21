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

import { isDead, isFinished } from './board.ts'
import type { RouterTask } from './board.ts'

/** Whether one row may start now. */
export type Gate =
  | { readonly kind: 'ready' }
  /** Waiting on these still-open rows. */
  | { readonly kind: 'wait'; readonly on: readonly string[] }
  /** A prerequisite failed, was cancelled, or does not exist: needs a human. */
  | { readonly kind: 'dead'; readonly on: readonly string[]; readonly reason: string }

/** The row ids that must finish before `task` may start, explicit and stage-derived. */
export function prerequisitesOf(task: RouterTask, all: readonly RouterTask[]): readonly string[] {
  const ids = new Set(task.dependsOn ?? [])
  if (task.stage !== undefined && task.parentId !== undefined) {
    for (const other of all) {
      if (other.id === task.id || other.parentId !== task.parentId) continue
      if (other.stage !== undefined && other.stage < task.stage) ids.add(other.id)
    }
  }
  ids.delete(task.id)
  return [...ids]
}

/**
 * Decide whether `task` may start.
 * @param task - the row to check (normally `queued`).
 * @param all - every row on the board.
 */
export function gateOf(task: RouterTask, all: readonly RouterTask[]): Gate {
  return gateOfIds(prerequisitesOf(task, all), all)
}

/** Gate on an explicit list of prerequisite ids. */
export function gateOfIds(ids: readonly string[], all: readonly RouterTask[]): Gate {
  const byId = new Map(all.map(row => [row.id, row]))
  const waiting: string[] = []
  const dead: string[] = []
  const reasons: string[] = []
  for (const id of ids) {
    const row = byId.get(id)
    if (row === undefined) {
      dead.push(id)
      reasons.push(`${id} 不存在`)
      continue
    }
    if (isFinished(row.state)) continue
    if (isDead(row.state)) {
      dead.push(id)
      reasons.push(`${id}（${row.subject}）${row.state === 'failed' ? '失败' : '已取消'}`)
      continue
    }
    waiting.push(id)
  }
  if (dead.length > 0) return { kind: 'dead', on: dead, reason: `前置任务 ${reasons.join('、')}` }
  if (waiting.length > 0) return { kind: 'wait', on: waiting }
  return { kind: 'ready' }
}

/**
 * Which rows a suspended row is still waiting for.
 * @returns `ready` when every `waitingOn` row is finished.
 */
export function suspendGateOf(task: RouterTask, all: readonly RouterTask[]): Gate {
  return gateOfIds(task.waitingOn ?? [], all)
}

/**
 * Validate the prerequisites a new row asks for.
 * @returns an error sentence, or undefined when they are acceptable.
 */
export function dependencyError(dependsOn: readonly string[] | undefined, all: readonly RouterTask[]): string | undefined {
  if (dependsOn === undefined || dependsOn.length === 0) return undefined
  const known = new Set(all.map(row => row.id))
  const missing = dependsOn.filter(id => !known.has(id))
  if (missing.length > 0) {
    return `depends_on names unknown task id(s): ${missing.join(', ')}. Use the ids route_task returned.`
  }
  return undefined
}

/** One request's family: its root row and every row under it. */
export interface GroupProgress {
  readonly rootId: string
  readonly subject: string
  readonly total: number
  readonly finished: number
  readonly running: number
  /** Queued rows that are held back by an unfinished prerequisite. */
  readonly waiting: number
  readonly suspended: number
  readonly failed: number
  /** Every row is in a final state (finished, failed, cancelled). */
  readonly complete: boolean
}

/** Root ancestor of one row (itself when it has no parent on the board). */
export function rootOf(task: RouterTask, byId: ReadonlyMap<string, RouterTask>): RouterTask {
  let current = task
  const seen = new Set<string>()
  while (current.parentId !== undefined && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = byId.get(current.parentId)
    if (parent === undefined) break
    current = parent
  }
  return current
}

/**
 * Roll rows up by request: one entry per root row, counting the root's
 * descendants (workers) rather than the root itself when it has any, because
 * "3/6 done" is what a person means by progress.
 */
export function groupProgress(all: readonly RouterTask[]): readonly GroupProgress[] {
  const byId = new Map(all.map(row => [row.id, row]))
  const families = new Map<string, RouterTask[]>()
  for (const row of all) {
    const root = rootOf(row, byId)
    const list = families.get(root.id) ?? []
    list.push(row)
    families.set(root.id, list)
  }
  const out: GroupProgress[] = []
  for (const [rootId, rows] of families) {
    const root = byId.get(rootId)!
    const members = rows.length > 1 ? rows.filter(row => row.id !== rootId) : rows
    const count = (test: (row: RouterTask) => boolean): number => members.filter(test).length
    const finished = count(row => isFinished(row.state))
    const failed = count(row => isDead(row.state))
    const waiting = count(row => row.state === 'queued' && gateOf(row, all).kind !== 'ready')
    out.push({
      rootId,
      subject: root.subject,
      total: members.length,
      finished,
      running: count(row => row.state === 'running' || row.state === 'dispatched' || row.state === 'interrupted'),
      waiting,
      suspended: count(row => row.state === 'suspended'),
      failed,
      complete: members.every(row => isFinished(row.state) || isDead(row.state)),
    })
  }
  return out
}

/** One line for a person: `3/6 完成，1 个运行中，2 个等前置`. */
export function progressLine(group: GroupProgress): string {
  const parts = [`${String(group.finished)}/${String(group.total)} 完成`]
  if (group.running > 0) parts.push(`${String(group.running)} 个进行中`)
  if (group.waiting > 0) parts.push(`${String(group.waiting)} 个等前置`)
  if (group.suspended > 0) parts.push(`${String(group.suspended)} 个挂起`)
  if (group.failed > 0) parts.push(`${String(group.failed)} 个失败/取消`)
  return parts.join('，')
}
