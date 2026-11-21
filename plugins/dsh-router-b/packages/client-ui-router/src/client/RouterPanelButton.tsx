/**
 * Conversation-header entry point for the panel.
 *
 * A docked panel with no opener is a panel nobody sees, so this ships with the
 * tab type. It also carries the awaiting-review count: a task that a worker
 * claimed to finish is the one thing the user must not miss.
 */

import { useSyncExternalStore } from 'react'
import type { RouterBoardController } from './controller.ts'

/** Props supplied by the header-utility registration's inject face. */
export interface RouterPanelButtonProps {
  /** Panel state. */
  readonly controller: RouterBoardController
  /** Namespace-bound translate. */
  readonly t: (key: string, values?: Record<string, string | number>) => string
  /** Open (or reveal) the panel's tab. */
  readonly open: () => void
}

/**
 * Render the header button.
 * @param props - controller, translate, and the open action.
 * @returns the button.
 */
export function RouterPanelButton({ controller, t, open }: RouterPanelButtonProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const tasks = state.board?.tasks ?? []
  const awaiting = tasks.filter(task => task.state === 'reported').length
  const running = tasks.filter(task => task.state === 'running').length

  return (
    <button
      type="button"
      className="dshr-btn"
      onClick={open}
      title={t('panel.title')}
      aria-label={t('panel.title')}
      data-router-entry
    >
      <span aria-hidden="true">▤</span>
      <span>{t('panel.title')}</span>
      {awaiting > 0 && (
        <span className="dshr-tab-count" data-tone="warn" title={t('lane.reported')}>{awaiting}</span>
      )}
      {awaiting === 0 && running > 0 && (
        <span className="dshr-tab-count" title={t('lane.running')}>{running}</span>
      )}
    </button>
  )
}
