/**
 * The secrets page: three views behind a segmented control.
 *
 * - Vault: the value-free table of the dsh-secrets vault (tag filter, keyword
 *   search) with new / replace / edit / rename / delete sheets.
 * - DSH credentials and Plugins: see Manage.tsx.
 *
 * Reads come from `GET /api/secrets/{summary,list}`; writes go to the
 * management routes. No route returns a value, so this component cannot show
 * one: there is no "reveal" or "copy value" affordance by design.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { Filter, ListDocument, SecretItem, SummaryDocument, VaultStatus } from './contract.ts'
import { ageOf, formatClock, formatDateTime } from './format.ts'
import type { MessageKey, Translate } from './locales.ts'
import { CredentialsTab, Layer, PluginsTab, VaultSheet } from './Manage.tsx'
import type { Toast, VaultSheetMode } from './Manage.tsx'
import { LockIcon } from './SecretsIcon.tsx'
import { BridgeError, fetchList, fetchSummary } from './source.ts'

/** The three views. */
type Tab = 'vault' | 'credentials' | 'plugins'
const TABS: readonly Tab[] = ['vault', 'credentials', 'plugins']
const TAB_KEY = 'dsh-secrets.tab'

/** Props of the page: the injected translate function. */
export interface SecretsPageProps {
  readonly t: Translate
}

interface Loaded {
  readonly summary: SummaryDocument
  readonly list: ListDocument
}

interface ViewState {
  /** Last good documents; kept on screen when a later refresh fails. */
  readonly data?: Loaded
  /** A request is in flight. */
  readonly busy: boolean
  /** The last request failed. */
  readonly error?: { readonly message: string; readonly status?: number }
}

/** Placeholder syntax shown in the notice (kept out of the dictionaries on purpose). */
const PLACEHOLDER = '${secret:NAME}'

/** Debounce of the search box, ms. */
const SEARCH_DEBOUNCE_MS = 250

const LOCK_HINTS: Readonly<Record<string, MessageKey>> = {
  'key-missing': 'locked.key-missing',
  'decrypt-failed': 'locked.decrypt-failed',
  'key-invalid': 'locked.key-invalid',
  'key-source-mismatch': 'locked.key-source-mismatch',
}

/** Fetch both documents for a filter; the latest request wins. */
function useDashboard(filter: Filter): { state: ViewState; reload: () => void } {
  const [state, setState] = useState<ViewState>({ busy: true })
  const ticket = useRef(0)
  const inflight = useRef<AbortController | null>(null)
  const current = useRef<Filter>(filter)
  current.current = filter

  const load = useCallback((wanted: Filter) => {
    const mine = ticket.current + 1
    ticket.current = mine
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    setState(previous => ({ ...previous, busy: true }))
    Promise.all([fetchSummary(controller.signal), fetchList(wanted, controller.signal)]).then(
      ([summary, list]) => {
        if (mine === ticket.current) setState({ data: { summary, list }, busy: false })
      },
      (error: unknown) => {
        if (mine !== ticket.current) return
        const message = error instanceof Error ? error.message : String(error)
        const status = error instanceof BridgeError ? error.status : undefined
        setState(previous => ({ data: previous.data, busy: false, error: { message, status } }))
      },
    )
  }, [])

  const tag = filter.tag
  const query = filter.query
  useEffect(() => { load({ tag, query }) }, [load, tag, query])

  useEffect(() => {
    const onVisibility = (): void => { if (document.visibilityState !== 'hidden') load(current.current) }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      inflight.current?.abort()
      ticket.current += 1
    }
  }, [load])

  const reload = useCallback(() => { load(current.current) }, [load])
  return { state, reload }
}

/** `3 分钟前` / `3 min ago`. */
function ageText(t: Translate, iso: string): string {
  const age = ageOf(iso)
  if (age.unit === 'now') return t('age.now')
  return t(`age.${age.unit}`, { count: age.count })
}

/** The always-visible read-only notice. */
function Notice({ t }: { readonly t: Translate }): ReactNode {
  return (
    <section className="dss-notice" role="note" aria-label={t('notice.title')}>
      <span className="dss-notice-icon"><LockIcon size={20} /></span>
      <div className="dss-notice-body">
        <span className="dss-notice-title">{t('notice.title')}</span>
        <p className="dss-notice-text">{t('notice.body', { placeholder: PLACEHOLDER })}</p>
        <p className="dss-notice-text">{t('notice.fingerprint')}</p>
      </div>
    </section>
  )
}

/** Vault state chip, key source, count, path. */
function VaultLine({ t, vault, summary }: { readonly t: Translate; readonly vault: VaultStatus; readonly summary: SummaryDocument }): ReactNode {
  return (
    <div className="dss-status">
      <span className="dss-chip" data-tone={vault.state}>{t(`vault.state.${vault.state}`)}</span>
      <span>{t(`vault.keySource.${vault.keySource}`)}</span>
      <span className="dss-status-key" data-ok={vault.keyConfigured}>
        {vault.keyConfigured ? t('vault.key.configured') : t('vault.key.missing')}
      </span>
      {vault.state === 'unlocked' && (
        <>
          <span className="dss-status-sep" aria-hidden="true">·</span>
          <span>{t('vault.count', { total: summary.total })}</span>
          {summary.lastUpdatedAt !== null && (
            <span title={summary.lastUpdatedAt}>{t('vault.lastUpdated', { time: formatDateTime(summary.lastUpdatedAt) })}</span>
          )}
        </>
      )}
      <span className="dss-status-path" title={vault.path}>{t('vault.path', { path: vault.path })}</span>
    </div>
  )
}

/** Why a locked / unreadable vault cannot be listed. */
function VaultProblem({ t, vault }: { readonly t: Translate; readonly vault: VaultStatus }): ReactNode {
  const code = vault.error?.code ?? ''
  const locked = vault.state === 'locked'
  return (
    <section className="dss-banner" data-tone={vault.state} role="alert">
      <span className="dss-banner-title">{locked ? t('locked.title') : t('error.vault.title')}</span>
      <p className="dss-banner-text">{locked ? t(LOCK_HINTS[code] ?? 'locked.generic') : t('error.hint')}</p>
      {vault.error !== undefined && <p className="dss-banner-detail">{t('detail', { message: vault.error.message })}</p>}
    </section>
  )
}

/** One metadata row. Deliberately has no value cell. */
function Row({ t, item, activeTag, onTag, onAction }: {
  readonly t: Translate
  readonly item: SecretItem
  readonly activeTag: string | undefined
  readonly onTag: (tag: string | undefined) => void
  readonly onAction: (mode: VaultSheetMode) => void
}): ReactNode {
  const times = t('cell.times', {
    created: formatDateTime(item.createdAt),
    updated: formatDateTime(item.updatedAt),
    meta: formatDateTime(item.metaUpdatedAt),
  })
  return (
    <tr>
      <td className="dss-cell-name"><code>{item.name}</code></td>
      <td className="dss-cell-desc">
        {item.description === '' ? <span className="dss-muted">{t('cell.noDescription')}</span> : item.description}
      </td>
      <td className="dss-cell-tags">
        {item.tags.length === 0
          ? <span className="dss-muted">{t('cell.noTags')}</span>
          : (
            <span className="dss-cell-tags-list">
              {item.tags.map(tag => (
                <button
                  key={tag}
                  type="button"
                  className="dss-tag"
                  data-on={tag === activeTag}
                  title={t('cell.tagFilter', { tag })}
                  onClick={() => { onTag(tag === activeTag ? undefined : tag) }}
                >
                  {tag}
                </button>
              ))}
            </span>
          )}
      </td>
      <td className="dss-cell-fp"><code>{item.fingerprint}</code></td>
      <td className="dss-cell-len">{t('cell.length', { count: item.length })}</td>
      <td className="dss-cell-time" title={times}>
        <span>{formatDateTime(item.updatedAt)}</span>
        <span className="dss-muted">{ageText(t, item.updatedAt)}</span>
      </td>
      <td className="dss-cell-actions">
        <div className="dss-row-actions">
          <button type="button" className="dss-btn dss-btn-sm" onClick={() => { onAction({ kind: 'replace', item }) }}>{t('action.replace')}</button>
          <button type="button" className="dss-btn dss-btn-sm" onClick={() => { onAction({ kind: 'edit', item }) }}>{t('action.edit')}</button>
          <button type="button" className="dss-btn dss-btn-sm" onClick={() => { onAction({ kind: 'rename', item }) }}>{t('action.rename')}</button>
          <button type="button" className="dss-btn dss-btn-sm" data-danger="true" onClick={() => { onAction({ kind: 'delete', item }) }}>{t('action.delete')}</button>
        </div>
      </td>
    </tr>
  )
}

/** The vault view. */
function VaultTab({ t, toast }: { readonly t: Translate; readonly toast: Toast }): ReactNode {
  const [sheet, setSheet] = useState<VaultSheetMode | undefined>(undefined)
  const [tag, setTag] = useState<string | undefined>(undefined)
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(queryInput.trim()) }, SEARCH_DEBOUNCE_MS)
    return () => { window.clearTimeout(timer) }
  }, [queryInput])

  const { state, reload } = useDashboard({ tag, query: query === '' ? undefined : query })
  const closeSheet = useCallback(() => { setSheet(undefined) }, [])
  const sheetDone = (message: string): void => { setSheet(undefined); toast('ok', message); reload() }
  const data = state.data
  const summary = data?.summary
  const list = data?.list
  const vault = summary?.vault
  const filtering = tag !== undefined || query !== ''

  const clear = useCallback(() => {
    setTag(undefined)
    setQueryInput('')
    setQuery('')
  }, [])

  // A selected tag stays visible as a chip even if the last secret carrying it was removed.
  const tagChips = summary === undefined ? [] : [...summary.tags]
  if (tag !== undefined && !tagChips.some(chip => chip.tag === tag)) tagChips.push({ tag, count: 0 })

  let body: ReactNode
  if (data === undefined || summary === undefined || list === undefined || vault === undefined) {
    if (state.error !== undefined && !state.busy) {
      const status = state.error.status
      const hint = status === 401 || status === 403 ? t('error.unauthorized') : status === 503 ? t('error.unavailable') : t('error.hint')
      body = (
        <div className="dss-empty" data-bad="true" role="alert">
          <span className="dss-empty-title">{t('error.title')}</span>
          <span className="dss-empty-hint">{hint}</span>
          <span className="dss-empty-hint">{t('detail', { message: state.error.message })}</span>
          <button type="button" className="dss-btn" data-primary="true" onClick={reload}>{t('retry')}</button>
        </div>
      )
    } else {
      body = <div className="dss-empty"><span className="dss-empty-hint">{t('loading')}</span></div>
    }
  } else if (vault.state === 'locked' || vault.state === 'error') {
    body = <VaultProblem t={t} vault={vault} />
  } else if (vault.state === 'missing') {
    body = (
      <div className="dss-empty">
        <span className="dss-empty-title">{t('empty.missing.title')}</span>
        <span className="dss-empty-hint">{t('empty.missing.hint')}</span>
        <button type="button" className="dss-btn" data-primary="true" onClick={() => { setSheet({ kind: 'create' }) }}>{t('action.new')}</button>
      </div>
    )
  } else if (list.total === 0) {
    body = (
      <div className="dss-empty">
        <span className="dss-empty-title">{t('empty.vault.title')}</span>
        <span className="dss-empty-hint">{t('empty.vault.hint')}</span>
        <button type="button" className="dss-btn" data-primary="true" onClick={() => { setSheet({ kind: 'create' }) }}>{t('action.new')}</button>
      </div>
    )
  } else {
    body = (
      <>
        <div className="dss-toolbar">
          <input
            className="dss-search"
            type="search"
            value={queryInput}
            placeholder={t('filter.search')}
            aria-label={t('filter.search.aria')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => { setQueryInput(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Escape') setQueryInput('') }}
          />
          <div className="dss-tags-row" role="group" aria-label={t('filter.tags.aria')}>
            <button type="button" className="dss-filter" data-on={tag === undefined} onClick={() => { setTag(undefined) }}>
              {t('filter.all')}<span className="dss-filter-count">{summary.total}</span>
            </button>
            {tagChips.map(chip => (
              <button
                key={chip.tag}
                type="button"
                className="dss-filter"
                data-on={chip.tag === tag}
                onClick={() => { setTag(chip.tag === tag ? undefined : chip.tag) }}
              >
                {chip.tag}<span className="dss-filter-count">{chip.count}</span>
              </button>
            ))}
          </div>
          <div className="dss-toolbar-foot">
            <span>{t('filter.matched', { matched: list.matched, total: list.total })}</span>
            {summary.untagged > 0 && <span>{t('filter.untagged', { count: summary.untagged })}</span>}
            {filtering && <button type="button" className="dss-link" onClick={clear}>{t('filter.clear')}</button>}
          </div>
        </div>
        {list.items.length === 0
          ? (
            <div className="dss-empty">
              <span className="dss-empty-title">{t('empty.filter.title')}</span>
              <span className="dss-empty-hint">{t('empty.filter.hint')}</span>
              <button type="button" className="dss-btn" onClick={clear}>{t('filter.clear')}</button>
            </div>
          )
          : (
            <div className="dss-table-wrap">
              <table className="dss-table">
                <thead>
                  <tr>
                    <th scope="col">{t('col.name')}</th>
                    <th scope="col">{t('col.description')}</th>
                    <th scope="col">{t('col.tags')}</th>
                    <th scope="col">{t('col.fingerprint')}</th>
                    <th scope="col">{t('col.length')}</th>
                    <th scope="col">{t('col.updated')}</th>
                    <th scope="col"><span className="dss-sr">{t('col.actions')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map(item => <Row key={item.name} t={t} item={item} activeTag={tag} onTag={setTag} onAction={setSheet} />)}
                </tbody>
              </table>
            </div>
          )}
      </>
    )
  }

  const canWrite = vault !== undefined && vault.state !== 'locked' && vault.state !== 'error'
  return (
    <section className="dss-section">
      <div className="dss-section-head">
        <div className="dss-head-text">
          <h2 className="dss-section-title">{t('tab.vault')}</h2>
          {vault !== undefined && summary !== undefined && <VaultLine t={t} vault={vault} summary={summary} />}
        </div>
        <div className="dss-head-actions">
          {data !== undefined && <span className="dss-updated">{t('updatedAt', { time: formatClock(data.list.generatedAt) })}</span>}
          <button type="button" className="dss-btn" disabled={state.busy} onClick={reload}>
            {state.busy && data !== undefined ? t('refreshing') : t('refresh')}
          </button>
          {canWrite && <button type="button" className="dss-btn" data-primary="true" onClick={() => { setSheet({ kind: 'create' }) }}>{t('action.new')}</button>}
        </div>
      </div>
      {data !== undefined && state.error !== undefined && (
        <section className="dss-banner" data-tone="error" role="status">
          <p className="dss-banner-text">{t('stale', { message: state.error.message, time: formatClock(data.list.generatedAt) })}</p>
        </section>
      )}
      {body}
      {sheet !== undefined && <VaultSheet t={t} mode={sheet} onClose={closeSheet} onDone={sheetDone} />}
    </section>
  )
}

/** Remembered view (per browser; a convenience, so failures are ignored). */
function initialTab(): Tab {
  try {
    const saved = window.localStorage.getItem(TAB_KEY)
    if (saved !== null && (TABS as readonly string[]).includes(saved)) return saved as Tab
  } catch { /* storage blocked */ }
  return 'vault'
}

/**
 * Draw the page.
 * @param props - the injected translate function.
 */
export function SecretsPage({ t }: SecretsPageProps): ReactNode {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [toastState, setToastState] = useState<{ tone: 'ok' | 'bad'; text: string; id: number } | undefined>(undefined)
  const toastId = useRef(0)

  const choose = (next: Tab): void => {
    setTab(next)
    try { window.localStorage.setItem(TAB_KEY, next) } catch { /* storage blocked */ }
  }
  const toast = useCallback<Toast>((tone, text) => {
    toastId.current += 1
    setToastState({ tone, text, id: toastId.current })
  }, [])
  useEffect(() => {
    if (toastState === undefined) return undefined
    const timer = window.setTimeout(() => { setToastState(undefined) }, 3200)
    return () => { window.clearTimeout(timer) }
  }, [toastState])

  return (
    <div className="dss-page">
      <div className="dss-col">
        <header className="dss-head">
          <div className="dss-head-text">
            <h1 className="dss-title">{t('page.title')}</h1>
            <p className="dss-sub">{t('page.subtitle')}</p>
          </div>
        </header>
        <div className="dss-segmented" role="tablist" aria-label={t('tab.aria')}>
          {TABS.map(name => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              className="dss-segment"
              data-on={tab === name}
              onClick={() => { choose(name) }}
            >
              {t(`tab.${name}`)}
            </button>
          ))}
        </div>
        {tab === 'vault' && <Notice t={t} />}
        {tab === 'vault' && <VaultTab t={t} toast={toast} />}
        {tab === 'credentials' && <CredentialsTab t={t} toast={toast} />}
        {tab === 'plugins' && <PluginsTab t={t} toast={toast} />}
      </div>
      {toastState !== undefined && (
        <Layer><div className="dss-toast" data-tone={toastState.tone} role="status" key={toastState.id}>{toastState.text}</div></Layer>
      )}
    </div>
  )
}
