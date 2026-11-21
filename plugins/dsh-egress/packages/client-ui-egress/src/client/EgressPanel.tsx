/**
 * The Egress panel: status bar, exit list (with the add/edit form), binding
 * table and the recent-request log.
 *
 * Everything the person can change lives here and goes through the controller;
 * the agent has a read-only tool and no way to reach these writes.
 */

import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { BindingView, EgressState, ExitInput, ExitView, RingEntry, Translate } from './contract.ts'
import type { EgressController } from './controller.ts'

/** Props of {@link EgressPanel}. */
export interface EgressPanelProps {
  readonly controller: EgressController
  readonly t: Translate
  /** Preview only: open the add form / edit form / log on first render. */
  readonly initialForm?: 'new' | { readonly edit: string }
  readonly initialLogOpen?: boolean
}

/** Types the form offers. */
const TYPES = ['http', 'https', 'socks5'] as const

/** `3 分钟前`-style short age, language-neutral (`3m`, `2h`, `4d`). */
function age(iso: string | undefined, now: number): string {
  if (iso === undefined) return ''
  const diff = Math.max(0, now - Date.parse(iso))
  if (!Number.isFinite(diff)) return ''
  const minutes = Math.round(diff / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${String(hours)}h` : `${String(Math.round(hours / 24))}d`
}

/** Short type label shown as a pill. */
const typeLabel = (exit: ExitView): string => (exit.type === 'socks5' ? 'SOCKS5' : exit.type.toUpperCase())

/** Status bar: how a change applies, plus the warnings that matter. */
function StatusBar({ data, origin, bridgeError, t }: { data: EgressState; origin: 'host' | 'mock'; bridgeError: string | undefined; t: Translate }): ReactNode {
  const [copied, setCopied] = useState(false)
  const restart = data.apply.mode === 'restart'
  const copy = (): void => {
    void navigator.clipboard?.writeText(data.apply.restartHint).then(() => { setCopied(true); setTimeout(() => { setCopied(false) }, 1500) }, () => undefined)
  }
  return (
    <div className="dshe-status" data-mode={restart ? 'restart' : 'instant'}>
      <div className="dshe-status-main">
        <span className="dshe-dot" aria-hidden="true" />
        <strong>{t(restart ? 'status.restart' : 'status.instant')}</strong>
        <span className="dshe-status-hint">
          {restart
            ? <>{t('status.restart.hint', { cmd: '' }).replace(/\s*$/, ' ')}<code className="dshe-code">{data.apply.restartHint}</code></>
            : t('status.instant.hint')}
        </span>
        {restart && <button type="button" className="dshe-btn" data-size="sm" onClick={copy}>{copied ? t('status.copied') : t('status.copy')}</button>}
        <span className="dshe-fill" />
        {origin === 'mock' && <span className="dshe-badge" title={bridgeError === undefined ? t('badge.mock.hint') : `${t('badge.mock.hint')}\n${bridgeError}`}>{t('badge.mock')}</span>}
      </div>
      <div className="dshe-status-sub">{t('status.failclosed')}</div>
      {data.apply.corrupt !== undefined && <div className="dshe-alert">{t('status.corrupt', { error: data.apply.corrupt })}</div>}
      {!data.apply.undici.ok && <div className="dshe-alert">{t('status.undici', { error: data.apply.undici.error ?? '' })}</div>}
    </div>
  )
}

/** The add/edit form. */
function ExitForm({ exit, t, saving, onSave, onCancel }: {
  exit: ExitView | undefined
  t: Translate
  saving: boolean
  onSave: (input: ExitInput) => void
  onCancel: () => void
}): ReactNode {
  const [name, setName] = useState(exit?.name ?? '')
  const [type, setType] = useState<(typeof TYPES)[number]>(exit !== undefined && exit.type !== 'direct' ? exit.type : 'http')
  const [host, setHost] = useState(exit?.host ?? '')
  const [port, setPort] = useState(exit?.port === undefined ? '' : String(exit.port))
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [clearAuth, setClearAuth] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const submit = (): void => {
    const portNumber = /^[0-9]{1,5}$/.test(port.trim()) ? Number(port.trim()) : 0
    if (name.trim() === '') return setError(t('form.err.name'))
    if (host.trim() === '') return setError(t('form.err.host'))
    if (portNumber < 1 || portNumber > 65_535) return setError(t('form.err.port'))
    setError(undefined)
    onSave({
      ...exit === undefined ? {} : { id: exit.id },
      name: name.trim(), type, host: host.trim(), port: portNumber,
      ...clearAuth ? { clearAuth: true } : {},
      ...!clearAuth && username !== '' ? { username } : {},
      ...!clearAuth && password !== '' ? { password } : {},
    })
  }

  return (
    <form className="dshe-form" onSubmit={(event) => { event.preventDefault(); submit() }}>
      <div className="dshe-form-title">{t(exit === undefined ? 'form.new' : 'form.edit')}</div>
      <div className="dshe-form-grid">
        <label className="dshe-field" style={{ gridColumn: 'span 2' }}>
          <span>{t('form.name')}</span>
          <input className="dshe-input" value={name} maxLength={40} onChange={(e) => { setName(e.target.value) }} placeholder="Tokyo" autoFocus={exit === undefined} />
        </label>
        <label className="dshe-field">
          <span>{t('form.type')}</span>
          <select className="dshe-input" value={type} onChange={(e) => { setType(e.target.value as (typeof TYPES)[number]) }}>
            {TYPES.map(value => <option key={value} value={value}>{value === 'socks5' ? 'socks5 (socks5h)' : value}</option>)}
          </select>
        </label>
        <label className="dshe-field" style={{ gridColumn: 'span 2' }}>
          <span>{t('form.host')}</span>
          <input className="dshe-input" value={host} onChange={(e) => { setHost(e.target.value) }} placeholder="proxy.example.com" spellCheck={false} />
        </label>
        <label className="dshe-field">
          <span>{t('form.port')}</span>
          <input className="dshe-input" value={port} inputMode="numeric" onChange={(e) => { setPort(e.target.value) }} placeholder="1080" />
        </label>
        <label className="dshe-field">
          <span>{t('form.username')} <em>{t('form.optional')}</em></span>
          <input className="dshe-input" value={username} autoComplete="off" disabled={clearAuth} onChange={(e) => { setUsername(e.target.value) }} placeholder={exit?.hasAuth === true ? t('form.hasAuth') : ''} spellCheck={false} />
        </label>
        <label className="dshe-field">
          <span>{t('form.password')} <em>{t('form.optional')}</em></span>
          <input className="dshe-input" type="password" value={password} autoComplete="new-password" disabled={clearAuth} onChange={(e) => { setPassword(e.target.value) }} placeholder={exit?.hasAuth === true ? t('form.keep') : ''} />
        </label>
        {exit?.hasAuth === true && (
          <label className="dshe-check">
            <input type="checkbox" checked={clearAuth} onChange={(e) => { setClearAuth(e.target.checked) }} /> {t('form.clearAuth')}
          </label>
        )}
      </div>
      <div className="dshe-form-note">{type === 'socks5' ? `${t('form.hint.socks5')} · ` : ''}{t('form.hint.secret')}</div>
      {error !== undefined && <div className="dshe-form-error">{error}</div>}
      <div className="dshe-form-actions">
        <button type="submit" className="dshe-btn" data-tone="primary" disabled={saving}>{t(saving ? 'form.saving' : 'form.save')}</button>
        <button type="button" className="dshe-btn" onClick={onCancel}>{t('form.cancel')}</button>
      </div>
    </form>
  )
}

/** One row of the exit list. */
function ExitRow({ exit, isDefault, probing, now, t, onProbe, onEdit, onDelete }: {
  exit: ExitView
  isDefault: boolean
  probing: boolean
  now: number
  t: Translate
  onProbe: () => void
  onEdit: () => void
  onDelete: () => void
}): ReactNode {
  const [confirm, setConfirm] = useState(false)
  const probe = exit.lastProbe
  return (
    <li className="dshe-exit" data-builtin={exit.builtin} data-probe={probe === undefined ? 'none' : probe.ok ? 'ok' : 'fail'}>
      <div className="dshe-exit-id">
        <span className="dshe-exit-name">{exit.name}</span>
        <span className="dshe-pill" data-type={exit.type}>{exit.builtin ? t('exit.builtin') : typeLabel(exit)}</span>
        {isDefault && <span className="dshe-pill" data-tone="accent">{t('exit.default')}</span>}
        {exit.hasAuth && <span className="dshe-pill" data-tone="muted">{t('exit.auth')}</span>}
      </div>
      <div className="dshe-exit-addr" title={exit.url}>{exit.builtin ? t('exit.direct.desc') : exit.url}</div>
      <div className="dshe-exit-probe">
        {probing
          ? <span className="dshe-probe-wait">{t('exit.probing')}</span>
          : probe === undefined
            ? <span className="dshe-probe-none">{t('exit.noProbe')}</span>
            : probe.ok
              ? <span className="dshe-probe-ok" title={probe.at}>{t('exit.probeOk', { ip: probe.ip ?? '?', ms: probe.ms ?? 0 })}<em>{age(probe.at, now)}</em></span>
              : <span className="dshe-probe-fail" title={probe.error}>{t('exit.probeFail', { error: probe.error ?? '' })}<em>{age(probe.at, now)}</em></span>}
      </div>
      <div className="dshe-exit-actions">
        <button type="button" className="dshe-btn" data-size="sm" disabled={probing} onClick={onProbe}>{t(probing ? 'exit.probing' : 'exit.probe')}</button>
        {!exit.builtin && !confirm && <>
          <button type="button" className="dshe-btn" data-size="sm" onClick={onEdit}>{t('exit.edit')}</button>
          <button type="button" className="dshe-btn" data-size="sm" data-tone="bad" onClick={() => { setConfirm(true) }}>{t('exit.delete')}</button>
        </>}
        {!exit.builtin && confirm && <>
          <button type="button" className="dshe-btn" data-size="sm" data-tone="bad-solid" onClick={() => { setConfirm(false); onDelete() }}>{t('exit.confirm')}</button>
          <button type="button" className="dshe-btn" data-size="sm" onClick={() => { setConfirm(false) }}>{t('exit.cancel')}</button>
        </>}
      </div>
    </li>
  )
}

/** The exit picker used by every binding row. */
function ExitSelect({ exits, value, onChange, label }: { exits: readonly ExitView[]; value: string; onChange: (id: string) => void; label: string }): ReactNode {
  return (
    <select className="dshe-select" aria-label={label} value={exits.some(e => e.id === value) ? value : ''} onChange={(e) => { onChange(e.target.value) }}>
      {!exits.some(e => e.id === value) && <option value="" disabled>{value}</option>}
      {exits.map(exit => <option key={exit.id} value={exit.id}>{exit.builtin ? exit.name : `${exit.name} · ${typeLabel(exit)}`}</option>)}
    </select>
  )
}

/** Binding table, with the default exit as its first row. */
function Bindings({ data, t, now, onBind }: { data: EgressState; t: Translate; now: number; onBind: (host: string, exit: string | null) => void }): ReactNode {
  const [host, setHost] = useState('')
  const add = (): void => {
    const value = host.trim().toLowerCase()
    if (value === '') return
    onBind(value, data.defaultExit)
    setHost('')
  }
  return (
    <section className="dshe-section">
      <header className="dshe-section-head">
        <h2>{t('bind.title')}</h2>
        <span className="dshe-section-sub">{t('bind.subtitle')}</span>
      </header>
      <div className="dshe-table">
        <div className="dshe-row dshe-row-head"><span>{t('bind.host')}</span><span /><span>{t('bind.exit')}</span><span /></div>
        <div className="dshe-row" data-kind="default">
          <span className="dshe-host"><strong>{t('bind.default')}</strong><em>{t('bind.default.hint')}</em></span>
          <span />
          <ExitSelect exits={data.exits} value={data.defaultExit} label={t('bind.default')} onChange={(id) => { onBind('*', id) }} />
          <span />
        </div>
        {data.bindings.map((row: BindingView) => (
          <div className="dshe-row" key={row.host} data-source={row.source}>
            <span className="dshe-host">
              <code>{row.host}</code>
              {row.provider !== undefined && <span className="dshe-pill" data-tone="muted">{row.provider}</span>}
            </span>
            <span className="dshe-seen">{row.lastSeen === undefined ? t('bind.neverSeen') : t('bind.lastSeen', { time: age(row.lastSeen, now) })}</span>
            <ExitSelect exits={data.exits} value={row.exit} label={row.host} onChange={(id) => { onBind(row.host, id) }} />
            <span className="dshe-row-end">
              <span className="dshe-source" data-source={row.source}>{t(row.source === 'binding' ? 'bind.source.binding' : 'bind.source.default')}</span>
              {row.source === 'binding' && <button type="button" className="dshe-link" onClick={() => { onBind(row.host, null) }}>{t('bind.unbind')}</button>}
            </span>
          </div>
        ))}
      </div>
      <form className="dshe-addhost" onSubmit={(event) => { event.preventDefault(); add() }}>
        <input className="dshe-input" value={host} onChange={(e) => { setHost(e.target.value) }} placeholder={t('bind.addHost.placeholder')} spellCheck={false} aria-label={t('bind.addHost')} />
        <button type="submit" className="dshe-btn" disabled={host.trim() === ''}>{t('bind.addHost')}</button>
      </form>
    </section>
  )
}

/** The recent-request ring, collapsed by default. */
function RequestLog({ entries, t, now, initialOpen }: { entries: readonly RingEntry[]; t: Translate; now: number; initialOpen: boolean }): ReactNode {
  const [open, setOpen] = useState(initialOpen)
  return (
    <section className="dshe-section">
      <header className="dshe-section-head">
        <h2>{t('log.title')}</h2>
        <span className="dshe-section-sub">{t('log.hint')}</span>
        <span className="dshe-fill" />
        <button type="button" className="dshe-link" aria-expanded={open} onClick={() => { setOpen(!open) }}>{t(open ? 'log.hide' : 'log.show')} ({entries.length})</button>
      </header>
      {open && (entries.length === 0
        ? <div className="dshe-empty">{t('log.empty')}</div>
        : <ul className="dshe-log">
          {entries.slice(0, 30).map((entry, index) => (
            <li key={`${entry.at}-${String(index)}`} data-ok={entry.ok}>
              <span className="dshe-log-dot" aria-hidden="true" />
              <code>{entry.host}</code>
              <span className="dshe-log-exit">→ {entry.exitName}</span>
              <span className="dshe-log-result">{entry.ok ? t('log.ok') : `${t('log.fail')}${entry.error === undefined ? '' : `: ${entry.error}`}`}</span>
              <span className="dshe-log-time">{age(entry.at, now)}</span>
            </li>
          ))}
        </ul>)}
    </section>
  )
}

/**
 * Render the panel.
 * @param props - controller and translate.
 */
export function EgressPanel({ controller, t, initialForm, initialLogOpen = false }: EgressPanelProps): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [form, setForm] = useState<'new' | { readonly edit: string } | undefined>(initialForm)
  const [saving, setSaving] = useState(false)
  const data = state.data
  const now = data === null ? Date.now() : Date.parse(data.fetchedAt) || Date.now()

  if (data === null) {
    return <div className="dshe-panel"><div className="dshe-page"><div className="dshe-empty">{t('loading')}</div></div></div>
  }
  const editing = typeof form === 'object' ? data.exits.find(exit => exit.id === form.edit) : undefined
  const save = (input: ExitInput): void => {
    setSaving(true)
    void controller.saveExit(input, t('form.save')).then((ok) => { setSaving(false); if (ok) setForm(undefined) })
  }

  return (
    <div className="dshe-panel">
      <div className="dshe-page">
        <header className="dshe-head">
          <div>
            <h1 className="dshe-title">{t('panel.title')}</h1>
            <p className="dshe-sub">{t('panel.subtitle')}</p>
          </div>
          <span className="dshe-fill" />
          <button type="button" className="dshe-btn" onClick={() => { void controller.refresh() }}>{t('refresh')}</button>
        </header>

        <StatusBar data={data} origin={state.origin} bridgeError={state.bridgeError} t={t} />

        {state.notice !== undefined && (
          <div className="dshe-notice" data-kind={state.notice.kind} role="status">
            <span>{state.notice.text}</span>
            <button type="button" className="dshe-link" onClick={() => { controller.dismissNotice() }}>×</button>
          </div>
        )}

        <section className="dshe-section">
          <header className="dshe-section-head">
            <h2>{t('exits.title')}</h2>
            <span className="dshe-fill" />
            {form === undefined && <button type="button" className="dshe-btn" data-tone="primary" onClick={() => { setForm('new') }}>+ {t('exits.add')}</button>}
          </header>
          {form !== undefined && (form === 'new' || editing !== undefined) && (
            <ExitForm key={form === 'new' ? 'new' : form.edit} exit={editing} t={t} saving={saving} onSave={save} onCancel={() => { setForm(undefined) }} />
          )}
          <ul className="dshe-exits">
            {data.exits.map(exit => (
              <ExitRow
                key={exit.id} exit={exit} isDefault={data.defaultExit === exit.id} probing={state.probing.includes(exit.id)} now={now} t={t}
                onProbe={() => { void controller.probe(exit.id) }}
                onEdit={() => { setForm({ edit: exit.id }) }}
                onDelete={() => { void controller.removeExit(exit.id, t('exit.delete')) }}
              />
            ))}
          </ul>
          {data.exits.length === 1 && <div className="dshe-empty">{t('exits.empty')}</div>}
        </section>

        <Bindings data={data} t={t} now={now} onBind={(host, exit) => { void controller.bind(host, exit, t('bind.title')) }} />
        <RequestLog entries={data.recent} t={t} now={now} initialOpen={initialLogOpen} />
      </div>
    </div>
  )
}
