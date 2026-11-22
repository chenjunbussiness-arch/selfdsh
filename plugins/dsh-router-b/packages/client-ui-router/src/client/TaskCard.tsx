/**
 * One task on the board: a compact row, and — once opened — the worker's
 * checklist and the actions that belong to this task's state.
 *
 * The row is deliberately one line with a state ring, the way a working list
 * reads in a task app: you scan titles, not cards. The ring is the only place
 * `reported` and `verified` are allowed to look similar, and they do not even
 * there: a self-report is an amber open ring, a verified task is a filled green
 * check. Everything else follows from that distinction — 待验收 is the only
 * section that offers 通过验收 / 退回, and only it prints 自报于 ….
 */

import { useState } from 'react'
import type { ArtifactRef, TaskState, TaskView } from './contract.ts'
import { todoProgress } from './lanes.ts'
import { bytes, relativeTime } from './format.ts'

/** Tone each state paints into the row's ring and chip. */
const TONE: Record<TaskState, 'neutral' | 'busy' | 'warn' | 'ok' | 'bad'> = {
  queued: 'neutral',
  running: 'busy',
  reported: 'ok',
  verified: 'ok',
  rejected: 'bad',
}

/** Props for {@link TaskCard}. */
export interface TaskCardProps {
  /** The task to render. */
  readonly task: TaskView
  /** Display name of the owning partition. */
  readonly partitionName: string
  /** Display name of the assigned worker, when one is assigned. */
  readonly workerName?: string
  /** Namespace-bound translate. */
  readonly t: (key: string, values?: Record<string, string | number>) => string
  /** Whether the detail is open. */
  readonly open: boolean
  /** Open or close this task's detail. */
  readonly onToggle: (taskId: string) => void
  /** Accept or send back a reported task. */
  readonly onVerify?: (taskId: string, verdict: Extract<TaskState, 'verified' | 'rejected'>, note?: string) => void
  /** Open the executing worker's Session. */
  readonly onOpenSession?: (sessionId: string) => void
  /** Download a produced artifact. */
  readonly onDownload?: (artifact: ArtifactRef) => void
}

/**
 * Render one task row.
 * @param props - task plus the actions the board offers for it.
 * @returns the row, with its detail rendered but hidden while closed.
 */
export function TaskCard({
  task, partitionName, workerName, t, open, onToggle, onVerify, onOpenSession, onDownload,
}: TaskCardProps) {
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const progress = todoProgress(task.todos)
  const tone = TONE[task.state]
  const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)
  // Only a reported task can be judged here, and only a worker with a Session can
  // be opened. No action, no action row: an empty strip of padding is noise.
  // No acceptance step any more: a finished task is simply done.
  const canVerify = false as boolean
  const canOpen = task.workerSessionId !== undefined && onOpenSession !== undefined

  return (
    <article className="dshr-task" data-tone={tone} data-task={task.id} data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="dshr-task-row"
        aria-expanded={open}
        aria-label={`${task.title} — ${t(`state.${task.state}`)}`}
        title={open ? t('task.collapse') : t('task.expand')}
        onClick={() => { onToggle(task.id) }}
      >
        <span className="dshr-ring" data-state={task.state} aria-hidden="true" />
        {task.level !== undefined && (
          <span className="dshr-chip" data-level={task.level} title={task.parentId === undefined ? task.id : ` ← `}>
            {task.level === 'manager' ? 'manager' : 'worker'}
          </span>
        )}
        <span className="dshr-task-title">{task.title}</span>
        {/* Wide layouts only (container query): where the task lives, how far
            along it is, and when it last moved. The docked Sidebar hides it. */}
        <span className="dshr-task-aside" aria-hidden="true">
          <span className="dshr-task-part">{partitionName}</span>
          <span className="dshr-task-prog">{progress.total === 0 ? '—' : `${progress.done}/${progress.total}`}</span>
          <span className="dshr-task-time">{relativeTime(task.state === 'reported' ? task.reportedAt ?? task.updatedAt : task.updatedAt)}</span>
        </span>
      </button>

      <div className="dshr-task-body" hidden={!open}>
        <div className="dshr-task-meta">
          <span className="dshr-chip" data-tone={tone}>{t(`state.${task.state}`)}</span>
          <span className="dshr-mono">{partitionName}</span>
          <span className="dshr-sep">·</span><span className="dshr-mono">{task.id}</span>
          {task.parentId !== undefined && <><span className="dshr-sep">·</span><span className="dshr-mono">↳ {task.parentId}</span></>}
          {workerName !== undefined && <><span className="dshr-sep">·</span><span>{workerName}</span></>}
          {(task.attempt ?? 1) > 1 && <><span className="dshr-sep">·</span><span>{t('task.attempt', { count: task.attempt ?? 1 })}</span></>}
          {/* A reported task's `updatedAt` is the report itself, so printing both
              said "6 分钟前 · 自报于 6 分钟前". The specific one wins. */}
          {task.state !== 'reported' && (
            <><span className="dshr-sep">·</span><span>{relativeTime(task.updatedAt)}</span></>
          )}
          {task.state === 'reported' && task.reportedAt !== undefined && (
            <><span className="dshr-sep">·</span><span>{t('task.reportedAt', { time: relativeTime(task.reportedAt) })}</span></>
          )}
          {task.state === 'verified' && task.verifiedAt !== undefined && (
            <><span className="dshr-sep">·</span><span>{t('task.verifiedAt', { time: relativeTime(task.verifiedAt) })}</span></>
          )}
          {task.scheduledFor !== undefined && (
            <><span className="dshr-sep">·</span><span>{t('lane.scheduled')} {new Date(task.scheduledFor).toLocaleTimeString(undefined, { hour12: false })}</span></>
          )}
        </div>

        {task.todos.length === 0
          ? <div className="dshr-empty">{t('task.noTodos')}</div>
          : (
            <div className="dshr-todos">
              <div className="dshr-todo-head">
                <span>{t('todo.title')}</span>
                <span className="dshr-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
                  <i style={{ width: `${percent}%` }} />
                </span>
                <span className="dshr-count">{t('todo.progress', { done: progress.done, total: progress.total })}</span>
              </div>
              {progress.current !== undefined && (
                <div className="dshr-current">
                  <span aria-hidden="true">▶</span>
                  <span className="dshr-current-text">{t('todo.current', { content: progress.current })}</span>
                </div>
              )}
              {task.todos.map((item, index) => (
                <div className="dshr-todo" data-status={item.status} key={`${task.id}-${index}`}>
                  <span className="dshr-mark" aria-hidden="true" />
                  <span className="dshr-todo-text">{item.content}</span>
                </div>
              ))}
            </div>
          )}

        {task.rejectionReason !== undefined && (
          <div className="dshr-reject-note">{task.rejectionReason}</div>
        )}

        {task.artifacts !== undefined && task.artifacts.length > 0 && (
          <div className="dshr-artifacts">
            {task.artifacts.map(item => (
              <button
                key={item.address}
                type="button"
                className="dshr-artifact"
                title={item.address}
                onClick={() => { onDownload?.(item) }}
              >
                <span>⤓</span>
                <span>{item.name}</span>
                {item.bytes !== undefined && <span className="dshr-count">{bytes(item.bytes)}</span>}
              </button>
            ))}
          </div>
        )}

        {(canVerify || canOpen) && (
          <div className="dshr-task-actions">
            {canVerify && (
              <>
                <button type="button" className="dshr-btn" data-tone="ok" data-size="xs"
                  onClick={() => { onVerify!(task.id, 'verified') }}>
                  {t('task.verify')}
                </button>
                <button type="button" className="dshr-btn" data-tone="bad" data-size="xs"
                  onClick={() => { setRejecting(value => !value) }}>
                  {t('task.reject')}
                </button>
              </>
            )}
            <span className="dshr-fill" />
            {canOpen && (
              <button type="button" className="dshr-btn" data-size="xs"
                onClick={() => { onOpenSession!(task.workerSessionId!) }}>
                {t('task.openSession')}
              </button>
            )}
          </div>
        )}

        {rejecting && onVerify !== undefined && (
          <div className="dshr-task-actions">
            <input
              className="dshr-input dshr-reject-input"
              placeholder={t('task.reject.reason')}
              value={reason}
              onChange={event => { setReason(event.target.value) }}
              aria-label={t('task.reject.reason')}
            />
            <button type="button" className="dshr-btn" data-tone="bad" data-size="xs"
              onClick={() => {
                onVerify(task.id, 'rejected', reason.trim() === '' ? t('state.rejected') : reason.trim())
                setRejecting(false)
                setReason('')
              }}>
              {t('task.reject')}
            </button>
          </div>
        )}
      </div>
    </article>
  )
}
