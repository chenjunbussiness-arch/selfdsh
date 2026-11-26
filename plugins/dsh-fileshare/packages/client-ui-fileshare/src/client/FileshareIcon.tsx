/**
 * Sidebar row glyph of the 文件中转 page: two arrows, up and down.
 */

import type { ReactNode } from 'react'

export interface FileshareIconProps {
  readonly size?: number
  readonly active?: boolean
}

export function FileshareIcon({ size = 18, active = false }: FileshareIconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true" style={{ opacity: active ? 1 : 0.72 }}>
      <path d="M6 14V4m0 0L3 7m3-3 3 3M12 4v10m0 0-3-3m3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
