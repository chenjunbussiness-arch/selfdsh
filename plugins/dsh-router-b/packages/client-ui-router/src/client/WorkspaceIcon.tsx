/**
 * Nav-row glyph for the 工作区 page: a folder with a file tree inside.
 *
 * @module client-ui-router/workspace-icon
 */

import type { ReactNode } from 'react'
import type { RoutingIconProps } from './RoutingIcon.tsx'

/**
 * Draw the glyph.
 * @param props - render props from the `sidebar.panellist` slot.
 */
export function WorkspaceIcon({ size = 18, active = false }: RoutingIconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ opacity: active ? 1 : 0.72 }}>
      <path d="M2 4.5h5l1.5 1.8H16v8.2H2z" />
      <path d="M5.5 9.5h3M5.5 12h5" opacity="0.72" />
    </svg>
  )
}
