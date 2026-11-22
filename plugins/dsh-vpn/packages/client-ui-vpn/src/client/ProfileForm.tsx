/**
 * The create / edit form.
 *
 * Secret handling: the password / URL inputs are `type="password"` and
 * `autocomplete="new-password"`, start empty even when a secret is stored (the
 * host never sends it), and are cleared the moment a save succeeds.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'

import type { ProfileInput, ProfileType, ProfileView } from './contract.ts'
import type { Translate } from './locales.ts'

/** The form's editable state. Everything is text until submit. */
export interface FormState {
  readonly id?: string
  readonly name: string
  readonly type: ProfileType
  readonly host: string
  readonly port: string
  readonly username: string
  readonly realm: string
  readonly trustedCert: string
  readonly targets: string
  readonly setDns: boolean
  readonly command: string
  readonly secret: string
  /** Whether the stored profile already has a secret (drives the placeholder). */
  readonly secretConfigured: boolean
}

/** A blank form for a new profile of one type. */
export function blankForm(type: ProfileType): FormState {
  return { name: '', type, host: '', port: '443', username: '', realm: '', trustedCert: '', targets: '', setDns: false, command: '', secret: '', secretConfigured: false }
}

/** A form filled from a stored profile. The secret stays empty. */
export function formFrom(profile: ProfileView): FormState {
  return {
    id: profile.id, name: profile.name, type: profile.type, host: profile.host, port: String(profile.port), username: profile.username,
    realm: profile.realm, trustedCert: profile.trustedCert, targets: profile.targets.join('\n'), setDns: profile.setDns,
    command: profile.command.join('\n'), secret: '', secretConfigured: profile.secretConfigured,
  }
}

/** Turn the form into the request body. Validation is the host's job; this only shapes it. */
export function toInput(form: FormState): ProfileInput {
  const lines = (text: string): string[] => text.split(/\r?\n|,/).map(entry => entry.trim()).filter(entry => entry !== '')
  return {
    ...form.id === undefined ? {} : { id: form.id },
    name: form.name.trim(),
    type: form.type,
    targets: lines(form.targets),
    setDns: form.setDns,
    ...form.type === 'password'
      ? { host: form.host.trim(), port: Number(form.port), username: form.username.trim(), realm: form.realm.trim() }
      : {},
    ...form.type === 'custom' ? { command: form.command.split(/\r?\n/).map(entry => entry.trim()).filter(entry => entry !== '') } : { trustedCert: form.trustedCert.trim() },
    ...form.type === 'password' ? { trustedCert: form.trustedCert.trim() } : {},
    ...form.secret === '' ? {} : { secret: form.secret },
  }
}

/**
 * Gateway host and port from a pasted address.
 *
 * `https://vpn.example.com:10443/remote/login` → `vpn.example.com` and `10443`;
 * `vpn.example.com:8443` → host and port. A bare host name returns `undefined`,
 * so typing is never rewritten mid-word.
 * @param raw - the gateway field's text.
 * @returns host and optional port, or `undefined` when there is nothing to split.
 */
export function gatewayFrom(raw: string): { host: string; port?: string } | undefined {
  const text = raw.trim()
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  if (!hasScheme && !/:[0-9]{1,5}\/?$/.test(text) && !text.includes('/')) return undefined
  try {
    const url = new URL(hasScheme ? text : `https://${text}`)
    if (url.hostname === '') return undefined
    return { host: url.hostname.replace(/^\[|\]$/g, ''), ...url.port === '' ? {} : { port: url.port } }
  } catch {
    return undefined
  }
}

/** Props of {@link ProfileForm}. */
export interface ProfileFormProps {
  readonly t: Translate
  readonly initial: FormState
  readonly allowCustom: boolean
  readonly busy: boolean
  readonly onSave: (input: ProfileInput) => Promise<string | undefined>
  readonly onCancel: () => void
  readonly onDelete?: () => Promise<string | undefined>
}

/** Render the form. */
export function ProfileForm(props: ProfileFormProps): ReactNode {
  const { t } = props
  const [form, setForm] = useState<FormState>(props.initial)
  const [error, setError] = useState<string | undefined>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const set = (patch: Partial<FormState>): void => { setForm(current => ({ ...current, ...patch })) }
  const types: ProfileType[] = props.allowCustom ? ['password', 'token-url', 'custom'] : ['password', 'token-url']
  const editing = form.id !== undefined

  /** Switch the auth type. A half-typed password must not land in the token-URL field. */
  const pickType = (type: ProfileType): void => {
    if (type !== form.type) set({ type, secret: '' })
  }

  /** `https://vpn.example.com:10443/remote/login` pasted as the gateway → host and port. */
  const absorbGateway = (text: string): boolean => {
    const gateway = gatewayFrom(text)
    if (gateway === undefined) return false
    set({ host: gateway.host, ...gateway.port === undefined ? {} : { port: gateway.port } })
    return true
  }

  const submit = async (event: { preventDefault(): void }): Promise<void> => {
    event.preventDefault()
    setError(undefined)
    // Catch the two blanks the host would reject, in words, before a round trip.
    if (form.name.trim() === '') { setError(t('form.err.name')); return }
    if (toInput(form).targets.length === 0) { setError(t('form.err.targets')); return }
    const message = await props.onSave(toInput(form))
    if (message === undefined) set({ secret: '' })
    else setError(message)
  }

  return (
    <form
      className="dshv-form" onSubmit={(event) => { void submit(event) }} autoComplete="off" data-type={form.type}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); props.onCancel() } }}
    >
      <h2 className="dshv-form-title">{editing ? t('form.title.edit') : t('form.title.new')}</h2>

      <div className="dshv-group">
        <div className="dshv-field">
          <label className="dshv-label" htmlFor="dshv-name">{t('form.name')}</label>
          <input id="dshv-name" className="dshv-input" value={form.name} maxLength={64} onChange={event => { set({ name: event.target.value }) }} />
        </div>

        <div className="dshv-field">
          <span className="dshv-label" id="dshv-type-label">{t('form.type')}</span>
          <div className="dshv-seg" role="radiogroup" aria-labelledby="dshv-type-label">
            {types.map(type => (
              <button key={type} type="button" role="radio" aria-checked={form.type === type} onClick={() => { pickType(type) }}>
                {t(`type.${type}` as 'type.password')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {form.type === 'password' && (
        <div className="dshv-group">
          <div className="dshv-grid">
            <div className="dshv-field">
              <label className="dshv-label" htmlFor="dshv-host">{t('form.host')}</label>
              <input
                id="dshv-host" className="dshv-input" data-mono="true" value={form.host} placeholder="vpn.example.com"
                onChange={event => { set({ host: event.target.value }) }}
                onPaste={(event) => { if (absorbGateway(event.clipboardData.getData('text'))) event.preventDefault() }}
                onBlur={() => { absorbGateway(form.host) }}
              />
            </div>
            <div className="dshv-field">
              <label className="dshv-label" htmlFor="dshv-port">{t('form.port')}</label>
              <input id="dshv-port" className="dshv-input" data-mono="true" inputMode="numeric" value={form.port} onChange={event => { set({ port: event.target.value }) }} />
            </div>
          </div>
          <div className="dshv-grid" data-cols="2">
            <div className="dshv-field">
              <label className="dshv-label" htmlFor="dshv-user">{t('form.username')}</label>
              <input id="dshv-user" className="dshv-input" autoComplete="off" value={form.username} onChange={event => { set({ username: event.target.value }) }} />
            </div>
            <div className="dshv-field">
              <label className="dshv-label" htmlFor="dshv-pass">{t('form.password')}</label>
              <input
                id="dshv-pass" className="dshv-input" type="password" autoComplete="new-password" value={form.secret}
                placeholder={form.secretConfigured ? t('form.password.set') : ''}
                onChange={event => { set({ secret: event.target.value }) }}
              />
            </div>
          </div>
          <div className="dshv-grid" data-cols="2">
            <div className="dshv-field">
              <label className="dshv-label" htmlFor="dshv-realm">{t('form.realm')}</label>
              <input id="dshv-realm" className="dshv-input" value={form.realm} onChange={event => { set({ realm: event.target.value }) }} />
            </div>
            <div className="dshv-field">
              <label className="dshv-label" htmlFor="dshv-cert">{t('form.cert')}</label>
              <input id="dshv-cert" className="dshv-input" data-mono="true" value={form.trustedCert} placeholder="e46d4aff08ba…" onChange={event => { set({ trustedCert: event.target.value }) }} />
            </div>
          </div>
        </div>
      )}

      {form.type === 'token-url' && (
        <div className="dshv-group">
          <div className="dshv-field">
            <label className="dshv-label" htmlFor="dshv-url">{t('form.url')}</label>
            <input
              id="dshv-url" className="dshv-input" data-mono="true" type="password" autoComplete="new-password" value={form.secret}
              placeholder={form.secretConfigured ? t('form.url.set') : 'https://host:port/path?token=…'}
              onChange={event => { set({ secret: event.target.value }) }}
            />
            <p className="dshv-hint">{t('form.url.hint')}</p>
          </div>
          <div className="dshv-field">
            <label className="dshv-label" htmlFor="dshv-cert2">{t('form.cert')}</label>
            <input id="dshv-cert2" className="dshv-input" data-mono="true" value={form.trustedCert} onChange={event => { set({ trustedCert: event.target.value }) }} />
            <p className="dshv-hint">{t('form.cert.hint')}</p>
          </div>
        </div>
      )}

      {form.type === 'custom' && (
        <div className="dshv-group">
          <div className="dshv-field">
            <label className="dshv-label" htmlFor="dshv-cmd">{t('form.command')}</label>
            <textarea id="dshv-cmd" className="dshv-input" data-mono="true" value={form.command} onChange={event => { set({ command: event.target.value }) }} />
            <p className="dshv-hint">{t('form.command.hint')}</p>
          </div>
          <div className="dshv-field">
            <label className="dshv-label" htmlFor="dshv-url2">{t('form.url')}</label>
            <input id="dshv-url2" className="dshv-input" data-mono="true" type="password" autoComplete="new-password" value={form.secret} placeholder={form.secretConfigured ? t('form.url.set') : ''} onChange={event => { set({ secret: event.target.value }) }} />
          </div>
        </div>
      )}

      <div className="dshv-group">
        <div className="dshv-field">
          <label className="dshv-label" htmlFor="dshv-targets">{t('form.targets')}</label>
          <textarea id="dshv-targets" className="dshv-input" data-mono="true" value={form.targets} placeholder={'198.51.100.0/24\ngit.corp.example'} onChange={event => { set({ targets: event.target.value }) }} />
          <p className="dshv-hint">{t('form.targets.hint')}</p>
        </div>

        <label className="dshv-check">
          <input type="checkbox" checked={form.setDns} onChange={event => { set({ setDns: event.target.checked }) }} />
          <span>{t('form.dns')}</span>
        </label>
      </div>

      <div className="dshv-form-notes">
        <p className="dshv-hint">{t('form.secret.write-only')}</p>
        {error !== undefined && <p className="dshv-form-error" role="alert">{t('form.error', { message: error })}</p>}
      </div>

      <div className="dshv-form-foot">
        <button type="submit" className="dshv-btn" data-kind="primary" disabled={props.busy}>{props.busy ? t('action.saving') : t('action.save')}</button>
        <button type="button" className="dshv-btn" onClick={props.onCancel}>{t('action.cancel')}</button>
        <span className="dshv-spacer" />
        {props.onDelete !== undefined && editing && (
          <button
            type="button" className="dshv-btn" data-kind="danger" disabled={props.busy}
            onClick={() => {
              if (!confirmDelete) { setConfirmDelete(true); return }
              void props.onDelete?.().then((message) => { if (message !== undefined) setError(message) })
            }}
          >
            {confirmDelete ? t('action.delete.confirm') : t('action.delete')}
          </button>
        )}
      </div>
    </form>
  )
}
