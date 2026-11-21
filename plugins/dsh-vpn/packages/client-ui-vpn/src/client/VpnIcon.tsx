/**
 * Nav-row glyph for the VPN page: a shield with a keyhole.
 *
 * @module client-ui-vpn/icon
 */

import type { ReactNode } from 'react'

/** Props the `sidebar.panellist` list slot passes to a row glyph. */
export interface VpnIconProps {
  readonly size?: number
  readonly active?: boolean
}

/** Draw the glyph. */
export function VpnIcon({ size = 18, active = false }: VpnIconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true" style={{ opacity: active ? 1 : 0.72 }}>
      <path d="M9 1.8 14.6 4v4.6c0 3.3-2.3 5.7-5.6 7.3C5.700 14.300 3.400 11.900 3.400 8.600V4z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="9" cy="7.700" r="1.500" fill="currentColor" />
      <path d="M9 9.200v2.400" stroke="currentColor" strokeWidth="1.400" strokeLinecap="round" />
    </svg>
  )
}
