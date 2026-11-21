/**
 * Nav-row glyph for the Routing page.
 *
 * Three stacked bars: several pieces of work at different stages — the same motif
 * the panel uses for a task row's state ring.
 *
 * @module client-ui-router/routing-icon
 */
import type { ReactNode } from 'react';
/** Props the `sidebar.panellist` list slot passes to a row glyph. */
export interface RoutingIconProps {
    /** Pixel size the sidebar asks for; grows when the rail is wide. */
    readonly size?: number;
    /** Whether this panel is the selected one. */
    readonly active?: boolean;
}
/**
 * Draw the glyph.
 * @param props - render props from the slot.
 */
export declare function RoutingIcon({ size, active }: RoutingIconProps): ReactNode;
