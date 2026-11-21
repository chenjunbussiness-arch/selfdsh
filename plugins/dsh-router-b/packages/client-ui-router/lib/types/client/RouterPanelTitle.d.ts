/**
 * The tab chip's title: the panel's name plus how much is waiting on the user.
 *
 * Reading the count here rather than in the body keeps the chip informative
 * while the panel is hidden behind another tab.
 */
import type { RouterBoardController } from './controller.ts';
/** Props supplied by the tab-title registration's inject face. */
export interface RouterPanelTitleProps {
    /** Panel state. */
    readonly controller: RouterBoardController;
    /** Namespace-bound translate. */
    readonly t: (key: string, values?: Record<string, string | number>) => string;
}
/**
 * Render the chip title.
 * @param props - controller and translate.
 * @returns the label, with an awaiting-review count when there is one.
 */
export declare function RouterPanelTitle({ controller, t }: RouterPanelTitleProps): import("react/jsx-runtime").JSX.Element;
