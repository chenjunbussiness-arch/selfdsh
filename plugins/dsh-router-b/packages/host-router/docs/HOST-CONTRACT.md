# HOST-CONTRACT — what a UI may read, and how

This is the interface between the host-side router (`packages/host-router`) and
the client-side router. Everything here is produced by the host plugin alone; the
client does not need a second host plugin, a Remote registration, or a database.

Two delivery channels exist. **Channel A is the contract**: it works regardless
of how cordis exposes services. **Channel B is an optimisation** for a host-side
bridge that can reach the service object.

---

## Channel A (guaranteed): the snapshot document

One file, rewritten atomically, containing everything a progress panel needs:

```
<boardDir>/snapshot.json
```

`boardDir` defaults to `<DSH_HOME>/router`; a deployment may override it through
the plugin config (`boardDir`). The same directory holds `board.json`, the
durable task board (raw record, channel A′ below).

### When it is rewritten

Not on a timer. It is rewritten when something changes and when someone asks:

| Trigger | Why |
|---|---|
| a worker settles (report or acceptance result) | progress actually moved |
| `task_progress` tool call | the agent asked |
| `task_board` / `task_control` / `task_resume` calls | a change happened |
| `ctx.hostRouter.snapshot()` (channel B) | the UI asked |

A UI may read the file on its own cadence (a 1–2 s poll of one file is
acceptable) or call channel B. **Do not poll one endpoint per task**: the
document is complete by design.

### Schema

```ts
interface RouterSnapshot {
  version: 1
  generatedAt: string                       // ISO-8601
  counts: Record<TaskState, number>         // aggregate, for badges
  partitions: {
    name: string
    dir: string
    workers: number                         // configured concurrency
    live: number                            // dispatched|running now
    queued: number
  }[]
  tasks: TaskView[]
}

type TaskState =
  | 'queued'      // accepted, waiting for a worker slot
  | 'dispatched'  // child session exists, its log shows no turn yet
  | 'running'     // the worker's log shows a started turn
  | 'reported'    // the worker stopped and claimed success; NOT verified
  | 'verified'    // an acceptance command passed — the only "done"
  | 'failed'      // worker error, or acceptance failed
  | 'blocked'     // parked on a human decision
  | 'cancelled'

interface TaskView {
  id: string
  partition: string
  subject: string
  state: TaskState
  level: 'manager' | 'worker'   // routing level that produced this row
  priority: number
  attempts: number
  parentId?: string             // set when a manager split a task
  sessionId?: string            // THE worker session id (open it in a panel)
  worker?: string               // subagent name inside the tree, e.g. `agent-2`
  progress: number              // 0..1 coarse progress
  todos: TodoProgress           // the worker's own list
  result?: string              // worker's closing report (a claim, truncated)
  verifyOutput?: string         // acceptance command output (truncated)
  error?: string
  createdAt: string
  updatedAt: string
}

interface TodoProgress {
  todos: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] | null
  done: number
  total: number
  current?: string              // the item marked in_progress
  ratio: string                 // "3/7"
}
```

### Why `reported` and `verified` are both present

A worker's closing message is a claim about work it cannot independently
validate; measured against real delegations, self-reported success is wrong often
enough that promoting it to "done" would corrupt the panel and every downstream
decision (arXiv:2611.04100 reports 3 of 16 delegations recording failure as done).
`reported` = a claim exists. `verified` = the partition's acceptance command
passed. A UI should render them differently: `reported` is "waiting for
acceptance", not "finished".

### Where `todos` comes from

The worker is an ordinary Session. `dsh-tool-todo`'s `todo_write` appends
`todo/write` events (`{ todos: [{ content, status }] }`) to that worker's log,
last-write-wins, **reset to null at each `turn/start`**. The host folds those
events out of the worker's log through `ctx.sessionQuery.readSession(sessionId)`,
so:

- the ratio is real durable evidence, not the worker's summary;
- it survives the worker being disposed (the log outlives the child);
- a historical list is still available by folding the same log yourself — the
  projection alone would show `null` after the next turn starts.

**Prerequisite**: the worker's preset must include `tool-todo`. The shipped web
presets do; a hand-written partition `preset` that omits it yields workers that
never write a list (the panel then shows `no todo list`, which is honest).

### `progress` semantics

`progress` is coarse and deliberately not a percentage of work:

| state | progress |
|---|---|
| queued | 0 |
| dispatched | 0.1 |
| running | `0.4 + 0.5 × done/total`, or 0.4 without a list |
| reported | 0.75 |
| verified / failed / blocked / cancelled | 1 |

---

## Channel A′ (guaranteed): the raw board

`<boardDir>/board.json`:

```json
{
  "version": 1,
  "tasks": [ { "…RouterTask": "…" } ],
  "partitions": { "<name>": { "managerSessionId": "…", "managerName": "…", "managerUpdatedAt": "…" } }
}
```

`RouterTask` is `TaskView` plus `body`, `cwd`, `reason`, `because`, `level`,
`dispatchFrom`, `reportedTo`, `runToken`, `notes`, `resumeNote`. Use this when a
panel needs the exact instruction (`body`) or the routing evidence
(`reason`/`because`). Writes are atomic; reads are safe at any time.

---

## Channel B (optional): `ctx.hostRouter`

If the running cordis build exposes `ctx.set(name, value)`, the plugin publishes:

```ts
interface HostRouterService {
  /** Full snapshot; `partition` narrows it. */
  snapshot(request?: { partition?: string }): Promise<RouterSnapshot>
  /** One task view, or undefined. */
  task(taskId: string): Promise<TaskView | undefined>
  /** Absolute path of the snapshot document (channel A). */
  readonly snapshotPath: string
}
```

Publication is feature-detected and best-effort; the plugin logs whether it
happened. **A client that relies on channel B must fall back to channel A**: the
plugin cannot guarantee `ctx.set` exists in a future build, and channel A always
exists because the plugin itself writes it.

There is deliberately **no typert `Remote` registration** in this package: a
Remote would pin the client to this plugin's method surface and to a protocol
version, while the snapshot document is stable, inspectable, and needs no bridge.

---

## Tool surface (what the *agent* calls)

| Tool | Purpose |
|---|---|
| `route_task(text, partition?, files?, subject?, priority?, parent_task?, verify?)` | publish one task; returns `{task, partition, state, worker, session}` |
| `partition_list()` | partitions, membership globs, capacity, load, acceptance commands |
| `task_board(task_id?, partition?)` | one line per task, or the full record plus children |
| `task_progress(partition?, task_id?)` | the same document as channel A, rendered for a model |
| `task_control(task_id, action, value?)` | `cancel` / `priority` / `retry` / `verify` / `block` / `note` |
| `task_resume(task_id, text)` | continue that task's existing worker session |

`task_progress` and channel A read the same builder, so the agent and the panel
cannot disagree about state.

---

## Versioning

The snapshot carries `version: 1`. A field may be **added** without a version
bump (readers ignore unknown keys); changing a field's meaning or removing one
bumps the version. `RouterTask` in `board.json` follows the same rule.
