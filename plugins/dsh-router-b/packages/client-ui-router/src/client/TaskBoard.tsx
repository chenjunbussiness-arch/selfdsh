/**
 * The task column: a tab strip, the sections inside the selected tab, and one
 * compact row per task.
 *
 * Every section stays in the DOM and is hidden with the `hidden` attribute, not
 * removed: the tab strip is a view switch over one list, so a proposed verdict
 * (or a test) never depends on which tab happened to be selected at render time.
 * `hidden` keeps the closed sections out of the accessibility tree and out of the
 * tab order, which is the part that matters.
 */

import { useMemo } from 'react'
import type { ArtifactRef, BoardSnapshot, PublishResult, TaskState, TaskView } from './contract.ts'
import { SECTIONS, TABS, tabCounts, tasksIn, type TabId } from './lanes.ts'
import { clockTime } from './format.ts'
import { Composer } from './Composer.tsx'
import { TaskCard } from './TaskCard.tsx'

/** Tone per tab: the one thing that needs the user is allowed to glow. */
type TabTone = 'neutral' | 'busy' | 'warn' | 'ok'

/** Props for {@link TaskBoard}. */
export interface TaskBoardProps {
  /** The last board read. Never null: the panel shows its own loading state. */
  readonly board: BoardSnapshot
  /** Tasks after the partition filter, in board order. */
  readonly tasks: readonly TaskView[]
  /** Selected tab. */
  readonly tab: TabId
  /** Select a tab. */
  readonly onTab: (tab: TabId) => void
  /** Namespace-bound translate. */
  readonly t: (key: string, values?: Record<string, string | number>) => string
  /** Read lifecycle of the board. */
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  /** True while a publish is in flight. */
  readonly publishing: boolean
  /** Last publish outcome. */
  readonly lastPublish?: PublishResult
  /** Last read failure, already human-readable. */
  readonly error?: string
  /** Ids of tasks whose detail is open. */
  readonly openTasks: ReadonlySet<string>
  /** Open or close one task's detail. */
  readonly onToggleTask: (taskId: string) => void
  /** Keep the composer always open at the top (the Routing page). */
  readonly inlineComposer?: boolean
  /** Whether the demand composer is open. */
  readonly composerOpen: boolean
  /** Open or close the demand composer. */
  readonly onToggleComposer: () => void
  /** Re-read the board. */
  readonly onRefresh: () => void
  /** Publish one demand per line. */
  readonly onPublish: (demands: readonly string[]) => void
  /** Open the 作战室 chat Session; absent when the shell cannot open Sessions. */
  readonly onOpenWarRoom?: () => void
  /** Clear the publish banner. */
  readonly onClearNotice: () => void
  /** Whether the project rail is open. */
  readonly railOpen: boolean
  /** DOM id of the rail, for aria-controls. */
  readonly railId: string
  /** Open or close the project rail. */
  readonly onToggleRail: () => void
  /** Drop the partition filter. */
  readonly onClearFilter: () => void
  /** Display name of the partition the list is filtered to, when one is. */
  readonly filterName?: string
  /** Display name of a task's partition. */
  readonly partitionOf: (task: TaskView) => string
  /** Display name of a task's worker, when assigned. */
  readonly workerOf: (task: TaskView) => string | undefined
  /** The task with any live checklist projection folded in. */
  readonly resolve: (task: TaskView) => TaskView
  /** Accept or send back a reported task. */
  readonly onVerify?: (taskId: string, verdict: Extract<TaskState, 'verified' | 'rejected'>, note?: string) => void
  /** Open the executing worker's Session. */
  readonly onOpenSession?: (sessionId: string) => void
  /** Download a produced artifact. */
  readonly onDownload?: (artifact: ArtifactRef) => void
}

/**
 * Render the task column.
 * @param props - board data, tab state, and the actions each row offers.
 * @returns the tab strip and the sections under it.
 */
export function TaskBoard(props: TaskBoardProps) {
  const {
    board, tasks, tab, onTab, t, status, publishing, lastPublish, error, openTasks, onToggleTask,
    inlineComposer, composerOpen, onToggleComposer, onRefresh, onPublish, onClearNotice, railOpen, railId, onToggleRail, onClearFilter, filterName,
    partitionOf, workerOf, resolve, onVerify, onOpenSession, onDownload, onOpenWarRoom,
  } = props

  const counts = useMemo(() => tabCounts(tasks), [tasks])
  const active = TABS.find(candidate => candidate.id === tab) ?? TABS[0]!
  const workerTotal = board.partitions.reduce((sum, partition) => sum + partition.workers.length, 0)

  /** Tabs earn a tone from what their count is made of. */
  const toneOf = (id: TabId): TabTone => {
    if (id === 'active') return 'busy'
    if (id === 'resolved') return 'ok'
    return 'neutral'
  }

  return (
    <section className="dshr-main" aria-label={t('panel.title')}>
      <header className="dshr-main-head">
        <h3 className="dshr-main-title">{t('panel.title')}</h3>
        <span className="dshr-rail-ctl" data-filtered={filterName === undefined ? 'false' : 'true'}>
          <button type="button" className="dshr-rail-btn" aria-expanded={railOpen} aria-controls={railId}
            aria-label={railOpen ? t('rail.close') : t('rail.open')}
            title={filterName === undefined ? (railOpen ? t('rail.close') : t('rail.open')) : t('rail.filtering', { name: filterName })}
            onClick={onToggleRail}>
            {/* Sidebar glyph: a frame with the left column filled. */}
            <svg className="dshr-rail-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M6 3v10" stroke="currentColor" strokeWidth="1.4" fill="none" />
              <rect x="2.4" y="3.4" width="3" height="9.2" rx="1.6" fill="currentColor" opacity="0.28" />
            </svg>
            {filterName === undefined
              ? (
                <>
                  <span className="dshr-rail-btn-label">{t('rail.title')}</span>
                  <span className="dshr-rail-btn-count">{board.partitions.length}</span>
                </>
              )
              : <span className="dshr-rail-btn-label dshr-ellipsis">{t('rail.filtering', { name: filterName })}</span>}
          </button>
          {filterName !== undefined && (
            <button type="button" className="dshr-rail-clear" aria-label={t('rail.filter.clearTitle')}
              title={t('rail.filter.clearTitle')} onClick={onClearFilter}>
              <span aria-hidden="true">×</span>
            </button>
          )}
        </span>
        <span className="dshr-fill" />
        {onOpenWarRoom !== undefined && (
          <button type="button" className="dshr-icon-btn" data-warroom="open"
            aria-label={t('warroom.open')} title={t('warroom.open')} onClick={onOpenWarRoom}>
            <span aria-hidden="true">💬</span>
            <span className="dshr-btn-label">{t('warroom.open')}</span>
          </button>
        )}
        {inlineComposer !== true && (
          <button type="button" className="dshr-icon-btn" data-open="plus" aria-expanded={composerOpen}
            aria-label={t('task.newDemand')} title={t('task.newDemand')}
            onClick={onToggleComposer}>
            <span aria-hidden="true">+</span>
            <span className="dshr-btn-label">{t('task.newDemand')}</span>
          </button>
        )}
        <button type="button" className="dshr-icon-btn" aria-label={t('board.refresh')}
          title={t('board.refresh')} onClick={onRefresh} disabled={status === 'loading'}>
          {status === 'loading' ? '…' : '↻'}
        </button>
      </header>

      <div className="dshr-main-sub">
        <span className="dshr-ellipsis">
          {t('panel.subtitle', { partitions: board.partitions.length, workers: workerTotal })}
        </span>
        {filterName !== undefined && (
          <>
            <span className="dshr-sep">·</span>
            <span className="dshr-mono">{t('rail.selected', { name: filterName })}</span>
          </>
        )}
        <span className="dshr-fill" />
        {board.origin === 'mock' && (
          <span className="dshr-origin" title={t('board.mock.hint')}>{t('board.mock')}</span>
        )}
        {board.staleSince !== undefined && (
          <span className="dshr-origin" data-tone="bad" title={t('board.stale')}>{t('board.stale')}</span>
        )}
        <span className="dshr-stamp">{t('board.updated', { time: clockTime(board.fetchedAt) })}</span>
      </div>

      {error !== undefined && <div className="dshr-notice" data-tone="bad">{t('board.error', { message: error })}</div>}

      {(inlineComposer === true || composerOpen) && (
        <div className={inlineComposer === true ? 'dshr-hero' : 'dshr-drawer'}>
          <Composer
            t={t}
            busy={publishing}
            {...(lastPublish === undefined ? {} : { lastPublish })}
            onPublish={onPublish}
            onEdit={onClearNotice}
          />
        </div>
      )}

      <div className="dshr-tabs" role="tablist" aria-label={t('panel.title')}>
        {TABS.map((definition) => {
          const count = counts[definition.id]
          return (
            <button
              key={definition.id}
              type="button"
              role="tab"
              className="dshr-tab"
              data-tab={definition.id}
              data-tone={toneOf(definition.id)}
              data-has={count > 0 ? 'true' : 'false'}
              aria-selected={tab === definition.id}
              onClick={() => { onTab(definition.id) }}
            >
              <span>{t(definition.labelKey)}</span>
              {count > 0 && <span className="dshr-tab-count">{count}</span>}
            </button>
          )
        })}
      </div>
      {/* No hint line: the tab's own name and its rows answer the question, and a
          sentence under the strip is another piece of chrome to read every time. */}

      <div className="dshr-scroll">
        {SECTIONS.map((section) => {
          const visible = active.sections.includes(section.id)
          const items = tasksIn(tasks, section)
          return (
            <section
              key={section.id}
              className="dshr-section"
              data-lane={section.id}
              data-tone={section.tone}
              aria-label={t(section.labelKey)}
              hidden={!visible}
            >
              <header className="dshr-section-head">
                <span className="dshr-section-title">{t(section.labelKey)}</span>
                <span className="dshr-section-count">{items.length}</span>
              </header>
              {items.length === 0
                ? <div className="dshr-empty">{t('board.empty')}</div>
                : items.map((task) => {
                  const view = resolve(task)
                  const worker = workerOf(task)
                  return (
                    <TaskCard
                      key={task.id}
                      task={view}
                      partitionName={partitionOf(task)}
                      {...(worker === undefined ? {} : { workerName: worker })}
                      t={t}
                      open={openTasks.has(task.id)}
                      onToggle={onToggleTask}
                      {...(onVerify === undefined ? {} : { onVerify })}
                      {...(onOpenSession === undefined ? {} : { onOpenSession })}
                      {...(onDownload === undefined ? {} : { onDownload })}
                    />
                  )
                })}
            </section>
          )
        })}
      </div>
    </section>
  )
}
