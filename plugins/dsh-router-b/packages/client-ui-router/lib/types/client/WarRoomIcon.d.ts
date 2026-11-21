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
import type { ReactNode } from 'react';
/** Props the `sidebar.panellist` list slot passes to a row glyph. */
export interface WarRoomIconProps {
    /** Pixel size the sidebar asks for; grows when the rail is wide. */
    readonly size?: number;
    /** Whether this panel is the selected one. */
    readonly active?: boolean;
}
/**
 * Three stacked bars: several pieces of work, at different stages.
 * @param props - render props from the slot.
 */
export declare function WarRoomIcon({ size, active }: WarRoomIconProps): ReactNode;
