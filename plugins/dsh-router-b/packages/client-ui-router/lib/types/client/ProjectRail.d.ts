/**
 * The left rail: which projects exist, which one you are looking at, whether
 * dispatch is on, and whether the model credentials are in place.
 *
 * This is the panel's own left column. It sits inside the right-Sidebar panel
 * rather than in the app's left Sidebar because the app's left column has no
 * free content slot: `sidebar` is a single slot already occupied by
 * `dsh-client-ui-sidebar`, whose only unoccupied holes are navigation *rows*
 * (`sidebar.panellist`, `sidebar.panellist.actions`, `sidebar.footer.action`),
 * while its two content regions (`sidebar.workspaces`, `sidebar.settings`) are
 * occupied by ui-workspace and ui-settings. See `docs/NATIVE-ENTRYPOINTS.md`.
 *
 * Layout: closed by default. The button in the task header opens it as a fixed
 * column beside the task list when the panel is wide, or full-width in place of
 * the list when it is narrow. A closed rail stays in the DOM but is hidden, so
 * it is out of the tab order and the accessibility tree.
 */
import type { CredentialView, PartitionView } from './contract.ts';
/** Props for {@link ProjectRail}. */
export interface ProjectRailProps {
    /** DOM id, so the toggle in the task header can point at the rail. */
    readonly id?: string;
    /** Whether the rail is shown. It always renders; a closed one is hidden. */
    readonly open?: boolean;
    /** Partitions in roster order. */
    readonly partitions: readonly PartitionView[];
    /** Partition the task list is filtered to, when one is. */
    readonly selectedId?: string;
    /** Select or clear the filter. */
    readonly onSelect: (partitionId: string | undefined) => void;
    /** Task count across every partition, for the "全部" row. */
    readonly totalTasks: number;
    /** Namespace-bound translate. */
    readonly t: (key: string, values?: Record<string, string | number>) => string;
    /** Credential status rows to show. */
    readonly credentials: readonly CredentialView[];
    /** True when the Host implements a credential write. */
    readonly credentialsWritable: boolean;
    /** Store one credential literal. */
    readonly onSaveCredential?: (ref: string, value: string) => Promise<string | undefined>;
    /** Re-read status after a write. */
    readonly onCredentialsChanged?: () => void;
    /** Switch dispatch into a partition. */
    readonly onTogglePartition?: (partitionId: string, enabled: boolean) => Promise<void>;
    /** Create a partition. */
    readonly onCreatePartition?: (name: string) => Promise<void>;
    /** Close the rail (narrow layout only). */
    readonly onClose?: () => void;
}
/**
 * Render the rail.
 * @param props - roster, credential status, and the host-wired actions.
 * @returns the project rail.
 */
export declare function ProjectRail({ id, open, partitions, selectedId, onSelect, totalTasks, t, credentials, credentialsWritable, onSaveCredential, onCredentialsChanged, onTogglePartition, onCreatePartition, onClose, }: ProjectRailProps): import("react/jsx-runtime").JSX.Element;
