/**
 * Conversation-header entry point for the panel.
 *
 * A docked panel with no opener is a panel nobody sees, so this ships with the
 * tab type. It also carries the awaiting-review count: a task that a worker
 * claimed to finish is the one thing the user must not miss.
 */
import type { RouterBoardController } from './controller.ts';
/** Props supplied by the header-utility registration's inject face. */
export interface RouterPanelButtonProps {
    /** Panel state. */
    readonly controller: RouterBoardController;
    /** Namespace-bound translate. */
    readonly t: (key: string, values?: Record<string, string | number>) => string;
    /** Open (or reveal) the panel's tab. */
    readonly open: () => void;
}
/**
 * Render the header button.
 * @param props - controller, translate, and the open action.
 * @returns the button.
 */
export declare function RouterPanelButton({ controller, t, open }: RouterPanelButtonProps): import("react/jsx-runtime").JSX.Element;
