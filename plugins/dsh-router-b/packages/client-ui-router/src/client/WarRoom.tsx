/**
 * The war room: the panel that replaces the conversation as the default screen.
 *
 * Three questions, in the order a person asks them, and nothing else:
 *
 *   1. which workspaces have work — one row per partition, with counts;
 *   2. what needs me — tasks a worker says it finished, and tasks the router
 *      parked on a human decision;
 *   3. where is each task — one line per running task, with the worker's own
 *      checklist progress.
 *
 * The composer at the top publishes a demand straight into the router, which is
 * the whole point of this panel existing: the conversation is still one click
 * away, but dispatching work does not require opening it.
 *
 * Data comes from {@link RouterBoardController}, the same controller the
 * right-hand board uses, so the two surfaces cannot disagree about state. No
 * Harness package is imported: this renders inside the Web module loader, where
 * `@deepseek-ai/dsh-*` specifiers are module-table entries rather than deps.
 *
 * @module client-ui-router/warroom
 */

import { useState, useSyncExternalStore, type ReactNode } from 'react'

import type { RouterBoardController } from './controller.ts'
import type { PartitionView, TaskView } from './contract.ts'

/** Shared hairline that reads correctly on both light and dark backgrounds. */
const LINE = '1px solid rgba(127, 127, 127, 0.22)'

/** What this panel receives from its registration. */
export interface WarRoomProps {
  /** The board controller shared with the right-hand panel. */
  readonly controller: RouterBoardController
}

/** One task the person has to do something about. */
function isPending(task: TaskView): boolean {
  return task.state === 'reported' || task.hostState === 'blocked'
}

/** Count tasks of one partition matching a predicate. */
function countWhere(
  tasks: readonly TaskView[],
  partitionId: string,
  match: (task: TaskView) => boolean,
): number {
  return tasks.filter(task => task.partitionId === partitionId && match(task)).length
}

/** One-line progress for a running task: state, worker, checklist, current step. */
function progressOf(task: TaskView): string {
  const worker = task.workerId === undefined ? 'unassigned' : task.workerId
  const todos = task.todoProgress
  if (todos === undefined || todos.total === 0) return `${worker} · no checklist yet`
  const current = todos.current === undefined ? '' : ` · now: ${todos.current}`
  return `${worker} · ${todos.ratio}${current}`
}

/**
 * One partition row: the workspace, and how much of its work is in each state.
 * @param props - the partition and the counts already computed for it.
 */
function PartitionRow({ partition, running, queued, pending }: {
  readonly partition: PartitionView
  readonly running: number
  readonly queued: number
  readonly pending: number
}): ReactNode {
  const idle = running === 0 && queued === 0 && pending === 0
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr auto',
      gap: 12,
      alignItems: 'center',
      padding: '10px 12px',
      borderBottom: LINE,
      opacity: partition.enabled === false ? 0.45 : 1,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{partition.name}</div>
        <div style={{
          fontSize: 11,
          opacity: 0.6,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>{partition.path ?? partition.repo ?? ''}</div>
      </div>
      <div style={{ fontSize: 12, display: 'flex', gap: 10, fontVariantNumeric: 'tabular-nums' }}>
        {idle
          ? <span style={{ opacity: 0.4 }}>idle</span>
          : (
            <>
              <span title="running">{running} running</span>
              <span title="queued" style={{ opacity: 0.7 }}>{queued} queued</span>
              {pending > 0 ? <span style={{ color: '#d97706' }}>{pending} for you</span> : null}
            </>
          )}
      </div>
    </div>
  )
}

/**
 * The war room page.
 * @param props - the shared board controller.
 */
export function WarRoom({ controller }: WarRoomProps): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [draft, setDraft] = useState('')
  const board = state.board
  const tasks = board?.tasks ?? []
  const partitions = board?.partitions ?? []
  const pending = tasks.filter(isPending)
  const running = tasks.filter(task => task.state === 'running')
  const queued = tasks.filter(task => task.state === 'queued')

  const submit = (): void => {
    const text = draft.trim()
    if (text === '' || state.publishing) return
    setDraft('')
    void controller.publish([text])
  }

  return (
    <div style={{
      height: '100%',
      overflow: 'auto',
      padding: '28px 32px 48px',
      display: 'flex',
      flexDirection: 'column',
      gap: 20,
    }}>
      <header>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 650, letterSpacing: '-0.01em' }}>作战室</h1>
        <div style={{ marginTop: 4, fontSize: 12, opacity: 0.6 }}>
          {partitions.length} workspaces · {running.length} running · {queued.length} queued
          {pending.length > 0 ? ` · ${pending.length} waiting on you` : ''}
        </div>
        {board?.origin === 'mock'
          ? <div style={{ marginTop: 6, fontSize: 12, color: '#d97706' }}>sample data — the host bridge is not reachable</div>
          : null}
      </header>

      <section>
        <textarea
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
          }}
          placeholder="说清楚要做什么、验收标准是什么。回车换行，⌘/Ctrl+Enter 派发。"
          rows={3}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            resize: 'vertical',
            padding: '10px 12px',
            fontSize: 13,
            lineHeight: 1.5,
            color: 'inherit',
            background: 'transparent',
            border: LINE,
            borderRadius: 8,
            outline: 'none',
            fontFamily: 'inherit',
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
          <button
            type="button"
            onClick={submit}
            disabled={draft.trim() === '' || state.publishing}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 6,
              border: LINE,
              background: 'transparent',
              color: 'inherit',
              cursor: draft.trim() === '' || state.publishing ? 'default' : 'pointer',
              opacity: draft.trim() === '' || state.publishing ? 0.45 : 1,
            }}
          >{state.publishing ? '派发中…' : '派发'}</button>
          {state.error === undefined ? null : <span style={{ fontSize: 12, color: '#dc2626' }}>{state.error}</span>}
          {state.lastPublish === undefined
            ? null
            : (
              <span style={{ fontSize: 12, opacity: 0.7 }}>
                posted {state.lastPublish.accepted}
                {state.lastPublish.routed[0]?.partitionId === undefined
                  ? ''
                  : `, partition ${state.lastPublish.routed[0].partitionId}`}
              </span>
            )}
        </div>
      </section>

      <section style={{ border: LINE, borderRadius: 10 }}>
        <div style={sectionHeader}>Workspaces</div>
        {partitions.length === 0
          ? <div style={empty}>no partition reported</div>
          : partitions.map(partition => (
            <PartitionRow
              key={partition.id}
              partition={partition}
              running={countWhere(tasks, partition.id, task => task.state === 'running')}
              queued={countWhere(tasks, partition.id, task => task.state === 'queued')}
              pending={countWhere(tasks, partition.id, isPending)}
            />
          ))}
      </section>

      <section style={{ border: LINE, borderRadius: 10 }}>
        <div style={sectionHeader}>Waiting on you · {pending.length}</div>
        {pending.length === 0
          ? <div style={empty}>nothing needs a decision</div>
          : pending.map(task => (
            <div key={task.id} style={row}>
              <span style={{ fontSize: 12, color: '#d97706', flex: '0 0 auto' }}>
                {task.hostState === 'blocked' ? 'blocked' : 'reported'}
              </span>
              <span style={title}>{task.title}</span>
              <span style={meta}>{task.partitionId}</span>
            </div>
          ))}
      </section>

      <section style={{ border: LINE, borderRadius: 10 }}>
        <div style={sectionHeader}>In progress · {running.length}</div>
        {running.length === 0
          ? <div style={empty}>no worker is running</div>
          : running.map(task => (
            <div key={task.id} style={{ ...row, alignItems: 'baseline' }}>
              <span style={{ fontSize: 12, opacity: 0.6, flex: '0 0 auto' }}>running</span>
              <span style={title}>{task.title}</span>
              <span style={{ ...meta, flex: '0 1 auto', textAlign: 'right' }}>{progressOf(task)}</span>
            </div>
          ))}
      </section>
    </div>
  )
}

const sectionHeader = {
  padding: '9px 12px',
  fontSize: 11,
  fontWeight: 650,
  letterSpacing: '0.06em',
  textTransform: 'uppercase' as const,
  opacity: 0.55,
  borderBottom: LINE,
}

const empty = { padding: '12px', fontSize: 12, opacity: 0.45 }

const row = {
  display: 'flex',
  gap: 12,
  alignItems: 'center',
  padding: '9px 12px',
  borderBottom: LINE,
  fontSize: 12.5,
}

const title = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }

const meta = { flex: '0 0 auto', fontSize: 11.5, opacity: 0.6, fontVariantNumeric: 'tabular-nums' as const }
