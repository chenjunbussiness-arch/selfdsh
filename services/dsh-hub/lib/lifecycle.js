/**
 * One task lifecycle for every task the hub knows, wherever it runs (a cloud worker,
 * a scheduled puller, DSH itself as the fallback, or a DSH's own partition worker
 * mirrored here as a `local` task): the phase it is in, its timeline (who did what,
 * when, how long each phase took) and the numbers over many tasks.
 *
 * Pure functions over the stored task records, so the hub, its tests and the archive
 * reader share them.
 *
 * Phases (the one vocabulary the 作战室, the 调度台 and the metrics use):
 *
 *   queued         waiting for a worker (pending)
 *   claimed        a worker leased it, no report yet (accepted)
 *   running        a worker reports progress
 *   waiting_input  a question waits on the human (a worker asked, or gave the task back with a question)
 *   blocked        the worker says it is stuck on something else
 *   completed | failed | cancelled   the end (`dead` = failed with retries exhausted)
 *
 * Around the phases, three markers that do not change it: `delivered` (the publishing
 * DSH put the result in front of its 作战室), `acknowledged` (someone put it away) and
 * `overdue` (past its due time).
 *
 * @module dsh-hub/lifecycle
 */

export const PHASES = Object.freeze(['queued', 'claimed', 'running', 'waiting_input', 'blocked', 'completed', 'failed', 'cancelled'])
export const END_PHASES = new Set(['completed', 'failed', 'cancelled'])

/** The phase of a task as it stands now. */
export function phaseOf(task) {
  switch (task.status) {
    case 'pending': return 'queued'
    case 'waiting_input': return 'waiting_input'
    case 'accepted': return task.question !== undefined ? 'waiting_input' : 'claimed'
    case 'running':
      if (task.question !== undefined || task.stage === 'needs_input') return 'waiting_input'
      return task.stage === 'blocked' ? 'blocked' : 'running'
    case 'completed': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'failed': case 'dead': return 'failed'
    default: return 'queued'
  }
}

/**
 * The phase after one history entry, for entries written before entries carried
 * their own `phase` (older state files and archives).
 */
export function phaseAfter(entry, previous) {
  if (typeof entry.phase === 'string') return entry.phase
  switch (entry.event) {
    case 'created': case 'requeued': case 'released': case 'retried': return 'queued'
    case 'sticky': return previous ?? 'queued'
    case 'accepted': return 'claimed'
    case 'registered': case 'reclaimed': case 'fallback': return 'running'
    case 'progress': return entry.stage === 'needs_input' ? 'waiting_input' : entry.stage === 'blocked' ? 'blocked' : 'running'
    case 'waiting_input': return 'waiting_input'
    case 'completed': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'failed': case 'dead': return entry.stage === 'needs_input' ? 'waiting_input' : 'failed'
    default: return previous ?? 'queued'
  }
}

/** Who did it, for entries written before entries carried `by`. */
function actorOf(entry, task) {
  if (typeof entry.by === 'string') return entry.by
  switch (entry.event) {
    case 'created': case 'registered': case 'retried': case 'cancelled': return task.created_by
    case 'accepted': {
      const m = /^leased by (\S+)/.exec(entry.message ?? '')
      return m?.[1] ?? 'hub'
    }
    default: return 'hub'
  }
}

const ms = (iso) => {
  const at = Date.parse(iso ?? '')
  return Number.isFinite(at) ? at : undefined
}

/**
 * The timeline of one task: every history entry with who did it, the phase it led to,
 * the time since the task was created and since the previous entry; and how long the
 * task spent in each phase (the last open phase counted up to `now`).
 * @param task - a stored task record (state.json or an archive line).
 * @param now - ms epoch.
 */
export function timelineOf(task, now = Date.now()) {
  const created = ms(task.created_at) ?? now
  const history = Array.isArray(task.history) ? task.history : []
  const events = []
  let phase
  let prevAt = created
  for (const entry of history) {
    const at = ms(entry.at) ?? prevAt
    phase = phaseAfter(entry, phase)
    events.push({
      at: entry.at, event: entry.event, phase, by: actorOf(entry, task),
      ...(entry.stage !== undefined ? { stage: entry.stage } : {}),
      ...(entry.message !== undefined ? { message: entry.message } : {}),
      elapsed_ms: Math.max(0, at - created), gap_ms: Math.max(0, at - prevAt),
    })
    prevAt = at
  }
  const spent = Object.fromEntries(PHASES.map(p => [p, 0]))
  const ended = END_PHASES.has(phaseOf(task))
  const endAt = ended ? (ms(task.result?.finished_at) ?? ms(history.at(-1)?.at) ?? now) : now
  // Markers (delivered, acknowledged, overdue, sticky ...) keep the phase; time is split
  // only where the phase changes, and an open phase runs up to now.
  let segPhase
  let segStart = created
  for (const e of events) {
    if (e.phase === segPhase) continue
    const at = ms(e.at) ?? segStart
    if (segPhase !== undefined && !END_PHASES.has(segPhase)) spent[segPhase] += Math.max(0, at - segStart)
    segPhase = e.phase
    segStart = at
  }
  if (segPhase !== undefined && !END_PHASES.has(segPhase)) spent[segPhase] += Math.max(0, endAt - segStart)
  return {
    phase: phaseOf(task),
    events,
    durations: {
      queue_ms: spent.queued,
      claim_ms: spent.claimed,
      // Held by a worker: claimed (a puller that reports nothing until its result) + running + blocked.
      run_ms: spent.claimed + spent.running + spent.blocked,
      waiting_ms: spent.waiting_input,
      total_ms: Math.max(0, endAt - created),
    },
    truncated: history.length >= 200,
  }
}

/** The p-th percentile (0..1) of a list of numbers, undefined when empty. */
export function percentile(values, p) {
  const list = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b)
  if (list.length === 0) return undefined
  const index = Math.min(list.length - 1, Math.max(0, Math.ceil(p * list.length) - 1))
  return list[index]
}

/** Which worker a task's numbers belong to: who ran it, or the DSH partition for a local task. */
export function workerOf(task) {
  if (task.origin?.kind === 'local') return task.origin.executor ?? task.result?.agent ?? 'dsh-self'
  return task.result?.agent ?? task.assignedTo ?? task.lastHolder ?? 'unassigned'
}

function summarize(tasks, now) {
  const rows = tasks.map(task => ({ task, t: timelineOf(task, now) }))
  const ended = rows.filter(r => END_PHASES.has(r.t.phase))
  const completed = ended.filter(r => r.t.phase === 'completed').length
  const failed = ended.filter(r => r.t.phase === 'failed').length
  const cancelled = ended.filter(r => r.t.phase === 'cancelled').length
  const asked = rows.filter(r => r.t.events.some(e => e.phase === 'waiting_input')).length
  const queue = rows.filter(r => r.t.events.some(e => e.phase !== 'queued')).map(r => r.t.durations.queue_ms)
  const run = ended.filter(r => r.t.phase === 'completed').map(r => r.t.durations.run_ms)
  const total = ended.map(r => r.t.durations.total_ms)
  const decided = completed + failed
  return {
    tasks: rows.length,
    open: rows.length - ended.length,
    completed, failed, cancelled,
    fail_rate: decided === 0 ? undefined : Math.round((failed / decided) * 1000) / 1000,
    asked_human: asked,
    ask_rate: rows.length === 0 ? undefined : Math.round((asked / rows.length) * 1000) / 1000,
    fallback: rows.filter(r => r.task.fallbackBy !== undefined && r.task.origin?.kind !== 'local').length,
    overdue: rows.filter(r => r.task.overdueAt !== undefined).length,
    retried: rows.filter(r => r.t.events.filter(e => e.event === 'accepted').length > 1 || r.t.events.some(e => e.event === 'retried')).length,
    queue_ms_p50: percentile(queue, 0.5), queue_ms_p90: percentile(queue, 0.9),
    run_ms_p50: percentile(run, 0.5), run_ms_p90: percentile(run, 0.9),
    total_ms_p50: percentile(total, 0.5), total_ms_p90: percentile(total, 0.9),
  }
}

/**
 * Numbers over the tasks created in the window, overall and per worker: how many,
 * how they ended, failure rate (failed / (completed + failed)), how many had to ask
 * the human, DSH fallbacks, overdue, retries, and p50 / p90 of the time spent
 * queued, running (completed tasks) and in total (ended tasks).
 * @param tasks - stored task records.
 * @param options.since - ms epoch; tasks created before it are left out.
 * @param options.now - ms epoch.
 */
export function metricsOf(tasks, { since = 0, now = Date.now() } = {}) {
  const inWindow = tasks.filter(t => (ms(t.created_at) ?? 0) >= since)
  const byWorker = new Map()
  for (const task of inWindow) {
    const key = workerOf(task)
    byWorker.set(key, [...(byWorker.get(key) ?? []), task])
  }
  const workers = [...byWorker.entries()]
    .map(([worker, list]) => ({ worker, ...summarize(list, now) }))
    .sort((a, b) => b.tasks - a.tasks || a.worker.localeCompare(b.worker))
  return { since: new Date(since).toISOString(), until: new Date(now).toISOString(), total: summarize(inWindow, now), workers }
}
