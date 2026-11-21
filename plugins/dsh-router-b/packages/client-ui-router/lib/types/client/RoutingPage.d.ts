/**
 * The Routing page: the task board promoted to the main panel.
 *
 * This is the same board the right-hand Sidebar tab renders — literally the same
 * component, with the same controller — so the two surfaces cannot disagree. It
 * exists as a page because the board is the thing a person wants to look at when
 * they open the app, and a panel that only appears after opening a conversation
 * and pressing a header button is a panel most people never find.
 *
 * The wrapper only constrains width: at full window width the board's own rail
 * plus task column would stretch into a very long line, so the page centres them
 * in a column and lets the panel's own container queries pick the layout.
 *
 * @module client-ui-router/routing-page
 */
import type { ReactNode } from 'react';
import { type RouterPanelProps } from './RouterPanel.tsx';
/**
 * Render the board as a page.
 * @param props - everything the panel needs (controller, translate, host actions).
 * @returns the centred board.
 */
export declare function RoutingPage(props: RouterPanelProps): ReactNode;
