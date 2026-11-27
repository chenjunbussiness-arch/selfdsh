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
 *  2. Stream: this DSH's mail on the hub's event stream (`/v1/ctl/events?inbox=mine`,
 *     long poll: the tasks it published, from this profile) is turned into
 *     【进度提醒】 lines in its 作战室 (through `hostRouter.notice`). Another DSH's tasks
 *     never show here (`watchAll: true` for an observer that wants the whole hub).
 *     The end of a run (completed / failed / a question) goes out whole, once per
 *     task and attempt; a task nobody took comes back here to decide (fallback_due).
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
/** How long a mirrored row may be missing from the board before its hub task is closed. */
const ORPHAN_MS = 10 * 60_000
/** How many tasks' last 作战室 line are remembered (so a repeat is never announced twice). */
const SAID_MAX = 300

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
      // Compaction re-surfaces older results (surfaceOp other than append): history, not new output.
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue
      // DSH 0.2.2 keeps the result under data.message ({ toolCallId, toolName, content, isError }).
      const message = data.message && typeof data.message === 'object' ? data.message : data
      const body = textBlocks(message.content ?? message.output) || preview(message.output ?? message.result ?? data.error)
      const name = typeof message.toolName === 'string' ? message.toolName : typeof data.name === 'string' ? data.name : 'result'
      entry = { role: 'tool', name, text: body }
      if (message.isError === true || data.error !== undefined) entry.error = true
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

/** First non-empty line of a text, at most `max` characters. */
function oneLine(text, max) {
  const line = String(text ?? '').split(/\r?\n/).map(part => part.trim()).find(part => part !== '') ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * Whether a hub stream event is about a task this DSH mirrored itself. The
 * hub's feed carries `origin` as a kind string ('local' / 'controller') plus
 * `created_by` and `dsh_profile`; older builds sent an object.
 */
export function isOwnMirror(event, controllerId, profile) {
  const kind = typeof event.origin === 'string' ? event.origin : event.origin?.kind
  if (kind !== 'local') return false
  const by = event.created_by ?? event.origin?.by
  if (by !== controllerId) return false
  return event.dsh_profile === undefined || event.dsh_profile === profile
}

/** Hub stream event -> one 作战室 line, or undefined when it is not worth a line. */
export function noticeOf(event) {
  const who = event.agent && event.agent !== 'dsh-self' ? `（${event.agent}）` : ''
  const title = `「${oneLine(event.title ?? event.task_id, 60)}」${who}`
  const said = oneLine(String(event.message ?? '').split(/^--- report ---$/m)[0], 120)
  const msg = said ? `：${said}` : ''
  const where = event.dsh_profile ? `${event.created_by ?? 'DSH'}（${event.dsh_profile}）` : event.created_by ?? event.origin?.by ?? '另一台 DSH'
  if (event.kind === 'quota') return `额度提醒${msg}`
  const pipe = event.pipeline
  // One stage of a pipeline: one line when it is done; the pipeline itself asks when one fails.
  if (pipe?.parent !== undefined) {
    const stage = `流水线 ${pipe.parent} 的「${oneLine(pipe.label ?? pipe.stage, 20)}」段${pipe.round > 1 ? `（第 ${pipe.round} 轮）` : ''}`
    if (event.kind === 'completed') return `${stage}完成${who}${msg}`
    if (event.kind === 'created' || event.kind === 'failed' || event.kind === 'cancelled') return undefined
  } else if (pipe?.name !== undefined) {
    const ptitle = `流水线「${oneLine(event.title ?? event.task_id, 60)}」`
    if (event.kind === 'created') return `${ptitle}开始${msg}`
    if (event.kind === 'bounced') return `${ptitle}退回重做${msg}`
    if (event.kind === 'cancelled') return `${ptitle}已停止`
  }
  switch (event.kind) {
    case 'created': return `云端新任务 ${title}`
    case 'registered': return `${where} 在本地开始 ${title}`
    case 'leased': return `${title} 已被领取`
    case 'progress': {
      if (event.stage === 'blocked') return `${title} 卡住了${msg}`
      if (event.stage === 'needs_input') return `${title} 需要回答${msg}（回答：task_answer ${event.task_id}）`
      if (event.stage === 'started') return `${title} 开始做了${msg}`
      // An older client re-sends "working" to keep its lease: that is not news.
      if (!event.message || /^working$/i.test(String(event.message).trim())) return undefined
      return `${title} 进度${msg}`
    }
    case 'completed': return `${title} 完成${msg}`
    // A worker that handed the task back with a question (needs_input / partial) ends as
    // failed on the hub; to the 作战室 that is a question, not a failure.
    case 'failed': return event.stage === 'needs_input' ? `${title} 需要回答${msg}` : `${title} 失败${msg}`
    case 'cancelled': return `${title} 已取消`
    case 'needs_input': return `${title} 需要回答${msg}`
    // Handed back with a question: it waits on the user; the answer goes back to the same worker.
    case 'waiting_input': return `${title} 需要回答${msg}（回答：task_answer ${event.task_id}）`
    case 'answered': return `${title} 已把回答交回 worker`
    // Past its due time (hub.json due / due_minutes): the user decides, unless the hub already reassigned it.
    case 'overdue': {
      const m = /(\d+) min since it was published, due after (\d+) min/.exec(String(event.message ?? ''))
      const late = m ? `（已 ${m[1]} 分钟，期限 ${m[2]} 分钟）` : msg
      return /taken from/.test(String(event.message))
        ? `${title} 超时${late}，已从原来的 worker 收回改派给别人`
        : `${title} 超时${late}，需要你决定：继续等、改派（task_retry 或 task_dispatch 带 replaces）还是取消（task_cancel）`
    }
    // The hub took it back from its worker because it ran past its due time (on_overdue: reassign).
    case 'requeued': return /^overdue/.test(String(event.message ?? ''))
      ? `${title} 超时，已从原来的 worker 收回，重新排队给别的 worker`
      : `${title} 退回队列${msg}`
    // Nobody took it: it is back with the DSH that published it (this one).
    case 'fallback_due': return `${title} 没人接（${/no worker/.test(String(event.message)) ? '能接的 worker 都不在线' : '能接的 worker 都忙'}），需要你决定：自己做（fallback_take）、改派（task_dispatch 带 replaces）还是取消`
    default: return undefined
  }
}

/** A line that waits on the user (a question, or a decision): later news in the same read must not hide it. */
const ASKS = /需要你决定|需要回答/
/** Events that settle such a line: once one of them follows, the question or decision is gone. */
const SETTLES = new Set(['answered', 'completed', 'failed', 'cancelled', 'waiting_input', 'needs_input'])

/** Kinds that end a run: the publisher gets the whole result once per (task, attempt). */
const FINAL_KINDS = new Set(['completed', 'failed', 'needs_input', 'waiting_input'])

/** Text flattened to one line (a 作战室 notice is one line per item), at most `max` characters. */
function flat(text, max) {
  const line = String(text ?? '').replace(/\s*\r?\n\s*/g, ' / ').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * The full result of one run, as the one line the publisher's 作战室 gets: what came out
 * (summary, or the question, or why it failed), the files, which attempt it was and
 * where to read the rest. `task` is the hub's task (`getTask`).
 */
export function resultLineOf(task, event = {}) {
  const pipeline = task.pipeline !== undefined && task.pipeline !== null
  const who = !pipeline && task.agent && task.agent !== 'dsh-self' ? `（${task.result?.agent ?? task.assigned_to ?? task.agent}）` : ''
  const title = `${pipeline ? '流水线' : ''}「${oneLine(task.title ?? task.task_id, 60)}」${who}`
  const r = { ...(task.result ?? {}) }
  // The worker's closing block (--- report --- summary / touched / left) is part of the result: keep it, drop the marker.
  if (typeof r.summary === 'string') r.summary = r.summary.replace(/^--- report ---$/m, '')
  const attempt = event.attempt ?? task.attempts
  const tail = `（${attempt > 1 ? `第 ${attempt} 次；` : ''}全文：task_get ${task.task_id}）`
  const files = (r.outputs ?? []).map(o => o?.name).filter(Boolean)
  const out = files.length > 0 ? `；产出 ${files.slice(0, 5).join('、')}${files.length > 5 ? ` 等 ${files.length} 个` : ''}` : ''
  if (r.needs_input !== undefined && r.needs_input !== null) {
    // A hub with the answer loop keeps the task open (waiting_input): answer it, do not re-dispatch.
    const how = task.status === 'waiting_input' ? `（回答：task_answer ${task.task_id}；全文：task_get ${task.task_id}）` : tail
    return `${title} 需要回答：${flat(r.needs_input, 600)}${how}`
  }
  // A summary that ends a sentence (。) and then "；产出" reads twice-stopped; drop the full stop.
  const said = text => (out === '' ? text : text.replace(/[。．.]$/, ''))
  if (task.status === 'completed') return `${title} 完成：${said(flat(r.summary, 800)) || '（没写总结）'}${out}${tail}`
  const why = r.error?.message || r.summary || event.message || ''
  return `${title} 失败：${said(flat(why, 600)) || '（没写原因）'}${out}${tail}`
}

/**
 * Whether a hub event / task is this DSH's mail: it published the task (its controller,
 * and its profile when the task says one), or it runs the task for its publisher and the
 * task was cancelled. A hub that already filters by inbox sends nothing else; an older
 * hub sends everything, so this check stays.
 */
export function isMine(item, controllerId, profile) {
  if (item.created_by === controllerId && (item.reply_to === undefined || item.reply_to === null || item.reply_to === profile)) return true
  return item.held_by === controllerId && item.kind === 'cancelled'
}

/**
 * @param {object} deps
 * @param {object} deps.client               hub client (hub-client.js)
 * @param {() => object | undefined} deps.router   hostRouter service ({ snapshot, notice? })
 * @param {() => object | undefined} deps.sessions sessionQuery service ({ readSession })
 * @param {string} deps.profile              this DSH's profile name
 * @param {string} deps.stateFile            where the sync state is kept
 * @param {object} deps.logger
 * @param {object} [deps.options]            { mirror, notices, watchAll, intervalMs, stepEveryMs, backfillHours, waitSeconds, stallMinutes, stallCheckMs }
 */
export function createSync(deps) {
  const { client, logger } = deps
  const opts = { mirror: true, notices: true, watchAll: false, intervalMs: 10_000, stepEveryMs: 30_000, backfillHours: 12, waitSeconds: 20, stallMinutes: 20, stallCheckMs: 120_000, ...deps.options }
  const now = deps.now ?? (() => Date.now())
  const profile = PROFILE_RE.test(deps.profile ?? '') ? deps.profile : 'default'
  let state = { tasks: {}, cursor: undefined, startedAt: undefined, said: {}, stalled: {}, delivered: {} }
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
      if (raw && typeof raw === 'object') state = { tasks: raw.tasks ?? {}, cursor: raw.cursor, startedAt: raw.startedAt, said: raw.said ?? {}, stalled: raw.stalled ?? {}, delivered: raw.delivered ?? {} }
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
        executor: `dsh-self/${profile}/${row.partition}`.slice(0, 120), dsh_profile: profile, reply_to: profile, parent_task_id: parent,
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
      const live = new Set((snap?.tasks ?? []).map(row => row.id))
      // A row the board lost while it was still open (board reset, profile moved) would stay
      // "进行中" on the hub for ever, with nobody able to clear it. Once it has been missing
      // for ORPHAN_MS, close it there. An empty board is never trusted (it may still be loading).
      if (live.size > 0 && offlineSince === undefined) {
        for (const [rowId, rec] of Object.entries(state.tasks)) {
          if (live.has(rowId) || rec.finished || rec.gone) { delete rec.missingSince; continue }
          rec.missingSince ??= now()
          if (now() - rec.missingSince < ORPHAN_MS) continue
          try {
            await client.cancel(rec.hubId, '本机已没有这个任务')
            rec.finished = true
          } catch (error) {
            if (isOffline(error)) { wentOffline(error); break }
            rec.gone = true
          }
        }
      }
      // Forget rows the board no longer has once they are finished on the hub.
      for (const [rowId, rec] of Object.entries(state.tasks)) if (!live.has(rowId) && (rec.finished || rec.gone)) delete state.tasks[rowId]
      await save()
      return { rows: synced }
    } finally {
      mirrorBusy = false
    }
  }

  /** One read of the event stream; turns new events into 作战室 lines. */
  /** This DSH's mail only, unless it watches the whole hub (`watchAll`, an observer). */
  const controllerId = () => client.config?.controllerId
  const mine = item => opts.watchAll === true || isMine(item, controllerId(), profile)
  const inbox = () => (opts.watchAll === true ? {} : { inbox: 'mine', profile })

  async function streamOnce(wait = opts.waitSeconds) {
    await load()
    if (state.cursor === undefined) {
      const head = await client.events({ after: 0, wait: 0, limit: 1 })
      state.cursor = head.latest ?? 0
      await save()
      return { lines: [] }
    }
    const out = await client.events({ after: state.cursor, wait, ...inbox() })
    backOnline()
    if (out.reset) {
      state.cursor = out.latest ?? 0
      await save()
      return { lines: [] }
    }
    // One line per task per read: its latest news. A line the 作战室 already got for
    // that task (the same words) is not sent again, also across a restart.
    const latest = new Map()
    const asks = new Map() // task id -> a question / decision line still open after later news
    const finals = new Map() // task id -> the event that ended its run
    for (const event of out.events ?? []) {
      if (isOwnMirror(event, client.config?.controllerId, profile)) continue // our own mirror
      if (!mine(event)) continue // another DSH's mail
      if (event.kind === 'progress' && (event.stage === 'step' || event.stage === undefined)) {
        const last = lastStep.get(`stream:${event.task_id}`) ?? 0
        if (now() - last < opts.stepEveryMs) continue
      }
      const line = noticeOf(event)
      if (line === undefined) continue
      if (event.kind === 'progress' && (event.stage === 'step' || event.stage === undefined)) lastStep.set(`stream:${event.task_id}`, now())
      if (SETTLES.has(event.kind)) asks.delete(event.task_id)
      if (ASKS.test(line)) asks.set(event.task_id, line)
      latest.delete(event.task_id) // keep the map in event order
      latest.set(event.task_id, line)
      // A pipeline stage that finished is one line; the pipeline's own end goes out whole.
      if (FINAL_KINDS.has(event.kind) && (event.pipeline?.parent === undefined || event.kind === 'waiting_input')) finals.set(event.task_id, event)
      else finals.delete(event.task_id)
    }
    // The end of a run goes out whole (summary / question / reason, files), once per
    // task and attempt, so the 作战室 never has to go and look, and never hears it twice.
    for (const [taskId, event] of finals) {
      // A question handed back does not count an attempt, so each one is its own event.
      const key = event.kind === 'waiting_input' ? `${taskId}#q${event.seq ?? 0}` : `${taskId}#${event.attempt ?? 0}`
      if (state.delivered[key] !== undefined) { latest.delete(taskId); continue }
      try {
        const task = await client.getTask(taskId)
        latest.set(taskId, resultLineOf(task, event))
      } catch (error) {
        if (isOffline(error)) throw error // the cursor stays: read again once the hub is back
      }
      state.delivered[key] = new Date(now()).toISOString()
    }
    const keys = Object.keys(state.delivered)
    if (keys.length > SAID_MAX) {
      keys.sort((a, b) => String(state.delivered[a]).localeCompare(String(state.delivered[b])))
      for (const key of keys.slice(0, keys.length - SAID_MAX)) delete state.delivered[key]
    }
    const lines = []
    const shown = []
    for (const [taskId, line] of latest) {
      // A question or decision that later news in this read would have hidden goes first
      // (unless the run's end line already carries it).
      const ask = asks.get(taskId)
      if (ask !== undefined && ask !== line && !finals.has(taskId) && state.said[`${taskId}#ask`]?.line !== ask) {
        state.said[`${taskId}#ask`] = { line: ask, at: new Date(now()).toISOString() }
        lines.push(ask)
        shown.push(taskId)
      }
      if (state.said[taskId]?.line === line) continue
      state.said[taskId] = { line, at: new Date(now()).toISOString() }
      lines.push(line)
      if ((finals.has(taskId) || ASKS.test(line)) && !shown.includes(taskId)) shown.push(taskId)
    }
    const ids = Object.keys(state.said)
    if (ids.length > SAID_MAX) {
      ids.sort((a, b) => String(state.said[a].at).localeCompare(String(state.said[b].at)))
      for (const id of ids.slice(0, ids.length - SAID_MAX)) delete state.said[id]
    }
    state.cursor = out.next ?? state.cursor
    await save()
    const router = deps.router?.()
    for (const line of lines) {
      if (router !== undefined && typeof router.notice === 'function') router.notice(line)
      else logger.info(`agent-hub: ${line}`)
    }
    // Tell the hub the result / question reached this 作战室 (the timeline's `delivered`).
    // Best effort: an older hub has no such route, and a miss never holds the stream up.
    if (shown.length > 0 && typeof client.delivered === 'function' && router !== undefined && typeof router.notice === 'function') {
      try { await client.delivered(shown.slice(0, 100), profile) } catch (error) { if (!isOffline(error) && error?.status !== 404) logger.warn(`agent-hub sync: delivered: ${error?.code ?? 'error'}: ${error?.message ?? error}`) }
    }
    return { lines }
  }

  /**
   * Cloud tasks that went quiet: leased or running, no news (progress, stage or
   * session upload) for `stallMinutes`. A keep-alive renews the lease but is no
   * news, so a worker stuck in a loop used to sit "进行中" for hours in silence.
   * One 作战室 line per silence (「没有动静」), which it puts to the human; the task
   * has to move again before it is reported a second time. Tasks a DSH runs itself
   * are left to that DSH's router, which watches its own workers' logs.
   */
  async function stallOnce() {
    const limitMs = opts.stallMinutes * 60_000
    if (!(limitMs > 0)) return { lines: [] }
    await load()
    const rows = await client.listTasks({ limit: 200 })
    const lines = []
    const active = new Set()
    for (const row of rows ?? []) {
      if (row?.status !== 'accepted' && row?.status !== 'running') continue
      const kind = typeof row.origin === 'string' ? row.origin : row.origin?.kind
      if (kind === 'local' || kind === 'pipeline') continue // a pipeline is as quiet as its stages: they are checked
      if (!mine(row)) continue // someone else's task: their DSH tells them
      active.add(row.task_id)
      if (row.stage === 'blocked' || row.stage === 'needs_input') continue // already a question
      const last = [row.updated_at, row.session_updated_at].map(at => Date.parse(at ?? '')).filter(Number.isFinite)
      if (last.length === 0) continue
      const at = Math.max(...last)
      if (now() - at < limitMs) continue
      const mark = new Date(at).toISOString()
      if (state.stalled[row.task_id] === mark) continue
      state.stalled[row.task_id] = mark
      const who = row.agent && row.agent !== 'dsh-self' ? `（${row.agent}）` : ''
      lines.push(`「${oneLine(row.title ?? row.task_id, 60)}」${who} 没有动静：已经 ${Math.max(1, Math.floor((now() - at) / 60_000))} 分钟没有新进展`)
    }
    for (const id of Object.keys(state.stalled)) if (!active.has(id)) delete state.stalled[id]
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
    stallOnce,
    get state() { return state },
    /** Start both loops; returns a stop function. */
    start() {
      stopped = false
      if (opts.mirror) void loop('mirror', mirrorOnce, () => opts.intervalMs)
      if (opts.notices) void loop('stream', () => streamOnce(), () => 0)
      if (opts.notices && opts.stallMinutes > 0) void loop('stall', stallOnce, () => opts.stallCheckMs)
      return () => { stopped = true }
    },
  }
}
