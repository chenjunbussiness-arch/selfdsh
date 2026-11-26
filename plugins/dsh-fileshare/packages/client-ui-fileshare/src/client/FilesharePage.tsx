/**
 * The 文件中转 page: create a download or upload link, copy it, see links
 * and what arrived on upload links, revoke.
 *
 * Full URLs exist only in the answer to the create call (the host stores token
 * hashes), so the page keeps the ones it created in memory and can copy those;
 * links made by agents show without a copy button.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { MessageKey, Translate } from './locales.ts'
import { createDownload, createUpload, fetchOverview, revoke } from './source.ts'
import type { Created, LinkView, Overview } from './source.ts'

export interface FilesharePageProps {
  readonly t: Translate
}

const DOWNLOAD_TTLS = [15, 60, 1440, 10080] as const
const UPLOAD_TTLS = [30, 120, 1440] as const
const UPLOAD_SIZES = [100, 512, 2048] as const

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function fullUrl(created: Created): string {
  return created.url ?? created.path
}

function CopyButton({ text, t, label }: { readonly text: string; readonly t: Translate; readonly label?: string }): ReactNode {
  const [done, setDone] = useState(false)
  const copy = (): void => {
    void navigator.clipboard?.writeText(text).then(() => {
      setDone(true)
      window.setTimeout(() => setDone(false), 1600)
    })
  }
  return (
    <button type="button" className="dsf-btn dsf-btn-sm" onClick={copy}>
      {done ? t('created.copied') : (label ?? t('created.copy'))}
    </button>
  )
}

function CreatedBox({ created, t }: { readonly created: Created; readonly t: Translate }): ReactNode {
  const text = fullUrl(created)
  return (
    <div className="dsf-created" role="status">
      <span className="dsf-created-title">{created.url === null ? t('created.pathOnly') : t('created.title')}</span>
      <div className="dsf-created-url">
        <span className="dsf-mono">{text}</span>
        <CopyButton text={text} t={t} />
        {created.url !== null && created.kind === 'upload' ? (
          <a className="dsf-btn dsf-btn-sm" href={created.url} target="_blank" rel="noreferrer noopener">{t('created.open')}</a>
        ) : null}
      </div>
      <span className="dsf-created-note">{t('created.once')}</span>
    </div>
  )
}

export function FilesharePage({ t }: FilesharePageProps): ReactNode {
  const [overview, setOverview] = useState<Overview | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [filter, setFilter] = useState<'active' | 'all'>('active')
  const [urls, setUrls] = useState<Record<string, string>>({})

  const [path, setPath] = useState('')
  const [shareTtl, setShareTtl] = useState<number>(60)
  const [shareLimit, setShareLimit] = useState<number>(0)
  const [shareResult, setShareResult] = useState<Created | undefined>(undefined)
  const [shareError, setShareError] = useState<string | undefined>(undefined)

  const [dir, setDir] = useState('')
  const [uploadTtl, setUploadTtl] = useState<number>(30)
  const [uploadMb, setUploadMb] = useState<number>(512)
  const [uploadResult, setUploadResult] = useState<Created | undefined>(undefined)
  const [uploadError, setUploadError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const inflight = useRef<AbortController | null>(null)

  const load = useCallback(() => {
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    fetchOverview(controller.signal).then(
      (next) => { setOverview(next); setLoadError(undefined) },
      (error: unknown) => { if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : String(error)) },
    )
  }, [])

  useEffect(() => {
    load()
    const timer = window.setInterval(load, 15000)
    return () => { window.clearInterval(timer); inflight.current?.abort() }
  }, [load])

  const remember = (created: Created): void => {
    setUrls(previous => ({ ...previous, [created.id]: fullUrl(created) }))
  }

  const onShare = async (): Promise<void> => {
    setBusy(true)
    setShareError(undefined)
    try {
      const created = await createDownload({ path: path.trim(), ttlMinutes: shareTtl, ...(shareLimit > 0 ? { maxDownloads: shareLimit } : {}) })
      setShareResult(created)
      remember(created)
      load()
    } catch (error) {
      setShareError(t('error.action', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  const onReceive = async (): Promise<void> => {
    setBusy(true)
    setUploadError(undefined)
    try {
      const created = await createUpload({ ...(dir.trim() !== '' ? { dir: dir.trim() } : {}), ttlMinutes: uploadTtl, maxMb: uploadMb })
      setUploadResult(created)
      remember(created)
      load()
    } catch (error) {
      setUploadError(t('error.action', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  const onRevoke = async (id: string): Promise<void> => {
    try {
      await revoke(id)
    } catch (error) {
      setLoadError(t('error.action', { message: error instanceof Error ? error.message : String(error) }))
    }
    load()
  }

  const links = (overview?.links ?? []).filter(link => filter === 'all' || link.state === 'active')
  const base = overview?.base ?? null

  return (
    <div className="dsf-page">
      <div className="dsf-col">
        <header className="dsf-head">
          <div>
            <h1 className="dsf-title">{t('page.title')}</h1>
            <p className="dsf-sub">{t('page.subtitle')}</p>
          </div>
          <button type="button" className="dsf-btn" onClick={load}>{t('page.refresh')}</button>
        </header>

        {overview !== undefined ? (
          <div className="dsf-base" data-missing={base === null ? 'true' : 'false'}>
            {base === null
              ? <span>{t('base.none')}</span>
              : (
                  <>
                    <span>{t('base.label')}</span>
                    <b className="dsf-mono">{base}</b>
                    <span>{t(overview.baseSource === 'config' ? 'base.config' : 'base.browser')}</span>
                  </>
                )}
          </div>
        ) : null}
        {loadError !== undefined ? <div className="dsf-error">{t('error.load', { message: loadError })}</div> : null}

        <div className="dsf-cards">
          <section className="dsf-card">
            <h2 className="dsf-card-title">{t('share.title')}</h2>
            <p className="dsf-card-sub">{t('share.sub')}</p>
            <label className="dsf-field">
              <span className="dsf-label">{t('share.path')}</span>
              <input className="dsf-input" value={path} placeholder="/srv/project/out/report.zip" onChange={event => setPath(event.target.value)} />
              <span className="dsf-hint">{t('share.path.hint')}</span>
            </label>
            <div className="dsf-row">
              <label className="dsf-field">
                <span className="dsf-label">{t('share.ttl')}</span>
                <select className="dsf-select" value={shareTtl} onChange={event => setShareTtl(Number(event.target.value))}>
                  {DOWNLOAD_TTLS.map(value => <option key={value} value={value}>{t(`ttl.${value}` as MessageKey)}</option>)}
                </select>
              </label>
              <label className="dsf-field">
                <span className="dsf-label">{t('share.limit')}</span>
                <select className="dsf-select" value={shareLimit} onChange={event => setShareLimit(Number(event.target.value))}>
                  <option value={0}>{t('share.limit.none')}</option>
                  <option value={1}>{t('share.limit.one')}</option>
                  <option value={5}>{t('share.limit.five')}</option>
                </select>
              </label>
            </div>
            <button type="button" className="dsf-btn" data-primary="true" disabled={busy || path.trim() === ''} onClick={() => { void onShare() }}>{t('share.submit')}</button>
            {shareError !== undefined ? <div className="dsf-error">{shareError}</div> : null}
            {shareResult !== undefined ? <CreatedBox created={shareResult} t={t} /> : null}
          </section>

          <section className="dsf-card">
            <h2 className="dsf-card-title">{t('receive.title')}</h2>
            <p className="dsf-card-sub">{t('receive.sub')}</p>
            <label className="dsf-field">
              <span className="dsf-label">{t('receive.dir')}</span>
              <input className="dsf-input" value={dir} placeholder={overview?.defaults.inboxDir ?? ''} onChange={event => setDir(event.target.value)} />
              <span className="dsf-hint">{t('receive.dir.hint', { inbox: overview?.defaults.inboxDir ?? '' })}</span>
            </label>
            <div className="dsf-row">
              <label className="dsf-field">
                <span className="dsf-label">{t('share.ttl')}</span>
                <select className="dsf-select" value={uploadTtl} onChange={event => setUploadTtl(Number(event.target.value))}>
                  {UPLOAD_TTLS.map(value => <option key={value} value={value}>{t(`ttl.${value}` as MessageKey)}</option>)}
                </select>
              </label>
              <label className="dsf-field">
                <span className="dsf-label">{t('receive.size')}</span>
                <select className="dsf-select" value={uploadMb} onChange={event => setUploadMb(Number(event.target.value))}>
                  {UPLOAD_SIZES.map(value => <option key={value} value={value}>{value >= 1024 ? `${value / 1024} GB` : `${value} MB`}</option>)}
                </select>
              </label>
            </div>
            <button type="button" className="dsf-btn" data-primary="true" disabled={busy} onClick={() => { void onReceive() }}>{t('receive.submit')}</button>
            {uploadError !== undefined ? <div className="dsf-error">{uploadError}</div> : null}
            {uploadResult !== undefined ? <CreatedBox created={uploadResult} t={t} /> : null}
          </section>
        </div>

        <section className="dsf-section">
          <div className="dsf-section-head">
            <h2 className="dsf-section-title">{t('list.title')}</h2>
            <div className="dsf-segmented" role="tablist">
              <button type="button" role="tab" className="dsf-segment" data-on={filter === 'active' ? 'true' : 'false'} onClick={() => setFilter('active')}>{t('list.active')}</button>
              <button type="button" role="tab" className="dsf-segment" data-on={filter === 'all' ? 'true' : 'false'} onClick={() => setFilter('all')}>{t('list.all')}</button>
            </div>
          </div>
          {links.length === 0
            ? <div className="dsf-empty">{t('list.empty')}</div>
            : (
                <div className="dsf-list">
                  {links.map(link => <LinkRow key={link.id} link={link} url={urls[link.id]} t={t} onRevoke={onRevoke} />)}
                </div>
              )}
        </section>

        {overview !== undefined ? (
          <section className="dsf-section">
            <h2 className="dsf-section-title">{t('roots.title')}</h2>
            {overview.roots.length === 0
              ? <div className="dsf-empty">{t('roots.none')}</div>
              : <div className="dsf-roots">{overview.roots.map(root => <span key={root} className="dsf-mono">{root}</span>)}</div>}
          </section>
        ) : null}
      </div>
    </div>
  )
}

function LinkRow({ link, url, t, onRevoke }: { readonly link: LinkView; readonly url: string | undefined; readonly t: Translate; readonly onRevoke: (id: string) => Promise<void> }): ReactNode {
  const ended = link.state !== 'active'
  const usage = link.kind === 'download'
    ? (link.maxDownloads !== null && link.maxDownloads !== undefined
        ? t('list.downloadsOf', { count: link.downloads ?? 0, max: link.maxDownloads })
        : t('list.downloads', { count: link.downloads ?? 0 }))
    : t('list.received', { count: link.files?.length ?? 0, max: link.maxFiles ?? 0, size: formatBytes(link.receivedBytes ?? 0) })
  return (
    <div className="dsf-item">
      <span className="dsf-kind" data-kind={link.kind}>{t(link.kind === 'download' ? 'list.kind.download' : 'list.kind.upload')}</span>
      <div className="dsf-item-main">
        <span className="dsf-item-name" title={link.path}>{link.name}{link.size !== undefined ? ` · ${formatBytes(link.size)}` : ''}</span>
        <span className="dsf-item-meta">
          <span className="dsf-state" data-state={link.state}>{t(`list.state.${link.state}` as MessageKey)}</span>
          <span>{ended ? t('list.ended', { time: formatTime(link.revokedAt ?? link.expiresAt) }) : t('list.expires', { time: formatTime(link.expiresAt) })}</span>
          <span>{usage}</span>
          <span>{t(link.by === 'page' ? 'list.by.page' : 'list.by.agent')}</span>
          {link.note !== undefined ? <span>{link.note}</span> : null}
        </span>
      </div>
      <div className="dsf-item-actions">
        {url !== undefined && !ended ? <CopyButton text={url} t={t} label={t('list.copy')} /> : null}
        {!ended ? <button type="button" className="dsf-btn dsf-btn-sm" data-danger="true" onClick={() => { void onRevoke(link.id) }}>{t('list.revoke')}</button> : null}
      </div>
      {link.kind === 'upload' && (link.files?.length ?? 0) > 0 ? (
        <div className="dsf-files">
          {link.files?.map(file => <span key={`${file.name}-${file.at}`} className="dsf-mono">{file.name} · {formatBytes(file.size)}</span>)}
        </div>
      ) : null}
    </div>
  )
}
