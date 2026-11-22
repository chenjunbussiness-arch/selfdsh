/**
 * Browser entry of the router panel.
 *
 * It contributes three things and nothing else:
 *   1. a right-Sidebar tab type (`sidebarRightTabs.register`) plus its body in
 *      the keyed `sidebar.right.pane.tab` seat and its chip title;
 *   2. a header button in the conversation so the panel is reachable without a
 *      shortcut;
 *   3. its dictionaries.
 *
 * The panel draws its own left rail (projects + API-key status) inside the right
 * column: the app's left Sidebar has no free content seat for a third-party
 * plugin — `sidebar` is a single slot occupied by `dsh-client-ui-sidebar`, whose
 * content holes (`sidebar.workspaces`, `sidebar.settings`) belong to ui-workspace
 * and ui-settings, and whose free holes are navigation *rows*, not containers.
 * See `docs/NATIVE-ENTRYPOINTS.md`.
 *
 * No Harness package is imported as a value: a Client plugin runs inside the
 * Web module loader, where `@deepseek-ai/dsh-*` specifiers are module-table
 * entries, not dependencies (see the authoring guide shipped with the app,
 * `dsh-agent-preset/skills/dsh-doc/references/practices.md`). Everything is
 * React plus this package's own CSS.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** Tab type id; also the key the body and title register under. */
export declare const TAB_ID = "dsh-client-ui-router/board";
/** Tab kind the opener names. */
export declare const TAB_KIND = "router-board";
/**
 * Key of the main panel, and the `id` of its Sidebar row.
 *
 * `main` is keyed, so this key sits beside the reserved `conversation` panel
 * rather than taking its place. The same value links the row to the panel: the
 * Sidebar selects the panel whose key equals the row's `id`.
 */
export declare const PANEL_ID = "router/routing";
/** Main-panel key and Sidebar row id of the 工作区 page. */
export declare const WORKSPACE_ID = "router/workspace";
/**
 * Services this plugin cannot work without.
 *
 * Deliberately minimal: the router Remote is NOT listed, so a profile without the
 * Host half still loads the panel and shows labelled sample data instead of
 * deactivating the plugin. Optional services are read defensively in `apply`.
 */
export declare const inject: string[];
/**
 * Register the panel.
 * @param ctx - Client Context carrying slots, locale, and the right Sidebar.
 */
export declare function apply(ctx: ClientContext): void;
