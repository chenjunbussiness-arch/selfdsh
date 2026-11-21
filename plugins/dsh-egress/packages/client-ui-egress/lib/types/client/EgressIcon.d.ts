/**
 * Nav-row glyph for the Egress page: one source branching into three exits.
 */
import type { ReactNode } from 'react';
/** Props the `sidebar.panellist` list slot passes to a row glyph. */
export interface EgressIconProps {
    readonly size?: number;
    readonly active?: boolean;
}
/**
 * Draw the glyph.
 * @param props - render props from the slot.
 */
export declare function EgressIcon({ size, active }: EgressIconProps): ReactNode;
