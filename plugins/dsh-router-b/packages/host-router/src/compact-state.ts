/**
 * 【作战室状态】: what is still open, re-posted to the 作战室 after its history is compacted.
 *
 * DSH condenses an old span of the conversation into one summary once the context grows
 * past its threshold (`@deepseek-ai/dsh-compaction-basic`, `thresholdRatio`). The summary
 * is written by a model and can drop a task that is still running or a question that is
 * still waiting on the human. The router knows both for certain: its board, and the
 * 【进度提醒】 lines that asked the human something and have not been closed since. After
 * every compaction of the anchor session it injects one short message listing them, so the
 * 作战室 carries on from facts rather than from the summary's recollection.
 */

import { isOpen, type RouterTask, type TaskState } from './board.ts'
import { closesSubject, isAskLine, noticeSubject, type NoticeMessage } from './notices.ts'

/** First line of the state message. */
export const STATE_HEAD = '【作战室状态】'

/** How long an unanswered question stays on the list. */
export const ASK_TTL_MS = 48 * 60 * 60 * 1000

/** Most rows and questions each section lists; the rest are counted. */
export const STATE_MAX_LINES = 15

const STATE_LABEL: Partial<Record<TaskState, string>> = {
  queued: '排队中',
  dispatched: '已派出',
  running: '进行中',
  interrupted: '重启后待恢复',
  suspended: '挂起等前置',
  blocked: '等你决定',
}

/**
 * Questions put to the human through 【进度提醒】 that nothing has closed yet: the latest
 * ask line per subject, dropped when a later line says that subject finished or was
 * cancelled, or after {@link ASK_TTL_MS}. Kept in memory: a restart starts it empty.
 */
export class OpenAsks {
  private readonly bySubject = new Map<string, { readonly line: string; readonly at: number }>()

  /** Feed every notice line, in the order they were posted. */
  note(line: string, now = Date.now()): void {
    const subject = noticeSubject(line)
    if (isAskLine(line)) {
      this.bySubject.delete(subject)
      this.bySubject.set(subject, { line, at: now })
    } else if (closesSubject(line)) {
      this.bySubject.delete(subject)
    }
  }

  /** The open questions, oldest first. */
  list(now = Date.now()): string[] {
    for (const [subject, ask] of this.bySubject) if (now - ask.at > ASK_TTL_MS) this.bySubject.delete(subject)
    return [...this.bySubject.values()].map(ask => ask.line)
  }
}

/** Whether an inbox message is a 【作战室状态】 the router posted earlier (and can replace). */
export function isStateMessage(message: NoticeMessage): boolean {
  if (message.role !== undefined && message.role !== 'user') return false
  const parts = Array.isArray(message.content) ? message.content : []
  const first = parts[0] as { text?: unknown } | undefined
  return typeof first?.text === 'string' && first.text.startsWith(STATE_HEAD)
}

/** A row worth re-stating: still open, or stopped on a human decision. */
function isLive(task: RouterTask): boolean {
  return isOpen(task.state) && task.state !== 'reported' || task.state === 'blocked'
}

function capped(lines: readonly string[]): string[] {
  if (lines.length <= STATE_MAX_LINES) return lines.map(line => `- ${line}`)
  const kept = lines.slice(lines.length - STATE_MAX_LINES)
  return [`- （另有 ${String(lines.length - kept.length)} 条较早的未列出）`, ...kept.map(line => `- ${line}`)]
}

/**
 * The text of one 【作战室状态】 message, or undefined when nothing is open (then nothing
 * is posted: an empty list would only cost tokens).
 * @param tasks - the router board.
 * @param asks - open questions from {@link OpenAsks.list}.
 */
export function compactStateText(tasks: readonly RouterTask[], asks: readonly string[]): string | undefined {
  const rows = tasks.filter(isLive)
    .slice()
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .map(task => `${task.id}「${task.subject}」（${task.partition}/${task.level}，${STATE_LABEL[task.state] ?? task.state}）`
      + (task.state === 'blocked' || task.state === 'suspended'
        ? (task.suspendReason !== undefined ? `：${task.suspendReason.replace(/\s+/g, ' ').slice(0, 120)}` : '')
        : ''))
  if (rows.length === 0 && asks.length === 0) return undefined
  const body = [
    STATE_HEAD,
    '较早的对话刚被压缩成总结。下面是压缩时还没了结的事，以这里为准（已经处理过的可以忽略；云端任务的最新情况用 task_list 查）。',
  ]
  if (rows.length > 0) body.push('', '本机看板上没结束的任务：', ...capped(rows))
  if (asks.length > 0) body.push('', '还在等用户决定或回答的：', ...capped(asks))
  return body.join('\n')
}

/** Default context size (tokens) past which the router compacts the 作战室 itself. */
export const ANCHOR_COMPACT_TOKENS = 300_000


/** The part of DSH's compaction service (`ctx.compaction`) the router calls. */
export interface CompactionEngineLike {
  compactNow(agent: never, signal: AbortSignal): Promise<{ readonly shadowedTokenCount?: number } | null>
}

/** What {@link AnchorCompactor} needs from the router. */
export interface AnchorCompactorDeps {
  /** Tokens past which to compact; 0 turns it off. */
  readonly threshold: number
  /** The live 作战室 Agent, if any. */
  agent(): { readonly status?: string } | undefined
  /** That Agent's compaction service (it lives inside the agent preset), if any. */
  engine(agent: object): CompactionEngineLike | undefined
  readonly log: { info(message: string): void; warn(message: string): void }
  readonly now?: () => number
  /** Wait after a turn ends, and between checks for idle. Default 1500 ms. */
  readonly retryMs?: number
}

/** Checks for idle before giving up until the next turn ends. */
const IDLE_TRIES = 40
/** Pause after a failed compaction, so a broken summarizer is not retried every turn. */
const FAILURE_PAUSE_MS = 10 * 60 * 1000

/**
 * Keeps the 作战室 under {@link AnchorCompactorDeps.threshold} tokens.
 *
 * Fed the context size of each of its replies ({@link sample}) and told when a turn ends
 * ({@link turnEnded}); once the last size is past the threshold it waits for the Agent to
 * be idle and calls `compactNow`, the same call `/compact` makes. A turn that starts in the
 * meantime only delays it (DSH refuses a compaction while the Agent works: `busy`).
 */
export class AnchorCompactor {
  private tokens = 0
  private running = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private pausedUntil = 0
  private warnedNoEngine = false
  private readonly abort = new AbortController()

  constructor(private readonly deps: AnchorCompactorDeps) {}

  /** The context size the 作战室's latest model call reported. */
  sample(tokens: number | undefined): void {
    if (tokens !== undefined) this.tokens = tokens
  }

  /** History was just compacted (by this or by anything else): the old size no longer holds. */
  compacted(): void {
    this.tokens = 0
  }

  /** A turn of the 作战室 ended: compact soon if it has grown past the threshold. */
  turnEnded(): void {
    if (this.due()) this.schedule(0)
  }

  /** Stop any pending check and cancel a compaction in flight. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.abort.abort()
  }

  private due(): boolean {
    const now = this.deps.now?.() ?? Date.now()
    return this.deps.threshold > 0 && this.tokens >= this.deps.threshold && !this.running && now >= this.pausedUntil
  }

  private schedule(tries: number): void {
    if (this.timer !== undefined || this.abort.signal.aborted) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.run(tries)
    }, this.deps.retryMs ?? 1500)
  }

  private async run(tries: number): Promise<void> {
    if (!this.due()) return
    const agent = this.deps.agent()
    if (agent === undefined) return
    if (agent.status !== undefined && agent.status !== 'idle') {
      if (tries < IDLE_TRIES) this.schedule(tries + 1)
      return
    }
    const engine = this.deps.engine(agent)
    if (engine === undefined) {
      if (!this.warnedNoEngine) this.deps.log.warn('host-router: 作战室 has no compaction service; automatic compaction is off')
      this.warnedNoEngine = true
      return
    }
    const before = this.tokens
    this.running = true
    try {
      const result = await engine.compactNow(agent as never, this.abort.signal)
      this.tokens = 0
      this.deps.log.info(result === null
        ? `host-router: 作战室 at ${String(before)} tokens, nothing to compact yet`
        : `host-router: 作战室 at ${String(before)} tokens, compacted (~${String(result.shadowedTokenCount ?? '?')} tokens folded into a summary)`)
      if (result === null) this.pausedUntil = (this.deps.now?.() ?? Date.now()) + FAILURE_PAUSE_MS
    } catch (error) {
      if (this.abort.signal.aborted) return
      if ((error as { code?: unknown } | null)?.code === 'busy') {
        if (tries < IDLE_TRIES) {
          this.running = false
          this.schedule(tries + 1)
        }
        return
      }
      this.pausedUntil = (this.deps.now?.() ?? Date.now()) + FAILURE_PAUSE_MS
      this.deps.log.warn(`host-router: could not compact the 作战室 (${String(before)} tokens), retrying in 10 minutes: ${String(error)}`)
    } finally {
      this.running = false
    }
  }
}
