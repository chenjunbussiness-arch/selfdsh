/**
 * Replacement brand mark and wordmark for the Sidebar.
 *
 * Both slots are `single` and are occupied by the official brand plugin, and the
 * slot registry throws rather than overwriting (`ui-slots/src/index.ts:1284`).
 * So these only render when a profile disables that row:
 *
 * ```yaml
 * - id: ui-brand-official
 *   disabled: true
 * ```
 *
 * Until then the registration is refused and caught in the entry point, which is
 * deliberate: a deployment that has not opted in keeps the shipped brand instead
 * of failing to load the router.
 *
 * The name is a placeholder on purpose — it is one string in one file, and the
 * real product name is not a technical decision.
 *
 * @module client-ui-router/brand
 */
import type { ReactNode } from 'react';
/** Placeholder wordmark. Change this one constant to rename the product. */
export declare const PRODUCT_NAME = "Team";
/** Props the Sidebar's brand slots pass; both are optional render hints. */
export interface BrandProps {
    /** Pixel size, when the slot passes one. */
    readonly size?: number;
}
/**
 * Square glyph: three ascending strokes, the same motif as the nav icon.
 * @param props - render props.
 */
export declare function BrandMark({ size }: BrandProps): ReactNode;
/**
 * Wordmark beside the mark.
 * @param _props - render props (unused; the name is static).
 */
export declare function BrandName(_props: BrandProps): ReactNode;
