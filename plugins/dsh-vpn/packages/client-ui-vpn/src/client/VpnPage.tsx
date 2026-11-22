/**
 * The VPN page: profile list on the left; status card, form and log on the right.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

import type { ProfileType, ProfileView, StatusView } from './contract.ts'
import type { VpnController } from './controller.ts'
import { formatClock, formatUptime } from './format.ts'
import type { Translate } from './locales.ts'
import { ProfileForm, blankForm, formFrom } from './ProfileForm.tsx'
import type { FormState } from './ProfileForm.tsx'
import { VpnIcon } from './VpnIcon.tsx'

/** Props of the page. `initialEdit` exists for the preview. */
export interface VpnPageProps {
  readonly controller: VpnController
  readonly t: Translate
  readonly initialEdit?: { readonly mode: 'new'; readonly type: ProfileType } | { readonly mode: 'edit'; readonly id: string }
}

/** Seconds since `iso`, ticking once a second while connected. */
function useUptime(status: StatusView | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now())
  const live = status?.status === 'connected'
  useEffect(() => {
    if (!live) return undefined
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [live])
  if (!live || status?.connectedAt === undefined) return status?.uptimeSeconds
  const since = Date.parse(status.connectedAt)
  return Number.isFinite(since) ? Math.max(0, Math.round((now - since) / 1000)) : status.uptimeSeconds
}

/** Draw the page. */
export function VpnPage({ controller, t, initialEdit }: VpnPageProps): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const snapshot = state.snapshot
  const status = snapshot?.status
  const profiles = snapshot?.profiles ?? []
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [editing, setEditing] = useState<FormState | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>()
  const seeded = useRef(false)

  useEffect(() => {
    controller.start()
    return () => { controller.dispose() }
  }, [controller])

  // First data: select the active profile (or the first), and open the preview's requested form once.
  useEffect(() => {
    if (snapshot === undefined) return
    if (selectedId === undefined || !profiles.some(profile => profile.id === selectedId)) {
      setSelectedId(snapshot.status.profileId ?? profiles[0]?.id)
    }
    if (!seeded.current && initialEdit !== undefined) {
      seeded.current = true
      if (initialEdit.mode === 'new') setEditing(blankForm(initialEdit.type))
      else {
        const target = profiles.find(profile => profile.id === initialEdit.id)
        if (target !== undefined) setEditing(formFrom(target))
      }
    }
  }, [snapshot, profiles, selectedId, initialEdit])

  const selected = useMemo(() => profiles.find(profile => profile.id === selectedId), [profiles, selectedId])
  const uptime = useUptime(status)
  const current = status?.status ?? 'disconnected'
  const running = current === 'connecting' || current === 'connected'
  const install = status?.install
  const blockedByInstall = selected !== undefined && selected.type !== 'custom' && install !== undefined && (!install.installed || (selected.type === 'token-url' && !install.cookieSupport))
  // Why 连接 is greyed out, in words: a disabled button alone does not say what to fix.
  const connectBlocker = selected === undefined
    ? t('connect.noProfile')
    : !selected.secretConfigured && selected.type !== 'custom'
      ? t(selected.type === 'token-url' ? 'connect.noUrl' : 'connect.noPassword')
      : blockedByInstall
        ? t(install?.installed === true ? 'connect.oldClient' : 'connect.noClient')
        : undefined
  const [copied, setCopied] = useState(false)

  const run = async (action: () => Promise<string | undefined>): Promise<void> => {
    setActionError(undefined)
    const message = await action()
    if (message !== undefined) setActionError(message)
  }

  const logRef = useRef<HTMLDivElement | null>(null)
  // Follow new lines only while the reader is at the bottom; scrolling up to read
  // an older line must not be yanked back down by the next poll.
  const following = useRef(true)
  const lastLog = snapshot?.logs[snapshot.logs.length - 1]?.t
  useEffect(() => {
    const element = logRef.current
    if (element !== null && following.current) element.scrollTop = element.scrollHeight
  }, [lastLog])

  const logCount = snapshot?.logs.length ?? 0

  return (
    <div className="dshv-root">
      <div className="dshv-page">
        <aside className="dshv-rail" aria-label={t('profiles.title')}>
          <div className="dshv-rail-head"><span className="dshv-rail-title">{t('profiles.title')}</span></div>
          <div className="dshv-rail-scroll">
            {profiles.length === 0 && (
              <div className="dshv-empty dshv-rail-empty">
                <span className="dshv-empty-icon"><VpnIcon size={22} /></span>
                <span>{t('profiles.empty')}</span>
              </div>
            )}
            {profiles.map((profile) => {
              const isActive = status?.profileId === profile.id && current !== 'disconnected'
              return (
                <button
                  key={profile.id} type="button" className="dshv-profile" data-on={profile.id === selectedId}
                  data-tone={isActive ? current : undefined} onClick={() => { setSelectedId(profile.id); setEditing(undefined) }}
                >
                  <span className="dshv-profile-dot" aria-hidden="true" />
                  <span className="dshv-profile-main">
                    <span className="dshv-profile-name">{profile.name}</span>
                    <span className="dshv-profile-sub" data-warn={!profile.secretConfigured && profile.type !== 'custom'}>
                      {!profile.secretConfigured && profile.type !== 'custom'
                        ? t('profiles.secret.missing')
                        : `${t(`type.${profile.type}` as 'type.password')} · ${t('profiles.targets', { count: profile.targets.length })}`}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
          <div className="dshv-rail-foot">
            <button type="button" className="dshv-new" onClick={() => { setEditing(blankForm('password')) }}>
              <span className="dshv-new-icon" aria-hidden="true">＋</span>{t('action.new')}
            </button>
          </div>
        </aside>

        <main className="dshv-main">
          <div className="dshv-col">
            <header className="dshv-head">
              <div className="dshv-head-row">
                <h1 className="dshv-title">{t('page.title')}</h1>
                {snapshot?.origin === 'mock' && <span className="dshv-badge" title={t('badge.mock.hint')}>{t('badge.mock')}</span>}
              </div>
              <p className="dshv-sub">{t('page.subtitle')}</p>
              {snapshot?.staleSince !== undefined && snapshot.origin === 'mock' && <p className="dshv-note">{t('badge.mock.hint')}</p>}
              {state.error !== undefined && <p className="dshv-form-error" role="alert">{t('load.error', { message: state.error })}</p>}
            </header>

            {status === undefined && <p className="dshv-empty" role="status">{t('load.loading')}</p>}

            {status !== undefined && (
              <section className="dshv-card" data-tone={current} aria-live="polite">
                <div className="dshv-card-top">
                  <span className="dshv-orb" aria-hidden="true" />
                  <div className="dshv-card-text">
                    <p className="dshv-state">{t(`state.${current}` as 'state.connected')}</p>
                    <p className="dshv-card-sub">
                      {running || current === 'failed'
                        ? (status.profileName ?? selected?.name ?? '')
                        : (selected?.name ?? t(`state.${current}.hint` as 'state.connected.hint'))}
                      {(running || current === 'failed') && ` · ${t(`state.${current}.hint` as 'state.connected.hint')}`}
                    </p>
                  </div>
                  <div className="dshv-card-actions">
                    {selected !== undefined && !running && (
                      <button type="button" className="dshv-btn" onClick={() => { setEditing(formFrom(selected)) }}>{t('action.edit')}</button>
                    )}
                    {running
                      ? (
                        <button type="button" className="dshv-btn" data-kind="danger" disabled={state.busy} onClick={() => { void run(() => controller.disconnect()) }}>
                          {state.busy ? t('action.disconnecting') : t('action.disconnect')}
                        </button>
                      )
                      : (
                        <button
                          type="button" className="dshv-btn" data-kind="primary"
                          disabled={state.busy || connectBlocker !== undefined}
                          title={connectBlocker}
                          onClick={() => { if (selected !== undefined) void run(() => controller.connect(selected.id)) }}
                        >
                          {state.busy ? t('action.connecting') : selected === undefined ? t('action.connect') : t('action.connect.profile', { name: selected.name })}
                        </button>
                      )}
                  </div>
                </div>

                <div className="dshv-card-msgs">
                  {!running && connectBlocker !== undefined && selected !== undefined && <p className="dshv-hint">{connectBlocker}</p>}
                  {actionError !== undefined && <p className="dshv-form-error" role="alert">{t('action.failed', { message: actionError })}</p>}

                  {current === 'failed' && status.error !== undefined && (
                    <div className="dshv-alert" role="alert"><span className="dshv-alert-title">{status.error}</span></div>
                  )}

                  {install !== undefined && !install.installed && (
                    <div className="dshv-alert" data-kind="warn">
                      <span className="dshv-alert-title">{t('install.missing.title')}</span>
                      <span>{t('install.missing.body')}</span>
                      <div className="dshv-alert-row">
                        <pre>{install.hint}</pre>
                        <button type="button" className="dshv-btn" data-size="sm" onClick={() => { void navigator.clipboard?.writeText(install.hint).then(() => { setCopied(true); setTimeout(() => { setCopied(false) }, 1500) }, () => undefined) }}>{t(copied ? 'install.copied' : 'install.copy')}</button>
                      </div>
                    </div>
                  )}
                  {install?.installed === true && !install.cookieSupport && selected?.type === 'token-url' && (
                    <div className="dshv-alert" data-kind="warn">{t('install.old', { version: install.version })}</div>
                  )}
                  {install?.installed === true && !install.pppd && <div className="dshv-alert" data-kind="warn">{t('install.pppd')}</div>}
                </div>

                <div className="dshv-stats">
                  <div className="dshv-stat"><span className="dshv-stat-label">{t('stat.ip')}</span><span className="dshv-stat-value">{status.ip ?? t('stat.none')}</span></div>
                  <div className="dshv-stat"><span className="dshv-stat-label">{t('stat.iface')}</span><span className="dshv-stat-value">{status.iface ?? t('stat.none')}</span></div>
                  <div className="dshv-stat"><span className="dshv-stat-label">{t('stat.uptime')}</span><span className="dshv-stat-value">{uptime === undefined ? t('stat.none') : formatUptime(uptime)}</span></div>
                  <div className="dshv-stat"><span className="dshv-stat-label">{t('stat.pid')}</span><span className="dshv-stat-value">{status.pid === undefined ? t('stat.none') : String(status.pid)}</span></div>
                </div>

                <div className="dshv-block">
                  <span className="dshv-block-title">{t('routes.title')}</span>
                  <div className="dshv-chips">
                    {status.routes.length === 0
                      ? <span className="dshv-chip" data-quiet="true">{t('routes.none')}</span>
                      : status.routes.map(route => <span key={route} className="dshv-chip">{route}</span>)}
                  </div>
                </div>

                <div className="dshv-watch" data-state={status.watchdog.state}>
                  <span className="dshv-watch-dot" aria-hidden="true" />
                  <span>
                    <b className="dshv-watch-title">{t('watchdog.title')}</b>{' · '}
                    {status.watchdog.state === 'watching'
                      ? t('watchdog.watching', { seconds: status.watchdog.secondsLeft ?? 0 })
                      : status.watchdog.state === 'tripped'
                        ? t('watchdog.tripped', { reason: status.watchdog.reason ?? '' })
                        : t(`watchdog.${status.watchdog.state}` as 'watchdog.idle')}
                  </span>
                </div>
              </section>
            )}

            {editing !== undefined && (
              <ProfileForm
                key={editing.id ?? `new-${editing.type}`}
                t={t}
                initial={editing}
                allowCustom={status?.allowCustom === true}
                busy={state.busy}
                onCancel={() => { setEditing(undefined) }}
                onSave={async (input) => {
                  const message = await controller.save(input)
                  if (message === undefined) setEditing(undefined)
                  return message
                }}
                {...editing.id === undefined ? {} : {
                  onDelete: async () => {
                    const message = await controller.remove(editing.id ?? '')
                    if (message === undefined) { setEditing(undefined); setSelectedId(undefined) }
                    return message
                  },
                }}
              />
            )}

            <section className="dshv-log">
              <div className="dshv-log-head">
                <span className="dshv-block-title">{t('logs.title')}</span>
                <span className="dshv-hint">{t('logs.hint', { count: 200 })}</span>
              </div>
              <div
                className="dshv-log-body" ref={logRef} role="log" aria-live="off" aria-label={t('logs.title')}
                tabIndex={0} data-empty={logCount === 0}
                onScroll={(event) => {
                  const element = event.currentTarget
                  following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
                }}
              >
                {logCount === 0
                  ? <span className="dshv-log-empty">{t('logs.empty')}</span>
                  : snapshot?.logs.map((line, index) => (
                    <div key={`${line.t}-${String(index)}`} className="dshv-log-line" data-level={line.level}>
                      <span className="dshv-log-time">{formatClock(line.t)}</span>
                      <span>{line.text}</span>
                    </div>
                  ))}
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  )
}

export type { ProfileView }
