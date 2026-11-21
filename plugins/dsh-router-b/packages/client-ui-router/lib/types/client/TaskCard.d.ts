/**
 * One task on the board: a compact row, and — once opened — the worker's
 * checklist and the actions that belong to this task's state.
 *
 * The row is deliberately one line with a state ring, the way a working list
 * reads in a task app: you scan titles, not cards. The ring is the only place
 * `reported` and `verified` are allowed to look similar, and they do not even
 * there: a self-report is an amber open ring, a verified task is a filled green
 * check. Everything else follows from that distinction — 待验收 is the only
 * section that offers 通过验收 / 退回, and only it prints 自报于 ….
 */
import type { ArtifactRef, TaskState, TaskView } from './contract.ts';
/** Props for {@link TaskCard}. */
export interface TaskCardProps {
    /** The task to render. */
    readonly task: TaskView;
    /** Display name of the owning partition. */
    readonly partitionName: string;
    /** Display name of the assigned worker, when one is assigned. */
    readonly workerName?: string;
    /** Namespace-bound translate. */
    readonly t: (key: string, values?: Record<string, string | number>) => string;
    /** Whether the detail is open. */
    readonly open: boolean;
    /** Open or close this task's detail. */
    readonly onToggle: (taskId: string) => void;
    /** Accept or send back a reported task. */
    readonly onVerify?: (taskId: string, verdict: Extract<TaskState, 'verified' | 'rejected'>, note?: string) => void;
    /** Open the executing worker's Session. */
    readonly onOpenSession?: (sessionId: string) => void;
    /** Download a produced artifact. */
    readonly onDownload?: (artifact: ArtifactRef) => void;
}
/**
 * Render one task row.
 * @param props - task plus the actions the board offers for it.
 * @returns the row, with its detail rendered but hidden while closed.
 */
export declare function TaskCard({ task, partitionName, workerName, t, open, onToggle, onVerify, onOpenSession, onDownload, }: TaskCardProps): import("react/jsx-runtime").JSX.Element;
