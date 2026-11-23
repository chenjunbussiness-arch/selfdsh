/**
 * Management pieces of the secrets page: the sheet (modal), the write-only
 * value input, the vault / credential / hub forms, and the DSH-credentials and
 * plugins tabs. Every write goes through source.ts; no response carries a
 * value, so nothing here can display one. A value typed into a form lives in
 * component state only until the sheet closes.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { CredentialItem, CredentialsDocument, HubItem, PluginInfo, PluginNeed, PluginsDocument, SecretItem } from './contract.ts'
import { formatClock } from './format.ts'
import type { MessageKey, Translate } from './locales.ts'
import {
  BridgeError, credentialSet, credentialUnset, fetchCredentials, fetchPlugins, hubSet, hubUnset,
  vaultDelete, vaultDescribe, vaultRename, vaultSet,
} from './source.ts'

/** A short message the page shows after a write. */
export type Toast = (tone: 'ok' | 'bad', text: string) => void

/** Which plugin uses each built-in credential ref (mirrors CATALOG in host-secrets/manage.js). */
const USED_BY: Readonly<Record<string, string>> = {
  DEEPSEEK_API_KEY: 'dsh-router-b',
  EXA_API_KEY: 'dsh-router-b',
  GITHUB_TOKEN: 'dsh-router-b',
  GITEA_TOKEN: 'dsh-router-b',
}

/** `Used by dsh-router-b`, or '' for a ref no built-in plugin uses. */
function usedBy(t: Translate, ref: string): string {
  const plugin = USED_BY[ref]
  return plugin === undefined ? '' : t('cred.usedBy', { plugins: plugin })
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** `t()` for a key built at run time; falls back when the dictionary has none. */
function tx(t: Translate, key: string, fallback: string, values?: Record<string, string | number>): string {
  const text = t(key as MessageKey, values)
  return text === key || text === '' ? fallback : text
}

/** Split a tags field on spaces and commas. */
export function parseTags(text: string): string[] {
  return [...new Set(text.split(/[\s,，]+/).map(tag => tag.trim()).filter(tag => tag !== ''))]
}

// --- generic pieces ---------------------------------------------------------------

/** Fetch one document; the latest request wins; reload on tab focus. */
export function useDocument<T>(load: (signal: AbortSignal) => Promise<T>): {
  data: T | undefined
  error: { message: string; status?: number } | undefined
  busy: boolean
  reload: () => void
} {
  const [state, setState] = useState<{ data?: T; error?: { message: string; status?: number }; busy: boolean }>({ busy: true })
  const ticket = useRef(0)
  const inflight = useRef<AbortController | null>(null)
  const run = useCallback(() => {
    const mine = ticket.current + 1
    ticket.current = mine
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    setState(previous => ({ ...previous, busy: true }))
    load(controller.signal).then(
      (data) => { if (mine === ticket.current) setState({ data, busy: false }) },
      (error: unknown) => {
        if (mine !== ticket.current) return
        const status = error instanceof BridgeError ? error.status : undefined
        setState(previous => ({ data: previous.data, busy: false, error: { message: messageOf(error), status } }))
      },
    )
  }, [load])
  useEffect(() => {
    run()
    const onVisibility = (): void => { if (document.visibilityState !== 'hidden') run() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      inflight.current?.abort()
      ticket.current += 1
    }
  }, [run])
  return { data: state.data, error: state.error, busy: state.busy, reload: run }
}

/** Render above the shell, in `<body>`, with the page's tokens (`.dss-layer`). */
export function Layer({ children }: { readonly children: ReactNode }): ReactNode {
  if (typeof document === 'undefined') return null
  return createPortal(<div className="dss-layer">{children}</div>, document.body)
}

/** A centred modal sheet. Esc and a click on the backdrop close it. */
export function Sheet({ t, title, onClose, children }: {
  readonly t: Translate
  readonly title: string
  readonly onClose: () => void
  readonly children: ReactNode
}): ReactNode {
  const panel = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const first = panel.current?.querySelector<HTMLElement>('input, textarea, button[data-primary="true"]')
    first?.focus()
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])
  return (
    <Layer>
      <div className="dss-sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
        <div className="dss-sheet" role="dialog" aria-modal="true" aria-label={title} ref={panel}>
          <div className="dss-sheet-head">
            <h2 className="dss-sheet-title">{title}</h2>
            <button type="button" className="dss-icon-btn" aria-label={t('action.close')} onClick={onClose}>×</button>
          </div>
          {children}
        </div>
      </div>
    </Layer>
  )
}

/** A write-only value input: password field with a show / hide toggle. */
export function SecretInput({ t, value, onChange, placeholder, id }: {
  readonly t: Translate
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder?: string
  readonly id: string
}): ReactNode {
  const [shown, setShown] = useState(false)
  return (
    <div className="dss-secret-input">
      <input
        id={id}
        className="dss-input"
        type={shown ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        autoComplete="new-password"
        spellCheck={false}
        autoCapitalize="off"
        onChange={(event) => { onChange(event.target.value) }}
      />
      <button type="button" className="dss-input-toggle" onClick={() => { setShown(!shown) }}>
        {shown ? t('action.hide') : t('action.show')}
      </button>
    </div>
  )
}

/** Label + control + optional hint. */
function Field({ label, hint, htmlFor, children }: { readonly label: string; readonly hint?: string; readonly htmlFor?: string; readonly children: ReactNode }): ReactNode {
  return (
    <div className="dss-field">
      <label className="dss-field-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint !== undefined && <span className="dss-field-hint">{hint}</span>}
    </div>
  )
}

/** Run one write; keep the sheet open with the error when it fails. */
function useSubmit(t: Translate, run: () => Promise<string>, onDone: (message: string) => void): {
  busy: boolean
  error: string | undefined
  submit: (event?: FormEvent) => void
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    if (busy) return
    setBusy(true)
    setError(undefined)
    run().then(
      (message) => { setBusy(false); onDone(message) },
      (failure: unknown) => { setBusy(false); setError(t('error.save', { message: messageOf(failure) })) },
    )
  }
  return { busy, error, submit }
}

/** Footer with cancel + the primary (or danger) action. */
function SheetActions({ t, busy, label, danger, onCancel, disabled }: {
  readonly t: Translate
  readonly busy: boolean
  readonly label: string
  readonly danger?: boolean
  readonly onCancel: () => void
  readonly disabled?: boolean
}): ReactNode {
  return (
    <div className="dss-sheet-actions">
      <button type="button" className="dss-btn" onClick={onCancel}>{t('action.cancel')}</button>
      <button type="submit" className="dss-btn" data-primary={danger === true ? undefined : 'true'} data-danger={danger === true ? 'true' : undefined} disabled={busy || disabled === true}>
        {busy ? t('action.saving') : label}
      </button>
    </div>
  )
}

// --- vault sheets -----------------------------------------------------------------

/** What the vault sheet is doing. */
export type VaultSheetMode =
  | { readonly kind: 'create' }
  | { readonly kind: 'replace' | 'edit' | 'rename' | 'delete'; readonly item: SecretItem }

/** Create / replace / edit / rename / delete one vault secret. */
export function VaultSheet({ t, mode, onClose, onDone }: {
  readonly t: Translate
  readonly mode: VaultSheetMode
  readonly onClose: () => void
  readonly onDone: (message: string) => void
}): ReactNode {
  const item = mode.kind === 'create' ? undefined : mode.item
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [description, setDescription] = useState(item?.description ?? '')
  const [tags, setTags] = useState(item?.tags.join(' ') ?? '')
  const [to, setTo] = useState(item?.name ?? '')
  const [overwrite, setOverwrite] = useState(false)

  const { busy, error, submit } = useSubmit(t, async () => {
    switch (mode.kind) {
      case 'create': {
        await vaultSet({ name: name.trim(), value, ...description.trim() === '' ? {} : { description: description.trim() }, tags: parseTags(tags) })
        return t('done.saved', { name: name.trim() })
      }
      case 'replace':
        await vaultSet({ name: mode.item.name, value })
        return t('done.saved', { name: mode.item.name })
      case 'edit':
        await vaultDescribe({ name: mode.item.name, description: description.trim(), tags: parseTags(tags) })
        return t('done.saved', { name: mode.item.name })
      case 'rename':
        await vaultRename({ from: mode.item.name, to: to.trim(), overwrite })
        return t('done.renamed', { name: to.trim() })
      case 'delete':
        await vaultDelete(mode.item.name)
        return t('done.deleted', { name: mode.item.name })
    }
  }, onDone)

  const title = mode.kind === 'create' ? t('sheet.create') : t(`sheet.${mode.kind}`, { name: mode.item.name })
  let body: ReactNode
  let ready = true
  if (mode.kind === 'delete') {
    body = <p className="dss-sheet-text">{t('sheet.delete.body')}</p>
  } else if (mode.kind === 'rename') {
    ready = to.trim() !== '' && to.trim() !== mode.item.name
    body = (
      <>
        <Field label={t('field.to')} hint={t('field.name.hint')} htmlFor="dss-f-to">
          <input id="dss-f-to" className="dss-input dss-mono" value={to} spellCheck={false} autoComplete="off" onChange={(event) => { setTo(event.target.value) }} />
        </Field>
        <label className="dss-check">
          <input type="checkbox" checked={overwrite} onChange={(event) => { setOverwrite(event.target.checked) }} />
          <span>{t('field.overwrite')}</span>
        </label>
      </>
    )
  } else {
    const showValue = mode.kind === 'create' || mode.kind === 'replace'
    const showMeta = mode.kind === 'create' || mode.kind === 'edit'
    ready = (mode.kind !== 'create' || name.trim() !== '') && (!showValue || value !== '')
    body = (
      <>
        {mode.kind === 'create' && (
          <Field label={t('field.name')} hint={t('field.name.hint')} htmlFor="dss-f-name">
            <input id="dss-f-name" className="dss-input dss-mono" value={name} spellCheck={false} autoComplete="off" onChange={(event) => { setName(event.target.value) }} />
          </Field>
        )}
        {showValue && (
          <Field label={t('field.value')} hint={t('field.value.hint')} htmlFor="dss-f-value">
            <SecretInput t={t} id="dss-f-value" value={value} onChange={setValue} />
          </Field>
        )}
        {showMeta && (
          <>
            <Field label={t('field.description')} htmlFor="dss-f-desc">
              <textarea id="dss-f-desc" className="dss-input dss-textarea" value={description} rows={2} onChange={(event) => { setDescription(event.target.value) }} />
            </Field>
            <Field label={t('field.tags')} hint={t('field.tags.hint')} htmlFor="dss-f-tags">
              <input id="dss-f-tags" className="dss-input" value={tags} spellCheck={false} autoComplete="off" onChange={(event) => { setTags(event.target.value) }} />
            </Field>
          </>
        )}
      </>
    )
  }
  return (
    <Sheet t={t} title={title} onClose={onClose}>
      <form className="dss-sheet-form" onSubmit={submit}>
        {body}
        {error !== undefined && <p className="dss-sheet-error" role="alert">{error}</p>}
        <SheetActions
          t={t}
          busy={busy}
          disabled={!ready}
          danger={mode.kind === 'delete'}
          label={mode.kind === 'delete' ? t('action.delete') : t('action.save')}
          onCancel={onClose}
        />
      </form>
    </Sheet>
  )
}

// --- credential + hub sheets ---------------------------------------------------------

/** Set or clear one DSH credential. */
function CredentialSheet({ t, refName, clear, onClose, onDone }: {
  readonly t: Translate
  readonly refName: string
  readonly clear: boolean
  readonly onClose: () => void
  readonly onDone: (message: string) => void
}): ReactNode {
  const [value, setValue] = useState('')
  const { busy, error, submit } = useSubmit(t, async () => {
    if (clear) {
      await credentialUnset(refName)
      return t('done.cleared', { name: refName })
    }
    await credentialSet(refName, value)
    return t('done.saved', { name: refName })
  }, onDone)
  return (
    <Sheet t={t} title={clear ? t('sheet.credential.clear', { name: refName }) : t('sheet.credential', { name: refName })} onClose={onClose}>
      <form className="dss-sheet-form" onSubmit={submit}>
        {clear
          ? <p className="dss-sheet-text">{t('sheet.credential.clear.body')}</p>
          : (
            <>
              <Field label={t('field.value')} hint={t('field.value.hint')} htmlFor="dss-f-cred">
                <SecretInput t={t} id="dss-f-cred" value={value} onChange={setValue} />
              </Field>
              <p className="dss-sheet-text">{t('cred.envWins')}</p>
            </>
          )}
        {error !== undefined && <p className="dss-sheet-error" role="alert">{error}</p>}
        <SheetActions t={t} busy={busy} disabled={!clear && value.trim() === ''} danger={clear} label={clear ? t('action.clear') : t('action.save')} onCancel={onClose} />
      </form>
    </Sheet>
  )
}

/** Set (or clear) one agent-hub connection setting. */
function HubSheet({ t, item, onClose, onDone }: {
  readonly t: Translate
  readonly item: HubItem
  readonly onClose: () => void
  readonly onDone: (message: string) => void
}): ReactNode {
  const [value, setValue] = useState(item.secret ? '' : item.value ?? '')
  const [clearing, setClearing] = useState(false)
  const { busy, error, submit } = useSubmit(t, async () => {
    if (clearing) {
      await hubUnset(item.key)
      return t('done.cleared', { name: item.key })
    }
    await hubSet(item.key, value.trim())
    return t('done.saved', { name: item.key })
  }, onDone)
  const hint = item.key === 'DSH_HUB_URL' ? t('hub.url.hint') : item.key === 'DSH_HUB_PROXY' ? t('hub.proxy.hint') : t('field.value.hint')
  return (
    <Sheet t={t} title={t('sheet.hub', { name: tx(t, `hub.key.${item.key}`, item.key) })} onClose={onClose}>
      <form className="dss-sheet-form" onSubmit={submit}>
        <Field label={item.key} hint={hint} htmlFor="dss-f-hub">
          {item.secret
            ? <SecretInput t={t} id="dss-f-hub" value={value} onChange={setValue} />
            : <input id="dss-f-hub" className="dss-input dss-mono" value={value} spellCheck={false} autoComplete="off" onChange={(event) => { setValue(event.target.value) }} />}
        </Field>
        {item.shadowed && <p className="dss-sheet-text">{t('hub.shadowed')}</p>}
        {error !== undefined && <p className="dss-sheet-error" role="alert">{error}</p>}
        <div className="dss-sheet-actions">
          {item.source === 'file' && (
            <button type="submit" className="dss-btn dss-btn-left" data-danger="true" disabled={busy} onClick={() => { setClearing(true) }}>{t('action.clear')}</button>
          )}
          <button type="button" className="dss-btn" onClick={onClose}>{t('action.cancel')}</button>
          <button type="submit" className="dss-btn" data-primary="true" disabled={busy || value.trim() === ''} onClick={() => { setClearing(false) }}>
            {busy ? t('action.saving') : t('action.save')}
          </button>
        </div>
      </form>
    </Sheet>
  )
}

// --- status bits -------------------------------------------------------------------

function StatusDot({ tone }: { readonly tone: 'ok' | 'warn' | 'idle' | 'bad' }): ReactNode {
  return <span className="dss-dot" data-state={tone} aria-hidden="true" />
}

function sourceText(t: Translate, source: string | null): string {
  return tx(t, `cred.source.${source ?? 'unknown'}`, source ?? t('cred.source.unknown'))
}

/** Problem / loading block shared by the two tabs. */
function LoadState({ t, error, onRetry }: { readonly t: Translate; readonly error?: { message: string; status?: number }; readonly onRetry: () => void }): ReactNode {
  if (error === undefined) return <div className="dss-empty"><span className="dss-empty-hint">{t('loading')}</span></div>
  const hint = error.status === 401 || error.status === 403 ? t('error.unauthorized') : error.status === 503 ? t('error.unavailable') : t('error.hint')
  return (
    <div className="dss-empty" data-bad="true" role="alert">
      <span className="dss-empty-title">{t('error.title')}</span>
      <span className="dss-empty-hint">{hint}</span>
      <span className="dss-empty-hint">{t('detail', { message: error.message })}</span>
      <button type="button" className="dss-btn" data-primary="true" onClick={onRetry}>{t('retry')}</button>
    </div>
  )
}

function SectionHead({ t, title, sub, busy, generatedAt, onRefresh }: {
  readonly t: Translate
  readonly title: string
  readonly sub: ReactNode
  readonly busy: boolean
  readonly generatedAt?: string
  readonly onRefresh: () => void
}): ReactNode {
  return (
    <div className="dss-section-head">
      <div className="dss-head-text">
        <h2 className="dss-section-title">{title}</h2>
        <p className="dss-sub">{sub}</p>
      </div>
      <div className="dss-head-actions">
        {generatedAt !== undefined && <span className="dss-updated">{t('updatedAt', { time: formatClock(generatedAt) })}</span>}
        <button type="button" className="dss-btn" disabled={busy} onClick={onRefresh}>{busy && generatedAt !== undefined ? t('refreshing') : t('refresh')}</button>
      </div>
    </div>
  )
}

// --- DSH credentials tab -------------------------------------------------------------

/** The DSH credential store: presence and source of each managed ref. */
export function CredentialsTab({ t, toast }: { readonly t: Translate; readonly toast: Toast }): ReactNode {
  const doc = useDocument<CredentialsDocument>(fetchCredentials)
  const [sheet, setSheet] = useState<{ ref: string; clear: boolean } | undefined>(undefined)
  const close = useCallback(() => { setSheet(undefined) }, [])
  const done = (message: string): void => { setSheet(undefined); toast('ok', message); doc.reload() }

  const data = doc.data
  return (
    <section className="dss-section">
      <SectionHead t={t} title={t('cred.title')} sub={t('cred.sub')} busy={doc.busy} generatedAt={data?.generatedAt} onRefresh={doc.reload} />
      {data === undefined
        ? <LoadState t={t} error={doc.busy ? undefined : doc.error} onRetry={doc.reload} />
        : (
          <>
            {!data.available && <div className="dss-banner" data-tone="locked"><p className="dss-banner-text">{t('cred.unavailable')}</p></div>}
            <div className="dss-list">
              {data.items.map((item: CredentialItem) => (
                <div className="dss-list-row" key={item.ref}>
                  <StatusDot tone={item.configured ? 'ok' : 'idle'} />
                  <div className="dss-list-main">
                    <code className="dss-list-name">{item.ref}</code>
                    <span className="dss-list-sub">
                      {tx(t, `cred.ref.${item.ref}`, usedBy(t, item.ref))}
                    </span>
                  </div>
                  <span className="dss-list-state">
                    {item.configured ? `${t('cred.status.set')} · ${sourceText(t, item.source)}` : t('cred.status.unset')}
                  </span>
                  <div className="dss-row-actions">
                    <button type="button" className="dss-btn dss-btn-sm" disabled={!data.available} onClick={() => { setSheet({ ref: item.ref, clear: false }) }}>
                      {item.configured ? t('action.change') : t('action.set')}
                    </button>
                    {item.configured && item.source === 'file' && (
                      <button type="button" className="dss-btn dss-btn-sm" data-danger="true" onClick={() => { setSheet({ ref: item.ref, clear: true }) }}>{t('action.clear')}</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      {sheet !== undefined && <CredentialSheet t={t} refName={sheet.ref} clear={sheet.clear} onClose={close} onDone={done} />}
    </section>
  )
}

// --- plugins tab --------------------------------------------------------------------

function NeedRow({ t, need, hub, onSetCredential, onSetHub }: {
  readonly t: Translate
  readonly need: PluginNeed
  readonly hub: HubItem | undefined
  readonly onSetCredential: (ref: string) => void
  readonly onSetHub: (item: HubItem) => void
}): ReactNode {
  const tone = need.configured ? 'ok' : need.required ? 'warn' : 'idle'
  let detail: string
  if (need.kind === 'vault-key') detail = t('plugins.vaultKey.hint')
  else if (need.kind === 'hub' && hub !== undefined) {
    detail = !hub.configured ? t('hub.notSet') : hub.secret ? t('hub.hidden') : hub.value ?? ''
    if (hub.shadowed) detail = `${detail} · ${t('hub.shadowed')}`
  } else detail = need.configured ? sourceText(t, need.source) : t('cred.status.unset')
  return (
    <div className="dss-need">
      <StatusDot tone={tone} />
      <div className="dss-need-main">
        <span className="dss-need-name">
          {need.kind === 'hub' ? tx(t, `hub.key.${need.key}`, need.key) : <code>{need.key}</code>}
          <span className="dss-need-tag">{need.required ? t('plugins.required') : t('plugins.optional')}</span>
        </span>
        <span className="dss-need-detail" data-mono={need.kind === 'hub' && hub?.secret !== true && hub?.configured === true ? 'true' : undefined}>{detail}</span>
      </div>
      {need.kind === 'credential' && (
        <button type="button" className="dss-btn dss-btn-sm" onClick={() => { onSetCredential(need.key) }}>{need.configured ? t('action.change') : t('action.set')}</button>
      )}
      {need.kind === 'hub' && hub !== undefined && (
        <button type="button" className="dss-btn dss-btn-sm" onClick={() => { onSetHub(hub) }}>{hub.configured ? t('action.change') : t('action.set')}</button>
      )}
    </div>
  )
}

function PluginCard({ t, plugin, hub, onSetCredential, onSetHub }: {
  readonly t: Translate
  readonly plugin: PluginInfo
  readonly hub: PluginsDocument['hub']
  readonly onSetCredential: (ref: string) => void
  readonly onSetHub: (item: HubItem) => void
}): ReactNode {
  const missing = plugin.needs.filter(need => need.required && !need.configured).length
  const hubByKey = new Map(hub.items.map(item => [item.key, item]))
  return (
    <article className="dss-card" data-installed={plugin.installed}>
      <header className="dss-card-head">
        <div className="dss-card-title-wrap">
          <h3 className="dss-card-title">{plugin.id}</h3>
          <p className="dss-card-sub">{tx(t, `plugin.${plugin.id}`, '')}</p>
        </div>
        <span className="dss-chip" data-tone={plugin.installed ? (missing === 0 ? 'unlocked' : 'locked') : 'missing'}>
          {!plugin.installed ? t('plugins.notInstalled') : missing === 0 ? t('plugins.ready') : t('plugins.missing', { count: missing })}
        </span>
      </header>
      {plugin.id === 'dsh-agent-hub' && <p className="dss-card-note">{t('hub.sub', { file: hub.file })}</p>}
      {plugin.needs.length === 0
        ? <p className="dss-card-note">{t('plugins.nothingNeeded')}</p>
        : (
          <div className="dss-needs">
            {plugin.needs.map(need => (
              <NeedRow key={need.key} t={t} need={need} hub={hubByKey.get(need.key)} onSetCredential={onSetCredential} onSetHub={onSetHub} />
            ))}
          </div>
        )}
    </article>
  )
}

/** selfdsh plugins in the profile and what each needs. */
export function PluginsTab({ t, toast }: { readonly t: Translate; readonly toast: Toast }): ReactNode {
  const doc = useDocument<PluginsDocument>(fetchPlugins)
  const [credential, setCredential] = useState<string | undefined>(undefined)
  const [hubItem, setHubItem] = useState<HubItem | undefined>(undefined)
  const close = useCallback(() => { setCredential(undefined); setHubItem(undefined) }, [])
  const done = (message: string): void => { close(); toast('ok', message); doc.reload() }

  const data = doc.data
  let sub: string = t('plugins.sub')
  if (data !== undefined) {
    const running = data.profiles.find(profile => profile.running)
    const where = running !== undefined
      ? t('plugins.profile', { name: running.name })
      : data.profiles.length === 0 ? t('plugins.noProfile') : t('plugins.profiles', { names: data.profiles.map(profile => profile.name).join(', ') })
    sub = `${sub} ${where}`
  }
  // Installed plugins first, then the rest; catalog order inside each group.
  const plugins = data === undefined ? [] : [...data.plugins.filter(plugin => plugin.installed), ...data.plugins.filter(plugin => !plugin.installed)]
  return (
    <section className="dss-section">
      <SectionHead t={t} title={t('plugins.title')} sub={sub} busy={doc.busy} generatedAt={data?.generatedAt} onRefresh={doc.reload} />
      {data === undefined
        ? <LoadState t={t} error={doc.busy ? undefined : doc.error} onRetry={doc.reload} />
        : (
          <div className="dss-cards">
            {plugins.map(plugin => (
              <PluginCard key={plugin.id} t={t} plugin={plugin} hub={data.hub} onSetCredential={setCredential} onSetHub={setHubItem} />
            ))}
          </div>
        )}
      {credential !== undefined && <CredentialSheet t={t} refName={credential} clear={false} onClose={close} onDone={done} />}
      {hubItem !== undefined && <HubSheet t={t} item={hubItem} onClose={close} onDone={done} />}
    </section>
  )
}
