/**
 * Glyphs for the Egress page.
 *
 * - {@link EgressIcon}: nav-row glyph, one source branching into three exits.
 * - {@link EmptyGlyph}: the muted mark drawn above empty-state text.
 *
 * Both draw in `currentColor`, so the colour always comes from the theme.
 */

import type { ReactNode } from 'react'

/** Props the `sidebar.panellist` list slot passes to a row glyph. */
export interface EgressIconProps {
  readonly size?: number
  readonly active?: boolean
}

/**
 * Draw the nav glyph.
 * @param props - render props from the slot.
 */
export function EgressIcon({ size = 18, active = false }: EgressIconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true" focusable="false" style={{ opacity: active ? 1 : 0.72 }}>
      <rect x="1.5" y="6.5" width="4.5" height="5" rx="1.6" fill="currentColor" />
      <path d="M6 9h2.5M8.5 9l3-4.5H15M8.5 9H15M8.5 9l3 4.5H15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Draw the empty-state mark (the same branching shape, outlined).
 * @param props - optional class name for sizing and colour.
 */
export function EmptyGlyph({ className }: { readonly className?: string }): ReactNode {
  return (
    <svg className={className} viewBox="0 0 18 18" fill="none" aria-hidden="true" focusable="false">
      <rect x="1.5" y="6.5" width="4.5" height="5" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6 9h2.5M8.5 9l3-4.5H15M8.5 9H15M8.5 9l3 4.5H15" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2 2" />
    </svg>
  )
}
