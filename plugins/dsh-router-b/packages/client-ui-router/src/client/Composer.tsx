/**
 * Demand composer.
 *
 * The user only states demands; routing is not their job. One line is one
 * demand, and the router decides the partition — so the field's contract is
 * "paste everything, press once" rather than a form per task.
 */

import { useState } from 'react'
import type { PublishResult } from './contract.ts'

/** Props for {@link Composer}. */
export interface ComposerProps {
  /** Namespace-bound translate. */
  readonly t: (key: string, values?: Record<string, string | number>) => string
  /** True while a publish request is in flight. */
  readonly busy: boolean
  /** The latest publish outcome, shown until the field is edited. */
  readonly lastPublish?: PublishResult
  /** Publish one demand per non-empty line. */
  readonly onPublish: (demands: readonly string[]) => void
  /** Called when the user starts editing again, so stale notices clear. */
  readonly onEdit?: () => void
}

/**
 * Render the composer.
 * @param props - publish callback and current publish status.
 * @returns the composer block.
 */
export function Composer({ t, busy, lastPublish, onPublish, onEdit }: ComposerProps) {
  const [text, setText] = useState('')

  const demands = text.split('\n').map(line => line.trim()).filter(line => line !== '')
  const submit = (): void => {
    if (demands.length === 0 || busy) return
    onPublish(demands)
    setText('')
  }

  return (
    <div className="dshr-composer">
      <label className="dshr-label" htmlFor="dshr-demand">{t('demand.title')}</label>
      <textarea
        id="dshr-demand"
        className="dshr-input"
        placeholder={t('demand.placeholder')}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          onEdit?.()
        }}
        onKeyDown={(event) => {
          // Cmd/Ctrl+Enter publishes; plain Enter stays a newline, because a
          // demand may legitimately be several lines of context.
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          }
        }}
        rows={2}
        spellCheck={false}
      />
      <div className="dshr-composer-foot">
        <span className="dshr-hint">
          {lastPublish !== undefined
            ? t('demand.published', { count: lastPublish.accepted })
            : t('demand.hint')}
        </span>
        <button
          type="button"
          className="dshr-send"
          aria-label={busy ? t('demand.submitting') : t('demand.submit')}
          title={busy ? t('demand.submitting') : `${t('demand.submit')} (Ctrl+Enter)`}
          data-busy={busy ? 'true' : 'false'}
          disabled={busy || demands.length === 0}
          onClick={submit}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
