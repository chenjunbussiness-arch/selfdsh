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
    <div className="dshr-wr-row" data-off={partition.enabled === false ? 'true' : 'false'}>
      <div className="dshr-wr-main">
        <div className="dshr-wr-name">{partition.name}</div>
        <div className="dshr-wr-path">{partition.path ?? partition.repo ?? ''}</div>
      </div>
      <div className="dshr-wr-counts">
        {idle
          ? <span className="dshr-wr-quiet">idle</span>
          : (
            <>
              <span title="running">{running} running</span>
              <span title="queued" className="dshr-wr-quiet">{queued} queued</span>
              {pending > 0 ? <span className="dshr-wr-pending">{pending} for you</span> : null}
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
    <div className="dshr-wr">
      <div className="dshr-wr-col">
        <header className="dshr-wr-head">
          <h1 className="dshr-wr-title">作战室</h1>
          <p className="dshr-wr-sub">
            {partitions.length} workspaces · {running.length} running · {queued.length} queued
            {pending.length > 0 ? ` · ${pending.length} waiting on you` : ''}
          </p>
          {board?.origin === 'mock'
            ? <p className="dshr-wr-mock">sample data — the host bridge is not reachable</p>
            : null}
        </header>

        <section className="dshr-wr-composer">
          <textarea
            className="dshr-wr-input"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
            }}
            placeholder="说清楚要做什么、验收标准是什么。回车换行，⌘/Ctrl+Enter 派发。"
            aria-label="派发"
            rows={3}
          />
          <div className="dshr-wr-foot">
            <button
              type="button"
              className="dshr-btn"
              data-tone="primary"
              data-size="xs"
              onClick={submit}
              disabled={draft.trim() === '' || state.publishing}
            >{state.publishing ? '派发中…' : '派发'}</button>
            {state.error === undefined ? null : <span className="dshr-wr-error" role="alert">{state.error}</span>}
            {state.lastPublish === undefined
              ? null
              : (
                <span className="dshr-wr-note">
                  posted {state.lastPublish.accepted}
                  {state.lastPublish.routed[0]?.partitionId === undefined
                    ? ''
                    : `, partition ${state.lastPublish.routed[0].partitionId}`}
                </span>
              )}
          </div>
        </section>

        <section className="dshr-wr-block" aria-label="Workspaces">
          <div className="dshr-wr-block-title">Workspaces</div>
          <div className="dshr-wr-list">
            {partitions.length === 0
              ? <div className="dshr-wr-empty">no partition reported</div>
              : partitions.map(partition => (
                <PartitionRow
                  key={partition.id}
                  partition={partition}
                  running={countWhere(tasks, partition.id, task => task.state === 'running')}
                  queued={countWhere(tasks, partition.id, task => task.state === 'queued')}
                  pending={countWhere(tasks, partition.id, isPending)}
                />
              ))}
          </div>
        </section>

        <section className="dshr-wr-block" aria-label="Waiting on you">
          <div className="dshr-wr-block-title">Waiting on you · {pending.length}</div>
          <div className="dshr-wr-list">
            {pending.length === 0
              ? <div className="dshr-wr-empty">nothing needs a decision</div>
              : pending.map(task => (
                <div key={task.id} className="dshr-wr-row">
                  <span className="dshr-wr-tag" data-tone="warn">
                    {task.hostState === 'blocked' ? 'blocked' : 'reported'}
                  </span>
                  <span className="dshr-wr-text">{task.title}</span>
                  <span className="dshr-wr-meta">{task.partitionId}</span>
                </div>
              ))}
          </div>
        </section>

        <section className="dshr-wr-block" aria-label="In progress">
          <div className="dshr-wr-block-title">In progress · {running.length}</div>
          <div className="dshr-wr-list">
            {running.length === 0
              ? <div className="dshr-wr-empty">no worker is running</div>
              : running.map(task => (
                <div key={task.id} className="dshr-wr-row">
                  <span className="dshr-wr-tag" data-tone="busy">running</span>
                  <span className="dshr-wr-text">{task.title}</span>
                  <span className="dshr-wr-meta">{progressOf(task)}</span>
                </div>
              ))}
          </div>
        </section>
      </div>
    </div>
  )
}
