/**
 * Right-Sidebar task board: a progress tree, styled after Claude Duet's rail.
 *
 * One quiet column: a titled header with icon-only actions, a pill segment strip
 * (进行中 / 接下来 / 排程任务 / 已结束), then status groups. A group caption counts
 * task *families*, and each family is one row — the manager's task — with the
 * workers it dispatched indented underneath behind a `n 个 worker` chip. Rows
 * never repeat a work item as two siblings.
 *
 * The groups are 进行中, 已暂停（需要处理）, 已挂起（等前置）, 排队中, 已失效分区,
 * 已完成, 失败 and 已取消. A parked (`blocked`) row carries a second line with its
 * reason and a 恢复 button that sends `task_control resume`; a suspended row
 * says what it waits for, and a queued row held back by the task order says
 * which prerequisites are still open. Live rows offer 挂起 (with an optional
 * prerequisite), failed rows offer 重试. The 进行中 tab opens with per-request
 * progress and the router's latest progress notices. There is
 * no "awaiting review" bucket: a worker that reported in has finished, so host
 * state `reported` renders as 已完成. The finished pile opens folded, so history
 * never buries what is running.
 *
 * Each row: an ellipsised 13px title with a light meta line (partition, time,
 * monospace task id) below it, and a small status dot plus word on the right
 * (进行中 / 已完成 / 已中断 / 已取消 / 失败). Narrow panels keep only title and dot.
 *
 * The groups come from `hostState` rather than the five-state `state` projection:
 * that projection folds `failed`/`cancelled` into `rejected` and `blocked` into
 * `queued`, which would merge 失败/取消 into 排队中 and lose 需要输入 entirely.
 *
 * Everything the previous dense card list did is still here: rows open their
 * worker's Session on click, the board is re-read when the refresh icon is used
 * and every 3 s while anything runs (checklists live in worker logs, not in the
 * board file), long groups fold behind 更多（还有 n 条） with 已显示 n/m beside the count, and the header's `+`
 * opens the war-room chat where demands are created.
 *
 * @module client-ui-router/compact-board
 */
import type { TaskView } from './contract.ts';
import type { RouterBoardController } from './controller.ts';
import { type SessionsFace } from './native-todos.ts';
/** Props supplied by the tab registration. */
export interface CompactBoardProps {
    readonly controller: RouterBoardController;
    readonly t: (key: string, values?: Record<string, string | number>) => string;
    readonly onOpenSession?: (sessionId: string) => void;
    readonly onOpenWarRoom?: () => void;
    /** Hide this panel's tab again. Absent when the shell has no right Sidebar. */
    readonly onClose?: () => void;
    readonly sessions?: SessionsFace;
}
/** A tab of the segment strip. */
export type BoardTab = 'active' | 'next' | 'scheduled' | 'resolved';
/**
 * A status bucket rendered under one caption inside a tab.
 *
 * There is deliberately no "awaiting review" bucket: a worker that reported in
 * has finished its work, and the panel is a progress tree, not a review queue.
 * Host states fold onto these three outcomes — running, finished, closed badly.
 */
export type Group = 'running' | 'blocked' | 'suspended' | 'queued' | 'stale' | 'done' | 'failed' | 'cancelled';
/**
 * Group of one task.
 * @param task - the task.
 * @param live - partition ids that still exist.
 * @returns its display group; unfinished work in a removed partition is `stale`.
 */
export declare function groupOf(task: TaskView, live: ReadonlySet<string>): Group;
/**
 * Bucket of one task.
 *
 * `reported` is a finished task here: a worker that reported in is done, and the
 * panel is a progress tree, not a review queue. A cancellation files under
 * 已取消; an abort stays in 失败 with its own 已中断 caption on the row.
 * @param task - a task.
 * @param live - partition ids that still exist.
 * @returns its bucket.
 */
export declare function groupOfTask(task: TaskView, live: ReadonlySet<string>): Group;
/** The word a row shows for its own status: icon colour alone is not enough. */
export type StatusTone = 'running' | 'blocked' | 'suspended' | 'queued' | 'waiting' | 'done' | 'failed' | 'aborted' | 'cancelled' | 'stale';
/**
 * Caption key for one task's status word.
 * @param task - a task.
 * @param live - partition ids that still exist.
 * @returns the locale key of its caption.
 */
export declare function statusKeyOf(task: TaskView, live: ReadonlySet<string>): string;
/** One row of the board: a task family, not a single task. */
export interface Family {
    /** Identity for React keys: the root task id, or the folded title key. */
    key: string;
    /** Bucket the family is filed under. */
    group: Group;
    /** Task the headline row shows. Newest member after a duplicate fold. */
    root: TaskView;
    /**
     * The member whose status the row reports.
     *
     * It is the member that put the family in its bucket: a manager that already
     * closed while its worker still runs must not paint the running row with the
     * manager's 已中断 — the row is 进行中, because the work is.
     */
    rep: TaskView;
    /** Every task in the family, headline first, then its children. */
    members: TaskView[];
    /** Highest attempt count in the family, for the 第 n 次尝试 tag. */
    attempt: number;
    /** Failure or abort reason, for the resolved tag and the tooltip. */
    reason?: string;
}
/**
 * Build the board's rows: one per task family.
 *
 * A manager and the workers under it are one piece of work, so `parentId` folds
 * the whole tree into a single headline row whose children open behind a count
 * chip. Counting families is what keeps "进行中 9" from reading as nine
 * unrelated jobs when it is three.
 *
 * Two display-only folds beyond that:
 *  - a task whose parent is not on the board is its own root (a board is a
 *     window, not a whole history);
 *  - root tasks with the same title, partition and bucket fold into one row. A
 *     demand that was retried or republished under a second id is not a second
 *     piece of work, and two identical rows read as a bug. Tasks with children
 *     never take part: their tree is their identity.
 *
 * Nothing here changes a task's state; the fold is a rendering decision.
 * @param tasks - every task in the snapshot.
 * @param live - partition ids that still exist.
 * @returns families, newest activity first within their bucket.
 */
export declare function buildFamilies(tasks: readonly TaskView[], live: ReadonlySet<string>): Family[];
/**
 * Render the board.
 * @param props - controller, translate, Session service and outward actions.
 * @returns the board.
 */
export declare function CompactBoard({ controller, t, onOpenSession, onOpenWarRoom, onClose, sessions }: CompactBoardProps): import("react").JSX.Element;
