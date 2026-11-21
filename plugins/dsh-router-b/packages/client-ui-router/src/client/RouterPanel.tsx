/**
 * The router panel, as the right Sidebar shows it.
 *
 * Two columns inside one panel:
 *
 *   rail    which projects exist, which one you are reading, whether dispatch is
 *           on, and whether the model credentials are in place (API key status)
 *   tasks   the work list: four tabs, one compact row per task, the worker's
 *           checklist and the accept/send-back actions behind the row
 *
 * Why the rail lives inside the panel instead of in the app's left Sidebar: the
 * app's left column has no free content slot (see `ProjectRail.tsx` and
 * `docs/NATIVE-ENTRYPOINTS.md`), so a genuine left column is not available to a
 * third-party plugin without replacing the workspace browser. The panel therefore
 * draws its own rail and switches between "rail + list" (wide) and "one of the
 * two, behind ☰" (narrow) — a container query, so nothing measures in JS.
 *
 * The middle column is the native conversation and is not this plugin's business.
 */

import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react'
import type { ArtifactRef, BoardSnapshot, CredentialView, HostActions, TaskState, TaskView } from './contract.ts'
import type { RouterBoardController } from './controller.ts'
import { TABS, tabCounts, todoProgress, type TabId } from './lanes.ts'
import { NO_SESSIONS, todosOf, type SessionsFace } from './native-todos.ts'
import { ProjectRail } from './ProjectRail.tsx'
import { TaskBoard } from './TaskBoard.tsx'

/** Props for {@link RouterPanel}. */
export interface RouterPanelProps {
  /** Panel state and actions. */
  readonly controller: RouterBoardController
  /** Namespace-bound translate. */
  readonly t: (key: string, values?: Record<string, string | number>) => string
  /** Open the worker Session that owns a task. */
  readonly onOpenSession?: (sessionId: string) => void
  /** Open the 作战室 chat Session. */
  readonly onOpenWarRoom?: () => void
  /** Download an artifact the worker produced. */
  readonly onDownload?: (artifact: ArtifactRef) => void
  /**
   * The Session service, so each task can show its worker's own `todos`
   * projection. Omitted in the standalone preview; the Host-supplied snapshot on
   * the task is used then.
   */
  readonly sessions?: SessionsFace
  /**
   * Host actions beyond reading the board (partition switch, credential status
   * and writes). Each member is optional: a Host that implements none still gets
   * a readable board, and the rail says which control is not wired.
   */
  readonly host?: HostActions
  /**
   * `page` when mounted as the main Routing page: the demand box stays open at
   * the top of a centred column. `panel` (default) is the docked Sidebar tab.
   */
  readonly variant?: 'page' | 'panel'
  /** Tab to open on first render; the preview and tests pin it. */
  readonly initialTab?: TabId
  /** Force the rail open or closed on first render (preview only); otherwise the remembered state wins. */
  readonly initialRailOpen?: boolean
  /** Partition id to filter to on first render (preview only). */
  readonly initialSelected?: string
  /** Task details to open on first render (preview only). */
  readonly initialOpenTasks?: readonly string[]
}

/**
 * localStorage key that remembers whether the project rail is open on the
 * Routing page. The docked Sidebar panel is narrow, where an open rail covers the
 * task list, so it keeps its own key and a page choice never hides its list.
 */
export const RAIL_STORAGE_KEY = 'dshr.rail.open'
const PANEL_RAIL_STORAGE_KEY = 'dshr.rail.open.panel'

/** Read the remembered rail state; closed when storage is missing or unreadable. */
function readRailOpen(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === '1'
  } catch {
    return false
  }
}

/** Remember the rail state; a missing or full storage is not an error. */
function writeRailOpen(key: string, open: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, open ? '1' : '0')
  } catch {
    // Storage is a convenience: the rail still works for this session.
  }
}

/** Look up display names for a task's partition and worker. */
function useTaskNames(board: BoardSnapshot | null) {
  return useMemo(() => {
    const partitionName = new Map<string, string>()
    const workerName = new Map<string, string>()
    for (const partition of board?.partitions ?? []) {
      partitionName.set(partition.id, partition.name)
      for (const worker of partition.workers) workerName.set(worker.id, worker.name)
    }
    return {
      partitionOf: (task: TaskView): string => partitionName.get(task.partitionId) ?? task.partitionId,
      workerOf: (task: TaskView): string | undefined =>
        task.workerId === undefined ? undefined : workerName.get(task.workerId) ?? task.workerId,
    }
  }, [board])
}

/**
 * Render the panel.
 * @param props - controller, translate, and the panel's outward actions.
 * @returns the rail and the task column.
 */
export function RouterPanel(props: RouterPanelProps) {
  const { controller, t, onOpenSession, onDownload, sessions, host } = props
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const board = state.board

  const [tab, setTab] = useState<TabId>(props.initialTab ?? 'active')
  const [selected, setSelected] = useState<string | undefined>(props.initialSelected)
  // Closed by default: once work is routed the project list is rarely needed.
  const railKey = props.variant === 'page' ? RAIL_STORAGE_KEY : PANEL_RAIL_STORAGE_KEY
  const [railOpen, setRailOpen] = useState<boolean>(() => props.initialRailOpen ?? readRailOpen(railKey))
  const railId = useId()
  const changeRail = (open: boolean): void => {
    setRailOpen(open)
    writeRailOpen(railKey, open)
  }
  const [composerOpen, setComposerOpen] = useState(false)
  const [openTasks, setOpenTasks] = useState<ReadonlySet<string>>(() => new Set(props.initialOpenTasks ?? []))
  const [probeSeq, setProbeSeq] = useState(0)
  const [probed, setProbed] = useState<readonly CredentialView[] | undefined>(undefined)

  // Worker checklists come from the Harness itself: every worker is a subagent
  // Session, and the Session list already carries each one's finished `todos`
  // projection. The Host-supplied snapshot on the task is only the fallback for
  // when the projection has been reset (the Host nulls it on `turn/start`).
  const sessionFace = sessions ?? NO_SESSIONS
  const sessionList = useSyncExternalStore(
    sessionFace.list.subscribe,
    sessionFace.list.getSnapshot,
    sessionFace.list.getSnapshot,
  )

  useEffect(() => {
    const detach = controller.start()
    void controller.load()
    return () => {
      detach()
      controller.dispose()
    }
  }, [controller])

  // Ask the Host for the projections of workers the list has not described yet.
  // `refreshProjections` opens nothing and is idempotent Host-side.
  useEffect(() => {
    const pending = (board?.tasks ?? [])
      .map(task => task.workerSessionId)
      .filter((id): id is string => id !== undefined && todosOf(sessionList, id) === undefined)
    if (pending.length === 0) return
    const refresh = sessionFace.refreshProjections
    if (refresh === undefined) return
    for (const id of new Set(pending)) void refresh.call(sessionFace, id).catch(() => {})
  }, [board, sessionList, sessionFace])

  // A board that arrives after mount may hold no work in the remembered tab;
  // land on the first tab that does, once, and open the task that is waiting on
  // the user — the reason this panel exists.
  const [landed, setLanded] = useState(false)
  useEffect(() => {
    if (board === null || landed) return
    setLanded(true)
    if (props.initialTab === undefined) {
      const counts = tabCounts(board.tasks)
      if (counts[tab] === 0) {
        const next = TABS.find(candidate => counts[candidate.id] > 0)
        if (next !== undefined) setTab(next.id)
      }
    }
    if (props.initialOpenTasks === undefined) {
      const first = board.tasks.find(task => task.state === 'reported')
      if (first !== undefined) setOpenTasks(previous => new Set(previous).add(first.id))
    }
  }, [board, landed, props.initialTab, props.initialOpenTasks, tab])

  // Credential status: the Host's own answer wins, the board's snapshot fills in
  // for a Host that does not describe credentials. Re-read after any write.
  const refs = useMemo(() => (board?.credentials ?? []).map(row => row.ref), [board])
  const readCredentials = host?.readCredentials
  useEffect(() => {
    if (readCredentials === undefined || refs.length === 0) return
    let alive = true
    void readCredentials(refs).then((rows) => {
      if (alive) setProbed(rows)
    }, () => {
      // A refused read is not a missing credential: fall back to the snapshot.
      if (alive) setProbed(undefined)
    })
    return () => { alive = false }
  }, [readCredentials, refs, probeSeq])

  const credentialRows = useMemo<readonly CredentialView[]>(() => {
    const base = board?.credentials ?? []
    if (probed === undefined) return base
    const live = new Map(probed.map(row => [row.ref, row]))
    return base.map((row) => {
      const answer = live.get(row.ref)
      return answer === undefined ? row : { ...row, ...answer }
    })
  }, [board, probed])

  const names = useTaskNames(board)
  const tasks = useMemo<readonly TaskView[]>(() => {
    if (board === null) return []
    return selected === undefined ? board.tasks : board.tasks.filter(task => task.partitionId === selected)
  }, [board, selected])

  const selectedName = board?.partitions.find(partition => partition.id === selected)?.name

  /** Fold the live checklist projection into the task the Host described. */
  const resolve = (task: TaskView): TaskView => {
    const live = todosOf(sessionList, task.workerSessionId)
    return live === undefined ? task : { ...task, todos: live }
  }

  const toggleTask = (taskId: string): void => {
    setOpenTasks((previous) => {
      const next = new Set(previous)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  const verify = (taskId: string, verdict: Extract<TaskState, 'verified' | 'rejected'>, note?: string): void => {
    void controller.verify(taskId, verdict, note)
  }

  const reloadCredentials = (): void => {
    setProbeSeq(value => value + 1)
    void controller.load()
  }

  return (
    <div className="dshr-panel" data-rail={railOpen ? 'open' : 'closed'} data-variant={props.variant ?? 'panel'}>
      <ProjectRail
        id={railId}
        open={railOpen}
        partitions={board?.partitions ?? []}
        {...(selected === undefined ? {} : { selectedId: selected })}
        onSelect={setSelected}
        totalTasks={board?.tasks.length ?? 0}
        t={t}
        credentials={credentialRows}
        credentialsWritable={host?.writeCredential !== undefined}
        {...(host?.writeCredential === undefined ? {} : { onSaveCredential: host.writeCredential })}
        onCredentialsChanged={reloadCredentials}
        {...(host?.setPartitionEnabled === undefined
          ? {}
          : {
            onTogglePartition: async (partitionId: string, enabled: boolean) => {
              await host.setPartitionEnabled!(partitionId, enabled)
              // The switch reflects the Host, not a local guess: re-read.
              await controller.load()
            },
          })}
        {...(host?.createPartition === undefined ? {} : { onCreatePartition: host.createPartition })}
        onClose={() => { changeRail(false) }}
      />

      {board === null
        ? (
          <section className="dshr-main dshr-main-bare" aria-label={t('panel.title')}>
            <div className="dshr-empty">
              {state.status === 'error' ? t('board.retry') : t('board.loading')}
            </div>
            {state.error !== undefined && (
              <div className="dshr-notice" data-tone="bad">{t('board.error', { message: state.error })}</div>
            )}
          </section>
        )
        : (
          <TaskBoard
            board={board}
            tasks={tasks}
            tab={tab}
            onTab={setTab}
            t={t}
            status={state.status}
            publishing={state.publishing}
            {...(state.lastPublish === undefined ? {} : { lastPublish: state.lastPublish })}
            {...(state.error === undefined ? {} : { error: state.error })}
            openTasks={openTasks}
            onToggleTask={toggleTask}
            inlineComposer={props.variant === 'page'}
            composerOpen={composerOpen}
            onToggleComposer={() => { setComposerOpen(value => !value) }}
            onRefresh={() => { void controller.load() }}
            onPublish={(demands) => { void controller.publish(demands) }}
            onClearNotice={() => { controller.clearPublishNotice() }}
            railOpen={railOpen}
            railId={railId}
            onToggleRail={() => { changeRail(!railOpen) }}
            onClearFilter={() => { setSelected(undefined) }}
            {...(selectedName === undefined ? {} : { filterName: selectedName })}
            partitionOf={names.partitionOf}
            workerOf={names.workerOf}
            resolve={resolve}
            onVerify={verify}
            {...(onOpenSession === undefined ? {} : { onOpenSession })}
            {...(props.onOpenWarRoom === undefined ? {} : { onOpenWarRoom: props.onOpenWarRoom })}
            {...(onDownload === undefined ? {} : { onDownload })}
          />
        )}
    </div>
  )
}

/** Re-exported so a caller can compute the same progress the rows show. */
export { todoProgress }
