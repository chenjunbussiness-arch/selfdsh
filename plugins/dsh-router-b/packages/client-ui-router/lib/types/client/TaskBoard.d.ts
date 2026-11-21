/**
 * The task column: a tab strip, the sections inside the selected tab, and one
 * compact row per task.
 *
 * Every section stays in the DOM and is hidden with the `hidden` attribute, not
 * removed: the tab strip is a view switch over one list, so a proposed verdict
 * (or a test) never depends on which tab happened to be selected at render time.
 * `hidden` keeps the closed sections out of the accessibility tree and out of the
 * tab order, which is the part that matters.
 */
import type { ArtifactRef, BoardSnapshot, PublishResult, TaskState, TaskView } from './contract.ts';
import { type TabId } from './lanes.ts';
/** Props for {@link TaskBoard}. */
export interface TaskBoardProps {
    /** The last board read. Never null: the panel shows its own loading state. */
    readonly board: BoardSnapshot;
    /** Tasks after the partition filter, in board order. */
    readonly tasks: readonly TaskView[];
    /** Selected tab. */
    readonly tab: TabId;
    /** Select a tab. */
    readonly onTab: (tab: TabId) => void;
    /** Namespace-bound translate. */
    readonly t: (key: string, values?: Record<string, string | number>) => string;
    /** Read lifecycle of the board. */
    readonly status: 'idle' | 'loading' | 'ready' | 'error';
    /** True while a publish is in flight. */
    readonly publishing: boolean;
    /** Last publish outcome. */
    readonly lastPublish?: PublishResult;
    /** Last read failure, already human-readable. */
    readonly error?: string;
    /** Ids of tasks whose detail is open. */
    readonly openTasks: ReadonlySet<string>;
    /** Open or close one task's detail. */
    readonly onToggleTask: (taskId: string) => void;
    /** Keep the composer always open at the top (the Routing page). */
    readonly inlineComposer?: boolean;
    /** Whether the demand composer is open. */
    readonly composerOpen: boolean;
    /** Open or close the demand composer. */
    readonly onToggleComposer: () => void;
    /** Re-read the board. */
    readonly onRefresh: () => void;
    /** Publish one demand per line. */
    readonly onPublish: (demands: readonly string[]) => void;
    /** Open the 作战室 chat Session; absent when the shell cannot open Sessions. */
    readonly onOpenWarRoom?: () => void;
    /** Clear the publish banner. */
    readonly onClearNotice: () => void;
    /** Whether the project rail is open. */
    readonly railOpen: boolean;
    /** DOM id of the rail, for aria-controls. */
    readonly railId: string;
    /** Open or close the project rail. */
    readonly onToggleRail: () => void;
    /** Drop the partition filter. */
    readonly onClearFilter: () => void;
    /** Display name of the partition the list is filtered to, when one is. */
    readonly filterName?: string;
    /** Display name of a task's partition. */
    readonly partitionOf: (task: TaskView) => string;
    /** Display name of a task's worker, when assigned. */
    readonly workerOf: (task: TaskView) => string | undefined;
    /** The task with any live checklist projection folded in. */
    readonly resolve: (task: TaskView) => TaskView;
    /** Accept or send back a reported task. */
    readonly onVerify?: (taskId: string, verdict: Extract<TaskState, 'verified' | 'rejected'>, note?: string) => void;
    /** Open the executing worker's Session. */
    readonly onOpenSession?: (sessionId: string) => void;
    /** Download a produced artifact. */
    readonly onDownload?: (artifact: ArtifactRef) => void;
}
/**
 * Render the task column.
 * @param props - board data, tab state, and the actions each row offers.
 * @returns the tab strip and the sections under it.
 */
export declare function TaskBoard(props: TaskBoardProps): import("react/jsx-runtime").JSX.Element;
