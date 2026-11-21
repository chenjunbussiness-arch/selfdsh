/**
 * The router panel, as the right Sidebar shows it.
 *
 * Two columns inside one panel:
 *
 *   rail    which projects exist, which one you are reading, whether dispatch is
 *           on, and whether the model credentials are in place (API key status)
 *   tasks   the work list: four tabs, one compact row per task, the worker's
 *           checklist and the accept/send-back actions behind the row
 *
 * Why the rail lives inside the panel instead of in the app's left Sidebar: the
 * app's left column has no free content slot (see `ProjectRail.tsx` and
 * `docs/NATIVE-ENTRYPOINTS.md`), so a genuine left column is not available to a
 * third-party plugin without replacing the workspace browser. The panel therefore
 * draws its own rail and switches between "rail + list" (wide) and "one of the
 * two, behind ☰" (narrow) — a container query, so nothing measures in JS.
 *
 * The middle column is the native conversation and is not this plugin's business.
 */
import type { ArtifactRef, HostActions } from './contract.ts';
import type { RouterBoardController } from './controller.ts';
import { todoProgress, type TabId } from './lanes.ts';
import { type SessionsFace } from './native-todos.ts';
/** Props for {@link RouterPanel}. */
export interface RouterPanelProps {
    /** Panel state and actions. */
    readonly controller: RouterBoardController;
    /** Namespace-bound translate. */
    readonly t: (key: string, values?: Record<string, string | number>) => string;
    /** Open the worker Session that owns a task. */
    readonly onOpenSession?: (sessionId: string) => void;
    /** Open the 作战室 chat Session. */
    readonly onOpenWarRoom?: () => void;
    /** Download an artifact the worker produced. */
    readonly onDownload?: (artifact: ArtifactRef) => void;
    /**
     * The Session service, so each task can show its worker's own `todos`
     * projection. Omitted in the standalone preview; the Host-supplied snapshot on
     * the task is used then.
     */
    readonly sessions?: SessionsFace;
    /**
     * Host actions beyond reading the board (partition switch, credential status
     * and writes). Each member is optional: a Host that implements none still gets
     * a readable board, and the rail says which control is not wired.
     */
    readonly host?: HostActions;
    /**
     * `page` when mounted as the main Routing page: the demand box stays open at
     * the top of a centred column. `panel` (default) is the docked Sidebar tab.
     */
    readonly variant?: 'page' | 'panel';
    /** Tab to open on first render; the preview and tests pin it. */
    readonly initialTab?: TabId;
    /** Force the rail open or closed on first render (preview only); otherwise the remembered state wins. */
    readonly initialRailOpen?: boolean;
    /** Partition id to filter to on first render (preview only). */
    readonly initialSelected?: string;
    /** Task details to open on first render (preview only). */
    readonly initialOpenTasks?: readonly string[];
}
/**
 * localStorage key that remembers whether the project rail is open on the
 * Routing page. The docked Sidebar panel is narrow, where an open rail covers the
 * task list, so it keeps its own key and a page choice never hides its list.
 */
export declare const RAIL_STORAGE_KEY = "dshr.rail.open";
/**
 * Render the panel.
 * @param props - controller, translate, and the panel's outward actions.
 * @returns the rail and the task column.
 */
export declare function RouterPanel(props: RouterPanelProps): import("react/jsx-runtime").JSX.Element;
/** Re-exported so a caller can compute the same progress the rows show. */
export { todoProgress };
