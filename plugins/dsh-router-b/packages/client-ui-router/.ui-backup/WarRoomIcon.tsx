/**
 * Nav-row glyph for the war room.
 *
 * The Sidebar renders this inside `sidebar.panellist`, which is a list slot: the
 * entry's `id` is the main panel key, and this is the icon that row draws. Size
 * and active state arrive as render props so the glyph matches every other row
 * in the same strip.
 *
 * @module client-ui-router/warroom-icon
 */

import type { ReactNode } from 'react'

/** Props the `sidebar.panellist` list slot passes to a row glyph. */
export interface WarRoomIconProps {
  /** Pixel size the sidebar asks for; grows when the rail is wide. */
  readonly size?: number
  /** Whether this panel is the selected one. */
  readonly active?: boolean
}

/**
 * Three stacked bars: several pieces of work, at different stages.
 * @param props - render props from the slot.
 */
export function WarRoomIcon({ size = 18, active = false }: WarRoomIconProps): ReactNode {
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
