/**
 * Nav-row glyph for the agent hub page: a hub node with three spokes.
 *
 * @module client-ui-agent-hub/icon
 */

import type { ReactNode } from 'react'

/** Props the `sidebar.panellist` list slot passes to a row glyph. */
export interface HubIconProps {
  readonly size?: number
  readonly active?: boolean
}

/** Draw the glyph. */
export function HubIcon({ size = 18, active = false }: HubIconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true" style={{ opacity: active ? 1 : 0.72 }}>
      <circle cx="9" cy="9" r="2.4" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="9" cy="2.6" r="1.4" fill="currentColor" />
      <circle cx="3.2" cy="13.4" r="1.4" fill="currentColor" />
      <circle cx="14.8" cy="13.4" r="1.4" fill="currentColor" />
      <path d="M9 4v2.6M4.4 12.6l2.5-1.9M13.6 12.6l-2.5-1.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
