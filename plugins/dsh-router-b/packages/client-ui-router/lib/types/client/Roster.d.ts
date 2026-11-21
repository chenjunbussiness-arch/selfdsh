/**
 * Partition roster — the left rail's project list.
 *
 * One row answers three questions at a glance, in this order:
 *
 *   is anyone on this?      the presence dot
 *   what is it called?      the name, plus its worker count
 *   is anything on my desk? the amber count badge (reported, not verified)
 *
 * Presence is spelled out in the second line ("4 个 worker · 忙 2 · 已释放 2")
 * instead of being implied by colour: a released worker holds no machine, and a
 * dot alone cannot say that. Selecting a row opens its worker chips and its
 * 启用/停用 switch; the switch is host-wired, and says so when it is not.
 */
import type { PartitionView } from './contract.ts';
/** Props for {@link Roster}. */
export interface RosterProps {
    /** Partitions in roster order. */
    readonly partitions: readonly PartitionView[];
    /** Partition the rail is filtered to, when one is. */
    readonly selectedId?: string;
    /** Select or clear (undefined) the filter. */
    readonly onSelect?: (partitionId: string | undefined) => void;
    /** Switch dispatch into a partition on or off. */
    readonly onToggle?: (partitionId: string, enabled: boolean) => void | Promise<void>;
    /** True when the Host actually implements {@link RosterProps.onToggle}. */
    readonly wired?: boolean;
    /** Called when a control is pressed but no Host action exists for it. */
    readonly onUnwired?: () => void;
    /** Namespace-bound translate. */
    readonly t: (key: string, values?: Record<string, string | number>) => string;
}
/**
 * Render the roster.
 * @param props - partitions plus the rail's selection and control handles.
 * @returns the project list.
 */
export declare function Roster({ partitions, selectedId, onSelect, onToggle, wired, onUnwired, t }: RosterProps): import("react/jsx-runtime").JSX.Element;
