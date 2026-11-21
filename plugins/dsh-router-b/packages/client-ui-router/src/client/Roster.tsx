/**
 * Partition roster — the left rail's project list.
 *
 * One row answers three questions at a glance, in this order:
 *
 *   is anyone on this?      the presence dot
 *   what is it called?      the name, plus its worker count
 *   is anything on my desk? the amber count badge (reported, not verified)
 *
 * Presence is spelled out in the second line ("4 个 worker · 忙 2 · 已释放 2")
 * instead of being implied by colour: a released worker holds no machine, and a
 * dot alone cannot say that. Selecting a row opens its worker chips and its
 * 启用/停用 switch; the switch is host-wired, and says so when it is not.
 */

import type { PartitionView, WorkerPresence, WorkerView } from './contract.ts'

/** Props for {@link Roster}. */
export interface RosterProps {
  /** Partitions in roster order. */
  readonly partitions: readonly PartitionView[]
  /** Partition the rail is filtered to, when one is. */
  readonly selectedId?: string
  /** Select or clear (undefined) the filter. */
  readonly onSelect?: (partitionId: string | undefined) => void
  /** Switch dispatch into a partition on or off. */
  readonly onToggle?: (partitionId: string, enabled: boolean) => void | Promise<void>
  /** True when the Host actually implements {@link RosterProps.onToggle}. */
  readonly wired?: boolean
  /** Called when a control is pressed but no Host action exists for it. */
  readonly onUnwired?: () => void
  /** Namespace-bound translate. */
  readonly t: (key: string, values?: Record<string, string | number>) => string
}

/** Summary order: what is doing work first, what is idle last. */
const PRESENCE_ORDER: readonly WorkerPresence[] = ['busy', 'online', 'offline', 'released']

/**
 * What a worker chip says after its name.
 * @param worker - the worker.
 * @param t - translate.
 * @returns its activity, or the copy for its idle state.
 */
function workerSuffix(worker: WorkerView, t: RosterProps['t']): string {
  if (worker.activity !== undefined && worker.activity !== '') return worker.activity
  if (worker.presence === 'released') return t('presence.released')
  if (worker.presence === 'online') return t('workers.idle')
  return t(`presence.${worker.presence}`)
}

/**
 * Presence summary for one partition's second line.
 * @param partition - the partition.
 * @param t - translate.
 * @returns `4 个 worker · 忙 2 · 已释放 2`, or the count alone for an empty roster.
 */
function presenceSummary(partition: PartitionView, t: RosterProps['t']): string {
  const head = t('roster.workers', { count: partition.workers.length })
  if (partition.workers.length === 0) return head
  const parts: string[] = []
  for (const presence of PRESENCE_ORDER) {
    const count = partition.workers.filter(worker => worker.presence === presence).length
    if (count > 0) parts.push(`${t(`presence.${presence}`)} ${count}`)
  }
  return [head, ...parts].join(' · ')
}

/**
 * The dot's own state: the most demanding presence present.
 * @param partition - the partition.
 * @returns one presence value for the row dot.
 */
function aggregatePresence(partition: PartitionView): WorkerPresence {
  for (const presence of PRESENCE_ORDER) {
    if (partition.workers.some(worker => worker.presence === presence)) return presence
  }
  return partition.manager.presence
}

/**
 * Render the roster.
 * @param props - partitions plus the rail's selection and control handles.
 * @returns the project list.
 */
export function Roster({ partitions, selectedId, onSelect, onToggle, wired, onUnwired, t }: RosterProps) {
  return (
    <ul className="dshr-projects" aria-label={t('roster.title')}>
      {partitions.map((partition) => {
        const awaiting = partition.manager.awaitingVerification
        const enabled = partition.enabled !== false
        const selected = selectedId === partition.id
        const summary = presenceSummary(partition, t)
        return (
          <li
            key={partition.id}
            className="dshr-project"
            data-partition={partition.id}
            data-on={selected ? 'true' : 'false'}
            data-off={enabled ? 'false' : 'true'}
          >
            <div className="dshr-project-row">
              <button
                type="button"
                className="dshr-project-main"
                title={partition.repo ?? partition.name}
                aria-pressed={selected}
                onClick={() => { onSelect?.(selected ? undefined : partition.id) }}
              >
                <span className="dshr-project-line">
                  <span className="dshr-dot" data-presence={aggregatePresence(partition)} aria-hidden="true" />
                  <span className="dshr-project-name">{partition.name}</span>
                  {!enabled && <span className="dshr-project-off">{t('rail.disabled')}</span>}
                  <span className="dshr-project-count">{partition.workers.length}</span>
                  {awaiting > 0 && (
                    <span className="dshr-badge" data-tone="warn" title={t('roster.awaiting', { count: awaiting })}>
                      {awaiting}
                    </span>
                  )}
                </span>
                <span className="dshr-project-sub">{summary}</span>
              </button>
              <button
                type="button"
                className="dshr-switch"
                data-on={enabled ? 'true' : 'false'}
                data-wired={wired === true ? 'true' : 'false'}
                title={wired === true
                  ? (enabled ? t('rail.disable') : t('rail.enable'))
                  : t('rail.unwired')}
                aria-label={enabled ? t('rail.disable') : t('rail.enable')}
                {...(wired === true ? { role: 'switch', 'aria-checked': enabled } : {})}
                onClick={() => {
                  if (wired !== true) { onUnwired?.(); return }
                  onToggle?.(partition.id, !enabled)
                }}
              >
                <span className="dshr-switch-knob" aria-hidden="true" />
              </button>
            </div>
            {selected && (
              <div className="dshr-workers">
                {partition.workers.length === 0
                  ? <span className="dshr-worker">{t('workers.none')}</span>
                  : partition.workers.map(worker => (
                    <span
                      className="dshr-worker"
                      key={worker.id}
                      data-presence={worker.presence}
                      title={worker.presence === 'released' ? t('presence.released.hint') : undefined}
                    >
                      <span className="dshr-dot" data-presence={worker.presence} aria-hidden="true" />
                      <span className="dshr-worker-name">{worker.name}</span>
                      <span className="dshr-worker-what">{workerSuffix(worker, t)}</span>
                    </span>
                  ))}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
