/**
 * The desk: what the board needs beyond rows.
 *
 * - {@link ApprovalsSection} — 等你确认: outlet actions (merge a PR, a dangerous
 *   server command, a push or a page capture in confirm mode) the router will
 *   not run until a person says 同意. Each card says what, on what, why, and
 *   whether it can be undone; 同意 runs it once, 拒绝 tells the agent not to.
 * - {@link LivePanel} — a worker's output as it happens, one block per command,
 *   errors in red, with 停止 / 改派 / 换模型 at hand. Polls every 2 s while open
 *   and follows the bottom unless the person scrolled up to read.
 * - {@link ReassignDialog} — 改派 / 换模型: another partition and/or model, and
 *   接着做 (hand over what the old worker did) or 从头来.
 * - {@link BatchBar} — 批量: filter by state, partition and failure cause,
 *   select, act on all of them after one confirmation, then read the outcome.
 *
 * @module client-ui-router/desk
 */
import type { LiveSegmentView, PartitionView, TaskView } from './contract.ts';
import type { RouterBoardController } from './controller.ts';
type T = (key: string, values?: Record<string, string | number>) => string;
/**
 * A failure's cause with the noise taken out, so the same problem on ten rows
 * groups as one: first line only, paths, numbers, hashes and quoted values
 * replaced, whitespace folded, capped at 80 characters.
 */
export declare function failureKey(error: string | undefined): string;
/** Polls the approval queue and renders pending cards; nothing when empty. */
export declare function ApprovalsSection({ controller, t, titleOf, nameOf, refreshKey }: {
    readonly controller: RouterBoardController;
    readonly t: T;
    readonly titleOf: ReadonlyMap<string, string>;
    readonly nameOf: ReadonlyMap<string, string>;
    /** Changes when the board changes, to re-read at once. */
    readonly refreshKey: string;
}): import("react").JSX.Element | null;
/** Merge a newer read into what is shown: same seq replaces, new seq appends. */
export declare function mergeSegments(shown: readonly LiveSegmentView[], fresh: readonly LiveSegmentView[]): LiveSegmentView[];
/** A worker's output, live. */
export declare function LivePanel({ controller, t, task, onClose, onStop, onReassign }: {
    readonly controller: RouterBoardController;
    readonly t: T;
    readonly task: TaskView;
    readonly onClose: () => void;
    readonly onStop?: () => void;
    readonly onReassign?: (focus: 'partition' | 'model') => void;
}): import("react").JSX.Element;
/** Move a task to another partition and/or model. */
export declare function ReassignDialog({ controller, t, task, partitions, focus, onClose, onDone }: {
    readonly controller: RouterBoardController;
    readonly t: T;
    readonly task: TaskView;
    readonly partitions: readonly PartitionView[];
    readonly focus: 'partition' | 'model';
    readonly onClose: () => void;
    readonly onDone: (text: string) => void;
}): import("react").JSX.Element;
/** Filters of batch mode; empty string means any. */
export interface BatchFilter {
    readonly group: string;
    readonly partition: string;
    readonly failure: string;
}
export declare const NO_FILTER: BatchFilter;
/** The batch bar: filters, selection, one action with a confirmation, and the outcome. */
export declare function BatchBar({ controller, t, filter, setFilter, groups, partitions, failures, visibleIds, selected, setSelected, titleOf, onExit }: {
    readonly controller: RouterBoardController;
    readonly t: T;
    readonly filter: BatchFilter;
    readonly setFilter: (filter: BatchFilter) => void;
    /** Groups present on the board, with counts, already translated. */
    readonly groups: readonly {
        readonly id: string;
        readonly label: string;
        readonly n: number;
    }[];
    readonly partitions: readonly PartitionView[];
    /** Failure causes and how many rows share each. */
    readonly failures: readonly {
        readonly key: string;
        readonly n: number;
    }[];
    /** Task ids on screen under the current filters. */
    readonly visibleIds: readonly string[];
    readonly selected: ReadonlySet<string>;
    readonly setSelected: (next: ReadonlySet<string>) => void;
    readonly titleOf: ReadonlyMap<string, string>;
    readonly onExit: () => void;
}): import("react").JSX.Element;
/** Desk styles; tokens come from BOARD_TOKENS_CSS (light and dark). */
export declare const DESK_CSS = "\n.dshd-grow{flex:1 1 auto}\n.dshd-btn{display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 14px;border:0;border-radius:var(--r-pill);background:var(--c-pill);color:var(--c-text);font-size:12px;font-weight:500;line-height:16px;white-space:nowrap;cursor:pointer;transition:background-color var(--dur) var(--ease),color var(--dur) var(--ease),transform .1s var(--ease)}\n.dshd-btn:hover:not(:disabled){background:color-mix(in srgb,var(--c-pill) 80%,var(--c-text))}\n.dshd-btn:active:not(:disabled){transform:scale(.97)}\n.dshd-btn[data-tone=\"primary\"]{background:var(--c-accent);color:var(--c-on-accent)}\n.dshd-btn[data-tone=\"primary\"]:hover:not(:disabled){background:var(--c-accent-hover)}\n.dshd-btn[data-tone=\"primary\"][data-armed]{background:var(--st-failed-dot)}\n.dshd-btn[data-tone=\"bad\"]{background:transparent;color:var(--st-failed-text);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--st-failed-dot) 45%,transparent)}\n.dshd-btn[data-tone=\"bad\"]:hover:not(:disabled){background:var(--st-failed-bg)}\n.dshd-btn[data-tone=\"bad\"][data-armed]{background:var(--st-failed-dot);color:#fff;box-shadow:none}\n.dshd-btn:disabled{opacity:.45;cursor:default}\n.dshd-pill{height:26px;padding:0 12px;border:1px solid var(--c-line);border-radius:var(--r-pill);background:var(--c-raised);color:var(--c-text);font-size:12px;cursor:pointer;transition:background-color var(--dur) var(--ease),border-color var(--dur) var(--ease)}\n.dshd-pill:hover:not(:disabled){border-color:var(--c-ghost-line);background:var(--c-hover)}\n.dshd-pill[data-tone=\"bad\"]{color:var(--st-failed-text)}\n.dshd-pill[aria-pressed=\"true\"]{background:var(--st-failed-bg);border-color:transparent}\n.dshd-pill:disabled{opacity:.45;cursor:default}\n.dshd-x{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--c-text3);cursor:pointer}\n.dshd-x:hover{background:var(--c-hover);color:var(--c-text)}\n.dshd-flash{margin:0 0 var(--sp-2);padding:var(--sp-2) var(--sp-3);border-radius:10px;background:var(--st-done-bg);color:var(--st-done-text);font-size:12px;line-height:18px;overflow-wrap:anywhere}\n.dshd-flash[data-tone=\"bad\"]{background:var(--st-failed-bg);color:var(--st-failed-text)}\n\n/* \u7B49\u4F60\u786E\u8BA4 */\n.dshd-ap{display:flex;flex-direction:column;gap:var(--sp-2);margin:var(--sp-3) var(--sp-2) 0}\n.dshd-cap{display:flex;align-items:center;gap:6px;padding:0 var(--sp-1);font-size:12px;font-weight:600;color:var(--c-text)}\n.dshd-cap-dot{width:7px;height:7px;border-radius:50%;background:var(--st-blocked-dot);box-shadow:0 0 0 3px color-mix(in srgb,var(--st-blocked-dot) 22%,transparent)}\n.dshd-cap-n{min-width:18px;height:18px;padding:0 6px;border-radius:var(--r-pill);background:var(--c-pill);color:var(--c-text2);font-size:11px;line-height:18px;text-align:center;font-variant-numeric:tabular-nums}\n.dshd-card{display:flex;flex-direction:column;gap:6px;padding:14px 16px;border-radius:var(--r-card);background:var(--c-raised);box-shadow:var(--shadow-1),inset 0 0 0 1px var(--c-line-soft);animation:dshd-in .24s var(--ease)}\n@keyframes dshd-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}\n.dshd-card-top{display:flex;align-items:center;gap:6px;font-size:11px;line-height:16px}\n.dshd-kind{padding:1px 8px;border-radius:var(--r-pill);background:var(--c-surface);color:var(--c-text2);font-weight:600}\n.dshd-kind[data-kind=\"merge\"]{background:var(--st-running-bg);color:var(--st-running-text)}\n.dshd-kind[data-kind=\"ops\"]{background:var(--st-blocked-bg);color:var(--st-blocked-text)}\n.dshd-rev{color:var(--c-text3)}\n.dshd-rev[data-rev=\"no\"]{color:var(--st-failed-text)}\n.dshd-when{margin-left:auto;color:var(--c-text3);font-variant-numeric:tabular-nums}\n.dshd-card-title{margin:0;font-size:14px;font-weight:600;line-height:20px;letter-spacing:-.01em;color:var(--c-text)}\n.dshd-target{display:block;max-width:100%;padding:6px 10px;border-radius:8px;background:var(--c-surface);color:var(--c-text);font-family:var(--f-mono);font-size:11.5px;line-height:17px;overflow-wrap:anywhere;text-decoration:none;white-space:pre-wrap}\na.dshd-target{color:var(--c-accent)}\na.dshd-target:hover{text-decoration:underline}\n.dshd-reason{margin:0;font-size:12px;line-height:18px;color:var(--c-text2);white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}\n.dshd-from{margin:0;font-size:11px;color:var(--c-text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dshd-card-btns{display:flex;justify-content:flex-end;gap:var(--sp-2);margin-top:2px}\n.dshd-reject{display:flex;gap:var(--sp-2);align-items:center;margin-top:2px}\n.dshd-reject input,.dshd-field input,.dshd-field select,.dshd-batch select,.dshd-confirm select{flex:1 1 auto;min-width:0;height:30px;padding:0 10px;border:1px solid var(--c-line);border-radius:8px;background:var(--c-raised);color:var(--c-text);font:inherit;font-size:12.5px}\n.dshd-reject input:focus,.dshd-field input:focus,.dshd-field select:focus,.dshd-batch select:focus{outline:none;border-color:var(--c-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--c-accent) 22%,transparent)}\n\n/* \u5B9E\u65F6\u8F93\u51FA */\n.dshd-live{position:relative;margin:2px var(--sp-2) var(--sp-3) 20px;border-radius:var(--r-card);background:var(--c-raised);box-shadow:var(--shadow-1),inset 0 0 0 1px var(--c-line-soft);overflow:hidden;animation:dshd-in .24s var(--ease)}\n.dshd-live-head{display:flex;align-items:center;gap:6px;min-width:0;padding:10px 8px 4px 12px}\n.dshd-live-acts{display:flex;gap:6px;flex-wrap:wrap;padding:0 12px 10px;border-bottom:1px solid var(--c-line-soft)}\n.dshd-live-acts:empty{display:none}\n.dshd-live-dot{width:7px;height:7px;border-radius:50%;background:var(--c-text3)}\n.dshd-live-dot[data-on]{background:var(--st-running-dot);animation:dshrc-pulse 1.6s ease-in-out infinite}\n.dshd-live-title{font-size:12px;font-weight:600}\n.dshd-live-state{font-size:11px;color:var(--c-text3)}\n.dshd-live-body{max-height:320px;overflow:auto;padding:8px 0;background:var(--c-code);scrollbar-width:thin}\n.dshd-live-empty{padding:20px;text-align:center;color:var(--c-text3);font-size:12px}\n.dshd-seg{margin:0 8px;padding:6px 8px 6px 10px;border-left:2px solid transparent;border-radius:6px}\n.dshd-seg+.dshd-seg{margin-top:2px}\n.dshd-seg[data-error]{border-left-color:var(--st-failed-dot);background:var(--st-failed-bg)}\n.dshd-seg-head{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:12px;line-height:18px}\n.dshd-seg-prompt{flex:none;color:var(--c-text3);font-family:var(--f-mono)}\n.dshd-seg-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--f-mono);font-size:11.5px;color:var(--c-text)}\n.dshd-seg[data-kind=\"message\"] .dshd-seg-title{font-family:var(--f-ui);color:var(--c-text3);font-size:11px}\n.dshd-seg[data-kind=\"end\"] .dshd-seg-title{font-family:var(--f-ui);color:var(--c-text3);font-size:11px}\n.dshd-seg-tag{flex:none;padding:0 6px;border-radius:var(--r-pill);background:var(--st-failed-dot);color:#fff;font-size:10.5px;line-height:16px;font-weight:600}\n.dshd-seg-spin{flex:none;width:10px;height:10px;border:1.5px solid var(--c-line);border-top-color:var(--st-running-dot);border-radius:50%;animation:dshrc-spin .8s linear infinite}\n.dshd-seg-time{flex:none;color:var(--c-text3);font-size:10.5px;font-variant-numeric:tabular-nums}\n.dshd-seg-body{margin:4px 0 0 14px;max-height:180px;overflow:auto;font-family:var(--f-mono);font-size:11px;line-height:16px;color:var(--c-text2);white-space:pre-wrap;overflow-wrap:anywhere}\n.dshd-seg[data-error] .dshd-seg-body{color:var(--st-failed-text)}\n.dshd-seg[data-kind=\"message\"] .dshd-seg-body{font-family:var(--f-ui);font-size:12px;line-height:18px;color:var(--c-text)}\n.dshd-jump{position:absolute;right:12px;bottom:10px;height:26px;padding:0 12px;border:0;border-radius:var(--r-pill);background:var(--c-accent);color:var(--c-on-accent);font-size:11.5px;box-shadow:var(--shadow-2);cursor:pointer}\n\n/* \u6539\u6D3E dialog */\n.dshd-scrim{position:absolute;inset:0;z-index:20;display:flex;align-items:flex-start;justify-content:center;padding:56px 12px 12px;background:var(--c-scrim);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:dshd-fade .18s var(--ease)}\n@keyframes dshd-fade{from{opacity:0}to{opacity:1}}\n.dshd-dialog{display:flex;flex-direction:column;gap:12px;width:100%;max-width:420px;max-height:100%;overflow:auto;padding:20px;border-radius:18px;background:var(--c-raised);box-shadow:var(--shadow-2);animation:dshd-in .22s var(--ease)}\n.dshd-dialog-title{margin:0;font-size:17px;font-weight:600;letter-spacing:-.02em}\n.dshd-dialog-sub{margin:-6px 0 0;font-size:12.5px;color:var(--c-text2)}\n.dshd-dialog-why{display:flex;flex-direction:column;gap:2px;margin:0;padding:8px 10px;border-radius:10px;background:var(--st-failed-bg);color:var(--st-failed-text);font-size:12px;line-height:17px;overflow-wrap:anywhere}\n.dshd-dialog-why span{font-size:11px;font-weight:600}\n.dshd-field{display:flex;flex-direction:column;gap:4px;font-size:11.5px;font-weight:500;color:var(--c-text2)}\n.dshd-choice{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0;padding:0;border:0}\n.dshd-choice legend{margin-bottom:4px;padding:0;font-size:11.5px;font-weight:500;color:var(--c-text2)}\n.dshd-choice label{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border-radius:12px;background:var(--c-surface);box-shadow:inset 0 0 0 1px transparent;cursor:pointer;transition:box-shadow var(--dur) var(--ease),background-color var(--dur) var(--ease)}\n.dshd-choice label[data-on]{background:var(--c-raised);box-shadow:inset 0 0 0 2px var(--c-accent)}\n.dshd-choice input{margin:3px 0 0;accent-color:var(--c-accent)}\n.dshd-choice span{display:flex;flex-direction:column;gap:2px;min-width:0}\n.dshd-choice b{font-size:13px;font-weight:600;color:var(--c-text)}\n.dshd-choice small{font-size:11px;line-height:15px;color:var(--c-text3)}\n.dshd-dialog-err{margin:0;color:var(--st-failed-text);font-size:12px;overflow-wrap:anywhere}\n.dshd-dialog-btns{display:flex;justify-content:flex-end;gap:var(--sp-2)}\n\n/* \u6279\u91CF */\n.dshd-batch{display:flex;flex-direction:column;gap:var(--sp-2);margin:var(--sp-3) var(--sp-2) 0;padding:12px;border-radius:var(--r-card);background:var(--c-surface)}\n.dshd-batch-filters{display:flex;gap:6px;flex-wrap:wrap}\n.dshd-batch-filters select{flex:1 1 120px}\n.dshd-causes{display:flex;flex-direction:column;gap:4px}\n.dshd-cause{display:flex;align-items:center;gap:8px;min-width:0;padding:6px 10px;border:0;border-radius:10px;background:var(--c-raised);color:var(--c-text);font-size:12px;text-align:left;cursor:pointer;box-shadow:inset 0 0 0 1px var(--c-line-soft)}\n.dshd-cause:hover{box-shadow:inset 0 0 0 1px var(--c-ghost-line)}\n.dshd-cause-n{flex:none;min-width:22px;height:20px;padding:0 6px;border-radius:var(--r-pill);background:var(--st-failed-bg);color:var(--st-failed-text);font-weight:600;font-size:11px;line-height:20px;text-align:center}\n.dshd-cause-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--f-mono);font-size:11px}\n.dshd-batch-row{display:flex;align-items:center;gap:var(--sp-2);font-size:12px}\n.dshd-check{display:inline-flex;align-items:center;gap:6px;cursor:pointer}\n.dshd-check input,.dshrc-pick{accent-color:var(--c-accent)}\n.dshd-batch-n{color:var(--c-text3);font-variant-numeric:tabular-nums}\n.dshd-batch-acts{display:flex;gap:6px;flex-wrap:wrap}\n.dshd-confirm{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:12px;background:var(--c-raised);box-shadow:var(--shadow-1)}\n.dshd-confirm p{margin:0;font-size:13px;font-weight:600}\n.dshd-confirm-list{margin:0;padding-left:18px;font-size:12px;color:var(--c-text2)}\n.dshd-result{position:relative;display:flex;flex-wrap:wrap;gap:4px 10px;padding:10px 36px 10px 12px;border-radius:12px;background:var(--c-raised);font-size:12px}\n.dshd-result [data-tone=\"ok\"]{color:var(--st-done-text);font-weight:600}\n.dshd-result [data-tone=\"bad\"]{color:var(--st-failed-text);font-weight:600}\n.dshd-result ul{flex-basis:100%;margin:0;padding-left:16px;color:var(--c-text2)}\n.dshd-result li b{margin-right:6px;color:var(--c-text);font-weight:500}\n.dshd-result .dshd-x{position:absolute;top:6px;right:6px}\n";
export {};
