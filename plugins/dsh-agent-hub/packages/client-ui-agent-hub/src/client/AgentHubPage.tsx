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
import type { AgentStatus, AgentView, AgentsDoc, HistoryEvent, Overview, RequestView, RequestsDoc, TaskDetail, TaskDoc, TaskFilter, TaskRow, TaskStatus, TasksDoc } from './contract.ts'
import { absolute, agentCounts, agentStatus, bytes, clock, percent, presence, relative, sortAgents, until } from './format.ts'
import { HubIcon } from './HubIcon.tsx'
import type { Translate } from './locales.ts'
import { SourceError, fetchAgents, fetchOverview, fetchRequests, fetchTask, fetchTasks } from './source.ts'

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
type Part = 'agents' | 'requests' | 'tasks'

const PARTS: readonly Part[] = ['agents', 'requests', 'tasks']

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

/** Embedded agent list: id and state, then platform · mode · load · client version · heartbeat. */
function EmbeddedAgents({ agents, loaded, now, t, onTask }: {
  readonly agents: readonly AgentView[]
  readonly loaded: boolean
  readonly now: number
  readonly t: Translate
  readonly onTask: (id: string) => void
}): ReactNode {
  if (agents.length === 0) return loaded ? <Empty>{t('agents.empty')}</Empty> : null
  return (
    <ul className="dah-list">
      {agents.map((agent) => {
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
          agent.last_seen === undefined ? undefined : `${t('agents.col.seen')}: ${absolute(agent.last_seen)}`,
          agent.left_at === undefined ? undefined : `${t('agent.status.left')}: ${absolute(agent.left_at)}`,
        ].filter(present).join('\n')
        return (
          <li key={agent.agent_id} className="dah-item">
            <div className="dah-item-row" title={tip === '' ? undefined : tip}>
              <div className="dah-item-top">
                <span className="dah-item-title dah-id">{agent.agent_id}</span>
                <AgentBadge agent={agent} t={t} />
              </div>
              <span className="dah-item-meta">{meta.join(' · ')}</span>
              {agent.running_tasks.length > 0
                ? (
                  <span className="dah-chips">
                    {agent.running_tasks.map(id => (
                      <button key={id} type="button" className="dah-chip dah-id" onClick={() => { onTask(id) }}>{id}</button>
                    ))}
                  </span>
                )
                : null}
            </div>
          </li>
        )
      })}
    </ul>
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

/**
 * Embedded task list. A row opens its detail right under itself; a task that is
 * not in the list (opened from an agent's running chip) shows its detail on top.
 */
function EmbeddedTasks({ tasks, loaded, filtered, selected, detail, now, t, onToggle }: {
  readonly tasks: readonly TaskRow[]
  readonly loaded: boolean
  readonly filtered: boolean
  readonly selected: string | undefined
  readonly detail: ReactNode
  readonly now: number
  readonly t: Translate
  readonly onToggle: (id: string) => void
}): ReactNode {
  const orphan = selected !== undefined && !tasks.some(task => task.task_id === selected)
  return (
    <>
      {orphan ? detail : null}
      {tasks.length === 0
        ? (loaded ? <Empty>{filtered ? t('tasks.empty') : t('tasks.empty.all')}</Empty> : null)
        : (
          <ul className="dah-list">
            {tasks.map((task) => {
              const on = selected === task.task_id
              const progress = percent(task.progress)
              const holder = task.assigned_to !== undefined && task.assigned_to !== task.agent ? `${task.agent} → ${task.assigned_to}` : task.agent
              const meta = [
                task.task_id,
                holder,
                task.type,
                task.priority === 'normal' ? undefined : t(`priority.${task.priority}`),
                task.attempts > 1 ? t('embed.attempts', { n: task.attempts }) : undefined,
                relative(task.created_at, t, now),
              ].filter(present)
              const note = task.result === undefined
                ? task.message
                : [task.result.error?.code, task.result.summary].filter(present).join(' ')
              return (
                <li key={task.task_id} className="dah-item" data-on={on}>
                  <div
                    className="dah-item-row" role="button" tabIndex={0} aria-expanded={on}
                    onClick={() => { onToggle(task.task_id) }} onKeyDown={onActivate(() => { onToggle(task.task_id) })}
                  >
                    <div className="dah-item-top">
                      <span className="dah-item-title" title={task.title}>{task.title}</span>
                      <span className="dah-badge" data-tone={task.status}>{statusLabel(task.status, t)}</span>
                    </div>
                    <span className="dah-item-meta" title={absolute(task.created_at)}>{meta.join(' · ')}</span>
                    {progress !== undefined && (task.status === 'running' || task.status === 'accepted')
                      ? <span className="dah-bar" title={progress}><i style={{ width: progress }} /></span>
                      : null}
                    {present(note)
                      ? <span className="dah-item-note" data-tone={task.result?.error !== undefined ? 'failed' : undefined} title={note}>{note}</span>
                      : null}
                  </div>
                  {on ? detail : null}
                </li>
              )
            })}
          </ul>
        )}
    </>
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
function TaskDetailView({ detail, t, now, onClose, onTask }: {
  readonly detail: DetailState
  readonly t: Translate
  readonly now: number
  readonly onClose: () => void
  readonly onTask: (id: string) => void
}): ReactNode {
  const task: TaskDetail | undefined = detail.data?.task
  const result = task?.result
  const history = task === undefined ? [] : [...task.history].reverse()
  return (
    <div className="dah-detail" role="region" aria-label={t('detail.title')}>
      <div className="dah-detail-head">
        <h3 className="dah-detail-title">
          {task === undefined ? t('detail.title') : task.title}
          {task !== undefined ? <span className="dah-sub-line dah-id">{task.task_id}</span> : null}
        </h3>
        {task !== undefined ? <span className="dah-badge" data-pill="true" data-tone={task.status}>{statusLabel(task.status, t)}</span> : null}
        <button type="button" className="dah-btn" data-size="sm" data-icon="true" onClick={onClose} aria-label={t('detail.close')}>×</button>
      </div>
      {detail.error !== undefined ? <div className="dah-alert" role="alert">{t('error.section', { error: messageOf(detail.error) })}</div> : null}
      {task === undefined
        ? (detail.error === undefined ? <Empty>{t('detail.loading')}</Empty> : null)
        : (
          <>
            <dl className="dah-meta">
              <div><dt>{t('detail.meta.target')}</dt><dd className="dah-id">{task.agent}</dd></div>
              <div><dt>{t('detail.meta.assigned')}</dt><dd className="dah-id">{task.assigned_to ?? t('value.none')}</dd></div>
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
              <h4 className="dah-block-title">{t('detail.history')}</h4>
              {history.length === 0
                ? <div className="dah-muted">{t('detail.history.none')}</div>
                : (
                  <ul className="dah-history">
                    {history.map((event, index) => {
                      const flag = presenceEvent(event)
                      return (
                        <li key={`${event.at ?? ''}-${String(index)}`} data-tone={flag === undefined ? undefined : 'warn'}>
                          <span className="dah-history-time" title={absolute(event.at)}>{absolute(event.at)}</span>
                          <span className="dah-history-event">{event.event ?? ''}</span>
                          <span>
                            {flag === undefined ? null : <span className="dah-history-flag">{t(PRESENCE_KEY[flag])}</span>}
                            {event.message ?? ''}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}
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
  const [filter, setFilter] = useState<TaskFilter>({ status: 'all', agent: '', limit: 50 })
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
    const isOpen = (part: Part): boolean => folds[part] ?? (part !== 'requests' || pendingRequests > 0 || requestStatus !== 'pending')
    const flip = (part: Part): void => {
      const next = !isOpen(part)
      setFolds(previous => ({ ...previous, [part]: next }))
    }
    const requestCount = board.requests.data === undefined ? '' : String(board.requests.data.requests.length)
    const detailNode = selected === undefined
      ? null
      : (
        <div ref={detailRef} className="dah-item-detail">
          <TaskDetailView detail={detail} t={t} now={now} onClose={() => { setSelected(undefined) }} onTask={openTask} />
        </div>
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
                {overviewBlock}
                <EmbeddedFold
                  part="agents" title={t('agents.title')} count={`${String(online)} / ${String(agents.length)}`}
                  note={<OfflineNote counts={listCounts.counts} t={t} />}
                  open={isOpen('agents')} onToggle={() => { flip('agents') }}
                >
                  <SectionError error={board.agents.error} t={t} />
                  <EmbeddedAgents agents={agents} loaded={board.agents.data !== undefined} now={now} t={t} onTask={openTask} />
                </EmbeddedFold>
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
                <EmbeddedFold
                  part="tasks" title={t('tasks.title')} count={board.tasks.data === undefined ? '' : t('tasks.shown', { n: tasks.length })}
                  open={isOpen('tasks')} onToggle={() => { flip('tasks') }}
                >
                  {taskFilters}
                  <SectionError error={board.tasks.error} t={t} />
                  <EmbeddedTasks
                    tasks={tasks} loaded={board.tasks.data !== undefined} filtered={filter.status !== 'all' || filter.agent !== ''}
                    selected={selected} detail={detailNode} now={now} t={t} onToggle={toggleTask}
                  />
                </EmbeddedFold>
                <p className="dah-foot">{t('readonly.hint')}</p>
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
                <TaskDetailView detail={detail} t={t} now={now} onClose={() => { setSelected(undefined) }} onTask={openTask} />
              </div>
            )
            : null}
        </section>

        <p className="dah-foot">{t('readonly.hint')}</p>
      </div>
    </div>
  )
}
