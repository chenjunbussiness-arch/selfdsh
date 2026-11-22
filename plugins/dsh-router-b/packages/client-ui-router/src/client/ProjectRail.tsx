/**
 * The left rail: which projects exist, which one you are looking at, whether
 * dispatch is on, and whether the model credentials are in place.
 *
 * This is the panel's own left column. It sits inside the right-Sidebar panel
 * rather than in the app's left Sidebar because the app's left column has no
 * free content slot: `sidebar` is a single slot already occupied by
 * `dsh-client-ui-sidebar`, whose only unoccupied holes are navigation *rows*
 * (`sidebar.panellist`, `sidebar.panellist.actions`, `sidebar.footer.action`),
 * while its two content regions (`sidebar.workspaces`, `sidebar.settings`) are
 * occupied by ui-workspace and ui-settings. See `docs/NATIVE-ENTRYPOINTS.md`.
 *
 * Layout: closed by default. The button in the task header opens it as a fixed
 * column beside the task list when the panel is wide, or full-width in place of
 * the list when it is narrow. A closed rail stays in the DOM but is hidden, so
 * it is out of the tab order and the accessibility tree.
 */

import { useEffect, useState } from 'react'
import type { CredentialView, PartitionView } from './contract.ts'
import { Credentials } from './CredentialForm.tsx'
import { Roster } from './Roster.tsx'

/** Props for {@link ProjectRail}. */
export interface ProjectRailProps {
  /** DOM id, so the toggle in the task header can point at the rail. */
  readonly id?: string
  /** Whether the rail is shown. It always renders; a closed one is hidden. */
  readonly open?: boolean
  /** Partitions in roster order. */
  readonly partitions: readonly PartitionView[]
  /** Partition the task list is filtered to, when one is. */
  readonly selectedId?: string
  /** Select or clear the filter. */
  readonly onSelect: (partitionId: string | undefined) => void
  /** Task count across every partition, for the "全部" row. */
  readonly totalTasks: number
  /** Namespace-bound translate. */
  readonly t: (key: string, values?: Record<string, string | number>) => string
  /** Credential status rows to show. */
  readonly credentials: readonly CredentialView[]
  /** True when the Host implements a credential write. */
  readonly credentialsWritable: boolean
  /** Store one credential literal. */
  readonly onSaveCredential?: (ref: string, value: string) => Promise<string | undefined>
  /** Re-read status after a write. */
  readonly onCredentialsChanged?: () => void
  /** Switch dispatch into a partition. */
  readonly onTogglePartition?: (partitionId: string, enabled: boolean) => Promise<void>
  /** Create a partition. */
  readonly onCreatePartition?: (name: string) => Promise<void>
  /** Close the rail (narrow layout only). */
  readonly onClose?: () => void
}

/**
 * Render the rail.
 * @param props - roster, credential status, and the host-wired actions.
 * @returns the project rail.
 */
export function ProjectRail({
  id, open = true, partitions, selectedId, onSelect, totalTasks, t, credentials, credentialsWritable,
  onSaveCredential, onCredentialsChanged, onTogglePartition, onCreatePartition, onClose,
}: ProjectRailProps) {
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<string | undefined>(undefined)

  // A pressed-but-unwired control explains itself and then gets out of the way.
  useEffect(() => {
    if (note === undefined) return
    const timer = setTimeout(() => { setNote(undefined) }, 4200)
    return () => { clearTimeout(timer) }
  }, [note])

  const unwired = (): void => { setNote(t('rail.unwired')) }

  /** Report a failed host action where the control is, not in a console. */
  const failed = (failure: unknown): void => {
    setNote(failure instanceof Error ? failure.message : String(failure))
  }

  const toggle = async (partitionId: string, enabled: boolean): Promise<void> => {
    if (onTogglePartition === undefined) { unwired(); return }
    try {
      await onTogglePartition(partitionId, enabled)
    } catch (failure) {
      failed(failure)
    }
  }

  const create = async (): Promise<void> => {
    const name = draft.trim()
    if (name === '' || onCreatePartition === undefined) return
    try {
      await onCreatePartition(name)
      setCreating(false)
      setDraft('')
    } catch (failure) {
      failed(failure)
    }
  }

  return (
    <aside className="dshr-rail" {...(id === undefined ? {} : { id })} hidden={!open} aria-label={t('rail.title')}>
      <header className="dshr-rail-head">
        <span className="dshr-rail-title">{t('rail.title')}</span>
        <span className="dshr-rail-count">{partitions.length}</span>
        <span className="dshr-fill" />
        {onClose !== undefined && (
          <button type="button" className="dshr-icon-btn dshr-rail-close" aria-label={t('rail.close')} title={t('rail.close')} onClick={onClose}>
            ×
          </button>
        )}
      </header>

      <div className="dshr-rail-scroll">
        <button
          type="button"
          className="dshr-project-all"
          data-on={selectedId === undefined ? 'true' : 'false'}
          aria-pressed={selectedId === undefined}
          onClick={() => { onSelect(undefined) }}
        >
          <span className="dshr-caret" aria-hidden="true">▸</span>
          <span className="dshr-project-name">{t('rail.all')}</span>
          <span className="dshr-project-count">{totalTasks}</span>
        </button>

        <Roster
          partitions={partitions}
          {...(selectedId === undefined ? {} : { selectedId })}
          onSelect={onSelect}
          {...(onTogglePartition === undefined ? {} : { onToggle: toggle })}
          wired={onTogglePartition !== undefined}
          onUnwired={unwired}
          t={t}
        />

        {creating
          ? (
            <div className="dshr-create">
              <input
                className="dshr-input"
                placeholder={t('rail.name.placeholder')}
                value={draft}
                autoFocus
                spellCheck={false}
                aria-label={t('rail.new')}
                onChange={(event) => { setDraft(event.target.value) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); void create() }
                  if (event.key === 'Escape') { setCreating(false); setDraft('') }
                }}
              />
              <div className="dshr-key-actions">
                <button type="button" className="dshr-btn" data-size="xs" data-tone="primary"
                  disabled={draft.trim() === ''} onClick={() => { void create() }}>
                  {t('rail.create')}
                </button>
                <button type="button" className="dshr-btn" data-size="xs"
                  onClick={() => { setCreating(false); setDraft('') }}>
                  {t('rail.cancel')}
                </button>
              </div>
            </div>
          )
          : (
            <button
              type="button"
              className="dshr-rail-new"
              onClick={() => {
                if (onCreatePartition === undefined) { unwired(); return }
                setCreating(true)
              }}
            >
              <span aria-hidden="true">+</span>
              <span>{t('rail.new')}</span>
            </button>
          )}
      </div>

      <Credentials
        rows={credentials}
        t={t}
        writable={credentialsWritable}
        {...(onSaveCredential === undefined ? {} : { onSave: onSaveCredential })}
        {...(onCredentialsChanged === undefined ? {} : { onChanged: onCredentialsChanged })}
      />

      {note !== undefined && <div className="dshr-rail-note" role="status">{note}</div>}
    </aside>
  )
}
