/**
 * The agent hub dispatch panel (read-only).
 *
 * Top: task counts per status, agents online, pending enrollment requests.
 * Then: the agent list, the enrollment request list, and the task list with a
 * status / agent filter; clicking a task opens its detail (instruction, inputs,
 * result summary, output file names, history).
 *
 * Worker presence (protocol v2 §9): each agent shows one of five states
 * (online / pending / offline / left / revoked, inferred from `online` /
 * `revoked` when an older bridge sends no `status`), its client version and
 * "最后心跳 n 前" / "离线 n 分钟"; online agents come first, the Agent caption
 * adds the offline count, and history entries of a presence requeue
 * (`worker-lost` / `worker-offline`, or `agent-offline`) are marked warn.
 *
 * Every number comes from the login-guarded GET routes of dsh-host-agent-hub.
 * The panel sends no write request at all: DSH stays the only controller
 * (task_dispatch / task_cancel / task_retry / agent_approve ... in chat).
 * It refreshes every {@link REFRESH_MS} while visible, plus on demand.
 *
 * Two forms share the data and the hooks:
 *   - the page (`main` panel): title, roomy overview, three tables, and the
 *     task detail opening under the task table;
 *   - `embedded` (the router board's 「Agent」 tab, about 420px wide): no page
 *     title or page margins, a one-line toolbar, three compact stat cells in a
 *     row, the seven task statuses as one horizontally scrolling strip of pills,
 *     and Agent / 加入申请 / 任务 as foldable groups of two-line rows. A task's
 *     detail opens inside the list, right under its row. Auto-refresh keeps the
 *     same period and also pauses while the tab is off screen (unmounted, the
 *     board hidden, or the browser tab hidden), catching up when it is back.
 *
 * Groups rather than a second segment strip: the board above already is a
 * segment strip (现在 / 已结束 / 工作区 / Agent), and tabs inside a tab hide two
 * of the three lists behind a click; folds keep them on one scroll, use the
 * board's own group-caption pattern, and remember what the person folded for
 * the browser session.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

import { AGENT_STATUSES, TASK_STATUSES } from './contract.ts'
import type { AgentStatus, AgentView, AgentsDoc, HistoryEvent, Overview, RequestView, RequestsDoc, SessionDoc, SessionEntry, TaskDetail, TaskDoc, TaskFilter, TaskRow, TaskStatus, TasksDoc } from './contract.ts'
import { LANES, agentGroups, clearActionOf, fallbackReason, fallbackTasks, laneOf, lanesOf, registeredBy, selfWorkers, stageOf, timeline } from './desk.ts'
import type { AgentGroup, Lane, SelfWorker } from './desk.ts'
import { absolute, agentCounts, agentStatus, bytes, clock, percent, presence, relative, sortAgents, until } from './format.ts'
import { HubIcon } from './HubIcon.tsx'
import type { Translate } from './locales.ts'
import { SourceError, ackTask, cancelTask, fetchAgents, fetchOverview, fetchRequests, fetchSession, fetchTask, fetchTasks } from './source.ts'

/** Auto-refresh period. */
export const REFRESH_MS = 10_000

/** Props of the page (injected by the `main` slot registration, or by the board tab). */
export interface AgentHubPageProps {
  readonly t: Translate
  /** Draw the compact form for the router board's tab body instead of the page. */
  readonly embedded?: boolean
  /** Receives every overview that arrives (keeps the board tab's badge current). */
  readonly onOverview?: (overview: Overview) => void
}

interface Section<T> {
  readonly data?: T
  readonly error?: unknown
  readonly at?: number
}

interface Board {
  readonly overview: Section<Overview>
  readonly agents: Section<AgentsDoc>
  readonly tasks: Section<TasksDoc>
  readonly requests: Section<RequestsDoc>
  /** Last time at least one document arrived. */
  readonly loadedAt?: number
  /** First failure of the last round, if any. */
  readonly lastError?: unknown
  readonly refreshing: boolean
  /** True until the first round settles. */
  readonly first: boolean
}

const EMPTY: Board = { overview: {}, agents: {}, tasks: {}, requests: {}, refreshing: false, first: true }

const REQUEST_FILTERS = ['pending', 'approved', 'rejected', 'expired', 'all'] as const
const LIMITS = [20, 50, 100, 200] as const

function merge<T>(previous: Section<T>, outcome: PromiseSettledResult<T>, now: number): Section<T> {
  return outcome.status === 'fulfilled'
    ? { data: outcome.value, at: now }
    : { data: previous.data, at: previous.at, error: outcome.reason }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whole-page failure text, chosen by HTTP status. */
function failureText(error: unknown, t: Translate): string {
  const status = error instanceof SourceError ? error.status : undefined
  if (status === 401) return t('error.login')
  if (status === 403) return t('error.forbidden')
  return `${t('error.unavailable')} (${messageOf(error)})`
}

/**
 * Load the four documents together; keep old data on failure.
 * @param filter - task-list filter.
 * @param requestStatus - enrollment-request filter.
 * @param auto - auto-refresh switch.
 * @param active - false while the view is off screen: the timer stops, and the
 *   first round after it comes back runs at once. Always true for the page.
 * @param onOverview - receives each overview that arrives.
 */
function useBoard(
  filter: TaskFilter,
  requestStatus: string,
  auto: boolean,
  active: boolean = true,
  onOverview?: (overview: Overview) => void,
): { board: Board; load: (manual: boolean) => void } {
  const [board, setBoard] = useState<Board>(EMPTY)
  const ticket = useRef(0)
  const report = useRef(onOverview)
  useEffect(() => { report.current = onOverview }, [onOverview])

  const load = useCallback((manual: boolean) => {
    ticket.current += 1
    const mine = ticket.current
    if (manual) setBoard(previous => ({ ...previous, refreshing: true }))
    void Promise.allSettled([fetchOverview(), fetchAgents(), fetchTasks(filter), fetchRequests(requestStatus)]).then((outcomes) => {
      if (mine !== ticket.current) return
      const [o, a, tk, r] = outcomes
      const now = Date.now()
      if (o.status === 'fulfilled') report.current?.(o.value)
      const failed = outcomes.find((x): x is PromiseRejectedResult => x.status === 'rejected')
      const anyOk = outcomes.some(x => x.status === 'fulfilled')
      setBoard(previous => ({
        overview: merge(previous.overview, o, now),
        agents: merge(previous.agents, a, now),
        tasks: merge(previous.tasks, tk, now),
        requests: merge(previous.requests, r, now),
        loadedAt: anyOk ? now : previous.loadedAt,
        lastError: failed?.reason,
        refreshing: false,
        first: false,
      }))
    })
  }, [filter, requestStatus])

  useEffect(() => { load(false) }, [load])

  // Back on screen after a pause (embedded only): catch up at once.
  const wasActive = useRef(active)
  useEffect(() => {
    if (active && !wasActive.current && document.visibilityState !== 'hidden') load(false)
    wasActive.current = active
  }, [active, load])

  useEffect(() => {
    if (!auto || !active) return undefined
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') load(false) }, REFRESH_MS)
    const onVisibility = (): void => { if (document.visibilityState !== 'hidden') load(false) }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [auto, active, load])

  // Drop answers that land after the page is gone.
  useEffect(() => () => { ticket.current += 1 }, [])

  return { board, load }
}

interface DetailState extends Section<TaskDoc> {
  readonly id?: string
}

/** Load one task's detail; re-read whenever the board refreshes. */
function useDetail(taskId: string | undefined, tick: number | undefined): DetailState {
  const [detail, setDetail] = useState<DetailState>({})
  const ticket = useRef(0)
  useEffect(() => {
    ticket.current += 1
    const mine = ticket.current
    if (taskId === undefined) {
      setDetail({})
      return undefined
    }
    fetchTask(taskId).then(
      (doc) => { if (mine === ticket.current) setDetail({ id: taskId, data: doc, at: Date.now() }) },
      (error: unknown) => {
        if (mine !== ticket.current) return
        setDetail(previous => ({ id: taskId, data: previous.id === taskId ? previous.data : undefined, at: previous.at, error }))
      },
    )
    return undefined
  }, [taskId, tick])
  useEffect(() => () => { ticket.current += 1 }, [])
  return detail
}

function statusLabel(status: string, t: Translate): string {
  return t(`status.${status}`)
}

/** Locale key of each agent presence status. */
const AGENT_STATUS_KEY: Readonly<Record<AgentStatus, string>> = {
  online: 'agent.status.online',
  pending: 'agent.status.pending',
  offline: 'agent.status.offline',
  left: 'agent.status.left',
  revoked: 'agent.status.revoked',
}

/** State dot and text of one agent; the tone is the status itself (styles.ts). */
function AgentBadge({ agent, t }: { readonly agent: AgentView; readonly t: Translate }): ReactNode {
  const status = agentStatus(agent)
  return <span className="dah-badge" data-tone={status}>{t(AGENT_STATUS_KEY[status])}</span>
}

/** "在线 2 · 离线 1 · …" for the statuses `keep` accepts, in display order. */
function countsText(counts: Readonly<Record<AgentStatus, number>>, t: Translate, keep: (status: AgentStatus) => boolean): string {
  return AGENT_STATUSES.filter(keep).map(status => t('stat.online.part', { label: t(AGENT_STATUS_KEY[status]), n: counts[status] })).join(' · ')
}

/** Offline (incl. left) count beside the Agent caption; nothing when 0. */
function OfflineNote({ counts, t }: { readonly counts: Readonly<Record<AgentStatus, number>>; readonly t: Translate }): ReactNode {
  const n = counts.offline + counts.left
  if (n <= 0) return null
  return (
    <span className="dah-count-note" title={t('agents.offline.hint', { offline: counts.offline, left: counts.left })}>
      {t('agents.offline', { n })}
    </span>
  )
}

/** Presence-related requeue reasons the hub writes into a task's history (hub.js `requeue`). */
type PresenceEvent = 'worker-lost' | 'worker-offline' | 'agent-offline'

const PRESENCE_RE = /\b(worker-lost|worker-offline|agent-offline)\b/

const PRESENCE_KEY: Readonly<Record<PresenceEvent, string>> = {
  'worker-lost': 'history.worker-lost',
  'worker-offline': 'history.worker-offline',
  'agent-offline': 'history.agent-offline',
}

/** Which presence reason a history entry carries, read from its event and message text only. */
function presenceEvent(event: HistoryEvent): PresenceEvent | undefined {
  const match = PRESENCE_RE.exec(`${event.event ?? ''} ${event.message ?? ''}`)
  const found = match?.[1]
  return found === 'worker-lost' || found === 'worker-offline' || found === 'agent-offline' ? found : undefined
}

/** A history entry's text; the hub's own English sentence for a task DSH runs itself is said in the page's language. */
function historyText(event: HistoryEvent, t: Translate): string {
  const own = registeredBy(event)
  if (own === undefined) return event.message ?? ''
  return own.executor === undefined ? t('history.registered', { by: own.by }) : t('history.registered.at', { by: own.by, executor: own.executor })
}

/** Enter / Space activate a focusable row. */
function onActivate(run: () => void): (event: KeyboardEvent<HTMLElement>) => void {
  return (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      run()
    }
  }
}

function Chips({ items, empty }: { readonly items: readonly string[]; readonly empty: string }): ReactNode {
  if (items.length === 0) return <span className="dah-muted">{empty}</span>
  return (
    <span className="dah-chips">
      {items.map(item => <span key={item} className="dah-chip">{item}</span>)}
    </span>
  )
}

function SectionError({ error, t }: { readonly error: unknown; readonly t: Translate }): ReactNode {
  if (error === undefined) return null
  return <div className="dah-alert" role="alert">{t('error.section', { error: messageOf(error) })}</div>
}

/** Quiet, centred empty / loading state with a faded hub glyph (no grey box). */
function Empty({ children, page = false }: { readonly children: ReactNode; readonly page?: boolean }): ReactNode {
  return (
    <div className="dah-empty" data-size={page ? 'page' : undefined}>
      <span className="dah-empty-icon" aria-hidden="true"><HubIcon size={28} /></span>
      <span>{children}</span>
    </div>
  )
}

/**
 * Whether an element is on screen, for the embedded form's refresh pause.
 *
 * The board keeps its body mounted while the right Sidebar is collapsed or shows
 * another tab, so unmounting alone does not stop the timer; an
 * IntersectionObserver also sees `display: none` ancestors. Without the API (or
 * when disabled) it answers true, i.e. the page's behaviour.
 * @param target - the element to watch.
 * @param enabled - watch at all.
 * @returns whether the element intersects the viewport.
 */
function useShown(target: { readonly current: Element | null }, enabled: boolean): boolean {
  const [shown, setShown] = useState(true)
  useEffect(() => {
    if (!enabled) {
      setShown(true)
      return undefined
    }
    const node = target.current
    if (node === null || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1]
      if (last !== undefined) setShown(last.isIntersecting)
    })
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [target, enabled])
  return shown
}

/** The embedded form's foldable groups. */
type Part = 'agents' | 'requests' | 'tasks' | 'fallback' | 'ended'

const PARTS: readonly Part[] = ['agents', 'requests', 'tasks', 'fallback', 'ended']

/** What the person folded or opened by hand; absent = the default. */
type Folds = Readonly<Partial<Record<Part, boolean>>>

/** sessionStorage key: hand folds survive a tab switch and a reload, not the session. */
const FOLDS_KEY = 'dah.embed.open'

/** Read the hand folds; anything unreadable means "no choice made". */
function readFolds(): Folds {
  try {
    const raw = globalThis.sessionStorage?.getItem(FOLDS_KEY)
    if (raw === null || raw === undefined || raw === '') return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Partial<Record<Part, boolean>> = {}
    for (const part of PARTS) {
      const value = (parsed as Record<string, unknown>)[part]
      if (typeof value === 'boolean') out[part] = value
    }
    return out
  } catch {
    return {}
  }
}

/** Remember the hand folds; blocked storage only means a reload forgets them. */
function writeFolds(folds: Folds): void {
  try {
    globalThis.sessionStorage?.setItem(FOLDS_KEY, JSON.stringify(folds))
  } catch {
    // Storage is a convenience.
  }
}

/** A non-empty string. */
const present = (part: string | undefined): part is string => part !== undefined && part !== ''

/** 16px caret of a group caption; turns 90° when the group is open. */
function Caret(): ReactNode {
  return (
    <svg className="dah-caret" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M6 4l4 4-4 4" />
    </svg>
  )
}

/** One foldable group of the embedded form: caption button, optional tools, body. */
function EmbeddedFold({ part, title, count, note, open, onToggle, tools, children }: {
  readonly part: Part
  readonly title: string
  readonly count: string
  /** Quiet text after the count (the Agent group's offline count). */
  readonly note?: ReactNode
  readonly open: boolean
  readonly onToggle: () => void
  readonly tools?: ReactNode
  readonly children?: ReactNode
}): ReactNode {
  return (
    <section className="dah-group" data-part={part} data-open={open} aria-label={title}>
      <div className="dah-group-head">
        <button type="button" className="dah-group-toggle" aria-expanded={open} onClick={onToggle}>
          <Caret />
          <span className="dah-group-title">{title}</span>
          <span className="dah-count">{count}</span>
          {note}
        </button>
        {open ? tools : null}
      </div>
      {open ? <div className="dah-group-body">{children}</div> : null}
    </section>
  )
}

/** One hub agent: id and state, then platform · mode · load · client version · heartbeat. */
function AgentItem({ agent, titles, now, t, onTask }: {
  readonly agent: AgentView
  /** Task titles by id, so a chip names the work rather than its id. */
  readonly titles?: ReadonlyMap<string, string>
  readonly now: number
  readonly t: Translate
  readonly onTask: (id: string) => void
}): ReactNode {
  const status = agentStatus(agent)
  const meta = [
    agent.platform,
    agent.mode,
    // busy / idle is only meaningful while the worker is around.
    agent.reported_status !== undefined && status === 'online' ? t(`agent.${agent.reported_status}`) : undefined,
    t('embed.conc', { n: agent.running_tasks.length, max: agent.max_concurrency ?? 1 }),
    present(agent.version) ? t('agent.version', { v: agent.version }) : undefined,
    presence(agent, t, now),
  ].filter(present)
  const tip = [
    agent.description,
    agent.capabilities.length === 0 ? undefined : `${t('agents.col.caps')}: ${agent.capabilities.join(', ')}`,
    agent.node === undefined ? undefined : `${t('group.node', { name: agent.node })}`,
    agent.last_seen === undefined ? undefined : `${t('agents.col.seen')}: ${absolute(agent.last_seen)}`,
    agent.left_at === undefined ? undefined : `${t('agent.status.left')}: ${absolute(agent.left_at)}`,
  ].filter(present).join('\n')
  return (
    <li className="dah-item">
      <div className="dah-item-row" title={tip === '' ? undefined : tip}>
        <div className="dah-item-top">
          <span className="dah-item-title dah-id">{agent.agent_id}</span>
          <AgentBadge agent={agent} t={t} />
        </div>
        <span className="dah-item-meta">{meta.join(' · ')}</span>
        {agent.running_tasks.length > 0
          ? (
            <span className="dah-chips">
              {agent.running_tasks.map(id => {
                const title = titles?.get(id)
                return title === undefined
                  ? <button key={id} type="button" className="dah-chip dah-id" onClick={() => { onTask(id) }}>{id}</button>
                  : <button key={id} type="button" className="dah-chip" title={id} onClick={() => { onTask(id) }}>{title}</button>
              })}
            </span>
          )
          : null}
      </div>
    </li>
  )
}

/** One DSH partition worker, shown beside the hub agents of its profile. */
function SelfItem({ worker, t, onTask }: {
  readonly worker: SelfWorker
  readonly t: Translate
  readonly onTask: (id: string) => void
}): ReactNode {
  const meta = [
    t('self.busy', { n: worker.tasks.length }),
    worker.quiet > 0 ? t('self.quiet', { n: worker.quiet }) : undefined,
  ].filter(present)
  return (
    <li className="dah-item" data-kind="self">
      <div className="dah-item-row">
        <div className="dah-item-top">
          <span className="dah-item-title dah-id">{worker.id}</span>
          <span className="dah-badge" data-tone="self">{t('self.badge')}</span>
        </div>
        <span className="dah-item-meta">{meta.join(' · ')}</span>
        <span className="dah-chips">
          {worker.tasks.map(task => (
            <button key={task.task_id} type="button" className="dah-chip" title={task.task_id} onClick={() => { onTask(task.task_id) }}>{task.title}</button>
          ))}
        </span>
      </div>
    </li>
  )
}

/** Caption of an agent group. */
function groupTitle(group: Pick<AgentGroup, 'kind' | 'key'>, t: Translate): string {
  if (group.kind === 'profile') return t('group.profile', { name: group.key })
  if (group.kind === 'node') return t('group.node', { name: group.key })
  return t('group.none')
}

/**
 * Embedded agent list: hub agents grouped by DSH profile, DSH's own partition
 * workers (from the local tasks they hold) in the group of their profile, and
 * the dormant agents behind one quiet toggle.
 */
function EmbeddedAgents({ agents, tasks, loaded, now, t, onTask }: {
  readonly agents: readonly AgentView[]
  readonly tasks: readonly TaskRow[]
  readonly loaded: boolean
  readonly now: number
  readonly t: Translate
  readonly onTask: (id: string) => void
}): ReactNode {
  const [showDormant, setShowDormant] = useState(false)
  const { groups, dormant } = useMemo(() => agentGroups(agents), [agents])
  const selves = useMemo(() => selfWorkers(tasks), [tasks])
  const titles = useMemo(() => new Map(tasks.filter(task => task.title !== '').map(task => [task.task_id, task.title])), [tasks])
  // Profiles that only DSH's own workers use still get a group.
  const all: AgentGroup[] = [...groups]
  for (const profile of selves.keys()) {
    if (!all.some(group => group.kind === 'profile' && group.key === profile)) {
      all.push({ key: profile, kind: profile === '' ? 'none' : 'profile', agents: [] })
    }
  }
  if (all.length === 0 && dormant.length === 0) return loaded ? <Empty>{t('agents.empty')}</Empty> : null
  return (
    <>
      {all.map(group => {
        const mine = group.kind === 'profile' ? selves.get(group.key) ?? [] : group.kind === 'none' ? selves.get('') ?? [] : []
        return (
          <div key={`${group.kind}:${group.key}`} className="dah-sub">
            {all.length > 1 || group.kind !== 'none' ? <div className="dah-sub-head">{groupTitle(group, t)}</div> : null}
            <ul className="dah-list">
              {group.agents.map(agent => <AgentItem key={agent.agent_id} agent={agent} titles={titles} now={now} t={t} onTask={onTask} />)}
              {mine.map(worker => <SelfItem key={worker.id} worker={worker} t={t} onTask={onTask} />)}
            </ul>
          </div>
        )
      })}
      {dormant.length > 0
        ? (
          <div className="dah-sub" data-kind="dormant">
            <button type="button" className="dah-link" title={t('dormant.hint')} aria-expanded={showDormant} onClick={() => { setShowDormant(value => !value) }}>
              {showDormant ? t('dormant.hide') : t('dormant.show', { n: dormant.length })}
            </button>
            {showDormant
              ? <ul className="dah-list">{dormant.map(agent => <AgentItem key={agent.agent_id} agent={agent} titles={titles} now={now} t={t} onTask={onTask} />)}</ul>
              : null}
          </div>
        )
        : null}
    </>
  )
}

/** Embedded enrollment requests: agent and status, then request id · platform · origin · age. */
function EmbeddedRequests({ section, status, now, t }: {
  readonly section: Section<RequestsDoc>
  readonly status: string
  readonly now: number
  readonly t: Translate
}): ReactNode {
  const requests: readonly RequestView[] = section.data?.requests ?? []
  if (requests.length === 0) {
    if (section.data === undefined) return null
    return <Empty>{status === 'all' ? t('requests.empty.any') : t('requests.empty', { status: t(`req.${status}`) })}</Empty>
  }
  return (
    <ul className="dah-list">
      {requests.map((request) => {
        const meta = [
          request.request_id,
          [request.platform, request.mode].filter(present).join(' / '),
          present(request.from) ? t('embed.from', { from: request.from }) : undefined,
          relative(request.requested_at, t, now),
        ].filter(present)
        const tip = [
          request.description,
          request.capabilities.length === 0 ? undefined : `${t('requests.col.caps')}: ${request.capabilities.join(', ')}`,
          `${t('requests.col.conc')}: ${String(request.max_concurrency ?? 1)}`,
          `${t('requests.col.at')}: ${absolute(request.requested_at)}`,
        ].filter(present).join('\n')
        return (
          <li key={request.request_id} className="dah-item">
            <div className="dah-item-row" title={tip}>
              <div className="dah-item-top">
                <span className="dah-item-title dah-id">{request.agent_id}</span>
                <span className="dah-badge" data-tone={request.status}>{t(`req.${request.status}`)}</span>
              </div>
              <span className="dah-item-meta">{meta.join(' · ')}</span>
              {present(request.reason) ? <span className="dah-item-note" title={request.reason}>{request.reason}</span> : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/** Where a task came from, in a few words. */
function originText(task: Pick<TaskRow, 'origin' | 'dsh_profile'>, t: Translate): string | undefined {
  const kind = task.origin?.kind
  if (kind === 'local') return present(task.dsh_profile) ? t('origin.local', { profile: task.dsh_profile }) : t('origin.local.any')
  if (kind === 'agent') return t('origin.agent')
  return undefined
}

/** One task row of the 调度台; opens its detail right under itself. */
function TaskItem({ task, on, detail, now, t, onToggle, onChanged }: {
  readonly task: TaskRow
  readonly on: boolean
  readonly detail: ReactNode
  readonly now: number
  readonly t: Translate
  readonly onToggle: (id: string) => void
  readonly onChanged?: () => void
}): ReactNode {
  const progress = percent(task.progress)
  const stage = stageOf(task)
  const holder = task.origin?.kind === 'local'
    ? task.origin.executor ?? task.assigned_to ?? task.agent
    : task.assigned_to !== undefined && task.assigned_to !== task.agent ? `${task.agent} → ${task.assigned_to}` : task.agent
  const meta = [
    holder,
    originText(task, t),
    task.priority === 'normal' ? undefined : t(`priority.${task.priority}`),
    task.attempts > 1 ? t('embed.attempts', { n: task.attempts }) : undefined,
    relative(task.updated_at ?? task.created_at, t, now),
  ].filter(present)
  const note = task.result === undefined
    ? task.message
    : [task.result.error?.code, task.result.needs_input ?? task.result.summary].filter(present).join(' ')
  return (
    <li className="dah-item" data-on={on}>
      <div
        className="dah-item-row" role="button" tabIndex={0} aria-expanded={on}
        onClick={() => { onToggle(task.task_id) }} onKeyDown={onActivate(() => { onToggle(task.task_id) })}
      >
        <div className="dah-item-top">
          <span className="dah-item-title" title={`${task.title}\n${task.task_id}`}>{task.title}</span>
          {stage !== undefined
            ? <span className="dah-badge" data-tone={stage === 'needs_input' || stage === 'blocked' ? 'pending' : task.status}>{t(`stage.${stage}`)}</span>
            : <span className="dah-badge" data-tone={task.status}>{statusLabel(task.status, t)}</span>}
        </div>
        <span className="dah-item-meta" title={absolute(task.created_at)}>{meta.join(' · ')}</span>
        {progress !== undefined && (task.status === 'running' || task.status === 'accepted')
          ? <span className="dah-bar" title={progress}><i style={{ width: progress }} /></span>
          : null}
        {present(note)
          ? <span className="dah-item-note" data-tone={task.result?.error !== undefined ? 'failed' : undefined} title={note}>{note}</span>
          : null}
        {task.quiet === true ? <span className="dah-item-note" data-tone="quiet">{t('task.quiet')}</span> : null}
      </div>
      {onChanged !== undefined && laneOf(task) === 'waiting'
        ? <div className="dah-item-actions"><ClearWaiting task={task} t={t} onDone={onChanged} /></div>
        : null}
      {on ? detail : null}
    </li>
  )
}

/**
 * The 调度台's task list: five lanes (排队 → 已领取 → 进行中 → 等你回复 → 已结束),
 * empty lanes left out; 已结束 folds. A task that is not in the list (opened from
 * an agent's chip) shows its detail on top.
 */
function EmbeddedTasks({ tasks, loaded, history, selected, detail, endedOpen, onEnded, now, t, onToggle, onChanged }: {
  readonly tasks: readonly TaskRow[]
  readonly loaded: boolean
  readonly history: boolean
  readonly selected: string | undefined
  readonly detail: ReactNode
  readonly endedOpen: boolean
  readonly onEnded: () => void
  readonly now: number
  readonly t: Translate
  readonly onToggle: (id: string) => void
  /** A task was put away or cancelled here: read the lists again. */
  readonly onChanged?: () => void
}): ReactNode {
  const lanes = useMemo(() => lanesOf(tasks), [tasks])
  const orphan = selected !== undefined && !tasks.some(task => task.task_id === selected)
  const item = (task: TaskRow): ReactNode => (
    <TaskItem key={task.task_id} task={task} on={selected === task.task_id} detail={detail} now={now} t={t} onToggle={onToggle} onChanged={onChanged} />
  )
  if (history) {
    return (
      <>
        {orphan ? detail : null}
        <p className="dah-note">{t('history.note')}</p>
        {tasks.length === 0
          ? (loaded ? <Empty>{t('history.empty')}</Empty> : null)
          : <ul className="dah-list">{tasks.map(item)}</ul>}
      </>
    )
  }
  return (
    <>
      {orphan ? detail : null}
      {tasks.length === 0 && loaded ? <Empty>{t('tasks.empty.all')}</Empty> : null}
      {LANES.filter(lane => lanes[lane].length > 0).map((lane: Lane) => {
        const rows = lanes[lane]
        const folded = lane === 'ended' && !endedOpen
        return (
          <div key={lane} className="dah-sub" data-lane={lane}>
            {lane === 'ended'
              ? (
                <button type="button" className="dah-sub-head" data-button="true" aria-expanded={!folded} title={t('lane.ended.hint')} onClick={onEnded}>
                  <Caret />
                  {t(`lane.${lane}`)}
                  <span className="dah-count">{String(rows.length)}</span>
                </button>
              )
              : (
                <div className="dah-sub-head">
                  {t(`lane.${lane}`)}
                  <span className="dah-count">{String(rows.length)}</span>
                </div>
              )}
            {folded ? null : <ul className="dah-list">{rows.map(item)}</ul>}
          </div>
        )
      })}
    </>
  )
}

/** Tasks DSH took over itself, with who did it; the reason is in the detail. */
function EmbeddedFallback({ tasks, selected, detail, now, t, onToggle }: {
  readonly tasks: readonly TaskRow[]
  readonly selected: string | undefined
  readonly detail: ReactNode
  readonly now: number
  readonly t: Translate
  readonly onToggle: (id: string) => void
}): ReactNode {
  if (tasks.length === 0) return <Empty>{t('fallback.empty')}</Empty>
  return (
    <ul className="dah-list">
      {tasks.map(task => (
        <TaskItem key={task.task_id} task={{ ...task, message: task.message ?? t('fallback.by', { by: task.fallback_by ?? '' }) }}
          on={selected === task.task_id} detail={detail} now={now} t={t} onToggle={onToggle} />
      ))}
    </ul>
  )
}

/** Agent table. */
function AgentsSection({ agents, section, now, t, onTask }: {
  readonly agents: readonly AgentView[]
  readonly section: Section<AgentsDoc>
  readonly now: number
  readonly t: Translate
  readonly onTask: (id: string) => void
}): ReactNode {
  const { counts } = agentCounts(agents)
  return (
    <section className="dah-section" aria-label={t('agents.title')}>
      <div className="dah-section-head">
        <h2 className="dah-section-title">{t('agents.title')}</h2>
        <span className="dah-count">{`${String(counts.online)} / ${String(agents.length)}`}</span>
        <OfflineNote counts={counts} t={t} />
      </div>
      <SectionError error={section.error} t={t} />
      {agents.length === 0
        ? (section.data !== undefined ? <Empty>{t('agents.empty')}</Empty> : null)
        : (
          <div className="dah-table-wrap">
            <table className="dah-table">
              <thead>
                <tr>
                  <th>{t('agents.col.agent')}</th>
                  <th>{t('agents.col.state')}</th>
                  <th>{t('agents.col.platform')}</th>
                  <th>{t('agents.col.caps')}</th>
                  <th>{t('agents.col.conc')}</th>
                  <th>{t('agents.col.running')}</th>
                  <th>{t('agents.col.seen')}</th>
                </tr>
              </thead>
              <tbody>
                {agents.map(agent => (
                  <tr key={agent.agent_id}>
                    <td>
                      <span className="dah-id">{agent.agent_id}</span>
                      {present(agent.version) ? <span className="dah-sub-line">{t('agent.version', { v: agent.version })}</span> : null}
                      {agent.description !== undefined && agent.description !== ''
                        ? <span className="dah-sub-line dah-clip" title={agent.description}>{agent.description}</span>
                        : null}
                    </td>
                    <td>
                      <AgentBadge agent={agent} t={t} />
                      {agent.reported_status !== undefined && agentStatus(agent) === 'online'
                        ? <span className="dah-sub-line">{t(`agent.${agent.reported_status}`)}</span>
                        : null}
                    </td>
                    <td>
                      {agent.platform ?? t('value.none')}
                      <span className="dah-sub-line">{agent.mode ?? ''}</span>
                    </td>
                    <td><Chips items={agent.capabilities} empty={t('value.none')} /></td>
                    <td className="dah-num">{`${String(agent.running_tasks.length)} / ${String(agent.max_concurrency ?? 1)}`}</td>
                    <td>
                      {agent.running_tasks.length === 0
                        ? <span className="dah-muted">{t('value.none')}</span>
                        : (
                          <span className="dah-chips">
                            {agent.running_tasks.map(id => (
                              <button key={id} type="button" className="dah-chip dah-id" onClick={() => { onTask(id) }}>{id}</button>
                            ))}
                          </span>
                        )}
                    </td>
                    <td className="dah-nowrap" title={absolute(agent.left_at ?? agent.last_seen)}>
                      {agent.last_seen === undefined && agent.left_at === undefined
                        ? <span className="dah-muted">{t('agent.never')}</span>
                        : presence(agent, t, now, false)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  )
}

/** Enrollment request table (no approve button on purpose). */
function RequestsSection({ section, status, onStatus, now, t }: {
  readonly section: Section<RequestsDoc>
  readonly status: string
  readonly onStatus: (status: string) => void
  readonly now: number
  readonly t: Translate
}): ReactNode {
  const requests: readonly RequestView[] = section.data?.requests ?? []
  return (
    <section className="dah-section" aria-label={t('requests.title')}>
      <div className="dah-section-head">
        <h2 className="dah-section-title">{t('requests.title')}</h2>
        <span className="dah-count">{section.data === undefined ? '' : String(requests.length)}</span>
        <span className="dah-spacer" />
        <select className="dah-select" value={status} onChange={(event) => { onStatus(event.target.value) }} aria-label={t('requests.col.status')}>
          {REQUEST_FILTERS.map(value => <option key={value} value={value}>{t(`req.${value}`)}</option>)}
        </select>
      </div>
      <SectionError error={section.error} t={t} />
      {requests.length === 0
        ? (section.data !== undefined
          ? <Empty>{status === 'all' ? t('requests.empty.any') : t('requests.empty', { status: t(`req.${status}`) })}</Empty>
          : null)
        : (
          <div className="dah-table-wrap">
            <table className="dah-table">
              <thead>
                <tr>
                  <th>{t('requests.col.request')}</th>
                  <th>{t('requests.col.agent')}</th>
                  <th>{t('requests.col.platform')}</th>
                  <th>{t('requests.col.caps')}</th>
                  <th>{t('requests.col.conc')}</th>
                  <th>{t('requests.col.from')}</th>
                  <th>{t('requests.col.at')}</th>
                  <th>{t('requests.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {requests.map(request => (
                  <tr key={request.request_id}>
                    <td><span className="dah-id">{request.request_id}</span></td>
                    <td>
                      <span className="dah-id">{request.agent_id}</span>
                      {request.description !== undefined && request.description !== ''
                        ? <span className="dah-sub-line dah-clip" title={request.description}>{request.description}</span>
                        : null}
                    </td>
                    <td>
                      {request.platform ?? t('value.none')}
                      <span className="dah-sub-line">{request.mode ?? ''}</span>
                    </td>
                    <td><Chips items={request.capabilities} empty={t('value.none')} /></td>
                    <td className="dah-num">{String(request.max_concurrency ?? 1)}</td>
                    <td className="dah-nowrap">{request.from !== undefined && request.from !== '' ? request.from : t('value.none')}</td>
                    <td className="dah-nowrap" title={absolute(request.requested_at)}>{relative(request.requested_at, t, now)}</td>
                    <td>
                      <span className="dah-badge" data-tone={request.status}>{t(`req.${request.status}`)}</span>
                      {request.reason !== undefined && request.reason !== ''
                        ? <span className="dah-sub-line dah-clip" title={request.reason}>{request.reason}</span>
                        : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  )
}

/** One task's detail block. */
/** Session entries per read. */
const SESSION_PAGE = 200

/**
 * A task's stored session (what the executor and the task said, tool calls,
 * notes), read on demand in pages. The hub redacted it before storing it.
 */
function SessionView({ taskId, count, t }: { readonly taskId: string; readonly count: number; readonly t: Translate }): ReactNode {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<readonly SessionEntry[]>([])
  const [doc, setDoc] = useState<SessionDoc | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  const ticket = useRef(0)
  useEffect(() => {
    ticket.current += 1
    setOpen(false)
    setEntries([])
    setDoc(undefined)
    setError(undefined)
  }, [taskId])
  useEffect(() => () => { ticket.current += 1 }, [])
  const read = (after: number): void => {
    ticket.current += 1
    const mine = ticket.current
    setBusy(true)
    fetchSession(taskId, after, SESSION_PAGE).then((next) => {
      if (mine !== ticket.current) return
      setDoc(next)
      setEntries(previous => (after === 0 ? next.entries : [...previous, ...next.entries]))
      setError(undefined)
      setBusy(false)
    }, (failure: unknown) => {
      if (mine !== ticket.current) return
      setError(failure)
      setBusy(false)
    })
  }
  if (!open) {
    if (count <= 0) return <div className="dah-muted">{t('detail.session.none')}</div>
    return (
      <button type="button" className="dah-btn" data-size="sm" onClick={() => { setOpen(true); read(0) }}>
        {t('detail.session.load', { n: count })}
      </button>
    )
  }
  const total = doc?.total ?? count
  const more = doc !== undefined && entries.length < total
  return (
    <div className="dah-session">
      {error !== undefined ? <div className="dah-alert" role="alert">{t('error.section', { error: messageOf(error) })}</div> : null}
      {entries.length === 0 && busy ? <div className="dah-muted">{t('detail.session.loading')}</div> : null}
      {doc !== undefined && entries.length === 0 && !busy ? <div className="dah-muted">{t('detail.session.none')}</div> : null}
      <ol className="dah-session-list">
        {entries.map((entry, index) => {
          const role = present(entry.role) ? entry.role : 'note'
          const label = ['user', 'assistant', 'tool', 'note', 'system'].includes(role) ? t(`role.${role}`) : role
          return (
            <li key={`${String(entry.index ?? index)}`} className="dah-session-entry" data-role={role}>
              <span className="dah-session-who">
                {present(entry.name) ? `${label} · ${entry.name}` : label}
                {present(entry.at) ? <span className="dah-muted" title={absolute(entry.at)}>{` ${clockOf(entry.at)}`}</span> : null}
              </span>
              <pre className="dah-session-text">{entry.text ?? ''}</pre>
            </li>
          )
        })}
      </ol>
      <div className="dah-session-foot">
        <span className="dah-muted">{t('detail.session.shown', { n: entries.length, total })}</span>
        {more ? <button type="button" className="dah-btn" data-size="sm" disabled={busy} onClick={() => { read(entries.length) }}>{t('detail.session.more')}</button> : null}
      </div>
      {doc?.full === true ? <p className="dah-note">{t('detail.session.full')}</p> : null}
    </div>
  )
}

/** HH:MM:SS of an ISO time, or nothing. */
function clockOf(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? clock(ms) : ''
}

/** Put a failed task away: one button, its own busy and error state. */
function AckButton({ task, t, onDone }: { readonly task: TaskDetail; readonly t: Translate; readonly onDone: () => void }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  if (task.acknowledged === true || task.in_history === true) return <span className="dah-muted">{t('detail.acked')}</span>
  return (
    <>
      <button
        type="button" className="dah-btn" data-size="sm" disabled={busy} title={t('detail.ack.hint')}
        onClick={() => {
          setBusy(true)
          ackTask(task.task_id).then(() => { setBusy(false); setError(undefined); onDone() }, (failure: unknown) => { setBusy(false); setError(failure) })
        }}
      >
        {busy ? t('detail.ack.busy') : t('detail.ack')}
      </button>
      {error !== undefined ? <span className="dah-error-text">{t('detail.ack.failed', { error: messageOf(error) })}</span> : null}
    </>
  )
}

/**
 * Clear one task out of 等你回复: put a finished one away (历史), cancel one that is
 * still open. Cancelling stops a worker, so it asks once more on the same spot.
 */
function ClearWaiting({ task, t, onDone }: { readonly task: TaskRow; readonly t: Translate; readonly onDone: () => void }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  const action = clearActionOf(task)
  const run = (): void => {
    setBusy(true)
    const call = action === 'ack' ? ackTask(task.task_id) : cancelTask(task.task_id)
    call.then(() => { setBusy(false); setAsking(false); setError(undefined); onDone() }, (failure: unknown) => { setBusy(false); setAsking(false); setError(failure) })
  }
  return (
    <>
      {asking
        ? (
          <>
            <span className="dah-muted">{t('waiting.cancel.ask')}</span>
            <button type="button" className="dah-btn" data-size="sm" data-tone="danger" disabled={busy} onClick={run}>
              {busy ? t('waiting.busy') : t('waiting.cancel.confirm')}
            </button>
            <button type="button" className="dah-btn" data-size="sm" disabled={busy} onClick={() => { setAsking(false) }}>{t('waiting.cancel.keep')}</button>
          </>
        )
        : (
          <button
            type="button" className="dah-btn" data-size="sm" disabled={busy}
            title={t(action === 'ack' ? 'waiting.ack.hint' : 'waiting.cancel.hint')}
            onClick={() => { if (action === 'ack') run(); else setAsking(true) }}
          >
            {busy ? t('waiting.busy') : t(action === 'ack' ? 'waiting.ack' : 'waiting.cancel')}
          </button>
        )}
      {error !== undefined ? <span className="dah-error-text">{t('waiting.failed', { error: messageOf(error) })}</span> : null}
    </>
  )
}

/** Locale key of a fallback reason. */
const FALLBACK_KEY = { 'nobody-online': 'fallback.nobody-online', 'waited-out': 'fallback.waited-out', other: 'fallback.other' } as const

function TaskDetailView({ detail, t, now, onClose, onTask, onChanged }: {
  readonly detail: DetailState
  readonly t: Translate
  readonly now: number
  readonly onClose: () => void
  readonly onTask: (id: string) => void
  /** The task changed here (put away): read the lists again. */
  readonly onChanged?: () => void
}): ReactNode {
  const task: TaskDetail | undefined = detail.data?.task
  const result = task?.result
  const history = task === undefined ? [] : timeline(task.history)
  // A task DSH registered as its own from the start was never taken over, whatever fallback_by says.
  const takenOver = task !== undefined && task.origin?.kind !== 'local' && task.fallback_by !== undefined && task.fallback_by !== ''
  const reason = task === undefined || !takenOver ? undefined : fallbackReason(task.history)
  const failed = task !== undefined && (task.status === 'failed' || task.status === 'dead')
  return (
    <div className="dah-detail" role="region" aria-label={t('detail.title')}>
      <div className="dah-detail-head">
        <h3 className="dah-detail-title">
          {task === undefined ? t('detail.title') : task.title}
          {task !== undefined ? <span className="dah-sub-line dah-id">{task.task_id}</span> : null}
        </h3>
        {task !== undefined ? <span className="dah-badge" data-pill="true" data-tone={task.status}>{statusLabel(task.status, t)}</span> : null}
        {task !== undefined && laneOf(task) === 'waiting'
          ? <ClearWaiting task={task} t={t} onDone={() => { onChanged?.() }} />
          : failed && task !== undefined ? <AckButton task={task} t={t} onDone={() => { onChanged?.() }} /> : null}
        <button type="button" className="dah-btn" data-size="sm" data-icon="true" onClick={onClose} aria-label={t('detail.close')}>×</button>
      </div>
      {detail.error !== undefined ? <div className="dah-alert" role="alert">{t('error.section', { error: messageOf(detail.error) })}</div> : null}
      {task === undefined
        ? (detail.error === undefined ? <Empty>{t('detail.loading')}</Empty> : null)
        : (
          <>
            <dl className="dah-meta">
              {task.origin !== undefined && task.origin.kind !== 'controller'
                ? <div><dt>{t('detail.meta.origin')}</dt><dd>{originText(task, t) ?? task.origin.kind}{present(task.origin.executor) ? <span className="dah-sub-line dah-id">{task.origin.executor}</span> : null}</dd></div>
                : null}
              {present(task.dsh_profile) ? <div><dt>{t('detail.meta.profile')}</dt><dd className="dah-id">{task.dsh_profile}</dd></div> : null}
              {task.stage !== undefined ? <div><dt>{t('detail.meta.stage')}</dt><dd>{t(`stage.${task.stage}`)}</dd></div> : null}
              {takenOver
                ? <div><dt>{t('detail.meta.fallback')}</dt><dd>{`${t(FALLBACK_KEY[reason ?? 'other'])} · ${task.fallback_by}`}</dd></div>
                : null}
              <div><dt>{t('detail.meta.target')}</dt><dd className="dah-id">{task.agent}</dd></div>
              <div><dt>{t('detail.meta.assigned')}</dt><dd className="dah-id">{task.assigned_to ?? t('value.none')}</dd></div>
              {task.preferred_agent !== undefined
                ? <div><dt>{t('detail.meta.preferred')}</dt><dd className="dah-id">{task.sticky_key !== undefined ? `${task.preferred_agent} · ${task.sticky_key}` : task.preferred_agent}</dd></div>
                : null}
              <div><dt>{t('detail.meta.type')}</dt><dd>{task.type}</dd></div>
              <div><dt>{t('detail.meta.priority')}</dt><dd>{t(`priority.${task.priority}`)}</dd></div>
              <div><dt>{t('detail.meta.attempts')}</dt><dd className="dah-num">{String(task.attempts)}</dd></div>
              <div><dt>{t('detail.meta.progress')}</dt><dd className="dah-num">{percent(task.progress) ?? t('value.none')}</dd></div>
              <div><dt>{t('detail.meta.lease')}</dt><dd title={absolute(task.lease_until)}>{until(task.lease_until, t, now)}</dd></div>
              <div><dt>{t('detail.meta.created')}</dt><dd title={absolute(task.created_at)}>{relative(task.created_at, t, now)}</dd></div>
              <div>
                <dt>{t('detail.meta.deps')}</dt>
                <dd>
                  {task.depends_on.length === 0
                    ? t('value.none')
                    : (
                      <span className="dah-chips">
                        {task.depends_on.map(id => (
                          <button key={id} type="button" className="dah-chip dah-id" onClick={() => { onTask(id) }}>{id}</button>
                        ))}
                      </span>
                    )}
                </dd>
              </div>
              <div><dt>{t('detail.meta.context')}</dt><dd><Chips items={task.context_keys} empty={t('value.none')} /></dd></div>
            </dl>

            {task.message !== undefined && task.message !== ''
              ? (
                <div className="dah-block">
                  <h4 className="dah-block-title">{t('detail.message')}</h4>
                  <div className="dah-text">{task.message}</div>
                </div>
              )
              : null}

            {task.instruction !== undefined && task.instruction !== ''
              ? (
                <div className="dah-block">
                  <h4 className="dah-block-title">{t('detail.instruction')}</h4>
                  <pre className="dah-pre">{task.instruction}</pre>
                </div>
              )
              : null}

            <div className="dah-block">
              <h4 className="dah-block-title">{t('detail.inputs')}</h4>
              <Chips items={task.inputs} empty={t('value.none')} />
            </div>

            <div className="dah-block">
              <h4 className="dah-block-title">{t('detail.result')}</h4>
              {result === undefined
                ? <div className="dah-muted">{t('detail.result.none')}</div>
                : (
                  <div className="dah-result">
                    <div><span className="dah-badge" data-tone={result.status === 'completed' ? 'completed' : 'failed'}>{result.status}</span></div>
                    {result.summary !== undefined && result.summary !== '' ? <pre className="dah-pre">{result.summary}</pre> : null}
                    {result.error !== undefined
                      ? (
                        <div className="dah-error-text">
                          {`${t('detail.error')}: ${result.error.code ?? ''}${result.error.message !== undefined && result.error.message !== '' ? ` — ${result.error.message}` : ''}`}
                          {result.error.retryable ? ` (${t('detail.retryable')})` : ''}
                        </div>
                      )
                      : null}
                    {result.needs_input !== undefined && result.needs_input !== ''
                      ? <div className="dah-text"><b>{t('detail.needs')}: </b>{result.needs_input}</div>
                      : null}
                  </div>
                )}
            </div>

            <div className="dah-block">
              <h4 className="dah-block-title">{t('detail.outputs')}</h4>
              {(result?.outputs ?? []).length === 0
                ? <div className="dah-muted">{t('detail.outputs.none')}</div>
                : (
                  <>
                    <ul className="dah-files">
                      {(result?.outputs ?? []).map(file => (
                        <li key={file.name}>
                          <span className="dah-id">{file.name}</span>
                          <span className="dah-muted">{bytes(file.bytes)}</span>
                          {file.type !== undefined && file.type !== '' ? <span className="dah-chip">{file.type}</span> : null}
                          {file.description !== undefined && file.description !== '' ? <span className="dah-muted">{file.description}</span> : null}
                        </li>
                      ))}
                    </ul>
                    <p className="dah-note">{t('detail.outputs.note')}</p>
                  </>
                )}
            </div>

            <div className="dah-block">
              <h4 className="dah-block-title">{t('detail.timeline')}</h4>
              {history.length === 0
                ? <div className="dah-muted">{t('detail.history.none')}</div>
                : (
                  <ul className="dah-history">
                    {history.map((event, index) => {
                      const flag = presenceEvent(event)
                      return (
                        <li key={`${event.at ?? ''}-${String(index)}`} data-tone={flag === undefined ? undefined : 'warn'}>
                          <span className="dah-history-time" title={absolute(event.at)}>{absolute(event.at)}</span>
                          <span className="dah-history-event">{event.stage !== undefined ? t(`stage.${event.stage}`) : event.event ?? ''}</span>
                          <span>
                            {flag === undefined ? null : <span className="dah-history-flag">{t(PRESENCE_KEY[flag])}</span>}
                            {historyText(event, t)}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}
            </div>

            <div className="dah-block">
              <h4 className="dah-block-title">{t('detail.session')}</h4>
              <SessionView taskId={task.task_id} count={task.session_entries ?? 0} t={t} />
            </div>
          </>
        )}
    </div>
  )
}

/**
 * The router board's tab body: this page in its embedded form.
 * @param t - translate bound to this plugin's namespace.
 * @param onOverview - receives every overview the tab reads (the tab's badge).
 * @returns a component for the board-tabs registry's `Component`.
 */
export function createAgentHubBoardTab(t: Translate, onOverview: (overview: Overview) => void): () => ReactNode {
  return function AgentHubBoardTab(): ReactNode {
    return <AgentHubPage t={t} embedded onOverview={onOverview} />
  }
}

/** Draw the page, or its embedded form. */
export function AgentHubPage({ t, embedded = false, onOverview }: AgentHubPageProps): ReactNode {
  // The 调度台 reads every open task at once (lanes, not a status filter); the page keeps its table filter.
  const [filter, setFilter] = useState<TaskFilter>(embedded ? { status: 'all', agent: '', limit: 200, history: 'hide' } : { status: 'all', agent: '', limit: 50 })
  const [requestStatus, setRequestStatus] = useState<string>('pending')
  const [auto, setAuto] = useState(true)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const shown = useShown(rootRef, embedded)
  const { board, load } = useBoard(filter, requestStatus, auto, shown, onOverview)
  // Embedded only: groups folded or opened by hand.
  const [folds, setFolds] = useState<Folds>(readFolds)
  const detail = useDetail(selected, board.loadedAt)
  const detailRef = useRef<HTMLDivElement | null>(null)
  const now = board.loadedAt ?? Date.now()

  const overview = board.overview.data
  // Online first, offline / left / revoked after (format.ts sortAgents).
  const agents: readonly AgentView[] = useMemo(
    () => sortAgents(board.agents.data?.agents ?? overview?.agents ?? []),
    [board.agents.data, overview],
  )
  // The list's own counts (captions), and the hub's agent_counts when it sends them (the stat cell).
  const listCounts = useMemo(() => agentCounts(agents), [agents])
  const statCounts = useMemo(() => agentCounts(agents, overview?.agent_counts), [agents, overview])
  const counts = overview?.task_counts ?? {}
  const total = TASK_STATUSES.reduce((sum, status) => sum + (counts[status] ?? 0), 0)
  const online = listCounts.counts.online
  const otherStates = countsText(statCounts.counts, t, status => status !== 'online' && statCounts.counts[status] > 0)
  const pendingRequests = overview?.pending_requests ?? 0
  const tasks: readonly TaskRow[] = board.tasks.data?.tasks ?? []

  const agentOptions = useMemo(() => {
    const set = new Set<string>()
    for (const agent of agents) set.add(agent.agent_id)
    for (const task of tasks) if (task.agent.startsWith('pool:')) set.add(task.agent)
    if (filter.agent !== '') set.add(filter.agent)
    return [...set].sort()
  }, [agents, tasks, filter.agent])

  const openTask = useCallback((id: string) => {
    setSelected(id)
    // Embedded: the detail lives in the 任务 group, so make sure it is open.
    setFolds(previous => (previous.tasks === false ? { ...previous, tasks: true } : previous))
  }, [])
  const toggleTask = useCallback((id: string) => { setSelected(previous => (previous === id ? undefined : id)) }, [])
  const setStatus = useCallback((status: TaskStatus | 'all') => {
    setFilter(previous => ({ ...previous, status: previous.status === status ? 'all' : status }))
  }, [])

  useEffect(() => {
    if (selected !== undefined) detailRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [selected])

  useEffect(() => { if (embedded) writeFolds(folds) }, [embedded, folds])

  const nothing = overview === undefined && board.agents.data === undefined && board.tasks.data === undefined && board.requests.data === undefined

  const staleAlert = board.lastError !== undefined && board.loadedAt !== undefined
    ? <div className="dah-alert" data-kind="warn" role="status">{t('stale', { error: failureText(board.lastError, t), time: clock(board.loadedAt) })}</div>
    : null

  const failedAlert = (
    <div className="dah-alert" role="alert">
      <span className="dah-alert-title">{t('error.title')}</span>
      <span>{failureText(board.lastError, t)}</span>
      <button type="button" className="dah-btn" data-size="sm" disabled={board.refreshing} onClick={() => { load(true) }}>{t('retry')}</button>
    </div>
  )

  const overviewBlock = (
    <div className="dah-overview">
      <div className="dah-summary">
        <button type="button" className="dah-stat" data-on={filter.status === 'all'} aria-pressed={filter.status === 'all'} onClick={() => { setStatus('all') }}>
          <span className="dah-stat-label">{t('stat.total')}</span>
          <span className="dah-stat-value">{overview === undefined ? t('value.none') : String(total)}</span>
        </button>
        <div
          className="dah-stat" data-tone={statCounts.counts.online > 0 ? 'online' : 'offline'}
          title={t('stat.online.counts', { list: countsText(statCounts.counts, t, () => true) })}
        >
          <span className="dah-stat-label"><span className="dah-dot" aria-hidden="true" />{t('stat.online')}</span>
          <span className="dah-stat-value">
            {String(statCounts.counts.online)}
            <span className="dah-stat-of">{`/${String(statCounts.total)}`}</span>
          </span>
          <span className="dah-stat-note">{otherStates === '' ? t('stat.online.of', { n: statCounts.total }) : otherStates}</span>
        </div>
        <div className="dah-stat" data-tone={pendingRequests > 0 ? 'pending' : undefined}>
          <span className="dah-stat-label"><span className="dah-dot" aria-hidden="true" />{t('stat.requests')}</span>
          <span className="dah-stat-value">{overview === undefined ? t('value.none') : String(pendingRequests)}</span>
        </div>
      </div>
      <div className="dah-states" role={embedded ? 'group' : undefined} aria-label={embedded ? t('embed.states') : undefined}>
        {TASK_STATUSES.map(status => (
          <button
            key={status} type="button" className="dah-state" data-tone={status} data-on={filter.status === status}
            data-zero={overview !== undefined && (counts[status] ?? 0) === 0} aria-pressed={filter.status === status}
            onClick={() => { setStatus(status) }}
          >
            <span className="dah-state-label"><span className="dah-dot" aria-hidden="true" />{statusLabel(status, t)}</span>
            <span className="dah-state-value">{overview === undefined ? t('value.none') : String(counts[status] ?? 0)}</span>
          </button>
        ))}
      </div>
    </div>
  )

  const taskFilters = (
    <div className="dah-filters">
      <select
        className="dah-select" value={filter.status} aria-label={t('tasks.col.status')}
        onChange={(event) => { const value = event.target.value as TaskStatus | 'all'; setFilter(previous => ({ ...previous, status: value })) }}
      >
        <option value="all">{t('status.all')}</option>
        {TASK_STATUSES.map(status => <option key={status} value={status}>{statusLabel(status, t)}</option>)}
      </select>
      <select
        className="dah-select" value={filter.agent} aria-label={t('tasks.col.agent')}
        onChange={(event) => { const value = event.target.value; setFilter(previous => ({ ...previous, agent: value })) }}
      >
        <option value="">{t('tasks.filter.agent')}</option>
        {agentOptions.map(id => <option key={id} value={id}>{id}</option>)}
      </select>
      <select
        className="dah-select" value={String(filter.limit)} aria-label={t('tasks.filter.limit', { n: filter.limit })}
        onChange={(event) => { const value = Number(event.target.value); setFilter(previous => ({ ...previous, limit: value })) }}
      >
        {LIMITS.map(n => <option key={n} value={String(n)}>{t('tasks.filter.limit', { n })}</option>)}
      </select>
    </div>
  )

  if (embedded) {
    const isOpen = (part: Part): boolean => folds[part] ?? (part === 'ended' ? false : part !== 'requests' || pendingRequests > 0 || requestStatus !== 'pending')
    const flip = (part: Part): void => {
      const next = !isOpen(part)
      setFolds(previous => ({ ...previous, [part]: next }))
    }
    const inHistory = filter.history === 'only'
    const openCount = tasks.filter(task => task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled' && task.status !== 'dead').length
    const fallback = inHistory ? [] : fallbackTasks(tasks)
    const requestCount = board.requests.data === undefined ? '' : String(board.requests.data.requests.length)
    const detailNode = selected === undefined
      ? null
      : (
        <div ref={detailRef} className="dah-item-detail">
          <TaskDetailView detail={detail} t={t} now={now} onClose={() => { setSelected(undefined) }} onTask={openTask} onChanged={() => { load(true) }} />
        </div>
      )
    const summary = (
      <div className="dah-summary">
        <div className="dah-stat" title={t('desk.active.hint')}>
          <span className="dah-stat-label">{t('desk.active')}</span>
          <span className="dah-stat-value">{board.tasks.data === undefined || inHistory ? t('value.none') : String(openCount)}</span>
        </div>
        <div
          className="dah-stat" data-tone={statCounts.counts.online > 0 ? 'online' : 'offline'}
          title={t('stat.online.counts', { list: countsText(statCounts.counts, t, () => true) })}
        >
          <span className="dah-stat-label"><span className="dah-dot" aria-hidden="true" />{t('stat.online')}</span>
          <span className="dah-stat-value">
            {String(statCounts.counts.online)}
            <span className="dah-stat-of">{`/${String(statCounts.total - (overview?.dormant_agents ?? 0))}`}</span>
          </span>
          <span className="dah-stat-note">{otherStates === '' ? t('stat.online.of', { n: statCounts.total }) : otherStates}</span>
        </div>
        <div className="dah-stat" data-tone={pendingRequests > 0 ? 'pending' : undefined}>
          <span className="dah-stat-label"><span className="dah-dot" aria-hidden="true" />{t('stat.requests')}</span>
          <span className="dah-stat-value">{overview === undefined ? t('value.none') : String(pendingRequests)}</span>
        </div>
      </div>
    )
    const taskTools = (
      <span className="dah-tools">
        <select
          className="dah-select" value={filter.agent} aria-label={t('tasks.col.agent')}
          onChange={(event) => { const value = event.target.value; setFilter(previous => ({ ...previous, agent: value })) }}
        >
          <option value="">{t('tasks.filter.agent')}</option>
          {agentOptions.map(id => <option key={id} value={id}>{id}</option>)}
        </select>
        <button
          type="button" className="dah-btn" data-size="sm" aria-pressed={inHistory}
          onClick={() => { setSelected(undefined); setFilter(previous => ({ ...previous, history: previous.history === 'only' ? 'hide' : 'only' })) }}
        >
          {inHistory ? t('history.back') : t('history.show')}
        </button>
      </span>
    )
    return (
      <div className="dah-page" data-embedded="true" ref={rootRef}>
        <div className="dah-inner">
          <div className="dah-toolbar">
            <span className="dah-updated">{board.loadedAt === undefined ? '' : t('updated', { time: clock(board.loadedAt) })}</span>
            <span className="dah-spacer" />
            <label className="dah-check" title={t('embed.auto.hint', { n: REFRESH_MS / 1000 })}>
              <input type="checkbox" checked={auto} onChange={(event) => { setAuto(event.target.checked) }} />
              {t('embed.auto')}
            </label>
            <button type="button" className="dah-btn" data-size="sm" disabled={board.refreshing} onClick={() => { load(true) }}>
              {board.refreshing ? t('refreshing') : t('refresh')}
            </button>
          </div>
          {nothing
            ? (board.first || board.lastError === undefined ? <Empty>{t('loading')}</Empty> : failedAlert)
            : (
              <>
                {staleAlert}
                {summary}
                <EmbeddedFold
                  part="tasks" title={inHistory ? t('history.show') : t('tasks.title')}
                  count={board.tasks.data === undefined ? '' : String(tasks.length)}
                  open={isOpen('tasks')} onToggle={() => { flip('tasks') }} tools={taskTools}
                >
                  <SectionError error={board.tasks.error} t={t} />
                  <EmbeddedTasks
                    tasks={tasks} loaded={board.tasks.data !== undefined} history={inHistory}
                    selected={selected} detail={detailNode} endedOpen={isOpen('ended')} onEnded={() => { flip('ended') }}
                    now={now} t={t} onToggle={toggleTask} onChanged={() => { load(true) }}
                  />
                </EmbeddedFold>
                <EmbeddedFold
                  part="agents" title={t('agents.title')} count={`${String(online)} / ${String(agents.filter(agent => agent.dormant !== true && !agent.revoked).length)}`}
                  note={<OfflineNote counts={listCounts.counts} t={t} />}
                  open={isOpen('agents')} onToggle={() => { flip('agents') }}
                >
                  <SectionError error={board.agents.error} t={t} />
                  <EmbeddedAgents agents={agents} tasks={tasks} loaded={board.agents.data !== undefined} now={now} t={t} onTask={openTask} />
                </EmbeddedFold>
                {fallback.length > 0
                  ? (
                    <EmbeddedFold part="fallback" title={t('fallback.title')} count={String(fallback.length)} open={isOpen('fallback')} onToggle={() => { flip('fallback') }}>
                      <EmbeddedFallback tasks={fallback} selected={selected} detail={detailNode} now={now} t={t} onToggle={toggleTask} />
                    </EmbeddedFold>
                  )
                  : null}
                {pendingRequests > 0 || requestStatus !== 'pending' || folds.requests === true
                  ? (
                    <EmbeddedFold
                      part="requests" title={t('requests.title')} count={requestCount}
                      open={isOpen('requests')} onToggle={() => { flip('requests') }}
                      tools={(
                        <select className="dah-select" value={requestStatus} onChange={(event) => { setRequestStatus(event.target.value) }} aria-label={t('requests.col.status')}>
                          {REQUEST_FILTERS.map(value => <option key={value} value={value}>{t(`req.${value}`)}</option>)}
                        </select>
                      )}
                    >
                      {pendingRequests > 0 ? <div className="dah-alert" data-kind="warn">{t('approve.hint', { n: pendingRequests })}</div> : null}
                      <SectionError error={board.requests.error} t={t} />
                      <EmbeddedRequests section={board.requests} status={requestStatus} now={now} t={t} />
                    </EmbeddedFold>
                  )
                  : null}
                <p className="dah-foot">{t('desk.hint')}</p>
              </>
            )}
        </div>
      </div>
    )
  }

  const header = (
    <header className="dah-head">
      <div className="dah-head-text">
        <h1 className="dah-title">{t('page.title')}</h1>
        <p className="dah-sub">{t('page.sub')}</p>
      </div>
      <div className="dah-head-actions">
        {board.loadedAt !== undefined ? <span className="dah-updated">{t('updated', { time: clock(board.loadedAt) })}</span> : null}
        <label className="dah-check">
          <input type="checkbox" checked={auto} onChange={(event) => { setAuto(event.target.checked) }} />
          {t('auto', { n: REFRESH_MS / 1000 })}
        </label>
        <button type="button" className="dah-btn" disabled={board.refreshing} onClick={() => { load(true) }}>
          {board.refreshing ? t('refreshing') : t('refresh')}
        </button>
      </div>
    </header>
  )

  if (nothing) {
    return (
      <div className="dah-page">
        <div className="dah-inner">
          {header}
          {board.first || board.lastError === undefined
            ? <Empty page>{t('loading')}</Empty>
            : failedAlert}
        </div>
      </div>
    )
  }

  return (
    <div className="dah-page">
      <div className="dah-inner">
        {header}

        {staleAlert}

        {overviewBlock}

        {pendingRequests > 0
          ? <div className="dah-alert" data-kind="warn">{t('approve.hint', { n: pendingRequests })}</div>
          : null}

        <AgentsSection agents={agents} section={board.agents} now={now} t={t} onTask={openTask} />

        <RequestsSection section={board.requests} status={requestStatus} onStatus={setRequestStatus} now={now} t={t} />

        <section className="dah-section" aria-label={t('tasks.title')}>
          <div className="dah-section-head">
            <h2 className="dah-section-title">{t('tasks.title')}</h2>
            <span className="dah-count">{board.tasks.data === undefined ? '' : t('tasks.shown', { n: tasks.length })}</span>
            <span className="dah-spacer" />
            {taskFilters}
          </div>
          <SectionError error={board.tasks.error} t={t} />
          {tasks.length === 0
            ? (board.tasks.data !== undefined
              ? <Empty>{filter.status === 'all' && filter.agent === '' ? t('tasks.empty.all') : t('tasks.empty')}</Empty>
              : null)
            : (
              <div className="dah-table-wrap">
                <table className="dah-table">
                  <thead>
                    <tr>
                      <th>{t('tasks.col.task')}</th>
                      <th>{t('tasks.col.status')}</th>
                      <th>{t('tasks.col.agent')}</th>
                      <th>{t('tasks.col.type')}</th>
                      <th>{t('tasks.col.attempts')}</th>
                      <th>{t('tasks.col.created')}</th>
                      <th>{t('tasks.col.result')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((task) => {
                      const progress = percent(task.progress)
                      return (
                        <tr
                          key={task.task_id} className="dah-row" data-on={selected === task.task_id} tabIndex={0}
                          aria-expanded={selected === task.task_id}
                          onClick={() => { toggleTask(task.task_id) }} onKeyDown={onActivate(() => { toggleTask(task.task_id) })}
                        >
                          <td>
                            <span className="dah-clip dah-task-title" title={task.title}>{task.title}</span>
                            <span className="dah-sub-line dah-id">{task.task_id}</span>
                          </td>
                          <td>
                            <span className="dah-badge" data-tone={task.status}>{statusLabel(task.status, t)}</span>
                            {progress !== undefined && (task.status === 'running' || task.status === 'accepted')
                              ? <span className="dah-bar" title={progress}><i style={{ width: progress }} /></span>
                              : null}
                          </td>
                          <td>
                            <span className="dah-id">{task.agent}</span>
                            {task.assigned_to !== undefined && task.assigned_to !== task.agent
                              ? <span className="dah-sub-line dah-id">{`→ ${task.assigned_to}`}</span>
                              : null}
                          </td>
                          <td className="dah-nowrap">
                            {task.type}
                            {task.priority !== 'normal' ? <span className="dah-sub-line">{t(`priority.${task.priority}`)}</span> : null}
                          </td>
                          <td className="dah-num">{String(task.attempts)}</td>
                          <td className="dah-nowrap" title={absolute(task.created_at)}>{relative(task.created_at, t, now)}</td>
                          <td>
                            {task.result === undefined
                              ? <span className="dah-muted dah-clip" title={task.message}>{task.message ?? t('value.none')}</span>
                              : (
                                <span className="dah-clip" title={task.result.summary}>
                                  {task.result.error !== undefined ? <span className="dah-error-text">{`${task.result.error.code ?? ''} `}</span> : null}
                                  {task.result.summary !== undefined && task.result.summary !== '' ? task.result.summary : t('value.none')}
                                </span>
                              )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          {selected !== undefined
            ? (
              <div ref={detailRef}>
                <TaskDetailView detail={detail} t={t} now={now} onClose={() => { setSelected(undefined) }} onTask={openTask} onChanged={() => { load(true) }} />
              </div>
            )
            : null}
        </section>

        <p className="dah-foot">{t('readonly.hint')}</p>
      </div>
    </div>
  )
}
