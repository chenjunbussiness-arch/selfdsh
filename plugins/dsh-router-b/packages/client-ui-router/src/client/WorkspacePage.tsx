/**
 * 工作区: what files each partition holds, and the rules a worker works by.
 *
 * Left: the partitions, then the selected partition's file tree. The tree reads
 * one directory level per request (`GET /api/router/files?partition=&path=`), so
 * a big repository costs nothing until someone opens a folder. Entries the
 * partition's include/exclude rules leave out are dimmed and say so.
 *
 * Right: that partition's root, its include/exclude rules, any configuration
 * problem the Host found at boot, the rules every worker brief carries, the
 * partition's open tasks (with what each one waits for, and 停止全部), and its
 * memory: the model its manager runs on, standing notes, recent work and the
 * worker sessions the manager can read or continue.
 *
 * Only names, kinds, sizes and times cross the bridge, never file contents.
 *
 * @module client-ui-router/workspace-page
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { FileEntryView, FileListingView, PartitionMemoryView, PartitionView, TaskView } from './contract.ts'
import type { RouterBoardController } from './controller.ts'
import { groupOf, statusKeyOf } from './CompactBoard.tsx'
import { bytes, relativeTime } from './format.ts'
import { BOARD_TOKENS_CSS } from './styles.ts'

/** Props supplied by the main-panel registration. */
export interface WorkspacePageProps {
  readonly controller: RouterBoardController
  readonly t: (key: string, values?: Record<string, string | number>) => string
  readonly onOpenSession?: (sessionId: string) => void
}

/** One directory's read state. */
type DirState =
  | { readonly status: 'loading' }
  | { readonly status: 'ok'; readonly listing: FileListingView }
  | { readonly status: 'error'; readonly message: string }

/** Key of one directory of one partition in the read cache. */
const dirKey = (partition: string, path: string): string => `${partition}\u0000${path}`

const STYLE = `${BOARD_TOKENS_CSS}
.dshws{--c-text:var(--dsw-alias-label-primary,#0f1115);--c-text2:var(--dsw-alias-label-secondary,#61666b);--c-text3:var(--c-meta);--c-line:var(--dsw-alias-border-l2,rgba(0,0,0,.1));--c-line-soft:var(--dsw-alias-border-l1,rgba(0,0,0,.04));--c-pill:var(--dsw-alias-interactive-bg-hover-solid,#f1f3f5);--f-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,transparent);color:var(--c-text);font-size:13px;line-height:1.45;text-align:left}
.dshws *{box-sizing:border-box}
:where(.dshws button){font:inherit}
.dshws button:focus-visible{outline:2px solid var(--st-running-dot);outline-offset:1px}
.dshws-head{display:flex;align-items:center;gap:var(--sp-3);flex:none;padding:var(--sp-4) var(--sp-4) var(--sp-3);border-bottom:1px solid var(--c-line-soft)}
.dshws-ht{flex:1 1 auto;min-width:0}
.dshws-title{margin:0;font-size:15px;font-weight:600;line-height:22px}
.dshws-sub{margin:2px 0 0;font-size:12px;color:var(--c-text3)}
.dshws-btn{flex:none;height:var(--h-ctl);padding:0 var(--sp-3);border:1px solid var(--c-ghost-line);border-radius:var(--r-ctl);background:transparent;color:var(--c-text);font-size:12px;cursor:pointer}
.dshws-btn:hover{background:var(--c-hover)}
.dshws-btn:active{background:var(--c-press)}
.dshws-body{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(240px,340px) minmax(0,1fr)}
.dshws-left{min-height:0;display:flex;flex-direction:column;border-right:1px solid var(--c-line-soft)}
.dshws-right{min-height:0;overflow:auto;padding:var(--sp-4)}
.dshws-cap{display:block;padding:var(--sp-3) var(--sp-4) var(--sp-1);font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--c-text2)}
.dshws-parts{flex:none;display:flex;flex-direction:column;gap:2px;padding:0 var(--sp-2) var(--sp-2);max-height:40%;overflow:auto;border-bottom:1px solid var(--c-line-soft)}
.dshws-part{display:flex;align-items:center;gap:var(--sp-2);width:100%;min-height:36px;padding:var(--sp-1) var(--sp-2);border:0;border-radius:var(--r-ctl);background:transparent;color:var(--c-text);text-align:left;cursor:pointer}
.dshws-part:hover{background:var(--c-hover)}
.dshws-part[data-on]{background:var(--c-pill)}
.dshws-part[data-off] .dshws-pn{color:var(--c-text3)}
.dshws-pmain{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
.dshws-pn{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshws-pp{font-family:var(--f-mono);font-size:11px;color:var(--c-text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshws-badge{flex:none;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--st-cancelled-bg);color:var(--c-text2);font-size:11px;line-height:18px;text-align:center;font-variant-numeric:tabular-nums}
.dshws-badge[data-tone="running"]{background:var(--st-running-bg);color:var(--st-running-text)}
.dshws-badge[data-tone="warn"]{background:var(--st-blocked-bg);color:var(--st-blocked-text)}
.dshws-badge[data-tone="error"]{background:var(--st-failed-bg);color:var(--st-failed-text)}
.dshws-tree{flex:1 1 auto;min-height:0;overflow:auto;padding:var(--sp-1) var(--sp-2) var(--sp-4);font-size:12px}
.dshws-node{display:flex;align-items:center;gap:6px;width:100%;height:26px;padding:0 var(--sp-2);border:0;border-radius:4px;background:transparent;color:var(--c-text);text-align:left;white-space:nowrap;cursor:default}
button.dshws-node{cursor:pointer}
button.dshws-node:hover{background:var(--c-hover)}
.dshws-node[data-out]{color:var(--c-text3)}
.dshws-node[data-out] .dshws-nn{text-decoration:line-through;text-decoration-color:var(--c-line)}
.dshws-caret{flex:none;width:12px;height:12px;color:var(--c-text3);transition:transform .12s ease}
.dshws-caret[data-open]{transform:rotate(90deg)}
.dshws-ico{flex:none;width:14px;height:14px;color:var(--c-text3)}
.dshws-node[data-kind="dir"] .dshws-ico{color:var(--st-blocked-dot)}
.dshws-nn{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.dshws-ns{flex:none;color:var(--c-text3);font-variant-numeric:tabular-nums;font-size:11px}
.dshws-note{padding:var(--sp-1) var(--sp-2);color:var(--c-text3);font-size:12px}
.dshws-note[data-tone="error"]{color:var(--st-failed-text)}
.dshws-sec{margin:0 0 var(--sp-4)}
.dshws-sec h3{margin:0 0 var(--sp-2);font-size:12px;font-weight:600;color:var(--c-text2)}
.dshws-sech{display:flex;align-items:center;justify-content:space-between;gap:var(--sp-2);margin-bottom:var(--sp-2)}
.dshws-sech h3{margin:0}
.dshws-btn[data-tone="stop"]:hover{color:var(--st-failed-text)}
.dshws-btn[data-armed]{border-color:var(--st-failed-text);color:var(--st-failed-text);font-weight:600}
.dshws-h4{margin:var(--sp-3) 0 var(--sp-1);font-size:11px;font-weight:600;color:var(--c-text3)}
.dshws-notes{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.dshws-mnote{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:0 var(--sp-2);padding:var(--sp-1) var(--sp-2);border-radius:var(--r-ctl);background:var(--c-line-soft);font-size:12px}
.dshws-mtext{grid-column:1;overflow-wrap:anywhere}
.dshws-mmeta{grid-column:1;font-size:11px;color:var(--c-text3)}
.dshws-x{grid-column:2;grid-row:1/3;width:20px;height:20px;padding:0;border:0;border-radius:var(--r-ctl);background:transparent;color:var(--c-text3);cursor:pointer}
.dshws-x:hover{background:var(--c-hover);color:var(--st-failed-text)}
.dshws-addnote{display:flex;gap:var(--sp-2);margin-top:var(--sp-2)}
.dshws-addnote input{flex:1 1 auto;min-width:0;height:var(--h-ctl);padding:0 var(--sp-2);border:1px solid var(--c-ghost-line);border-radius:var(--r-ctl);background:transparent;color:var(--c-text);font-size:12px}
.dshws-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:var(--sp-1) var(--sp-3);margin:0;font-size:12px}
.dshws-kv dt{color:var(--c-text3)}
.dshws-kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.dshws-globs{display:flex;flex-wrap:wrap;gap:var(--sp-1)}
.dshws-glob{padding:0 6px;border-radius:4px;background:var(--c-line-soft);font-family:var(--f-mono);font-size:11px;line-height:18px}
.dshws-probs{display:flex;flex-direction:column;gap:var(--sp-1);margin:0;padding:0;list-style:none}
.dshws-prob{padding:var(--sp-1) var(--sp-2);border-radius:var(--r-ctl);background:var(--st-blocked-bg);color:var(--st-blocked-text);font-size:12px}
.dshws-prob[data-level="error"]{background:var(--st-failed-bg);color:var(--st-failed-text)}
.dshws-ok{color:var(--st-done-text);font-size:12px}
.dshws-rules{margin:0;padding-left:18px;font-size:12px;color:var(--c-text2)}
.dshws-rules li+li{margin-top:2px}
.dshws-tasks{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.dshws-task{display:flex;flex-direction:column;gap:2px;padding:var(--sp-2) var(--sp-2);border-radius:var(--r-ctl)}
.dshws-task+.dshws-task{border-top:1px solid var(--c-line-soft)}
.dshws-task[data-link]{cursor:pointer}
.dshws-task[data-link]:hover{background:var(--c-hover)}
.dshws-tt{display:flex;align-items:baseline;gap:var(--sp-2);min-width:0}
.dshws-tn{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dshws-ts{flex:none;font-size:11px;color:var(--c-text2)}
.dshws-ts[data-tone="running"]{color:var(--st-running-text)}
.dshws-ts[data-tone="blocked"],.dshws-ts[data-tone="suspended"]{color:var(--st-blocked-text)}
.dshws-tm{font-size:11px;color:var(--c-text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshws-empty{padding:48px var(--sp-4);color:var(--c-text3);text-align:center}
@container (max-width:640px){.dshws-body{grid-template-columns:1fr}.dshws-left{border-right:0;border-bottom:1px solid var(--c-line-soft);max-height:55%}}
.dshws-wrap{container-type:inline-size;height:100%}
`

const CARET = 'M4.5 3l3 3-3 3'
const ICON_DIR = 'M1.75 3.5h3.5l1.25 1.5h5.75v6.5h-10.5z'
const ICON_FILE = 'M3 1.75h5l3 3v7.5H3zM8 1.75V5h3'
const ICON_LINK = 'M5 7h4M4 9.5a2.5 2.5 0 0 1 0-5M10 4.5a2.5 2.5 0 0 1 0 5'

function Glyph({ d, className, open }: { d: string; className: string; open?: boolean }) {
  return (
    <svg className={className} data-open={open === true ? '' : undefined} viewBox="0 0 14 14" width="14" height="14"
      fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"><path d={d} /></svg>
  )
}

/** Open states a person still waits on, in the order the list shows them. */
const OPEN_ORDER: readonly string[] = ['running', 'blocked', 'suspended', 'queued']

/**
 * Render the 工作区 page.
 * @param props - controller, translate and the Session opener.
 * @returns the page.
 */
export function WorkspacePage({ controller, t, onOpenSession }: WorkspacePageProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const board = state.board
  const partitions: readonly PartitionView[] = board?.partitions ?? []
  const [selected, setSelected] = useState<string | null>(null)
  const [dirs, setDirs] = useState<ReadonlyMap<string, DirState>>(() => new Map())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const now = Date.now()

  useEffect(() => {
    const detach = controller.start()
    void controller.load()
    return () => { detach() }
  }, [controller])

  // Select the first partition once the board arrives, and keep the choice
  // valid if a partition disappears.
  const current = partitions.find(partition => partition.id === selected) ?? partitions[0]
  const partitionId = current?.id

  const loadDir = useCallback(async (partition: string, path: string): Promise<void> => {
    const key = dirKey(partition, path)
    setDirs(previous => new Map(previous).set(key, { status: 'loading' }))
    try {
      const listing = await controller.listFiles(partition, path)
      setDirs(previous => new Map(previous).set(key, { status: 'ok', listing }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setDirs(previous => new Map(previous).set(key, { status: 'error', message }))
    }
  }, [controller])

  useEffect(() => {
    if (partitionId === undefined || !controller.canListFiles) return
    if (dirs.has(dirKey(partitionId, ''))) return
    void loadDir(partitionId, '')
  }, [partitionId, dirs, loadDir, controller])

  /** The selected partition's memory, keyed by partition so a switch never shows stale notes. */
  const [memory, setMemory] = useState<{ readonly partition: string; readonly view?: PartitionMemoryView; readonly error?: string } | null>(null)
  const [noteText, setNoteText] = useState('')
  const [noteBusy, setNoteBusy] = useState(false)
  const [stopArmed, setStopArmed] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [message, setMessage] = useState<{ readonly tone: 'ok' | 'bad'; readonly text: string } | null>(null)

  const loadMemory = useCallback(async (partition: string): Promise<void> => {
    if (!controller.canReadMemory) return
    try {
      const view = await controller.readMemory(partition)
      setMemory({ partition, view })
    } catch (error) {
      setMemory({ partition, error: error instanceof Error ? error.message : String(error) })
    }
  }, [controller])

  useEffect(() => {
    if (partitionId === undefined) return
    setNoteText('')
    setStopArmed(false)
    void loadMemory(partitionId)
  }, [partitionId, loadMemory])

  useEffect(() => {
    if (!stopArmed) return
    const timer = setTimeout(() => { setStopArmed(false) }, 4000)
    return () => { clearTimeout(timer) }
  }, [stopArmed])

  useEffect(() => {
    if (message === null) return
    const timer = setTimeout(() => { setMessage(null) }, 4000)
    return () => { clearTimeout(timer) }
  }, [message])

  const toggleDir = (partition: string, path: string): void => {
    const key = dirKey(partition, path)
    const opening = !expanded.has(key)
    setExpanded((previous) => {
      const next = new Set(previous)
      if (opening) next.add(key)
      else next.delete(key)
      return next
    })
    if (opening && !dirs.has(key)) void loadDir(partition, path)
  }

  /** Re-read the root and every open folder of the current partition. */
  const refresh = (): void => {
    void controller.load()
    if (partitionId !== undefined) void loadMemory(partitionId)
    if (partitionId === undefined || !controller.canListFiles) return
    const open = [...expanded].filter(key => key.startsWith(`${partitionId}\u0000`)).map(key => key.slice(partitionId.length + 1))
    for (const path of ['', ...open]) void loadDir(partitionId, path)
  }

  const live = useMemo(() => new Set(partitions.map(partition => partition.id)), [partitions])
  const titleOf = useMemo(() => new Map((board?.tasks ?? []).map(task => [task.id, task.title])), [board])
  const tasks = useMemo(() => {
    if (partitionId === undefined) return []
    return (board?.tasks ?? [])
      .filter(task => task.partitionId === partitionId)
      .map(task => ({ task, group: groupOf(task, live) }))
      .filter(row => OPEN_ORDER.includes(row.group))
      .sort((left, right) => OPEN_ORDER.indexOf(left.group) - OPEN_ORDER.indexOf(right.group))
  }, [board, partitionId, live])

  /** Running tasks per partition, for the badge on each partition row. */
  const runningBy = useMemo(() => {
    const counts = new Map<string, number>()
    for (const task of board?.tasks ?? []) {
      if (groupOf(task, live) === 'running') counts.set(task.partitionId, (counts.get(task.partitionId) ?? 0) + 1)
    }
    return counts
  }, [board, live])

  const names = (ids: readonly string[]): string => ids.map(id => titleOf.get(id) ?? id).join('、')

  const entryRow = (partition: string, entry: FileEntryView, depth: number) => {
    const pad = { paddingLeft: `${String(8 + depth * 14)}px` }
    const out = entry.inScope ? undefined : ''
    const title = [entry.path, entry.inScope ? undefined : t('ws.outOfScope'),
      entry.modifiedAt === undefined ? undefined : relativeTime(entry.modifiedAt, now)]
      .filter(line => line !== undefined && line !== '').join('\n')
    if (entry.kind === 'dir') {
      const key = dirKey(partition, entry.path)
      const open = expanded.has(key)
      return (
        <div key={entry.path} role="treeitem" aria-expanded={open}>
          <button type="button" className="dshws-node" data-kind="dir" data-out={out} style={pad} title={title}
            onClick={() => { toggleDir(partition, entry.path) }}>
            <Glyph className="dshws-caret" d={CARET} open={open} />
            <Glyph className="dshws-ico" d={ICON_DIR} />
            <span className="dshws-nn">{entry.name}</span>
          </button>
          {open && <div role="group">{dirBody(partition, entry.path, depth + 1)}</div>}
        </div>
      )
    }
    return (
      <div key={entry.path} role="treeitem" className="dshws-node" data-kind={entry.kind} data-out={out} style={pad} title={title}>
        <span className="dshws-caret" />
        <Glyph className="dshws-ico" d={entry.kind === 'link' ? ICON_LINK : ICON_FILE} />
        <span className="dshws-nn">{entry.name}</span>
        {entry.size !== undefined && <span className="dshws-ns">{bytes(entry.size)}</span>}
      </div>
    )
  }

  const dirBody = (partition: string, path: string, depth: number) => {
    const read = dirs.get(dirKey(partition, path))
    const pad = { paddingLeft: `${String(8 + depth * 14)}px` }
    if (read === undefined || read.status === 'loading') return <div className="dshws-note" style={pad}>{t('ws.loading')}</div>
    if (read.status === 'error') return <div className="dshws-note" data-tone="error" style={pad}>{t('ws.error', { message: read.message })}</div>
    if (read.listing.entries.length === 0) return <div className="dshws-note" style={pad}>{t('ws.empty')}</div>
    return (
      <>
        {read.listing.entries.map(entry => entryRow(partition, entry, depth))}
        {read.listing.omitted > 0 && <div className="dshws-note" style={pad}>{t('ws.omitted', { n: read.listing.omitted })}</div>}
      </>
    )
  }

  const partitionRow = (partition: PartitionView) => {
    const problems = partition.problems ?? []
    const worst = problems.some(problem => problem.level === 'error') ? 'error' : problems.length > 0 ? 'warn' : undefined
    const running = runningBy.get(partition.id) ?? 0
    return (
      <button key={partition.id} type="button" className="dshws-part" data-on={partition.id === partitionId ? '' : undefined}
        data-off={partition.enabled === false ? '' : undefined} onClick={() => { setSelected(partition.id) }}
        title={partition.path ?? partition.repo ?? partition.name}>
        <span className="dshws-pmain">
          <span className="dshws-pn">{partition.name}{partition.enabled === false ? ` · ${t('ws.disabled')}` : ''}</span>
          <span className="dshws-pp">{partition.path ?? partition.repo ?? ''}</span>
        </span>
        {worst !== undefined && <span className="dshws-badge" data-tone={worst} title={problems.map(problem => problem.message).join('\n')}>!</span>}
        {running > 0 && <span className="dshws-badge" data-tone="running">{running}</span>}
      </button>
    )
  }

  const taskRow = ({ task, group }: { task: TaskView; group: string }) => {
    const key = statusKeyOf(task, live)
    const tone = key.replace('status.', '')
    const lines: string[] = []
    if (task.waitingFor !== undefined && task.waitingFor.length > 0) lines.push(t('order.waiting', { ids: names(task.waitingFor) }))
    if (group === 'suspended') {
      lines.push(task.suspendReason === undefined || task.suspendReason === '' ? t('susp.noReason') : t('susp.reason', { reason: task.suspendReason }))
      if (task.waitingOn !== undefined && task.waitingOn.length > 0) lines.push(t('susp.waitingOn', { ids: names(task.waitingOn) }))
    }
    if (group === 'blocked') lines.push(task.resumeNote === undefined || task.resumeNote === '' ? t('hold.noReason') : t('hold.reason', { reason: task.resumeNote }))
    if (task.stage !== undefined) lines.push(t('order.stage', { n: task.stage }))
    const open = task.workerSessionId !== undefined && onOpenSession !== undefined
      ? () => { onOpenSession(task.workerSessionId!) }
      : undefined
    return (
      <li key={task.id} className="dshws-task" data-link={open === undefined ? undefined : ''} onClick={open} title={task.id}>
        <span className="dshws-tt">
          <span className="dshws-tn">{task.title}</span>
          <span className="dshws-ts" data-tone={tone}>{t(key)}</span>
        </span>
        {lines.map(line => <span key={line} className="dshws-tm" title={line}>{line}</span>)}
      </li>
    )
  }

  /**
   * 停止全部: stop every open request in this partition. Each top-most open row
   * goes as one `cancel_tree`, so a manager and its workers stop together.
   */
  const stopAll = async (): Promise<void> => {
    if (!stopArmed) { setStopArmed(true); return }
    setStopArmed(false)
    const openIds = new Set(tasks.map(row => row.task.id))
    const tops = tasks.map(row => row.task).filter(task => task.parentId === undefined || !openIds.has(task.parentId))
    setStopping(true)
    const failures: string[] = []
    for (const task of tops) {
      const failure = await controller.control(task.id, 'cancel_tree')
      if (failure !== undefined) failures.push(`${task.title}: ${failure}`)
    }
    setStopping(false)
    setMessage(failures.length === 0
      ? { tone: 'ok', text: t('ws.stopAllDone', { n: tops.length }) }
      : { tone: 'bad', text: t('ws.stopAllFailed', { message: failures.join('；') }) })
    if (partitionId !== undefined) void loadMemory(partitionId)
  }

  const addNote = async (): Promise<void> => {
    const text = noteText.trim()
    if (partitionId === undefined || text === '' || noteBusy) return
    setNoteBusy(true)
    try {
      await controller.addMemoryNote(partitionId, text)
      setNoteText('')
      await loadMemory(partitionId)
    } catch (error) {
      setMessage({ tone: 'bad', text: t('ws.mem.failed', { message: error instanceof Error ? error.message : String(error) }) })
    } finally {
      setNoteBusy(false)
    }
  }

  const forgetNote = async (id: string): Promise<void> => {
    if (partitionId === undefined) return
    try {
      await controller.removeMemoryNote(partitionId, id)
      await loadMemory(partitionId)
    } catch (error) {
      setMessage({ tone: 'bad', text: t('ws.mem.failed', { message: error instanceof Error ? error.message : String(error) }) })
    }
  }

  const MANAGER_SOURCE: Readonly<Record<string, string>> = {
    strongest: t('ws.mem.src.strongest'),
    hard: t('ws.mem.src.hard'),
    saved: t('ws.mem.src.saved'),
    inherit: t('ws.mem.src.inherit'),
  }

  /** 分区记忆 section: manager model, notes, recent work, worker sessions. */
  const memorySection = () => {
    if (!controller.canReadMemory) return null
    const read = memory !== null && memory.partition === partitionId ? memory : undefined
    const view = read?.view
    return (
      <section className="dshws-sec" data-router-memory>
        <h3>{t('ws.mem.title')}</h3>
        {read === undefined
          ? <div className="dshws-note">{t('ws.loading')}</div>
          : read.error !== undefined
            ? <div className="dshws-note" data-tone="error">{t('ws.error', { message: read.error })}</div>
            : view !== undefined && (
                <>
                  <dl className="dshws-kv">
                    <dt>{t('ws.mem.manager')}</dt>
                    <dd>
                      {!view.manager.enabled
                        ? t('ws.mem.noManager')
                        : view.manager.route === undefined
                          ? MANAGER_SOURCE[view.manager.source] ?? view.manager.source
                          : `${view.manager.route.model}${view.manager.route.reasoningEffort === undefined ? '' : ` · ${view.manager.route.reasoningEffort}`}（${MANAGER_SOURCE[view.manager.source] ?? view.manager.source}）`}
                    </dd>
                  </dl>
                  <h4 className="dshws-h4">{t('ws.mem.notes', { n: view.notes.length })}</h4>
                  {view.notes.length === 0
                    ? <div className="dshws-note">{t('ws.mem.noNotes')}</div>
                    : (
                        <ul className="dshws-notes">
                          {view.notes.map(note => (
                            <li key={note.id} className="dshws-mnote">
                              <span className="dshws-mtext">{note.text}</span>
                              <span className="dshws-mmeta">{t(`ws.mem.by.${note.by}`)} · {relativeTime(note.at, now)}</span>
                              <button type="button" className="dshws-x" title={t('ws.mem.forget')} aria-label={t('ws.mem.forget')}
                                onClick={() => { void forgetNote(note.id) }}>×</button>
                            </li>
                          ))}
                        </ul>
                      )}
                  <form className="dshws-addnote" onSubmit={(event) => { event.preventDefault(); void addNote() }}>
                    <input value={noteText} maxLength={600} placeholder={t('ws.mem.placeholder')}
                      onChange={(event) => { setNoteText(event.target.value) }} />
                    <button type="submit" className="dshws-btn" disabled={noteBusy || noteText.trim() === ''}>{t('ws.mem.add')}</button>
                  </form>
                  <h4 className="dshws-h4">{t('ws.mem.work', { n: view.logTotal })}</h4>
                  {view.log.length === 0
                    ? <div className="dshws-note">{t('ws.mem.noWork')}</div>
                    : (
                        <ul className="dshws-tasks">
                          {view.log.slice(0, 12).map(entry => {
                            const open = entry.sessionId !== undefined && onOpenSession !== undefined
                              ? () => { onOpenSession(entry.sessionId!) }
                              : undefined
                            return (
                              <li key={`${entry.taskId}-${entry.at}`} className="dshws-task" data-link={open === undefined ? undefined : ''}
                                onClick={open}>
                                <div className="dshws-tt">
                                  <span className="dshws-tn">{entry.subject}</span>
                                  <span className="dshws-ts" data-tone={entry.state === 'failed' || entry.state === 'cancelled' ? 'blocked' : undefined}>
                                    {t(`ws.mem.state.${entry.state}`)}
                                  </span>
                                </div>
                                <span className="dshws-tm">
                                  {[relativeTime(entry.at, now), entry.level === 'manager' ? 'manager' : entry.model, entry.summary ?? entry.error]
                                    .filter(part => part !== undefined && part !== '').join(' · ')}
                                </span>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                  <h4 className="dshws-h4">{t('ws.mem.sessions', { n: view.sessions.length })}</h4>
                  {view.sessions.length === 0
                    ? <div className="dshws-note">{t('ws.mem.noSessions')}</div>
                    : (
                        <ul className="dshws-tasks">
                          {view.sessions.slice(0, 12).map((ref) => {
                            const open = onOpenSession !== undefined ? () => { onOpenSession(ref.sessionId) } : undefined
                            return (
                              <li key={ref.sessionId} className="dshws-task" data-link={open === undefined ? undefined : ''} onClick={open}>
                                <div className="dshws-tt">
                                  <span className="dshws-tn">{ref.subject}</span>
                                  <span className="dshws-ts">{t(`ws.mem.state.${ref.state}`)}</span>
                                </div>
                                <span className="dshws-tm">{[ref.taskId, relativeTime(ref.updatedAt, now), ref.summary].filter(part => part !== undefined && part !== '').join(' · ')}</span>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                </>
              )}
      </section>
    )
  }

  const rootListing = partitionId === undefined ? undefined : dirs.get(dirKey(partitionId, ''))
  const include = current?.include ?? (rootListing?.status === 'ok' ? rootListing.listing.include : undefined)
  const exclude = current?.exclude ?? (rootListing?.status === 'ok' ? rootListing.listing.exclude : undefined)
  const problems = current?.problems ?? []

  return (
    <div className="dshws-wrap">
      <div className="dshrc dshws" data-router-workspace>
        <style>{STYLE}</style>
        <header className="dshws-head">
          <div className="dshws-ht">
            <h2 className="dshws-title">{t('ws.title')}</h2>
            <p className="dshws-sub">{t('ws.subtitle')}</p>
          </div>
          <button type="button" className="dshws-btn" onClick={refresh}>{t('ws.refresh')}</button>
        </header>
        {board === null
          ? <div className="dshws-empty">{t('board.loading')}</div>
          : current === undefined
            ? <div className="dshws-empty">{t('ws.noPartition')}</div>
            : (
                <div className="dshws-body">
                  <div className="dshws-left">
                    <span className="dshws-cap">{t('ws.partitions')}</span>
                    <div className="dshws-parts">{partitions.map(partitionRow)}</div>
                    <span className="dshws-cap">{current.name}</span>
                    <div className="dshws-tree" role="tree" aria-label={current.name}>
                      {controller.canListFiles
                        ? dirBody(current.id, '', 0)
                        : <div className="dshws-note">{t('ws.notWired')}</div>}
                    </div>
                  </div>
                  <div className="dshws-right">
                    <section className="dshws-sec">
                      <h3>{current.name}</h3>
                      <dl className="dshws-kv">
                        <dt>{t('ws.root')}</dt>
                        <dd><code>{current.path ?? current.repo ?? ''}</code></dd>
                        <dt>{t('ws.include')}</dt>
                        <dd>
                          {include === undefined || (include.length === 1 && include[0] === '**')
                            ? t('ws.all')
                            : <span className="dshws-globs">{include.map(glob => <span key={glob} className="dshws-glob">{glob}</span>)}</span>}
                        </dd>
                        <dt>{t('ws.exclude')}</dt>
                        <dd>
                          {exclude === undefined || exclude.length === 0
                            ? t('ws.none')
                            : <span className="dshws-globs">{exclude.map(glob => <span key={glob} className="dshws-glob">{glob}</span>)}</span>}
                        </dd>
                      </dl>
                      {current.description !== undefined && current.description !== '' && (
                        <p className="dshws-sub">{current.description}</p>
                      )}
                    </section>
                    <section className="dshws-sec">
                      <h3>{t('ws.problems')}</h3>
                      {problems.length === 0
                        ? <span className="dshws-ok">{t('ws.noProblems')}</span>
                        : (
                            <ul className="dshws-probs">
                              {problems.map(problem => (
                                <li key={problem.message} className="dshws-prob" data-level={problem.level}>{problem.message}</li>
                              ))}
                            </ul>
                          )}
                    </section>
                    <section className="dshws-sec">
                      <h3>{t('ws.rules')}</h3>
                      <ol className="dshws-rules">
                        <li>{t('ws.rule1')}</li>
                        <li>{t('ws.rule2')}</li>
                        <li>{t('ws.rule3')}</li>
                      </ol>
                    </section>
                    <section className="dshws-sec">
                      <div className="dshws-sech">
                        <h3>{t('ws.tasks')}</h3>
                        {tasks.length > 0 && controller.canControl && (
                          <button type="button" className="dshws-btn" data-tone="stop" data-armed={stopArmed ? '' : undefined}
                            disabled={stopping} title={t('ws.stopAllHint')} onClick={() => { void stopAll() }}>
                            {stopping ? t('ws.stopping') : stopArmed ? t('ws.stopAllConfirm', { n: tasks.length }) : t('ws.stopAll')}
                          </button>
                        )}
                      </div>
                      {message !== null && <div className="dshws-note" data-tone={message.tone === 'bad' ? 'error' : undefined} role="status">{message.text}</div>}
                      {tasks.length === 0
                        ? <span className="dshws-sub">{t('ws.noTasks')}</span>
                        : <ul className="dshws-tasks">{tasks.map(taskRow)}</ul>}
                    </section>
                    {memorySection()}
                  </div>
                </div>
              )}
      </div>
    </div>
  )
}
