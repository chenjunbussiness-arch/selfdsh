/**
 * The board's tabs and the sections inside them.
 *
 * Two levels, because the two questions are different:
 *
 *   tab      "what do I look after now" — 待处理 / 接下来 / 排程 / 已有结果
 *   section  "what is this group of work waiting on" — 待验收 / 进行中 / 待派 …
 *
 * `reported` and `verified` must stay in different sections and different tabs:
 * a worker's self-report is not evidence of completion. Collapsing them is the
 * exact failure arXiv:2611.04100 measured (3 of 16 real delegations recorded as
 * done while the work had failed). Note also which tab each lands in — a
 * self-report is work still on your desk (`active`), not a result (`resolved`).
 */

import type { TaskState, TaskView } from './contract.ts'

/** A tab in the board's strip. */
export type TabId = 'active' | 'next' | 'scheduled' | 'resolved'

/** A group of task states rendered under one caption. */
export type SectionId = 'reported' | 'running' | 'queued' | 'rejected' | 'scheduled' | 'verified'

/** Visual tone a section paints into its caption and rows. */
export type Tone = 'neutral' | 'busy' | 'warn' | 'ok' | 'bad'

/** One group of tasks inside a tab. */
export interface SectionDefinition {
  /** Section id, also the `data-lane` attribute the tests key off. */
  readonly id: SectionId
  /** Locale key of the caption. */
  readonly labelKey: string
  /** Locale key of the one-line explanation beside the caption. */
  readonly hintKey: string
  /** Tone token the caption and its rows inherit. */
  readonly tone: Tone
  /** Task states rendered here. */
  readonly states: readonly TaskState[]
  /** True when only tasks carrying `scheduledFor` belong here. */
  readonly scheduled?: boolean
}

/** One tab: a caption, a count, and the sections it shows at once. */
export interface TabDefinition {
  /** Tab id. */
  readonly id: TabId
  /** Locale key of the tab caption. */
  readonly labelKey: string
  /** Locale key of the tab's one-line explanation. */
  readonly hintKey: string
  /** Sections visible while this tab is selected, in reading order. */
  readonly sections: readonly SectionId[]
}

/**
 * Section order, which is also DOM order.
 *
 * 待验收 sits first inside `active` on purpose: a worker that claims it is done
 * is the one thing on this board that is *waiting on the user*.
 */
export const SECTIONS: readonly SectionDefinition[] = [
  {
    id: 'reported',
    labelKey: 'lane.reported',
    hintKey: 'lane.reported.hint',
    tone: 'warn',
    states: ['reported'],
  },
  {
    id: 'running',
    labelKey: 'lane.running',
    hintKey: 'lane.running.hint',
    tone: 'busy',
    states: ['running'],
  },
  {
    id: 'queued',
    labelKey: 'lane.queued',
    hintKey: 'lane.queued.hint',
    tone: 'neutral',
    states: ['queued'],
  },
  {
    id: 'rejected',
    labelKey: 'lane.rejected',
    hintKey: 'lane.rejected.hint',
    tone: 'bad',
    states: ['rejected'],
  },
  {
    id: 'scheduled',
    labelKey: 'lane.scheduled',
    hintKey: 'lane.scheduled.hint',
    tone: 'neutral',
    states: ['queued'],
    scheduled: true,
  },
  {
    id: 'verified',
    labelKey: 'lane.verified',
    hintKey: 'lane.verified.hint',
    tone: 'ok',
    states: ['verified'],
  },
]

/** Tab strip order, left to right. */
export const TABS: readonly TabDefinition[] = [
  {
    id: 'active',
    labelKey: 'tab.active',
    hintKey: 'tab.active.hint',
    sections: ['running'],
  },
  {
    id: 'next',
    labelKey: 'tab.next',
    hintKey: 'tab.next.hint',
    sections: ['queued', 'rejected'],
  },
  {
    id: 'scheduled',
    labelKey: 'tab.scheduled',
    hintKey: 'tab.scheduled.hint',
    sections: ['scheduled'],
  },
  {
    id: 'resolved',
    labelKey: 'tab.resolved',
    hintKey: 'tab.resolved.hint',
    sections: ['reported', 'verified'],
  },
]

/**
 * Section a task belongs to.
 * @param task - the task, read for `state` and `scheduledFor`.
 * @returns the owning section.
 */
export function sectionOf(task: TaskView): SectionId {
  switch (task.state) {
    case 'reported':
      return 'reported'
    case 'running':
      return 'running'
    case 'verified':
      return 'verified'
    case 'rejected':
      return 'rejected'
    case 'queued':
      // A deferred queue entry waits on the clock, not on a worker.
      return task.scheduledFor === undefined ? 'queued' : 'scheduled'
  }
}

/**
 * Tab a task belongs to.
 * @param task - the task.
 * @returns the owning tab.
 */
export function tabOf(task: TaskView): TabId {
  const section = sectionOf(task)
  const tab = TABS.find(candidate => candidate.sections.includes(section))
  return tab === undefined ? 'active' : tab.id
}

/**
 * Tasks of one section, newest activity first.
 * @param tasks - the board's tasks, already filtered.
 * @param section - the section to take.
 * @returns its tasks in display order.
 */
export function tasksIn(tasks: readonly TaskView[], section: SectionDefinition): TaskView[] {
  return tasks
    .filter(task => sectionOf(task) === section.id)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

/**
 * Count of tasks per tab.
 * @param tasks - the board's tasks, already filtered.
 * @returns counts keyed by tab id.
 */
export function tabCounts(tasks: readonly TaskView[]): Record<TabId, number> {
  const counts: Record<TabId, number> = { active: 0, next: 0, scheduled: 0, resolved: 0 }
  for (const task of tasks) counts[tabOf(task)] += 1
  return counts
}

/**
 * Progress of a checklist.
 * @param todos - the worker's checklist.
 * @returns completed/total counts and the in-progress line, if any.
 */
export function todoProgress(todos: readonly { content: string; status: 'pending' | 'in_progress' | 'completed' }[]): {
  done: number
  total: number
  current?: string
} {
  const done = todos.filter(item => item.status === 'completed').length
  const current = todos.find(item => item.status === 'in_progress')?.content
  return { done, total: todos.length, ...(current === undefined ? {} : { current }) }
}
