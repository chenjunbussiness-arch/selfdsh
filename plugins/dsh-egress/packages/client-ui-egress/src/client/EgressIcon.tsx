/**
 * Nav-row glyph for the Egress page: one source branching into three exits.
 */

import type { ReactNode } from 'react'

/** Props the `sidebar.panellist` list slot passes to a row glyph. */
export interface EgressIconProps {
  readonly size?: number
  readonly active?: boolean
}

/**
 * Draw the glyph.
 * @param props - render props from the slot.
 */
export function EgressIcon({ size = 18, active = false }: EgressIconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true" style={{ opacity: active ? 1 : 0.72 }}>
      <rect x="1.5" y="6.5" width="4.5" height="5" rx="1.6" fill="currentColor" />
      <path d="M6 9h2.5M8.5 9l3-4.5H15M8.5 9H15M8.5 9l3 4.5H15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
