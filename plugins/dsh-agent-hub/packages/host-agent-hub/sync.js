/**
 * This DSH on the cloud channel (dsh-hub as the one place every task lives).
 *
 *  1. Mirror: every task the local router (dsh-router-b, `ctx.hostRouter`)
 *     runs is registered on the hub as a task this DSH runs itself
 *     (`run_here`, origin `local`, executor `dsh-self/<profile>/<partition>`),
 *     and kept up to date: stage, a progress line, the worker's session log
 *     (prompts, answers, tool calls) and the final result. So a task started
 *     here is visible to every other DSH and to the cloud 作战室: no task is
 *     isolated on one machine.
 *  2. Stream: the hub's event stream (`/v1/ctl/events`, long poll) is turned
 *     into short 【进度提醒】 lines in this DSH's 作战室 (through
 *     `hostRouter.notice`), for tasks this DSH did not run itself.
 *
 * Offline: the mirror compares the router's board with what the hub last
 * accepted (kept in <DSH home>/agent-hub/sync-<profile>.json). Whatever could
 * not be sent stays "not yet sent" and goes out on the next pass once the hub
 * is reachable again: the latest stage, every session entry not yet uploaded,
 * and the result. Nothing is lost across a DSH restart either.
 *
 * @module host-agent-hub/sync
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Router states that are over, and how each one ends on the hub. */
const FINISHED = { done: 'completed', verified: 'completed', reported: 'completed', failed: 'failed', cancelled: 'cancelled' }
const ROLES = new Set(['user', 'assistant', 'tool', 'system', 'note'])
const TASK_ID_RE = /^[A-Za-z0-9_.-]{1,96}$/
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SESSION_BATCH = 200
const TEXT_MAX = 20000

/** Hub task id of one local router row: deterministic, so a restart never registers it twice. */
export function hubTaskId(profile, rowId) {
  const clean = `local_${profile}_${rowId}`.replace(/[^A-Za-z0-9_.-]/g, '-')
  return clean.length <= 96 ? clean : `${clean.slice(0, 80)}_${hash(clean)}`
}

function hash(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0
  return h.toString(36)
}

/** The stage a router row is at, as the hub names stages. */
export function stageOf(row) {
  switch (row.state) {
    case 'queued': return 'received'
    case 'dispatched': return 'started'
    case 'running': case 'interrupted': return 'step'
    case 'blocked': case 'suspended': return 'blocked'
    default: return undefined
  }
}

/** One line on what a row is doing now (todo step, last tool, why it waits). */
export function lineOf(row) {
  if (row.state === 'blocked') return `等你处理：${row.resumeNote ?? '已暂停'}`
  if (row.state === 'suspended') return `等待前置任务：${(row.waitingOn ?? []).join('、') || row.suspendReason || ''}`
  if (row.state === 'queued') return (row.waitingFor?.length ?? 0) > 0 ? `排队，等 ${row.waitingFor.join('、')}` : '排队中'
  if (row.state === 'interrupted') return '重启后接着做'
  const todo = row.todos?.current ? `${row.todos.ratio ?? ''} ${row.todos.current}`.trim() : undefined
  const tool = row.activity?.lastTool ? `正在用 ${row.activity.lastTool}` : undefined
  return todo ?? tool ?? (row.state === 'dispatched' ? '已开始' : '进行中')
}

function textBlocks(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => {
    if (typeof block === 'string') return [block]
    if (block && typeof block === 'object' && typeof block.text === 'string') return [block.text]
    return []
  }).join('\n')
}

function preview(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

/** A DSH session log (sessionQuery.readSession events) -> hub session entries. */
export function sessionEntriesOf(events) {
  const out = []
  for (const event of events ?? []) {
    const data = event?.data ?? {}
    const at = typeof event?.time === 'number' ? new Date(event.time).toISOString() : undefined
    let entry
    if (event?.type === 'tool/call') {
      entry = { role: 'tool', name: typeof data.name === 'string' ? data.name : 'tool', text: `调用 ${preview(data.arguments ?? data.input)}` }
    } else if (event?.type === 'tool/result') {
      const body = textBlocks(data.output ?? data.content) || preview(data.output ?? data.result)
      entry = { role: 'tool', name: typeof data.name === 'string' ? data.name : 'result', text: body }
      if (data.isError === true || data.error !== undefined) entry.error = true
    } else if (event?.type === 'turn/end') {
      const kind = data?.reason?.kind
      entry = { role: 'note', text: `回合结束：${typeof kind === 'string' ? kind : 'unknown'}` }
    } else if (event?.type === 'assistant/attempt') {
      continue
    } else {
      const message = data.message ?? data
      const role = typeof message?.role === 'string' ? message.role
        : String(event?.type).startsWith('assistant/') ? 'assistant' : String(event?.type).startsWith('user/') ? 'user' : undefined
      if (!ROLES.has(role)) continue
      const text = textBlocks(message.content)
      if (text.trim() === '') continue
      entry = { role, text }
    }
    if (entry.text.length > TEXT_MAX) entry.text = `${entry.text.slice(0, TEXT_MAX)}\n[...]`
    if (at !== undefined) entry.at = at
    out.push(entry)
  }
  return out
}

/** Network trouble (retry later) as opposed to the hub refusing the call. */
export function isOffline(error) {
  if (error?.fromHub === true) return error.status >= 500
  return error?.status === undefined || error.status >= 500 || ['hub-unreachable', 'hub-timeout'].includes(error.code)
}

/** Hub stream event -> one 作战室 line, or undefined when it is not worth a line. */
export function noticeOf(event) {
  const who = event.agent && event.agent !== 'dsh-self' ? `（${event.agent}）` : ''
  const title = `「${event.title ?? event.task_id}」${who}`
  const msg = event.message ? `：${event.message}` : ''
  switch (event.kind) {
    case 'created': return `云端新任务 ${title}`
    case 'registered': return `${event.origin?.by ?? '另一台 DSH'} 在本地开始 ${title}`
    case 'leased': return `${title} 已被领取`
    case 'progress': {
      if (event.stage === 'blocked') return `${title} 卡住了${msg}`
      if (event.stage === 'needs_input') return `${title} 需要回答${msg}`
      if (event.stage === 'started') return `${title} 开始做了${msg}`
      return event.message ? `${title} 进度${msg}` : undefined
    }
    case 'completed': return `${title} 完成${msg}`
    case 'failed': return `${title} 失败${msg}`
    case 'cancelled': return `${title} 已取消`
    case 'needs_input': return `${title} 需要回答${msg}`
    case 'requeued': return `${title} 退回队列${msg}`
    default: return undefined
  }
}

/**
 * @param {object} deps
 * @param {object} deps.client               hub client (hub-client.js)
 * @param {() => object | undefined} deps.router   hostRouter service ({ snapshot, notice? })
 * @param {() => object | undefined} deps.sessions sessionQuery service ({ readSession })
 * @param {string} deps.profile              this DSH's profile name
 * @param {string} deps.stateFile            where the sync state is kept
 * @param {object} deps.logger
 * @param {object} [deps.options]            { mirror, notices, intervalMs, stepEveryMs, backfillHours, waitSeconds }
 */
export function createSync(deps) {
  const { client, logger } = deps
  const opts = { mirror: true, notices: true, intervalMs: 10_000, stepEveryMs: 30_000, backfillHours: 12, waitSeconds: 20, ...deps.options }
  const now = deps.now ?? (() => Date.now())
  const profile = PROFILE_RE.test(deps.profile ?? '') ? deps.profile : 'default'
  let state = { tasks: {}, cursor: undefined, startedAt: undefined }
  let loaded = false
  let stopped = false
  let mirrorBusy = false
  const lastStep = new Map() // hub task id -> ms of the last step notice / step event sent
  let offlineSince

  async function load() {
    if (loaded) return
    loaded = true
    try {
      const raw = JSON.parse(await readFile(deps.stateFile, 'utf8'))
      if (raw && typeof raw === 'object') state = { tasks: raw.tasks ?? {}, cursor: raw.cursor, startedAt: raw.startedAt }
    } catch { /* first run */ }
    state.startedAt ??= new Date(now()).toISOString()
  }

  async function save() {
    await mkdir(dirname(deps.stateFile), { recursive: true })
    const tmp = `${deps.stateFile}.tmp`
    await writeFile(tmp, JSON.stringify(state), 'utf8')
    await rename(tmp, deps.stateFile)
  }

  function wentOffline(error) {
    if (offlineSince === undefined) {
      offlineSince = now()
      logger.warn(`agent-hub sync: hub not reachable (${error?.code ?? error?.message ?? error}); keeping local changes until it is back`)
    }
  }

  function backOnline() {
    if (offlineSince !== undefined) {
      logger.info(`agent-hub sync: hub reachable again after ${Math.round((now() - offlineSince) / 1000)} s; sending what waited`)
      offlineSince = undefined
    }
  }

  /** Rows worth mirroring: anything not finished, and finished rows changed within backfillHours. */
  function wanted(row, known) {
    if (known !== undefined) return true
    if (FINISHED[row.state] === undefined) return true
    return now() - Date.parse(row.updatedAt ?? row.createdAt ?? 0) < opts.backfillHours * 3600_000
  }

  async function uploadSession(row, rec) {
    const reader = deps.sessions?.()
    if (row.sessionId === undefined || reader === undefined || typeof reader.readSession !== 'function') return
    let events
    try { events = (await reader.readSession(row.sessionId)).events } catch (error) {
      logger.debug?.(`agent-hub sync: session ${row.sessionId} not readable: ${error?.message ?? error}`)
      return
    }
    const entries = sessionEntriesOf(events)
    const sent = rec.session ?? 0
    for (let i = sent; i < entries.length; i += SESSION_BATCH) {
      await client.appendSession(rec.hubId, entries.slice(i, i + SESSION_BATCH))
      rec.session = Math.min(entries.length, i + SESSION_BATCH)
    }
  }

  /** Bring one row's hub task up to date. Throws on network trouble (the rest waits for the next pass). */
  async function syncRow(row) {
    const id = hubTaskId(profile, row.id)
    let rec = state.tasks[row.id]
    if (rec?.gone) return
    if (rec === undefined) {
      const parent = row.parentId === undefined ? undefined : state.tasks[row.parentId]?.hubId
      await client.registerLocal({
        task_id: id, title: String(row.subject ?? row.id).slice(0, 200) || row.id, instruction: String(row.subject ?? row.id),
        executor: `dsh-self/${profile}/${row.partition}`.slice(0, 120), dsh_profile: profile, parent_task_id: parent,
        context: { router_task: row.id, partition: row.partition, level: row.level },
      })
      rec = state.tasks[row.id] = { hubId: id, sent: 'registered', session: 0 }
    }
    if (rec.finished) return
    const final = FINISHED[row.state]
    const stage = stageOf(row)
    const line = lineOf(row)
    const key = `${row.state}|${line}`
    const changed = key !== rec.sent
    const stepDue = now() - (lastStep.get(id) ?? 0) >= opts.stepEveryMs
    if (final === undefined && changed && (stage !== 'step' || stepDue || rec.sentStage !== 'step')) {
      await client.fallbackEvent({ task_id: id, stage, message: line, progress: typeof row.progress === 'number' ? Math.min(1, Math.max(0, row.progress)) : undefined })
      rec.sent = key
      rec.sentStage = stage
      if (stage === 'step') lastStep.set(id, now())
    } else if (final === undefined) {
      await client.fallbackEvent({ task_id: id, renew: true })
    }
    if (final !== undefined || stepDue || changed) await uploadSession(row, rec)
    if (final === undefined) return
    if (final === 'cancelled') {
      await client.cancel(id, '本地已取消')
    } else {
      const summary = String(row.result ?? row.error ?? '').slice(0, 4000)
      await client.fallbackResult({
        task_id: id, status: final, summary,
        error: final === 'failed' ? { code: 'LOCAL_FAILED', message: String(row.error ?? '本地任务失败').slice(0, 1800), retryable: false } : undefined,
      })
    }
    rec.finished = true
  }

  /** One mirror pass over the router's board. */
  async function mirrorOnce() {
    if (mirrorBusy) return { skipped: true }
    mirrorBusy = true
    try {
      await load()
      const router = deps.router?.()
      if (router === undefined || typeof router.snapshot !== 'function') return { rows: 0 }
      const snap = await router.snapshot()
      let synced = 0
      for (const row of snap?.tasks ?? []) {
        if (typeof row?.id !== 'string' || !wanted(row, state.tasks[row.id])) continue
        try {
          await syncRow(row)
          synced++
        } catch (error) {
          if (isOffline(error)) { wentOffline(error); break }
          // The hub refused this row (e.g. task gone, not ours): stop mirroring it, keep the others going.
          logger.warn(`agent-hub sync: ${row.id} not mirrored (${error?.code ?? 'error'}: ${error?.message ?? error})`)
          state.tasks[row.id] = { ...(state.tasks[row.id] ?? { hubId: hubTaskId(profile, row.id) }), gone: true }
        }
      }
      if (offlineSince !== undefined && synced > 0) backOnline()
      // Forget rows the board no longer has once they are finished on the hub.
      const live = new Set((snap?.tasks ?? []).map(row => row.id))
      for (const [rowId, rec] of Object.entries(state.tasks)) if (!live.has(rowId) && (rec.finished || rec.gone)) delete state.tasks[rowId]
      await save()
      return { rows: synced }
    } finally {
      mirrorBusy = false
    }
  }

  /** One read of the event stream; turns new events into 作战室 lines. */
  async function streamOnce(wait = opts.waitSeconds) {
    await load()
    if (state.cursor === undefined) {
      const head = await client.events({ after: 0, wait: 0, limit: 1 })
      state.cursor = head.latest ?? 0
      await save()
      return { lines: [] }
    }
    const out = await client.events({ after: state.cursor, wait })
    backOnline()
    if (out.reset) {
      state.cursor = out.latest ?? 0
      await save()
      return { lines: [] }
    }
    const lines = []
    for (const event of out.events ?? []) {
      if (event.origin?.kind === 'local' && event.origin?.by === client.config?.controllerId) continue // our own mirror
      if (event.kind === 'progress' && (event.stage === 'step' || event.stage === undefined)) {
        const last = lastStep.get(`stream:${event.task_id}`) ?? 0
        if (now() - last < opts.stepEveryMs) continue
        lastStep.set(`stream:${event.task_id}`, now())
      }
      const line = noticeOf(event)
      if (line !== undefined) lines.push(line)
    }
    state.cursor = out.next ?? state.cursor
    await save()
    const router = deps.router?.()
    for (const line of lines) {
      if (router !== undefined && typeof router.notice === 'function') router.notice(line)
      else logger.info(`agent-hub: ${line}`)
    }
    return { lines }
  }

  async function loop(name, body, pause) {
    while (!stopped) {
      try {
        await body()
        await sleep(pause())
      } catch (error) {
        if (isOffline(error)) wentOffline(error)
        else logger.warn(`agent-hub sync: ${name}: ${error?.code ?? 'error'}: ${error?.message ?? error}`)
        await sleep(Math.min(60_000, Math.max(5_000, opts.intervalMs)))
      }
    }
  }

  function sleep(ms) {
    if (ms <= 0 || stopped) return Promise.resolve()
    return new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.() })
  }

  return {
    mirrorOnce,
    streamOnce,
    get state() { return state },
    /** Start both loops; returns a stop function. */
    start() {
      stopped = false
      if (opts.mirror) void loop('mirror', mirrorOnce, () => opts.intervalMs)
      if (opts.notices) void loop('stream', () => streamOnce(), () => 0)
      return () => { stopped = true }
    },
  }
}
