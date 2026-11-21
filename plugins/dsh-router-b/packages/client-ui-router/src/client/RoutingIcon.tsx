/**
 * Nav-row glyph for the Routing page.
 *
 * Three stacked bars: several pieces of work at different stages — the same motif
 * the panel uses for a task row's state ring.
 *
 * @module client-ui-router/routing-icon
 */

import type { ReactNode } from 'react'

/** Props the `sidebar.panellist` list slot passes to a row glyph. */
export interface RoutingIconProps {
  /** Pixel size the sidebar asks for; grows when the rail is wide. */
  readonly size?: number
  /** Whether this panel is the selected one. */
  readonly active?: boolean
}

/**
 * Draw the glyph.
 * @param props - render props from the slot.
 */
export function RoutingIcon({ size = 18, active = false }: RoutingIconProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
      style={{ opacity: active ? 1 : 0.72 }}
    >
      <rect x="2" y="3" width="14" height="3.2" rx="1.2" fill="currentColor" />
      <rect x="2" y="7.6" width="10" height="3.2" rx="1.2" fill="currentColor" opacity="0.72" />
      <rect x="2" y="12.2" width="6.5" height="3.2" rx="1.2" fill="currentColor" opacity="0.45" />
    </svg>
  )
}
