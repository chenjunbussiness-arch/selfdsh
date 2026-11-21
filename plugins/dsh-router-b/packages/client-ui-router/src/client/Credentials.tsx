/**
 * The rail's API-key block.
 *
 * A status block, not a secret store. It shows, per reference, whether a value
 * exists and where it came from; the only write it can perform is "store this
 * literal", which is the same call the official Models page makes
 * (`ctx.remote.credentials.set`). Nothing here ever reads a value back, because
 * the Host's credential seam has no read path at all — the block cannot leak what
 * it cannot fetch.
 *
 * When the Host exposes no credential write, the rows stay readable and the
 * block says where the official entry is instead of offering a dead button.
 */

import { useState } from 'react'
import type { CredentialView } from './contract.ts'

/** Props for {@link Credentials}. */
export interface CredentialsProps {
  /** Status rows, already resolved by the panel (live Host answer or board snapshot). */
  readonly rows: readonly CredentialView[]
  /** Namespace-bound translate. */
  readonly t: (key: string, values?: Record<string, string | number>) => string
  /** True when the Host implements a credential write. */
  readonly writable: boolean
  /**
   * Store one literal.
   * @param ref - credential reference name.
   * @param value - the literal to store.
   * @returns a refusal message, or undefined once stored.
   */
  readonly onSave?: (ref: string, value: string) => Promise<string | undefined>
  /** Called after a successful write, so the panel can re-read status. */
  readonly onChanged?: () => void
}

/**
 * Render the API-key block.
 * @param props - rows, translate, and the optional write path.
 * @returns the rail's credential section.
 */
export function Credentials({ rows, t, writable, onSave, onChanged }: CredentialsProps) {
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [done, setDone] = useState<string | undefined>(undefined)

  const submit = async (ref: string): Promise<void> => {
    if (onSave === undefined || saving || value.trim() === '') return
    setSaving(true)
    setError(undefined)
    try {
      const message = await onSave(ref, value.trim())
      if (message === undefined) {
        setEditing(undefined)
        setValue('')
        setDone(ref)
        onChanged?.()
      } else {
        setError(message)
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="dshr-keys" aria-label={t('apiKey.title')}>
      <div className="dshr-rail-label">
        <span aria-hidden="true">⚙</span>
        <span>{t('apiKey.title')}</span>
      </div>

      {rows.length === 0 && <div className="dshr-key-empty">{t('apiKey.none')}</div>}

      {rows.map((row) => {
        const status = row.configured
          ? t('apiKey.configured')
          : row.source === 'unknown' ? t('apiKey.unknown') : t('apiKey.missing')
        const hint = row.source === undefined ? undefined : t(`apiKey.source.${row.source}`)
        const open = editing === row.ref
        // A row the Host marks unwritable stays readable even when the seam exists.
        const canWrite = writable && row.writable !== false
        const body = (
          <>
            <span className="dshr-key-dot" data-on={row.configured ? 'true' : 'false'} aria-hidden="true" />
            <span className="dshr-key-ref" title={row.label === undefined ? row.ref : `${row.label} · ${hint ?? row.ref}`}>
              {row.ref}
            </span>
            <span className="dshr-key-state" data-on={row.configured ? 'true' : 'false'}>{status}</span>
          </>
        )
        return (
          <div className="dshr-key-block" key={row.ref}>
            {canWrite
              ? (
                <button
                  type="button"
                  className="dshr-key"
                  aria-expanded={open}
                  title={hint ?? t('apiKey.edit')}
                  onClick={() => {
                    setError(undefined)
                    setDone(undefined)
                    setEditing(open ? undefined : row.ref)
                    setValue('')
                  }}
                >
                  {body}
                </button>
              )
              : <div className="dshr-key" title={hint ?? t('rail.unwired')}>{body}</div>}

            {open && (
              <div className="dshr-key-form">
                <input
                  className="dshr-input dshr-key-input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t('apiKey.value')}
                  value={value}
                  aria-label={t('apiKey.value')}
                  onChange={(event) => { setValue(event.target.value) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); void submit(row.ref) }
                    if (event.key === 'Escape') { setEditing(undefined); setValue('') }
                  }}
                />
                <div className="dshr-key-actions">
                  <button type="button" className="dshr-btn" data-size="xs" data-tone="primary"
                    disabled={saving || value.trim() === ''} onClick={() => { void submit(row.ref) }}>
                    {saving ? t('apiKey.writing') : t('apiKey.save')}
                  </button>
                  <button type="button" className="dshr-btn" data-size="xs"
                    onClick={() => { setEditing(undefined); setValue('') }}>
                    {t('rail.cancel')}
                  </button>
                </div>
              </div>
            )}
            {open && error !== undefined && <div className="dshr-key-error">{error}</div>}
          </div>
        )
      })}

      {done !== undefined && error === undefined && <div className="dshr-key-ok">{t('apiKey.saved')}</div>}
      {!writable && <div className="dshr-key-where">{t('apiKey.where')}</div>}
    </section>
  )
}
