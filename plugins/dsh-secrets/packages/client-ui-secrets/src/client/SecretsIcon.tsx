/**
 * Glyphs of the secrets page: the Sidebar row icon (a key) and the lock used
 * in the read-only notice.
 *
 * @module client-ui-secrets/icon
 */

import type { ReactNode } from 'react'

/** Props the `sidebar.panellist` list slot passes to a row glyph. */
export interface SecretsIconProps {
  readonly size?: number
  readonly active?: boolean
}

/** Sidebar row glyph: a key. */
export function SecretsIcon({ size = 18, active = false }: SecretsIconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true" style={{ opacity: active ? 1 : 0.72 }}>
      <circle cx="6" cy="9" r="3.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9.4 9h6.2M13.4 9v2.6M15.6 9v1.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Notice glyph: a closed padlock. */
export function LockIcon({ size = 18 }: { readonly size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="3.5" y="8" width="11" height="7.5" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 8V5.8a3 3 0 0 1 6 0V8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="9" cy="11.6" r="1.1" fill="currentColor" />
    </svg>
  )
}
