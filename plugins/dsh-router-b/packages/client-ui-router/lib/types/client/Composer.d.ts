/**
 * Demand composer.
 *
 * The user only states demands; routing is not their job. One line is one
 * demand, and the router decides the partition — so the field's contract is
 * "paste everything, press once" rather than a form per task.
 */
import type { PublishResult } from './contract.ts';
/** Props for {@link Composer}. */
export interface ComposerProps {
    /** Namespace-bound translate. */
    readonly t: (key: string, values?: Record<string, string | number>) => string;
    /** True while a publish request is in flight. */
    readonly busy: boolean;
    /** The latest publish outcome, shown until the field is edited. */
    readonly lastPublish?: PublishResult;
    /** Publish one demand per non-empty line. */
    readonly onPublish: (demands: readonly string[]) => void;
    /** Called when the user starts editing again, so stale notices clear. */
    readonly onEdit?: () => void;
}
/**
 * Render the composer.
 * @param props - publish callback and current publish status.
 * @returns the composer block.
 */
export declare function Composer({ t, busy, lastPublish, onPublish, onEdit }: ComposerProps): import("react").JSX.Element;
