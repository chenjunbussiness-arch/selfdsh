/**
 * The war room: the panel that replaces the conversation as the default screen.
 *
 * Three questions, in the order a person asks them, and nothing else:
 *
 *   1. which workspaces have work — one row per partition, with counts;
 *   2. what needs me — tasks a worker says it finished, and tasks the router
 *      parked on a human decision;
 *   3. where is each task — one line per running task, with the worker's own
 *      checklist progress.
 *
 * The composer at the top publishes a demand straight into the router, which is
 * the whole point of this panel existing: the conversation is still one click
 * away, but dispatching work does not require opening it.
 *
 * Data comes from {@link RouterBoardController}, the same controller the
 * right-hand board uses, so the two surfaces cannot disagree about state. No
 * Harness package is imported: this renders inside the Web module loader, where
 * `@deepseek-ai/dsh-*` specifiers are module-table entries rather than deps.
 *
 * @module client-ui-router/warroom
 */
import { type ReactNode } from 'react';
import type { RouterBoardController } from './controller.ts';
/** What this panel receives from its registration. */
export interface WarRoomProps {
    /** The board controller shared with the right-hand panel. */
    readonly controller: RouterBoardController;
}
/**
 * The war room page.
 * @param props - the shared board controller.
 */
export declare function WarRoom({ controller }: WarRoomProps): ReactNode;
