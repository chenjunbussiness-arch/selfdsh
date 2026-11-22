/**
 * 工作区: what files each partition holds, and the rules a worker works by.
 *
 * Left: the partitions, then the selected partition's file tree. The tree reads
 * one directory level per request (`GET /api/router/files?partition=&path=`), so
 * a big repository costs nothing until someone opens a folder. Entries the
 * partition's include/exclude rules leave out are dimmed and say so.
 *
 * Right: that partition's root, its include/exclude rules, any configuration
 * problem the Host found at boot, the rules every worker brief carries, the
 * partition's open tasks (with what each one waits for, and 停止全部), and its
 * memory: the model its manager runs on, standing notes, recent work and the
 * worker sessions the manager can read or continue.
 *
 * Only names, kinds, sizes and times cross the bridge, never file contents.
 *
 * @module client-ui-router/workspace-page
 */
import type { RouterBoardController } from './controller.ts';
/** Props supplied by the main-panel registration. */
export interface WorkspacePageProps {
    readonly controller: RouterBoardController;
    readonly t: (key: string, values?: Record<string, string | number>) => string;
    readonly onOpenSession?: (sessionId: string) => void;
}
/**
 * Render the 工作区 page.
 * @param props - controller, translate and the Session opener.
 * @returns the page.
 */
export declare function WorkspacePage({ controller, t, onOpenSession }: WorkspacePageProps): import("react").JSX.Element;
