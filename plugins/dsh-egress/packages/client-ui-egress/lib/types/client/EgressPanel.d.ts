/**
 * The Egress panel: status bar, exit list (with the add/edit form), binding
 * table and the recent-request log.
 *
 * Everything the person can change lives here and goes through the controller;
 * the agent has a read-only tool and no way to reach these writes.
 */
import type { ReactNode } from 'react';
import type { Translate } from './contract.ts';
import type { EgressController } from './controller.ts';
/** Props of {@link EgressPanel}. */
export interface EgressPanelProps {
    readonly controller: EgressController;
    readonly t: Translate;
    /** Preview only: open the add form / edit form / log on first render. */
    readonly initialForm?: 'new' | {
        readonly edit: string;
    };
    readonly initialLogOpen?: boolean;
}
/**
 * Render the panel.
 * @param props - controller and translate.
 */
export declare function EgressPanel({ controller, t, initialForm, initialLogOpen }: EgressPanelProps): ReactNode;
