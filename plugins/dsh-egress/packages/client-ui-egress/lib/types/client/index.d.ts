/**
 * Browser entry of the Egress panel.
 *
 * It contributes three things:
 *   1. a main panel (`main` slot, key `egress/panel`) with the exit list, the
 *      binding table and the request log;
 *   2. a Sidebar row that opens it (`sidebar.panellist`);
 *   3. its dictionaries (zh and en).
 *
 * No Harness package is imported as a value: a Client plugin runs inside the Web
 * module loader, where `@deepseek-ai/dsh-*` specifiers are module-table entries,
 * not dependencies. Only types come from the vendored shim. It does not touch
 * `rightbar` (a single slot owned by the right Sidebar).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** Key of the main panel, and the `id` of its Sidebar row (the Sidebar binds a row to the panel with the same key). */
export declare const PANEL_ID = "egress/panel";
/** Services this plugin cannot work without. */
export declare const inject: string[];
/**
 * Register the panel.
 * @param ctx - Client Context carrying slots and locale.
 */
export declare function apply(ctx: ClientContext): void;
