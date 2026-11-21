/**
 * Host-side router for DeepSeek Harness: file partitions, a per-partition
 * manager, and one continuable worker session per task.
 *
 * ```
 * your session (level 1: assign)
 *   └── route_task(text) ── resolves the partition from config ──┐
 *                                                                │
 *   partition manager child (level 2: direct) ← only if enabled  │
 *     ├── route_task(text, partition, parent_task)  → new worker │
 *     └── task_resume(worker task, text)            → same worker│
 *                                                                ▼
 *   worker child, cwd = partition root, released when it settles
 * ```
 *
 * Three facts about the running build drive the plumbing, all read from the
 * installed JavaScript rather than assumed:
 *
 * 1. **`cwd` on the subagent *service* roots a child in a partition.**
 *    `startActivation({ cwd })` → `SubagentManager.resolveDirectory` (an absolute
 *    path is used verbatim) → `workingDirectory.set(child, cwd)` before the
 *    child's first turn, so sandbox policy sees the partition directory. A
 *    worker therefore needs no "cd first" step. The `subagent` *tool*'s own
 *    `cwd` parameter is not a stable surface — present in 0.2.2-rc.3, absent from
 *    the 0.2.2-rc.5 tool source — while the service keeps `cwd` in both.
 * 2. **A worker is an ordinary Session**, and `dsh-tool-todo`'s `todo_write`
 *    appends `todo/write` events to it. That log is where "how far along is this
 *    worker" comes from; the board stores the worker's `sessionId` so the UI can
 *    read it.
 * 3. **No live child survives this process.** The subagent manager's activation
 *    map is process-local, so the board is the durable record, and a row left
 *    `running` by a dead process is reconciled from its session log instead of
 *    being trusted.
 *
 * There is no human acceptance step: a worker or manager that ends normally is
 * recorded as `done` and its report flows back up the chain (worker -> manager ->
 * the 作战室 anchor conversation, which relays it to the user).
 *
 * @module host-router
 */
import { normalisePartitions, resolveRoute } from './config.ts';
import type { Partition, RouterConfig } from './config.ts';
import type { RouterTask, TaskState } from './board.ts';
import type { RouterSnapshot, TaskView } from './snapshot.ts';
import type { PluginContext } from './types.ts';
/** Stable plugin name. */
export declare const name = "host-router";
/** The tool registry and the subagent seam are hard dependencies. */
export declare const inject: string[];
/** Mount the router: partitions, board, tools, and the worker lifecycle. */
export declare function apply(ctx: PluginContext, config: RouterConfig): Promise<void>;
/** Exported so a deployment or test can validate config without booting the plugin. */
export { normalisePartitions, resolveRoute };
export type { RouterConfig, Partition, RouterTask, TaskState, RouterSnapshot, TaskView };
