/**
 * Right-Sidebar task board: a progress tree, styled after Claude Duet's rail.
 *
 * One quiet column: a titled header with icon-only actions, a pill segment strip
 * (进行中 / 接下来 / 排程任务 / 已结束), then status groups. A group caption counts
 * task *families*, and each family is one row — the manager's task — with the
 * workers it dispatched indented underneath behind a `n 个 worker` chip. Rows
 * never repeat a work item as two siblings.
 *
 * The groups are 进行中, 已暂停（需要处理）, 已挂起（等前置）, 排队中, 已失效分区,
 * 已完成, 失败 and 已取消. A parked (`blocked`) row carries a second line with its
 * reason and a 恢复 button that sends `task_control resume`; a suspended row
 * says what it waits for, and a queued row held back by the task order says
 * which prerequisites are still open. Live rows offer 挂起 (with an optional
 * prerequisite), failed rows offer 重试. The 进行中 tab opens with per-request
 * progress and the router's latest progress notices. There is
 * no "awaiting review" bucket: a worker that reported in has finished, so host
 * state `reported` renders as 已完成. The finished pile opens folded, so history
 * never buries what is running.
 *
 * Each row: an ellipsised 13px title with a light meta line (partition, time,
 * monospace task id) below it, and a small status dot plus word on the right
 * (进行中 / 已完成 / 已中断 / 已取消 / 失败). Narrow panels keep only title and dot.
 *
 * The groups come from `hostState` rather than the five-state `state` projection:
 * that projection folds `failed`/`cancelled` into `rejected` and `blocked` into
 * `queued`, which would merge 失败/取消 into 排队中 and lose 需要输入 entirely.
 *
 * Everything the previous dense card list did is still here: rows open their
 * worker's Session on click, the board is re-read when the refresh icon is used
 * and every 3 s while anything runs (checklists live in worker logs, not in the
 * board file), long groups fold behind 更多（还有 n 条） with 已显示 n/m beside the count, and the header's `+`
 * opens the war-room chat where demands are created.
 *
 * @module client-ui-router/compact-board
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { GroupProgressView, HostTaskState, NoticeView, PartitionView, TaskView, TodoItem } from './contract.ts'
import type { ControlAction, ControlExtra } from './source.ts'
import type { RouterBoardController } from './controller.ts'
import { clockTime, duration, relativeTime } from './format.ts'
import { NO_SESSIONS, todosOf, type SessionsFace } from './native-todos.ts'
import { BOARD_TOKENS_CSS, type BoardTone } from './styles.ts'

/** Props supplied by the tab registration. */
export interface CompactBoardProps {
  readonly controller: RouterBoardController
  readonly t: (key: string, values?: Record<string, string | number>) => string
  readonly onOpenSession?: (sessionId: string) => void
  readonly onOpenWarRoom?: () => void
  /** Hide this panel's tab again. Absent when the shell has no right Sidebar. */
  readonly onClose?: () => void
  readonly sessions?: SessionsFace
}

/** A tab of the segment strip. */
export type BoardTab = 'active' | 'next' | 'scheduled' | 'resolved'

/**
 * A status bucket rendered under one caption inside a tab.
 *
 * There is deliberately no "awaiting review" bucket: a worker that reported in
 * has finished its work, and the panel is a progress tree, not a review queue.
 * Host states fold onto these three outcomes — running, finished, closed badly.
 */
export type Group = 'running' | 'blocked' | 'suspended' | 'queued' | 'stale' | 'done' | 'failed' | 'cancelled'

/** Rows a group shows before it folds behind 更多. */
const PAGE = 12
const POLL_MS = 3000

/** Tab order, left to right, mirroring the reference's four segments. */
const TABS: readonly { id: BoardTab; key: string }[] = [
  { id: 'active', key: 'seg.active' },
  { id: 'next', key: 'seg.next' },
  { id: 'scheduled', key: 'seg.scheduled' },
  { id: 'resolved', key: 'seg.resolved' },
]

/** Group order inside each tab. */
const TAB_GROUPS: Readonly<Record<BoardTab, readonly Group[]>> = {
  active: ['running', 'blocked', 'suspended'],
  next: ['queued'],
  scheduled: ['stale'],
  resolved: ['done', 'failed', 'cancelled'],
}

/** Caption key per group. */
const GROUP_KEY: Readonly<Record<Group, string>> = {
  running: 'grp.running',
  blocked: 'grp.blocked',
  suspended: 'grp.suspended',
  queued: 'grp.queued',
  stale: 'grp.stale',
  done: 'grp.done',
  failed: 'grp.failed',
  cancelled: 'grp.cancelled',
}

/** Groups the panel opens folded: the finished pile is history, not status. */
const FOLDED_GROUPS: readonly Group[] = ['done']

/**
 * Prefix of the fold key a family row uses.
 *
 * Family rows carry `f:`, group captions carry `g:`, and the two mean opposite
 * things: a family is open unless the user folded it, while a group still starts
 * cut at `PAGE`. One set cannot hold both defaults, so the family default lives
 * in {@link COLLAPSED_STORAGE_KEY} below and the older `g:` paging is untouched.
 */
const FAMILY_FOLD = 'f:'

/**
 * sessionStorage key holding the families the user folded by hand.
 *
 * "This session only" is exactly what sessionStorage is: the choice survives a
 * panel remount, a tab switch and a page reload (component state would pop every
 * row back open), but it never leaks into another tab or a later day the way
 * localStorage would. The value is a JSON array of `f:` fold keys.
 */
const COLLAPSED_STORAGE_KEY = 'dshr.board.collapsed'

/**
 * Read the hand-folded families for this tab session.
 *
 * Storage may be absent, not JSON, not an array, or full of non-strings (an
 * older build, a hand edit, a half-written value). Every one of those cases
 * reads as "nothing folded" instead of throwing, so a bad value can never keep
 * the board from rendering, and a family that no longer exists just leaves a
 * stale key in the set, which is never consulted.
 * @returns the fold keys remembered for this tab session.
 */
function readCollapsedFamilies(): ReadonlySet<string> {
  try {
    const raw = globalThis.sessionStorage?.getItem(COLLAPSED_STORAGE_KEY)
    if (raw === null || raw === undefined || raw === '') return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    const keys = parsed.filter((item): item is string => typeof item === 'string' && item.startsWith(FAMILY_FOLD))
    return new Set(keys)
  } catch {
    // Unreadable or not JSON: folding still works, it just is not remembered.
    return new Set()
  }
}

/** Remember the hand-folded families; missing or full storage is not an error. */
function writeCollapsedFamilies(collapsed: ReadonlySet<string>): void {
  try {
    globalThis.sessionStorage?.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...collapsed]))
  } catch {
    // Storage is a convenience: this session still folds, a reload just forgets.
  }
}

/** Host state of a task; sample data without it falls back to the projection. */
function hostOf(task: TaskView): HostTaskState | 'done' {
  if (task.hostState !== undefined) return task.hostState
  return task.state === 'rejected' ? 'failed' : task.state
}

/**
 * Group of one task.
 * @param task - the task.
 * @param live - partition ids that still exist.
 * @returns its display group; unfinished work in a removed partition is `stale`.
 */
export function groupOf(task: TaskView, live: ReadonlySet<string>): Group {
  const host = hostOf(task)
  if (host === 'done' || host === 'verified' || host === 'reported') return 'done'
  // 失败 and 已取消 are separate buckets. A cancellation is a request, not a
  // verdict; an abort (已中断: the worker stopped without a result) stays in 失败
  // because nobody asked for it. Host state `interrupted` is not closed at all:
  // the router resumes it, so it files under 进行中 below.
  if (host === 'cancelled') return 'cancelled'
  if (host === 'failed') return isCancelled(task) ? 'cancelled' : 'failed'
  if (!live.has(task.partitionId)) return 'stale'
  if (host === 'blocked') return 'blocked'
  if (host === 'suspended') return 'suspended'
  if (host === 'queued') return 'queued'
  return 'running'
}

const isLive = (g: Group): boolean => g === 'running' || g === 'queued' || g === 'blocked' || g === 'suspended'

/**
 * Groups, most attention-worthy first.
 *
 * A family's own bucket is the first of these any of its members is in, so a
 * manager that already reported while its worker still runs files under 进行中
 * rather than under 已完成.
 */
const GROUP_ORDER: readonly Group[] = ['running', 'blocked', 'suspended', 'queued', 'stale', 'failed', 'cancelled', 'done']

/**
 * Whether a closed task ended without a verdict.
 *
 * The host reports an abort as a failure whose `error` names the stop reason
 * (`worker ended with stopReason "aborted"`) and a cancellation as
 * `cancelled: …`. Both are "closed without a result", so the row says 已中断 or
 * 已取消 instead of showing them as a normal failure.
 * @param task - a task.
 * @returns true when its failure reason is an abort or a cancellation.
 */
function isAborted(task: TaskView): boolean {
  return /aborted|interrupted|已中止/i.test(`${task.error ?? ''} ${task.rejectionReason ?? ''}`)
}

/** Whether a closed task was cancelled on request. */
function isCancelled(task: TaskView): boolean {
  return /cancel|已取消/i.test(`${task.error ?? ''} ${task.rejectionReason ?? ''}`)
}

/**
 * Bucket of one task.
 *
 * `reported` is a finished task here: a worker that reported in is done, and the
 * panel is a progress tree, not a review queue. A cancellation files under
 * 已取消; an abort stays in 失败 with its own 已中断 caption on the row.
 * @param task - a task.
 * @param live - partition ids that still exist.
 * @returns its bucket.
 */
export function groupOfTask(task: TaskView, live: ReadonlySet<string>): Group {
  return groupOf(task, live)
}

/** The word a row shows for its own status: icon colour alone is not enough. */
export type StatusTone = 'running' | 'blocked' | 'suspended' | 'queued' | 'waiting' | 'done' | 'failed' | 'aborted' | 'cancelled' | 'stale'

/**
 * Caption key for one task's status word.
 * @param task - a task.
 * @param live - partition ids that still exist.
 * @returns the locale key of its caption.
 */
export function statusKeyOf(task: TaskView, live: ReadonlySet<string>): string {
  const host = hostOf(task)
  if (host === 'done' || host === 'verified' || host === 'reported') return 'status.done'
  if (host === 'cancelled') return 'status.cancelled'
  if (host === 'failed') {
    if (isCancelled(task)) return 'status.cancelled'
    return isAborted(task) ? 'status.aborted' : 'status.failed'
  }
  if (!live.has(task.partitionId)) return 'status.stale'
  if (host === 'blocked') return 'status.blocked'
  if (host === 'suspended') return 'status.suspended'
  if (host === 'interrupted') return 'status.resuming'
  if (host === 'queued' && (task.waitingFor?.length ?? 0) > 0) return 'status.waiting'
  if (host === 'queued' || host === 'dispatched') return 'status.queued'
  return 'status.running'
}

/** One row of the board: a task family, not a single task. */
export interface Family {
  /** Identity for React keys: the root task id, or the folded title key. */
  key: string
  /** Bucket the family is filed under. */
  group: Group
  /** Task the headline row shows. Newest member after a duplicate fold. */
  root: TaskView
  /**
   * The member whose status the row reports.
   *
   * It is the member that put the family in its bucket: a manager that already
   * closed while its worker still runs must not paint the running row with the
   * manager's 已中断 — the row is 进行中, because the work is.
   */
  rep: TaskView
  /** Every task in the family, headline first, then its children. */
  members: TaskView[]
  /** Highest attempt count in the family, for the 第 n 次尝试 tag. */
  attempt: number
  /** Failure or abort reason, for the resolved tag and the tooltip. */
  reason?: string
}

/** Fold a title for the duplicate test: case, spacing and punctuation ignored. */
function foldTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/gu, ' ').replace(/[\p{P}\p{S}\s]/gu, '')
}

/**
 * Build the board's rows: one per task family.
 *
 * A manager and the workers under it are one piece of work, so `parentId` folds
 * the whole tree into a single headline row whose children open behind a count
 * chip. Counting families is what keeps "进行中 9" from reading as nine
 * unrelated jobs when it is three.
 *
 * Two display-only folds beyond that:
 *  - a task whose parent is not on the board is its own root (a board is a
 *     window, not a whole history);
 *  - root tasks with the same title, partition and bucket fold into one row. A
 *     demand that was retried or republished under a second id is not a second
 *     piece of work, and two identical rows read as a bug. Tasks with children
 *     never take part: their tree is their identity.
 *
 * Nothing here changes a task's state; the fold is a rendering decision.
 * @param tasks - every task in the snapshot.
 * @param live - partition ids that still exist.
 * @returns families, newest activity first within their bucket.
 */
export function buildFamilies(tasks: readonly TaskView[], live: ReadonlySet<string>): Family[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  // 1. Fold every task under its outermost ancestor that the board still holds.
  const trees = new Map<string, TaskView[]>()
  for (const task of tasks) {
    let root = task
    const seen = new Set<string>()
    while (root.parentId !== undefined && byId.has(root.parentId) && !seen.has(root.id)) {
      seen.add(root.id)
      root = byId.get(root.parentId)!
    }
    const list = trees.get(root.id)
    if (list === undefined) trees.set(root.id, [task])
    else list.push(task)
  }
  // 2. Fold duplicate-looking singleton roots into one row.
  const families: Family[] = []
  const folded = new Map<string, Family>()
  for (const [id, members] of trees) {
    const root = byId.get(id)!
    if (members.length > 1) {
      families.push({ key: `root:${id}`, group: 'done', root, rep: root, members, attempt: 1 })
      continue
    }
    const dedupeKey = [root.partitionId, groupOfTask(root, live), foldTitle(root.title)].join('\u0000')
    const hit = folded.get(dedupeKey)
    if (hit === undefined) {
      const family: Family = { key: `one:${dedupeKey}`, group: 'done', root, rep: root, members: [root], attempt: 1 }
      folded.set(dedupeKey, family)
      families.push(family)
      continue
    }
    hit.members.push(root)
    if (startOf(root) > startOf(hit.root)) hit.root = root
  }
  // 3. Resolve each family's bucket, attempt count and reason once.
  for (const family of families) {
    family.group = GROUP_ORDER.find(group => family.members.some(task => groupOfTask(task, live) === group)) ?? 'done'
    family.rep = family.members.find(task => groupOfTask(task, live) === family.group) ?? family.root
    family.attempt = family.members.reduce((most, task) => Math.max(most, task.attempt ?? 1), 1)
    const reason = family.members
      .map(task => task.error ?? task.rejectionReason)
      .find((text): text is string => text !== undefined && text !== '')
    if (reason !== undefined) family.reason = reason
  }
  return families.sort((left, right) => startOf(right.root) - startOf(left.root))
}

/** Seconds-precision age for the live activity line. */
function ago(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  return seconds < 60 ? `${seconds} 秒前` : relativeTime(iso, now)
}

const startOf = (task: TaskView): number => Date.parse(task.requestedAt ?? task.updatedAt) || 0

/** Colour family of one status word: queued and stale stay neutral. */
const TONE_COLOR: Readonly<Record<StatusTone | 'resuming', BoardTone>> = {
  running: 'running',
  resuming: 'running',
  blocked: 'blocked',
  suspended: 'blocked',
  queued: 'cancelled',
  waiting: 'cancelled',
  stale: 'cancelled',
  done: 'done',
  failed: 'failed',
  aborted: 'failed',
  cancelled: 'cancelled',
}

/**
 * Status on the right of a row: a 6px dot plus an 11px word.
 *
 * The word stays in the DOM even when a narrow panel hides it visually, so the
 * status never depends on colour alone for assistive tech or the tooltip.
 * @param props - the tone and its caption.
 * @returns the status cell.
 */
function Status({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span className="dshrc-st" data-tone={tone} data-color={TONE_COLOR[tone] ?? 'cancelled'} title={label}>
      <span className="dshrc-dot" aria-hidden="true" />
      <span className="dshrc-st-text">{label}</span>
    </span>
  )
}

/** 16px line icon on a 16-unit grid, stroke 1.5: the only icon shape the board uses. */
function Icon({ d, className, open }: { d: string; className?: string; open?: boolean }) {
  return (
    <svg className={className} data-open={open === true ? '' : undefined} viewBox="0 0 16 16" width="16" height="16"
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"><path d={d} /></svg>
  )
}

/** Short task id for the row: the tail after the last dash, full id in the tooltip. */
function shortId(id: string): string {
  const tail = id.slice(id.lastIndexOf('-') + 1)
  return tail.length >= 3 && tail.length < id.length ? `#${tail}` : id
}

const CARET = 'M6 4l4 4-4 4'
const ICON_REFRESH = 'M13 8a5 5 0 1 1-1.5-3.6M13 3v3h-3'
const ICON_PLUS = 'M8 3v10M3 8h10'
const ICON_CLOSE = 'M4 4l8 8M12 4l-8 8'

/*
 * Board stylesheet. Tokens (state colours, hover/press, 4px spacing scale, 28px
 * control height, 6px radius) come from BOARD_TOKENS_CSS in styles.ts; this
 * block only uses them. No bordered boxes: grouping is whitespace plus 1px
 * low-contrast dividers.
 */
const STYLE = `${BOARD_TOKENS_CSS}
.dshrc{container-type:inline-size;--c-text:var(--dsw-alias-label-primary,#0f1115);--c-text2:var(--dsw-alias-label-secondary,#61666b);--c-text3:var(--c-meta);--c-line:var(--dsw-alias-border-l2,rgba(0,0,0,.1));--c-line-soft:var(--dsw-alias-border-l1,rgba(0,0,0,.04));--c-pill:var(--dsw-alias-interactive-bg-hover-solid,#f1f3f5);--c-focus:var(--st-running-dot);--f-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,transparent);color:var(--c-text);font-size:13px;line-height:1.45;text-align:left}
.dshrc *{box-sizing:border-box}
/* Zero-specificity reset so .dshrc-gh/-chip/-fold/-tab keep their own font size, weight and numerals. */
:where(.dshrc button){font:inherit}
.dshrc button:focus-visible{outline:2px solid var(--c-focus);outline-offset:1px}
.dshrc button:disabled{opacity:.45;cursor:default}
.dshrc-head{display:flex;align-items:center;gap:var(--sp-2);padding:var(--sp-3) var(--sp-3) var(--sp-1) var(--sp-4);flex:none}
.dshrc-title{flex:1 1 auto;min-width:0;margin:0;font-size:13px;font-weight:600;line-height:20px;color:var(--c-text)}
.dshrc-acts{display:flex;align-items:center;gap:var(--sp-1);flex:none}
.dshrc-ico{display:flex;align-items:center;justify-content:center;width:var(--h-ctl);height:var(--h-ctl);padding:0;border:0;border-radius:var(--r-ctl);background:transparent;color:var(--c-text2);cursor:pointer;transition:background-color .12s ease,color .12s ease}
.dshrc-ico:hover{background:var(--c-hover);color:var(--c-text)}
.dshrc-ico:active{background:var(--c-press);color:var(--c-text)}
.dshrc-ico svg{width:16px;height:16px;display:block}
.dshrc-tabs{display:flex;align-items:center;gap:var(--sp-1);flex:none;padding:var(--sp-1) var(--sp-3) var(--sp-2) var(--sp-4);overflow-x:auto;scrollbar-width:none;border-bottom:1px solid var(--c-line-soft)}
.dshrc-tabs::-webkit-scrollbar{display:none}
.dshrc-find{flex:0 1 160px;min-width:72px;height:24px;margin-left:auto;padding:0 var(--sp-2);border:1px solid var(--c-ghost-line);border-radius:var(--r-ctl);background:transparent;color:var(--c-text);font-size:12px}
.dshrc-tab{flex:none;height:var(--h-ctl);padding:0 var(--sp-3);border:0;border-radius:var(--r-ctl);background:transparent;color:var(--c-text2);font-size:12px;font-weight:500;line-height:var(--h-ctl);cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease}
.dshrc-tab:hover{background:var(--c-hover);color:var(--c-text)}
.dshrc-tab:active{background:var(--c-press)}
.dshrc-tab[data-on]{background:var(--c-pill);color:var(--c-text);font-weight:600}
.dshrc-tab-n{margin-left:var(--sp-1);font-weight:500;color:var(--c-text3);font-variant-numeric:tabular-nums}
.dshrc-tab-flag{display:inline-block;width:6px;height:6px;margin-left:var(--sp-1);vertical-align:middle;border-radius:50%;background:var(--st-blocked-dot)}
.dshrc-ico[data-busy] svg{animation:dshrc-spin .8s linear infinite}
@keyframes dshrc-spin{to{transform:rotate(360deg)}}
.dshrc-row[data-link]:focus-visible{outline:2px solid var(--c-focus);outline-offset:-2px}
.dshrc-list{flex:1 1 auto;min-height:0;overflow:auto;padding:0 var(--sp-1) 24px;scrollbar-width:thin}
.dshrc-group{margin-top:var(--sp-4)}
.dshrc-group+.dshrc-group{padding-top:var(--sp-3);margin-top:var(--sp-1);border-top:1px solid var(--c-line-soft)}
.dshrc-gh{display:flex;align-items:center;gap:var(--sp-2);width:100%;height:var(--h-ctl);margin:0 0 6px;padding:0 var(--sp-3) 0 var(--sp-2);border:0;border-radius:var(--r-ctl);background:transparent;color:var(--c-text2);font-size:11px;font-weight:600;line-height:16px;letter-spacing:.02em;text-transform:uppercase;text-align:left;cursor:pointer;transition:background-color .12s ease}
.dshrc-gh:hover{background:var(--c-hover);color:var(--c-text)}
.dshrc-gh:active{background:var(--c-press)}
.dshrc-gcaret{flex:none;width:16px;height:16px;color:var(--c-text3);transition:transform .15s ease}
.dshrc-gcaret[data-open]{transform:rotate(90deg)}
.dshrc-gn{color:inherit}
.dshrc-gc,.dshrc-gshown{font-weight:500;color:var(--c-text3);font-variant-numeric:tabular-nums;white-space:nowrap;letter-spacing:0}
.dshrc-family{display:block}
.dshrc-family+.dshrc-family{border-top:1px solid var(--c-line-soft)}
.dshrc-row{display:flex;align-items:center;gap:var(--sp-2);width:100%;min-height:var(--h-row);padding:var(--sp-1) var(--sp-3);border-radius:var(--r-ctl);cursor:default;transition:background-color .12s ease}
.dshrc-row[data-link]{cursor:pointer}
.dshrc-row[data-link]:hover{background:var(--c-hover)}
.dshrc-row[data-link]:active{background:var(--c-press)}
.dshrc-sub{min-height:var(--h-sub);padding-left:28px}
.dshrc-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
.dshrc-rt{flex:1 1 auto;min-width:56px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;line-height:20px;color:var(--c-text)}
.dshrc-sub .dshrc-rt{font-weight:400;color:var(--c-text2)}
.dshrc-row[data-group="stale"] .dshrc-rt{color:var(--c-text2)}
.dshrc-meta{display:flex;align-items:baseline;gap:var(--sp-2);min-width:0;font-size:11px;line-height:16px;color:var(--c-text3);white-space:nowrap}
.dshrc-rm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--c-text3);font-variant-numeric:tabular-nums}
.dshrc-sub>.dshrc-rm{flex:0 1 auto;max-width:40%;text-align:right}
.dshrc-id{flex:none;font-family:var(--f-mono);font-size:11px;line-height:16px;color:var(--c-id);white-space:nowrap}
.dshrc-st{flex:none;display:inline-flex;align-items:center;gap:var(--sp-1);font-size:11px;line-height:16px;white-space:nowrap;color:var(--st-cancelled-text)}
.dshrc-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--st-cancelled-dot)}
.dshrc-st[data-color="running"]{color:var(--st-running-text)}.dshrc-st[data-color="running"] .dshrc-dot{background:var(--st-running-dot);animation:dshrc-pulse 1.6s ease-in-out infinite}
.dshrc-st[data-color="blocked"]{color:var(--st-blocked-text)}.dshrc-st[data-color="blocked"] .dshrc-dot{background:var(--st-blocked-dot)}
.dshrc-st[data-color="done"]{color:var(--st-done-text)}.dshrc-st[data-color="done"] .dshrc-dot{background:var(--st-done-dot)}
.dshrc-st[data-color="failed"]{color:var(--st-failed-text)}.dshrc-st[data-color="failed"] .dshrc-dot{background:var(--st-failed-dot)}
.dshrc-st[data-tone="queued"] .dshrc-dot,.dshrc-st[data-tone="waiting"] .dshrc-dot,.dshrc-st[data-tone="suspended"] .dshrc-dot,.dshrc-st[data-tone="stale"] .dshrc-dot,.dshrc-st[data-tone="aborted"] .dshrc-dot{background:transparent;box-shadow:inset 0 0 0 1.5px currentColor}
@keyframes dshrc-pulse{0%,100%{opacity:1}50%{opacity:.4}}
/* Worker fold chip: ghost button, 28x28 minimum hit area, 16px caret. The
   negative block margin keeps it from growing the 44px family row. */
.dshrc-chip{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:var(--sp-1);min-width:var(--h-ctl);height:var(--h-ctl);margin-block:-4px;padding:0 var(--sp-2) 0 var(--sp-1);border:1px solid transparent;border-radius:var(--r-ctl);background:transparent;color:var(--c-text3);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,border-color .12s ease,color .12s ease}
.dshrc-chip:hover{border-color:var(--c-ghost-line);background:var(--dsw-alias-bg-base,transparent);color:var(--c-text)}
.dshrc-chip:active{background:var(--c-press);color:var(--c-text)}
.dshrc-caret{flex:none;width:16px;height:16px;display:block;transition:transform .15s ease}
.dshrc-caret[data-open]{transform:rotate(90deg)}
.dshrc-tag{flex:none;display:inline-flex;align-items:center;height:20px;padding:0 var(--sp-1);border-radius:4px;background:var(--st-cancelled-bg);color:var(--c-text3);font-size:11px;line-height:16px;white-space:nowrap;font-variant-numeric:tabular-nums}
.dshrc-fold{display:flex;align-items:center;gap:var(--sp-1);height:var(--h-ctl);margin:var(--sp-1) 0 0 var(--sp-1);padding:0 var(--sp-2);border:1px solid transparent;border-radius:var(--r-ctl);background:transparent;color:var(--c-text3);font-size:12px;cursor:pointer;font-variant-numeric:tabular-nums}
.dshrc-fold:hover{border-color:var(--c-ghost-line);color:var(--c-text)}
.dshrc-fold:active{background:var(--c-press)}
.dshrc-err{display:flex;align-items:center;gap:var(--sp-2);flex:none;margin:var(--sp-2) var(--sp-3) 0;padding:var(--sp-2) var(--sp-3);border-radius:var(--r-ctl);background:var(--st-failed-bg);color:var(--c-text);font-size:12px;line-height:16px}
.dshrc-err-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.dshrc-err-msg{color:var(--st-failed-text)}
.dshrc-err-stale{display:block;color:var(--c-text3);font-size:11px}
.dshrc-err-btn,.dshrc-hold-btn{flex:none;height:var(--h-ctl);padding:0 var(--sp-3);border:1px solid transparent;border-radius:var(--r-ctl);background:transparent;color:var(--c-text);font-size:12px;line-height:16px;white-space:nowrap;cursor:pointer;transition:background-color .12s ease,border-color .12s ease}
.dshrc-err-btn{border-color:var(--c-ghost-line)}
.dshrc-err-btn:hover,.dshrc-hold-btn:hover:not(:disabled){border-color:var(--c-ghost-line);background:var(--dsw-alias-bg-base,transparent)}
.dshrc-err-btn:active,.dshrc-hold-btn:active:not(:disabled){background:var(--c-press)}
.dshrc-sample{flex:none;margin:var(--sp-2) var(--sp-3) 0;padding:var(--sp-1) var(--sp-3);border-radius:var(--r-ctl);background:var(--st-blocked-bg);color:var(--st-blocked-text);font-size:11px}
.dshrc-hold{display:flex;align-items:center;gap:var(--sp-2);min-width:0;margin:-4px 0 var(--sp-1);padding:0 var(--sp-3) 0 28px;font-size:12px;line-height:16px;color:var(--c-text2)}
.dshrc-hold-why{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshrc-hold-err{flex:0 1 auto;min-width:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--st-failed-text)}
.dshrc-hold-btn{color:var(--st-blocked-text)}
.dshrc-notice{flex:none;margin:var(--sp-2) var(--sp-3) 0;padding:var(--sp-1) var(--sp-3);border-radius:var(--r-ctl);background:var(--st-done-bg);color:var(--st-done-text);font-size:12px;line-height:20px;overflow-wrap:anywhere}
.dshrc-notice[data-tone="bad"]{background:var(--st-failed-bg);color:var(--st-failed-text)}
.dshrc-empty{padding:36px var(--sp-4);color:var(--c-text3);text-align:center;font-size:12px}
/* Row actions: hidden until the row is hovered or focused, so a quiet list stays quiet. */
.dshrc-acts-row{flex:none;display:flex;align-items:center;gap:2px;opacity:.55;transition:opacity .12s ease}
.dshrc-row:hover .dshrc-acts-row,.dshrc-row:focus-within .dshrc-acts-row,.dshrc-acts-row[data-busy]{opacity:1}
.dshrc-act{height:22px;margin-block:-3px;padding:0 var(--sp-2);border:1px solid var(--c-ghost-line);border-radius:var(--r-ctl);background:var(--dsw-alias-bg-base,transparent);color:var(--c-text2);font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.dshrc-act[data-tone="stop"]:hover{color:var(--st-failed-text)}
.dshrc-act[data-armed]{border-color:var(--st-failed-text);color:var(--st-failed-text);font-weight:600}
.dshrc-act:hover:not(:disabled){color:var(--c-text);background:var(--c-hover)}
.dshrc-act:active:not(:disabled){background:var(--c-press)}
.dshrc-wait{display:flex;align-items:center;gap:var(--sp-2);min-width:0;margin:-4px 0 var(--sp-1);padding:0 var(--sp-3) 0 28px;font-size:12px;line-height:16px;color:var(--c-text3)}
.dshrc-wait-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshrc-wait .dshrc-id{color:var(--c-text2)}
.dshrc-sform{display:flex;flex-direction:column;gap:var(--sp-2);margin:0 var(--sp-2) var(--sp-2) 28px;padding:var(--sp-2) var(--sp-3);border:1px solid var(--c-line);border-radius:var(--r-ctl);background:var(--c-line-soft)}
.dshrc-sform label{display:flex;flex-direction:column;gap:2px;font-size:11px;line-height:16px;color:var(--c-text2)}
.dshrc-sform input{height:var(--h-ctl);padding:0 var(--sp-2);border:1px solid var(--c-line);border-radius:var(--r-ctl);background:var(--dsw-alias-bg-base,#fff);color:var(--c-text);font:inherit;font-size:12px}
.dshrc-sform input:focus-visible{outline:2px solid var(--c-focus);outline-offset:0}
.dshrc-sform-hint{font-size:11px;color:var(--c-text3)}
.dshrc-sform-btns{display:flex;justify-content:flex-end;gap:var(--sp-2)}
.dshrc-sform-err{font-size:11px;color:var(--st-failed-text)}
.dshrc-prog{display:flex;flex-direction:column;gap:var(--sp-2);margin:var(--sp-3) var(--sp-2) 0;padding:var(--sp-2) var(--sp-3);border-radius:var(--r-ctl);background:var(--c-line-soft)}
.dshrc-prog-h,.dshrc-nt-h{font-size:11px;font-weight:600;line-height:16px;letter-spacing:.02em;color:var(--c-text2)}
.dshrc-prog-item{display:flex;flex-direction:column;gap:3px;min-width:0}
.dshrc-prog-top{display:flex;align-items:baseline;gap:var(--sp-2);min-width:0;font-size:12px;line-height:16px}
.dshrc-prog-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--c-text)}
.dshrc-prog-num{flex:none;font-variant-numeric:tabular-nums;color:var(--c-text2)}
.dshrc-bar{position:relative;display:flex;height:4px;border-radius:2px;overflow:hidden;background:var(--c-line)}
.dshrc-bar>span{display:block;height:100%}
.dshrc-bar>[data-k="done"]{background:var(--st-done-dot)}
.dshrc-bar>[data-k="run"]{background:var(--st-running-dot)}
.dshrc-bar>[data-k="susp"]{background:var(--st-blocked-dot)}
.dshrc-bar>[data-k="fail"]{background:var(--st-failed-dot)}
.dshrc-prog-sub{font-size:11px;line-height:16px;color:var(--c-text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshrc-nt{margin:var(--sp-4) var(--sp-2) 0;padding-top:var(--sp-3);border-top:1px solid var(--c-line-soft)}
.dshrc-nt-list{display:flex;flex-direction:column;gap:var(--sp-1);margin:var(--sp-2) 0 0;padding:0;list-style:none}
.dshrc-nt-item{display:flex;gap:var(--sp-2);padding:0 var(--sp-1);font-size:12px;line-height:18px;color:var(--c-text2)}
.dshrc-nt-time{flex:none;min-width:44px;color:var(--c-text3);font-variant-numeric:tabular-nums}
.dshrc-nt-text{min-width:0;overflow-wrap:anywhere}
@media (prefers-reduced-motion:reduce){.dshrc *{transition:none!important;animation:none!important}}
/* Narrow rail (about 340px at a 1024 viewport): title and status dot only. */
@container (max-width:379px){
.dshrc-meta,.dshrc-id,.dshrc-sub>.dshrc-rm,.dshrc-chip-text,.dshrc-sub .dshrc-tag{display:none}
.dshrc-st-text{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.dshrc-chip{padding:0 var(--sp-1)}
.dshrc-st{padding:0 var(--sp-1)}
}
`

/**
 * Render the board.
 * @param props - controller, translate, Session service and outward actions.
 * @returns the board.
 */
export function CompactBoard({ controller, t, onOpenSession, onOpenWarRoom, onClose, sessions }: CompactBoardProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const board = state.board
  const sessionFace = sessions ?? NO_SESSIONS
  const sessionList = useSyncExternalStore(sessionFace.list.subscribe, sessionFace.list.getSnapshot, sessionFace.list.getSnapshot)
  const [tab, setTab] = useState<BoardTab>('active')
  // Filter text: a family stays when any of its tasks matches by title, id or workspace.
  const [query, setQuery] = useState('')
  // Families the user folded by hand. Empty means every family is open, so the
  // worker rows are visible the moment the tree renders — no click per family.
  // The set holds `f:` keys and outlives re-renders, so a board poll can never
  // pop a family the user closed back open.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(readCollapsedFamilies)
  // Older paging state: only `g:` keys, where "in the set" means "past PAGE".
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  // Group headers fold their whole bucket; the finished pile starts folded.
  const [folded, setFolded] = useState<ReadonlySet<Group>>(() => new Set<Group>(FOLDED_GROUPS))
  const [now, setNow] = useState(() => Date.now())
  // Resume requests in flight, and the last failure per task id.
  const [resuming, setResuming] = useState<ReadonlySet<string>>(() => new Set())
  const [resumeError, setResumeError] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  // Row actions in flight, keyed `${taskId}:${action}`.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  // The one row whose 挂起 form is open, and that form's fields.
  const [suspending, setSuspending] = useState<string | null>(null)
  const [formReason, setFormReason] = useState('')
  const [formPrereq, setFormPrereq] = useState('')
  const [formError, setFormError] = useState('')
  // The stop button armed by a first click (`${taskId}:${action}`); it disarms by itself.
  const [arming, setArming] = useState<string | null>(null)

  useEffect(() => {
    if (arming === null) return
    const timer = setTimeout(() => { setArming(null) }, 4000)
    return () => { clearTimeout(timer) }
  }, [arming])
  // A hand-triggered refresh spins its icon until the read settles.
  const [refreshing, setRefreshing] = useState(false)
  const refresh = (): void => {
    if (refreshing) return
    setRefreshing(true)
    void controller.load().finally(() => { setRefreshing(false) })
  }

  useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(() => { setNotice(null) }, 4000)
    return () => { clearTimeout(timer) }
  }, [notice])

  // Persist the manual folds. Writing on every change also heals a corrupt or
  // stale stored value back to a clean `f:` key array on the first render.
  useEffect(() => { writeCollapsedFamilies(collapsed) }, [collapsed])

  /**
   * Resume one parked task through `task_control resume`. The controller moves
   * the row to running at once and re-reads the board after the call, so the
   * family leaves 已暂停 without waiting for the next poll.
   */
  const resume = async (task: TaskView): Promise<void> => {
    if (resuming.has(task.id)) return
    setResuming(previous => new Set(previous).add(task.id))
    setResumeError((previous) => {
      if (!previous.has(task.id)) return previous
      const next = new Map(previous)
      next.delete(task.id)
      return next
    })
    const failure = await controller.control(task.id, 'resume')
    setResuming((previous) => {
      const next = new Set(previous)
      next.delete(task.id)
      return next
    })
    if (failure === undefined) {
      setNotice({ tone: 'ok', text: t('hold.resumed', { title: task.title }) })
    } else {
      setResumeError(previous => new Map(previous).set(task.id, failure))
      setNotice({ tone: 'bad', text: t('hold.resumeFailed', { message: failure }) })
    }
  }

  /**
   * Run one row action (`suspend`, `retry`) through `task_control` and say how
   * it went in the toast.
   * @returns true when the Host accepted it.
   */
  const act = async (task: TaskView, action: ControlAction, value?: string, extra?: ControlExtra): Promise<boolean> => {
    const key = `${task.id}:${action}`
    if (busy.has(key)) return false
    setBusy(previous => new Set(previous).add(key))
    const failure = await controller.control(task.id, action, value, extra)
    setBusy((previous) => {
      const next = new Set(previous)
      next.delete(key)
      return next
    })
    if (failure === undefined) {
      setNotice({ tone: 'ok', text: t('act.done', { action: t(`act.${action}`), title: task.title }) })
      return true
    }
    setNotice({ tone: 'bad', text: t('act.failed', { message: failure }) })
    return false
  }

  const openSuspend = (task: TaskView): void => {
    if (suspending === task.id) {
      setSuspending(null)
      return
    }
    setSuspending(task.id)
    setFormReason('')
    setFormPrereq('')
    setFormError('')
  }

  const submitSuspend = async (task: TaskView): Promise<void> => {
    const reason = formReason.trim()
    if (reason === '') {
      setFormError(t('susp.form.empty'))
      return
    }
    const prerequisite = formPrereq.trim()
    const ok = await act(task, 'suspend', reason, prerequisite === '' ? undefined : { prerequisite })
    if (ok) setSuspending(null)
  }

  const toggleFolded = (group: Group): void => {
    setFolded((previous) => {
      const next = new Set(previous)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  // SSE: `start` attaches the source's change feed (`/api/router/events`).
  useEffect(() => {
    const detach = controller.start()
    void controller.load()
    return () => { detach() }
  }, [controller])

  const model = useMemo(() => {
    const tasks = board?.tasks ?? []
    const partitions: readonly PartitionView[] = board?.partitions ?? []
    const live = new Set(partitions.map(partition => partition.id))
    const nameOf = new Map<string, string>(partitions.map(partition => [partition.id, partition.name]))
    const workerName = new Map<string, string>()
    for (const partition of partitions) for (const worker of partition.workers) workerName.set(worker.id, worker.name)
    const titleOf = new Map<string, string>(tasks.map(task => [task.id, task.title]))
    // One row per task family, not one per task: a manager and the workers it
    // dispatched are one piece of work, and the caption count must agree with
    // the rows actually drawn.
    const needle = query.trim().toLowerCase()
    const matches = (task: TaskView): boolean => [task.title, task.id, nameOf.get(task.partitionId) ?? '']
      .some(text => text.toLowerCase().includes(needle))
    const families = buildFamilies(tasks, live).filter(family => needle === '' || family.members.some(matches))
    const groupFams = new Map<Group, Family[]>()
    for (const group of Object.keys(TAB_GROUPS).flatMap(id => TAB_GROUPS[id as BoardTab])) groupFams.set(group, [])
    for (const family of families) {
      const list = groupFams.get(family.group)
      if (list !== undefined) list.push(family)
    }
    const counts = new Map<Group, number>()
    for (const [group, list] of groupFams) counts.set(group, list.length)
    const anyShown = [...counts].some(([group, count]) => count > 0 && isLive(group))
    // `anyLive` drives polling, so it reads the whole board, not the filtered rows.
    const anyLive = needle === '' ? anyShown : buildFamilies(tasks, live).some(family => isLive(family.group))
    return { live, nameOf, workerName, titleOf, groupFams, counts, anyLive }
  }, [board, query])

  // Checklists are not in the board file: poll while something runs. A hidden
  // browser tab skips its polls and catches up the moment it is shown again.
  useEffect(() => {
    if (!model.anyLive) return
    const hidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden'
    const tick = (): void => {
      if (hidden()) return
      setNow(Date.now())
      void controller.load()
    }
    const timer = setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [model.anyLive, controller])

  // Families per tab, for the counts on the segment strip.
  const tabCounts = useMemo(() => {
    const counts = new Map<BoardTab, number>()
    for (const item of TABS) counts.set(item.id, TAB_GROUPS[item.id].reduce((sum, group) => sum + (model.counts.get(group) ?? 0), 0))
    return counts
  }, [model])
  const waiting = model.counts.get('blocked') ?? 0

  // The first board lands on 进行中; when that tab is empty but another one has
  // work, open that one instead, once, so the panel never opens on a blank list.
  const [landed, setLanded] = useState(false)
  useEffect(() => {
    if (board === null || landed) return
    setLanded(true)
    if ((tabCounts.get(tab) ?? 0) > 0) return
    const next = TABS.find(item => (tabCounts.get(item.id) ?? 0) > 0)
    if (next !== undefined) setTab(next.id)
  }, [board, landed, tabCounts, tab])

  const toggle = (id: string): void => {
    setOpen((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /**
   * Fold or unfold one family by hand.
   *
   * `collapsed` is the negative of the old `open`: a key present means "the user
   * closed this one", so a re-render with fresh board data keeps every other
   * family open and leaves this one exactly where the user put it.
   */
  const toggleCollapsed = (key: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const elapsed = (task: TaskView, group: Group): string => {
    const start = Date.parse(task.startedAt ?? '') || startOf(task)
    if (start === 0) return ''
    const end = isLive(group) ? now : Date.parse(task.updatedAt) || now
    return duration(Math.max(0, (end - start) / 1000))
  }

  const todoLine = (task: TaskView): { done: number; total: number } | undefined => {
    const liveTodos: TodoItem[] | undefined = todosOf(sessionList, task.workerSessionId)
    if (liveTodos !== undefined && liveTodos.length > 0) {
      return { done: liveTodos.filter(item => item.status === 'completed').length, total: liveTodos.length }
    }
    const progress = task.todoProgress
    if (progress === undefined || progress.total === 0) return undefined
    return { done: progress.done, total: progress.total }
  }

  /**
   * Secondary column of one row: which partition it lives in, then either how long
   * it has been running or when it settled. Deliberately two short parts so the
   * line never needs an ellipsis; everything else (checklist, worker, tool calls)
   * is in the row's tooltip.
   */
  const metaOf = (task: TaskView, group: Group): string => {
    const parts: string[] = []
    const partition = model.nameOf.get(task.partitionId)
    // A partition that no longer exists has no caption to show; the group already
    // says 已失效分区, so the meta column drops to its time alone.
    if (partition !== undefined) parts.push(partition)
    if (isLive(group)) {
      const spent = elapsed(task, group)
      if (spent !== '') parts.push(spent)
    } else if (group === 'stale') {
      parts.push(t('compact.stale'))
    } else {
      const when = relativeTime(task.updatedAt, now)
      if (when !== '') parts.push(when)
    }
    return parts.join(' · ')
  }

  const openOf = (task: TaskView): (() => void) | undefined =>
    task.workerSessionId !== undefined && onOpenSession !== undefined ? () => { onOpenSession(task.workerSessionId!) } : undefined

  /** A row that opens a Session is a button for the keyboard too: Tab to it, Enter or Space opens. */
  const linkProps = (click: (() => void) | undefined) => click === undefined ? {} : {
    'data-link': '',
    role: 'button',
    tabIndex: 0,
    onClick: click,
    onKeyDown: (event: { key: string; target: unknown; currentTarget: unknown; preventDefault(): void }) => {
      if (event.target !== event.currentTarget) return
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); click() }
    },
  }

  const workerNameOf = (task: TaskView): string =>
    (task.workerId === undefined ? undefined : model.workerName.get(task.workerId) ?? task.workerId) ?? ''

  /** Everything the row cannot show in one line, for the native tooltip. */
  const tooltipOf = (task: TaskView, group: Group, extra: readonly string[] = []): string => {
    const who = group === 'running' || group === 'queued' || group === 'blocked' ? workerNameOf(task) : ''
    return [
      task.title,
      `${task.id} · ${task.hostState ?? task.state}`,
      model.nameOf.get(task.partitionId) ?? task.partitionId,
      who === '' ? undefined : who,
      ...extra,
      (() => {
        const todo = todoLine(task)
        return todo === undefined ? undefined : t('todo.progress', { done: todo.done, total: todo.total })
      })(),
      task.toolCalls !== undefined && task.toolCalls > 0
        ? `${t('compact.calls', { n: task.toolCalls })}${task.lastTool === undefined ? '' : ` · ${task.lastTool}`}`
        : undefined,
      task.lastActivityAt === undefined ? undefined : ago(task.lastActivityAt, now),
    ].filter((line): line is string => line !== undefined && line !== '').join('\n')
  }

  /** Status word of one row: the badge's colour alone is not a caption. */
  const statusOf = (task: TaskView): { key: string; tone: StatusTone } => {
    const key = statusKeyOf(task, model.live)
    return { key, tone: key.replace('status.', '') as StatusTone }
  }

  /** One indented child row: a worker the headline task dispatched. */
  const childRow = (task: TaskView, group: Group) => {
    const click = openOf(task)
    const status = statusOf(task)
    return (
      <div key={task.id} className="dshrc-child" data-child={task.id}>
        <div className="dshrc-row dshrc-sub" data-group={group} data-task={task.id}
          {...linkProps(click)} title={tooltipOf(task, group, orderLines(task))}>
          <span className="dshrc-rt">{task.title}</span>
          {task.stage !== undefined && <span className="dshrc-tag" data-tone="stage">{t('order.stage', { n: task.stage })}</span>}
          <span className="dshrc-rm">{metaOf(task, group)}</span>
          <span className="dshrc-id">{shortId(task.id)}</span>
          {rowActs(task, group)}
          <Status tone={status.tone} label={t(status.key)} />
        </div>
        {group === 'suspended' && suspendLine(task)}
        {group === 'queued' && waitLine(task)}
        {suspending === task.id && suspendForm(task)}
      </div>
    )
  }

  /** Names of task ids, for a line a person reads: titles where the board has them. */
  const namesOf = (ids: readonly string[]): string =>
    ids.map(id => model.titleOf.get(id) ?? shortId(id)).join('、')

  /** Tooltip lines about order and suspension. */
  const orderLines = (task: TaskView): string[] => {
    const lines: string[] = []
    if (task.stage !== undefined) lines.push(t('order.stage', { n: task.stage }))
    if (task.dependsOn !== undefined && task.dependsOn.length > 0) lines.push(t('order.after', { ids: task.dependsOn.join(', ') }))
    if (task.waitingFor !== undefined && task.waitingFor.length > 0) lines.push(t('order.waiting', { ids: task.waitingFor.join(', ') }))
    return lines
  }

  /** Whether any other row names this one as its parent. */
  const hasChildren = (task: TaskView): boolean => (board?.tasks ?? []).some(other => other.parentId === task.id)

  /**
   * A stop asks twice: the first click arms the button (it turns red and says
   * 确认停止?), the second within a few seconds sends it.
   */
  const stop = (task: TaskView, action: 'cancel' | 'cancel_tree'): void => {
    const key = `${task.id}:${action}`
    if (arming !== key) { setArming(key); return }
    setArming(null)
    void act(task, action)
  }

  /**
   * Actions of one row: 停止 and 挂起 for open work, 停止整个需求 on a row
   * that has tasks under it, 重试 for a failure or a stop. They act on that
   * row's own task, so a family row acts on its headline task and each worker
   * row on its worker.
   */
  const rowActs = (task: TaskView, group: Group) => {
    if (!controller.canControl) return null
    const open = group === 'running' || group === 'queued' || group === 'blocked' || group === 'suspended'
    const canSuspend = group === 'running' || group === 'queued'
    const canRetry = group === 'failed' || group === 'cancelled'
    const canStopTree = open && hasChildren(task)
    if (!open && !canRetry) return null
    const anyBusy = [...busy].some(key => key.startsWith(`${task.id}:`))
    const armed = (action: string): boolean => arming === `${task.id}:${action}`
    return (
      <span className="dshrc-acts-row" data-busy={anyBusy || suspending === task.id || arming?.startsWith(`${task.id}:`) === true ? '' : undefined}
        onClick={(event) => { event.stopPropagation() }}>
        {canSuspend && (
          <button type="button" className="dshrc-act" title={t('act.suspendHint')}
            aria-expanded={suspending === task.id} disabled={anyBusy}
            onClick={() => { openSuspend(task) }}>
            {t('act.suspend')}
          </button>
        )}
        {open && (
          <button type="button" className="dshrc-act" data-tone="stop" data-armed={armed('cancel') ? '' : undefined}
            title={t('act.stopHint')} disabled={anyBusy}
            onClick={() => { stop(task, 'cancel') }}>
            {armed('cancel') ? t('act.confirmStop') : t('act.cancel')}
          </button>
        )}
        {canStopTree && (
          <button type="button" className="dshrc-act" data-tone="stop" data-armed={armed('cancel_tree') ? '' : undefined}
            title={t('act.stopTreeHint')} disabled={anyBusy}
            onClick={() => { stop(task, 'cancel_tree') }}>
            {armed('cancel_tree') ? t('act.confirmStop') : t('act.cancel_tree')}
          </button>
        )}
        {canRetry && (
          <button type="button" className="dshrc-act" title={t('act.retryHint')} disabled={anyBusy}
            onClick={() => { void act(task, 'retry') }}>
            {t('act.retry')}
          </button>
        )}
      </span>
    )
  }

  /** Inline 挂起 form: a reason, and optionally the prerequisite to create first. */
  const suspendForm = (task: TaskView) => (
    <form className="dshrc-sform" data-suspend-form={task.id}
      onClick={(event) => { event.stopPropagation() }}
      onSubmit={(event) => { event.preventDefault(); void submitSuspend(task) }}>
      <label>
        {t('susp.form.reason')}
        <input value={formReason} placeholder={t('susp.form.reasonHint')} autoFocus
          onChange={(event) => { setFormReason(event.target.value); setFormError('') }} />
      </label>
      <label>
        {t('susp.form.prereq')}
        <input value={formPrereq} onChange={(event) => { setFormPrereq(event.target.value) }} />
        <span className="dshrc-sform-hint">{t('susp.form.prereqHint')}</span>
      </label>
      {formError !== '' && <span className="dshrc-sform-err" role="alert">{formError}</span>}
      <div className="dshrc-sform-btns">
        <button type="button" className="dshrc-hold-btn" onClick={() => { setSuspending(null) }}>{t('susp.form.cancel')}</button>
        <button type="submit" className="dshrc-err-btn" disabled={busy.has(`${task.id}:suspend`)}>{t('susp.form.submit')}</button>
      </div>
    </form>
  )

  /** Second line of a queued row the task order holds back: what it waits for. */
  const waitLine = (task: TaskView) => {
    const ids = task.waitingFor ?? []
    if (ids.length === 0) return null
    return (
      <div className="dshrc-wait" data-wait={task.id}>
        <span className="dshrc-wait-text" title={ids.join('\n')}>{t('order.waiting', { ids: namesOf(ids) })}</span>
      </div>
    )
  }

  /** Second line of a suspended row: why, what it waits for, and 恢复 to go on now. */
  const suspendLine = (task: TaskView) => {
    const why = task.suspendReason ?? task.resumeNote ?? ''
    const ids = task.waitingOn ?? []
    const head = why === '' ? t('susp.noReason') : t('susp.reason', { reason: why })
    const text = ids.length === 0 ? head : `${head} · ${t('susp.waitingOn', { ids: namesOf(ids) })}`
    const going = resuming.has(task.id)
    const wired = controller.canControl
    return (
      <div className="dshrc-hold" data-suspended={task.id}>
        <span className="dshrc-hold-why" title={text}>{text}</span>
        <button type="button" className="dshrc-hold-btn" disabled={going || !wired}
          title={wired ? t('susp.resumeHint') : t('hold.notWired')}
          onClick={(event) => { event.stopPropagation(); void resume(task) }}>
          {going ? t('hold.resuming') : t('hold.resume')}
        </button>
      </div>
    )
  }

  /**
   * One family row: the headline task, how many workers it dispatched, and —
   * unless the user folded it by hand — those workers indented underneath.
   *
   * A family is one node of the progress tree. The caption counts the node, and
   * the chip says how many tasks are behind it, so "进行中 3" and the three rows
   * on screen are the same number. Open is the default: `expanded` is the
   * absence of a manual fold, not the presence of a click, and the chip's
   * `aria-expanded` reads the same value the rows are rendered from, so the two
   * can never disagree — not when a family loses its workers (the chip is gone),
   * not when the count changes, not when a `f:` key outlives its family.
   */
  const familyRow = (family: Family) => {
    const group = family.group
    const click = openOf(family.root)
    const hidden = family.members.filter(task => task.id !== family.root.id)
    const foldKey = `${FAMILY_FOLD}${family.key}`
    const expanded = !collapsed.has(foldKey)
    // The rep's own second line shows here unless its worker row is on screen and shows it.
    const repHere = family.rep.id === family.root.id || !expanded
    const status = statusOf(family.rep)
    const extra: string[] = []
    if (hidden.length > 0) extra.push(t('compact.family', { n: family.members.length }))
    if (family.attempt > 1) extra.push(t('task.attempt', { count: family.attempt }))
    if (family.reason !== undefined) extra.push(family.reason)
    extra.push(...orderLines(family.root))
    return (
      <div key={family.key} className="dshrc-family" data-family={family.key} data-group={group}>
        <div className="dshrc-row" data-group={group} data-task={family.root.id}
          {...linkProps(click)} title={tooltipOf(family.root, group, extra)}>
          <span className="dshrc-main">
            <span className="dshrc-rt">{family.root.title}</span>
            <span className="dshrc-meta">
              <span className="dshrc-rm">{metaOf(family.rep, group)}</span>
              <span className="dshrc-id">{shortId(family.root.id)}</span>
            </span>
          </span>
          {family.attempt > 1 && (
            <span className="dshrc-tag" data-tone="attempt">{t('compact.retry', { n: family.attempt })}</span>
          )}
          {hidden.length > 0 && (
            <button type="button" className="dshrc-chip" aria-expanded={expanded}
              aria-label={t('compact.workers', { n: hidden.length })}
              title={t('compact.family', { n: family.members.length })}
              onClick={(event) => { event.stopPropagation(); toggleCollapsed(foldKey) }}>
              <Icon className="dshrc-caret" d={CARET} open={expanded} />
              <span className="dshrc-chip-text">{t('compact.workers', { n: hidden.length })}</span>
            </button>
          )}
          {rowActs(family.root, groupOfTask(family.root, model.live))}
          <Status tone={status.tone} label={t(status.key)} />
        </div>
        {group === 'blocked' && holdLine(family.rep)}
        {group === 'suspended' && repHere && suspendLine(family.rep)}
        {group === 'queued' && repHere && waitLine(family.rep)}
        {suspending === family.root.id && suspendForm(family.root)}
        {expanded && hidden.map(task => childRow(task, groupOfTask(task, model.live)))}
      </div>
    )
  }

  /**
   * Second line of a parked row: why it is parked and a 恢复 button.
   *
   * The reason is the Host's `resumeNote` (what `task_control block` wrote from
   * its `value`), falling back to `error`. It is one ellipsised line with the
   * full text in the tooltip, so a long note never widens the panel.
   */
  const holdLine = (task: TaskView) => {
    const why = task.resumeNote ?? task.error ?? ''
    const busy = resuming.has(task.id)
    const failure = resumeError.get(task.id)
    const wired = controller.canControl
    return (
      <div className="dshrc-hold" data-hold={task.id}>
        <span className="dshrc-hold-why" title={why === '' ? undefined : why}>
          {why === '' ? t('hold.noReason') : t('hold.reason', { reason: why })}
        </span>
        {failure !== undefined && <span className="dshrc-hold-err" title={failure}>{t('hold.resumeFailedShort')}</span>}
        <button type="button" className="dshrc-hold-btn" disabled={busy || !wired}
          title={wired ? t('hold.resumeHint') : t('hold.notWired')}
          onClick={(event) => { event.stopPropagation(); void resume(task) }}>
          {busy ? t('hold.resuming') : t('hold.resume')}
        </button>
      </div>
    )
  }

  /** One request's progress: name, count, a segmented bar and what is left. */
  const progressItem = (group: GroupProgressView) => {
    const total = Math.max(1, group.total)
    const part = (n: number): string => `${String(Math.round((n / total) * 1000) / 10)}%`
    const rest: string[] = []
    if (group.running > 0) rest.push(t('progress.running', { n: group.running }))
    if (group.waiting > 0) rest.push(t('progress.waiting', { n: group.waiting }))
    if (group.suspended > 0) rest.push(t('progress.suspended', { n: group.suspended }))
    if (group.failed > 0) rest.push(t('progress.failed', { n: group.failed }))
    const line = t('progress.line', { done: group.finished, total: group.total })
    return (
      <div key={group.rootId} className="dshrc-prog-item" data-progress-root={group.rootId}>
        <div className="dshrc-prog-top">
          <span className="dshrc-prog-name" title={group.subject}>{group.subject}</span>
          <span className="dshrc-prog-num">{line}</span>
        </div>
        <div className="dshrc-bar" role="progressbar" aria-valuemin={0} aria-valuemax={group.total}
          aria-valuenow={group.finished} aria-label={`${group.subject} ${line}`}>
          {group.finished > 0 && <span data-k="done" style={{ width: part(group.finished) }} />}
          {group.running > 0 && <span data-k="run" style={{ width: part(group.running) }} />}
          {group.suspended > 0 && <span data-k="susp" style={{ width: part(group.suspended) }} />}
          {group.failed > 0 && <span data-k="fail" style={{ width: part(group.failed) }} />}
        </div>
        {rest.length > 0 && <span className="dshrc-prog-sub">{rest.join(' · ')}</span>}
      </div>
    )
  }

  /** Requests still under way that split into more than one task. */
  const progressBlock = (list: readonly GroupProgressView[]) => {
    const underway = list.filter(group => !group.complete && group.total > 1).slice(0, 4)
    if (underway.length === 0) return null
    return (
      <section className="dshrc-prog" data-progress aria-label={t('progress.title')}>
        <span className="dshrc-prog-h">{t('progress.title')}</span>
        {underway.map(progressItem)}
      </section>
    )
  }

  /** The router's latest progress notices (the same lines the war room receives). */
  const noticeBlock = (list: readonly NoticeView[]) => {
    if (list.length === 0) return null
    const shown = list.slice(0, 5)
    return (
      <section className="dshrc-nt" data-notices aria-label={t('notices.title')}>
        <span className="dshrc-nt-h">{t('notices.title')}</span>
        <ul className="dshrc-nt-list">
          {shown.map((item, index) => (
            <li key={`${item.at}-${String(index)}`} className="dshrc-nt-item">
              <span className="dshrc-nt-time" title={item.at}>{clockTime(item.at)}</span>
              <span className="dshrc-nt-text">{item.text}</span>
            </li>
          ))}
        </ul>
        {list.length > shown.length && <span className="dshrc-prog-sub">{t('notices.more', { n: list.length - shown.length })}</span>}
      </section>
    )
  }

  /** One captioned group: name, family count, then its rows (folded past PAGE). */
  const groupBlock = (group: Group) => {
    const list = model.groupFams.get(group) ?? []
    if (list.length === 0) return null
    const foldKey = `g:${group}`
    const more = open.has(foldKey)
    const shown = more ? list : list.slice(0, PAGE)
    // The finished pile is history: it opens folded, so old work never buries what
    // is happening now. Every group header stays clickable to fold or unfold.
    const closed = folded.has(group)
    const tasks = list.reduce((sum, family) => sum + family.members.length, 0)
    // The caption counts every top-level family in the bucket. When the bucket is
    // folded or cut at PAGE, say so next to the number so it matches the rows.
    const visible = closed ? 0 : shown.length
    const hint = closed
      ? t('compact.foldedHint', { n: list.length })
      : visible < list.length ? t('compact.shown', { n: visible, m: list.length }) : ''
    return (
      <section key={group} className="dshrc-group" data-section={group} data-folded={closed ? '' : undefined}>
        <button type="button" className="dshrc-gh" aria-expanded={!closed}
          onClick={() => { toggleFolded(group) }} title={t('compact.familyTotal', { n: tasks })}>
          <Icon className="dshrc-gcaret" d={CARET} open={!closed} />
          <span className="dshrc-gn">{t(GROUP_KEY[group])}</span>
          <span className="dshrc-gc">{list.length}</span>
          {hint !== '' && <span className="dshrc-gshown" data-shown={visible} data-total={list.length}>{hint}</span>}
        </button>
        {!closed && shown.map(familyRow)}
        {!closed && list.length > PAGE && (
          <button type="button" className="dshrc-fold" aria-expanded={more} onClick={() => { toggle(foldKey) }}>
            {more ? t('compact.less') : t('compact.more', { n: list.length - PAGE })}
          </button>
        )}
      </section>
    )
  }

  const groups = TAB_GROUPS[tab]
  const shownCount = groups.reduce((sum, group) => sum + (model.counts.get(group) ?? 0), 0)
  const failed = state.status === 'error'
  const lastOk = board === null ? '' : clockTime(board.fetchedAt)

  return (
    <div className="dshrc" data-router-compact data-tab={tab}>
      <style>{STYLE}</style>
      <header className="dshrc-head">
        <h2 className="dshrc-title">{t('board.title')}</h2>
        <div className="dshrc-acts">
          <button type="button" className="dshrc-ico" onClick={refresh} data-busy={refreshing ? '' : undefined}
            title={t(refreshing ? 'board.refreshing' : 'board.refresh')} aria-label={t(refreshing ? 'board.refreshing' : 'board.refresh')}>
            <Icon d={ICON_REFRESH} />
          </button>
          {onOpenWarRoom !== undefined && (
            <button type="button" className="dshrc-ico" onClick={onOpenWarRoom}
              title={t('board.newTask')} aria-label={t('board.newTask')}>
              <Icon d={ICON_PLUS} />
            </button>
          )}
          {onClose !== undefined && (
            <button type="button" className="dshrc-ico" onClick={onClose}
              title={t('board.close')} aria-label={t('board.close')}>
              <Icon d={ICON_CLOSE} />
            </button>
          )}
        </div>
      </header>
      <div className="dshrc-tabs" role="tablist" aria-label={t('panel.title')}>
        {TABS.map(item => (
          <button key={item.id} type="button" role="tab" className="dshrc-tab"
            data-on={tab === item.id ? '' : undefined} aria-selected={tab === item.id}
            onClick={() => { setTab(item.id) }}>
            {t(item.key)}
            {(tabCounts.get(item.id) ?? 0) > 0 && <span className="dshrc-tab-n">{tabCounts.get(item.id)}</span>}
            {item.id === 'active' && waiting > 0 && (
              <span className="dshrc-tab-flag" title={t('seg.waiting', { n: waiting })} aria-label={t('seg.waiting', { n: waiting })} />
            )}
          </button>
        ))}
        <input className="dshrc-find" type="search" value={query} placeholder={t('board.find')} aria-label={t('board.find')}
          onChange={(event) => { setQuery(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Escape') setQuery('') }} />
      </div>
      {failed && (
        <div className="dshrc-err" role="alert" data-router-error>
          <span className="dshrc-err-text">
            <span className="dshrc-err-msg">{t('board.error', { message: state.error ?? '' })}</span>
            {lastOk !== '' && <span className="dshrc-err-stale">{t('board.lastOk', { time: lastOk })}</span>}
          </span>
          <button type="button" className="dshrc-err-btn" onClick={refresh} disabled={refreshing}>
            {t('board.retry')}
          </button>
        </div>
      )}
      {board !== null && board.origin === 'mock' && (
        <div className="dshrc-sample" data-router-sample title={t('board.mock.hint')}>{t('board.mock')}</div>
      )}
      {notice !== null && (
        <div className="dshrc-notice" role="status" data-tone={notice.tone}>{notice.text}</div>
      )}
      <div className="dshrc-list">
        {board === null
          ? <div className="dshrc-empty">{failed ? t('board.emptyOnError') : t('board.loading')}</div>
          : (
              <>
                {tab === 'active' && progressBlock(board.groups ?? [])}
                {shownCount === 0
                  ? <div className="dshrc-empty">{t('compact.empty')}</div>
                  : groups.map(groupBlock)}
                {tab === 'active' && noticeBlock(board.notices ?? [])}
              </>
            )}
      </div>
    </div>
  )
}
