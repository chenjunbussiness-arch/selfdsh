/**
 * Light and dark for the board and the workspace page.
 *
 * The person picks 跟随系统 (default), 白天 or 黑夜 in the panel header. The
 * choice is a per-browser convenience kept in `localStorage`; reading or writing
 * it never throws (private windows, blocked storage), and without it the panel
 * follows the system.
 *
 * "System" means: the host shell's own dark switch when it sets one
 * (`body[data-ds-dark-theme]`), otherwise the operating system's
 * `prefers-color-scheme`. Both are watched, so flipping either repaints at once.
 *
 * The effective theme is written as `data-theme="light|dark"` on the panel root;
 * every colour in the stylesheet hangs off that attribute (see BOARD_TOKENS_CSS).
 *
 * @module client-ui-router/theme
 */

import { useEffect, useState } from 'react'

/** What the person chose. */
export type ThemePref = 'auto' | 'light' | 'dark'
/** What is painted. */
export type ThemeMode = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'dshr.theme'

const listeners = new Set<() => void>()

/** The stored choice; `auto` when absent, unreadable or unknown. */
export function readThemePref(): ThemePref {
  try {
    const value = globalThis.localStorage?.getItem(THEME_STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : 'auto'
  } catch {
    return 'auto'
  }
}

/** Store a choice and tell every mounted panel. */
export function writeThemePref(pref: ThemePref): void {
  try {
    if (pref === 'auto') globalThis.localStorage?.removeItem(THEME_STORAGE_KEY)
    else globalThis.localStorage?.setItem(THEME_STORAGE_KEY, pref)
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
  memoryPref = pref
  for (const listener of listeners) listener()
}

let memoryPref: ThemePref | undefined

/** The system's mode: the host's dark switch when present, else the OS preference. */
export function systemMode(): ThemeMode {
  if (typeof document !== 'undefined' && document.body?.hasAttribute('data-ds-dark-theme') === true) return 'dark'
  try {
    if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
  } catch {
    // No media queries (tests, old shells): light.
  }
  return 'light'
}

/** Resolve a choice to what is painted. */
export const resolveTheme = (pref: ThemePref, system: ThemeMode): ThemeMode => pref === 'auto' ? system : pref

/**
 * The panel's theme: the stored choice, the mode it resolves to, and a setter.
 * Re-renders when the choice changes in another panel or the system flips.
 */
export function useBoardTheme(): { pref: ThemePref; mode: ThemeMode; setPref: (pref: ThemePref) => void } {
  const [pref, setPrefState] = useState<ThemePref>(() => memoryPref ?? readThemePref())
  const [system, setSystem] = useState<ThemeMode>(systemMode)

  useEffect(() => {
    const onPref = (): void => { setPrefState(memoryPref ?? readThemePref()) }
    listeners.add(onPref)
    const onSystem = (): void => { setSystem(systemMode()) }
    let media: MediaQueryList | undefined
    try { media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined } catch { media = undefined }
    media?.addEventListener?.('change', onSystem)
    let observer: MutationObserver | undefined
    if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.body !== null) {
      observer = new MutationObserver(onSystem)
      observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    }
    return () => {
      listeners.delete(onPref)
      media?.removeEventListener?.('change', onSystem)
      observer?.disconnect()
    }
  }, [])

  return { pref, mode: resolveTheme(pref, system), setPref: writeThemePref }
}

const ORDER: readonly ThemePref[] = ['auto', 'light', 'dark']

/** Sun, moon, and a half disc for "system". 16px, stroke icons. */
const ICON: Readonly<Record<ThemePref, string>> = {
  auto: 'M8 2.5a5.5 5.5 0 1 0 0 11zM8 2.5a5.5 5.5 0 0 1 0 11',
  light: 'M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1',
  dark: 'M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6z',
}

/**
 * One icon button that cycles 跟随系统 → 白天 → 黑夜. Its tooltip names the
 * current choice and the next one.
 */
export function ThemeButton({ pref, setPref, t, className }: {
  readonly pref: ThemePref
  readonly setPref: (pref: ThemePref) => void
  readonly t: (key: string, values?: Record<string, string | number>) => string
  readonly className: string
}) {
  const next = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length]!
  const label = t('theme.now', { now: t(`theme.${pref}`), next: t(`theme.${next}`) })
  return (
    <button type="button" className={className} data-theme-pref={pref} title={label} aria-label={label}
      onClick={() => { setPref(next) }}>
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d={ICON[pref]} fill={pref === 'auto' ? 'none' : undefined} />
        {pref === 'auto' && <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />}
      </svg>
    </button>
  )
}
