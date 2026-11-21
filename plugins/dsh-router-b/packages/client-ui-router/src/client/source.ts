/**
 * Where the board's data comes from.
 *
 * The panel never talks to the network itself: it reads one {@link BoardSource}.
 * Three implementations exist —
 *
 * - `createHttpSource` — the real path. It calls the host plugin's same-origin
 *   HTTP bridge (`/api/router/*`, mounted by `packages/host-router` on
 *   `ctx.webServer`), which answers the panel's document, accepts demands, and
 *   records verification verdicts. No Harness Remote is involved: the bridge is
 *   ordinary HTTP because the Web shell is served by the same web server, so a
 *   relative `fetch` needs no new transport and no Typert declaration.
 * - `createHostSource` — the Remote surface (`ctx.remote.router`) this file was
 *   originally written against. Kept because it is the documented contract in
 *   `docs/CONTRACT.md` and because a Host that later publishes that Remote keeps
 *   working; the router bundle does not publish one today.
 * - `createMockSource` — built-in sample data, used when the Host half is not
 *   installed or has never answered. The panel labels itself `mock` so nobody
 *   mistakes the demo for live state.
 *
 * Swapping the source is one line in `index.ts`; nothing in the view knows which
 * one it is reading.
 */

import type {
  ApprovalsView, ApprovalView, AuditEntryView, BatchAction, BatchResultView, LiveView, ModelChoiceView, ReassignInput, ReassignResult,
  BoardSnapshot, CredentialView, FileListingView, MemoryNoteView, PartitionMemoryView, HostTaskState, PublishResult, TaskState, TaskView,
} from './contract.ts'
import { createMockSource } from './mock.ts'

/** The one seam between the view and the router. */
export interface BoardSource {
  /** Whether this source is live Host data or built-in sample data. */
  readonly origin: 'host' | 'mock'
  /**
   * Read one consistent board snapshot.
   * @returns the snapshot the panel renders.
   */
  read(): Promise<BoardSnapshot>
  /**
   * Publish one or more demands; the router assigns partitions.
   * @param demands - raw demand text, one entry per line the user submitted.
   * @returns what the router accepted and where it routed each demand.
   */
  publish(demands: readonly string[]): Promise<PublishResult>
  /**
   * Record a verification decision on a reported task.
   * @param taskId - the task being judged.
   * @param verdict - `verified` accepts, `rejected` sends it back.
   * @param note - why it was rejected.
   */
  verify(taskId: string, verdict: Extract<TaskState, 'verified' | 'rejected'>, note?: string): Promise<void>
  /**
   * Run one `task_control` action on a task. Optional: a source without it
   * renders the control as "not wired" instead of pretending.
   * @param taskId - the task.
   * @param action - the `task_control` action; only `resume` is used today.
   * @param value - the action's optional `value` argument.
   * @param extra - `suspend` only: the prerequisite to create, or ids to wait for.
   */
  control?(taskId: string, action: ControlAction, value?: string, extra?: ControlExtra): Promise<void>
  /**
   * List one directory level of one partition. Optional: a source without it
   * renders the workspace page as "not available".
   */
  listFiles?(partition: string, path: string): Promise<FileListingView>
  /** A partition's memory (notes, recent work, sessions); optional like `listFiles`. */
  readMemory?(partition: string): Promise<PartitionMemoryView>
  /** Add one note to a partition's memory. */
  addMemoryNote?(partition: string, text: string): Promise<MemoryNoteView>
  /** Remove one note from a partition's memory. */
  removeMemoryNote?(partition: string, id: string): Promise<void>
  /** Outlet actions waiting for a human, and the latest decided ones. */
  readApprovals?(): Promise<ApprovalsView>
  /** Approve (run once) or reject one approval. */
  decideApproval?(id: string, decision: 'approve' | 'reject', note?: string): Promise<ApprovalView>
  /** Newest audit lines. */
  readAudit?(limit?: number): Promise<readonly AuditEntryView[]>
  /** A worker's output since segment `after`. */
  readLive?(taskId: string, after?: number): Promise<LiveView>
  /** Models the runtime offers (for 换模型). */
  listModels?(): Promise<readonly ModelChoiceView[]>
  /** 改派 / 换模型. */
  reassign?(input: ReassignInput): Promise<ReassignResult>
  /** One action over many rows. */
  batch?(taskIds: readonly string[], action: BatchAction, value?: string): Promise<BatchResultView>
  /**
   * Observe Host-side changes.
   * @param listener - called whenever the board may have changed.
   * @returns unsubscribe.
   */
  subscribe(listener: () => void): () => void
}

/** `task_control` actions the panel may send. */
export type ControlAction = 'resume' | 'suspend' | 'retry' | 'cancel' | 'cancel_tree'

/** Extra arguments of a `suspend`. */
export interface ControlExtra {
  /** A prerequisite task to create and wait for. */
  readonly prerequisite?: string
  /** Existing task ids to wait for. */
  readonly waitFor?: readonly string[]
}

/** The Remote surface the Host half is expected to expose (`ctx.remote.router`). */
export interface RouterRemoteLike {
  board(): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>
  publish(request: { demands: readonly string[] }): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>
  verify(request: { taskId: string; verdict: 'verified' | 'rejected'; note?: string }): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>
}

/** Five panel states; anything else on `state` is a Host state passed through. */
const PANEL_STATES: ReadonlySet<string> = new Set(['queued', 'running', 'reported', 'verified', 'rejected'])
/** Projection for Host states that may arrive on `state` (mirrors host-router `STATE_TO_UI`). */
const HOST_TO_PANEL: Readonly<Record<string, TaskState>> = {
  dispatched: 'running', interrupted: 'running', blocked: 'queued',
  done: 'verified', failed: 'rejected', cancelled: 'rejected',
}

/**
 * Keep `state` inside the five panel states.
 *
 * The bridge currently sends `state: 'queued'` + `hostState: 'blocked'` for a
 * parked row; a Host that passes `blocked` straight through on `state` must not
 * break the views that index tables by `state`. The raw value then moves to
 * `hostState` (unless the Host already sent one), so grouping still sees it.
 */
function normalizeTask(task: TaskView): TaskView {
  const raw = task.state as string
  if (PANEL_STATES.has(raw)) return task
  const projected = HOST_TO_PANEL[raw] ?? 'queued'
  return { ...task, state: projected, hostState: task.hostState ?? (raw as HostTaskState) }
}

/**
 * Narrow an unknown wire value into a board snapshot without trusting its shape.
 * A Host that drifts from the contract yields `undefined` rather than a crash in
 * the middle of a render.
 * @param value - decoded wire value.
 * @returns the snapshot, or undefined when the payload is not one.
 */
export function asBoardSnapshot(value: unknown): BoardSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<BoardSnapshot>
  if (!Array.isArray(candidate.partitions) || !Array.isArray(candidate.tasks) || !Array.isArray(candidate.demands)) return undefined
  return {
    fetchedAt: typeof candidate.fetchedAt === 'string' ? candidate.fetchedAt : new Date().toISOString(),
    partitions: candidate.partitions,
    tasks: candidate.tasks.map(normalizeTask),
    demands: candidate.demands,
    origin: 'host',
    ...(typeof candidate.staleSince === 'string' ? { staleSince: candidate.staleSince } : {}),
    // Additive fields are forwarded only when the Host sent them, so a view can
    // tell "the Host did not describe credentials" from "it described none".
    ...(Array.isArray(candidate.credentials) ? { credentials: candidate.credentials as readonly CredentialView[] } : {}),
    ...(Array.isArray(candidate.groups) ? { groups: candidate.groups } : {}),
    ...(Array.isArray(candidate.notices) ? { notices: candidate.notices } : {}),
  }
}

/**
 * Build the source that talks to the Host router bundle.
 * @param remote - `ctx.remote.router` from the client Context.
 * @param subscribeChanges - Host change feed (`ctx.remote.$on('router/changed', …)`).
 * @returns a live BoardSource.
 */
export function createHostSource(
  remote: RouterRemoteLike,
  subscribeChanges: (listener: () => void) => () => void,
): BoardSource {
  return {
    origin: 'host',
    async read() {
      const result = await remote.board()
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      const snapshot = asBoardSnapshot(result.value)
      if (snapshot === undefined) throw new Error('router/board returned a payload that is not a BoardSnapshot')
      return snapshot
    },
    async publish(demands) {
      const result = await remote.publish({ demands })
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return result.value as PublishResult
    },
    async verify(taskId, verdict, note) {
      const result = await remote.verify({ taskId, verdict, ...(note === undefined ? {} : { note }) })
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    },
    subscribe(listener) {
      return subscribeChanges(listener)
    },
  }
}

/**
 * Where the Host's HTTP bridge lives.
 *
 * Mirrors `BRIDGE_BASE` in `packages/host-router/src/bridge.ts`; the two are
 * deployed together, so this constant is the whole coupling.
 */
export const BRIDGE_BASE = '/api/router'

/** How often the board is re-read when the event stream is unavailable. */
const POLL_INTERVAL_MS = 5_000

/** Options for {@link createHttpSource}. */
export interface HttpSourceOptions {
  /** Bridge prefix; defaults to {@link BRIDGE_BASE}. */
  readonly base?: string
  /**
   * Source rendered while the Host has never answered.
   *
   * A panel that has never reached the Host is a labelled demo, not a blank
   * column — the same rule the Remote path had. Once a live read has succeeded
   * this is never consulted again: a stale real board is shown as stale, never
   * silently replaced by sample data.
   */
  readonly fallback?: BoardSource
  /** Injected for a test; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch
}

/** Resolve `fetch` without throwing in an environment that has none (a test VM). */
function fetchOf(options: HttpSourceOptions): typeof fetch | undefined {
  if (options.fetchImpl !== undefined) return options.fetchImpl
  return typeof fetch === 'function' ? fetch : undefined
}

/** Pull a `{ error: { code, message } }` message out of a decoded body. */
function errorMessageOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const error = (body as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = error as { code?: unknown; message?: unknown }
  const code = typeof candidate.code === 'string' ? candidate.code : undefined
  const message = typeof candidate.message === 'string' ? candidate.message : undefined
  if (code === undefined && message === undefined) return undefined
  return [code, message].filter(part => part !== undefined).join(': ')
}

/**
 * Call one bridge endpoint and decode its JSON answer.
 * @param doFetch - the `fetch` implementation to use.
 * @param url - request URL, relative to the page origin.
 * @param init - method, headers, body.
 * @returns the decoded body (undefined for an empty body).
 * @throws {Error} when the request fails or the bridge answers with a non-2xx status.
 */
/** Upper bound for one bridge request before it counts as failed. */
export const REQUEST_TIMEOUT_MS = 10_000

/**
 * Upper bound for the board read. The host rebuilds the whole board on each
 * read and, on a large board, that takes well over 10s; a tighter bound turned
 * a slow-but-healthy read into a permanent error banner.
 */
export const BOARD_TIMEOUT_MS = 90_000

async function requestJson(
  doFetch: typeof fetch,
  url: string,
  init?: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  // A hung bridge must not leave the panel on "loading" forever: abort after
  // REQUEST_TIMEOUT_MS and surface it as an ordinary, retryable read error.
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  let timedOut = false
  const timer = controller === undefined ? undefined : setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  let response: Response
  let text: string
  try {
    response = await doFetch(url, controller === undefined ? init : { ...init, signal: controller.signal })
    text = await response.text()
  } catch (error) {
    if (timedOut) throw new Error(`router bridge timed out after ${String(timeoutMs / 1000)}s: ${url}`)
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  let body: unknown
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
  }
  if (!response.ok) {
    const detail = errorMessageOf(body) ?? (text.trim() === '' ? response.statusText : text.trim().slice(0, 200))
    throw new Error(`router bridge ${String(response.status)}: ${detail === '' ? 'no detail' : detail}`)
  }
  return body
}

/** JSON POST headers, and the body for a value. */
function jsonPost(value: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  }
}

/** Narrow a publish answer without trusting its shape. */
function asPublishResult(value: unknown): PublishResult {
  if (typeof value !== 'object' || value === null) throw new Error('publish returned a payload that is not a PublishResult')
  const candidate = value as Partial<PublishResult>
  if (typeof candidate.accepted !== 'number' || !Array.isArray(candidate.routed)) {
    throw new Error('publish returned a payload that is not a PublishResult')
  }
  return { accepted: candidate.accepted, routed: candidate.routed }
}

/**
 * Build the source that talks to the Host's HTTP bridge.
 * @param options - bridge prefix, sample fallback, and a test `fetch`.
 * @returns a live BoardSource.
 */
export function createHttpSource(options: HttpSourceOptions = {}): BoardSource {
  const base = options.base ?? BRIDGE_BASE
  const fallback = options.fallback
  const doFetch = fetchOf(options)
  /** Whether a live read has ever succeeded; decides if the fallback may speak. */
  let live = false

  const requireFetch = (): typeof fetch => {
    if (doFetch === undefined) throw new Error('this environment has no fetch(); the router bridge is unreachable')
    return doFetch
  }

  return {
    origin: 'host',
    async read() {
      try {
        const payload = await requestJson(requireFetch(), `${base}/board`, {
          headers: { accept: 'application/json' },
        }, BOARD_TIMEOUT_MS)
        const snapshot = asBoardSnapshot(payload)
        if (snapshot === undefined) {
          throw new Error('GET /api/router/board returned a payload that is not a BoardSnapshot')
        }
        live = true
        return snapshot
      } catch (error) {
        if (live || fallback === undefined) throw error
        // Never reached the Host: show the sample board, which keeps
        // `origin: 'mock'` so every view labels it 示例数据. Only used when a
        // caller opts in with `fallback`; the real panel does not.
        const sample = await fallback.read()
        return { ...sample, staleSince: new Date().toISOString() }
      }
    },
    async publish(demands) {
      const payload = await requestJson(requireFetch(), `${base}/publish`, jsonPost({ demands }))
      return asPublishResult(payload)
    },
    async verify(taskId, verdict, note) {
      await requestJson(
        requireFetch(),
        `${base}/verify`,
        jsonPost({ taskId, verdict, ...(note === undefined ? {} : { note }) }),
      )
    },
    async control(taskId, action, value, extra) {
      // Same transport as verify: the Host maps this onto `task_control`
      // (`{ task_id, action, value }`), so the board row changes exactly as the
      // tool would change it.
      await requestJson(
        requireFetch(),
        `${base}/control`,
        jsonPost({
          taskId,
          action,
          ...(value === undefined ? {} : { value }),
          ...(extra?.prerequisite === undefined || extra.prerequisite === '' ? {} : { prerequisite: extra.prerequisite }),
          ...(extra?.waitFor === undefined || extra.waitFor.length === 0 ? {} : { waitFor: extra.waitFor }),
        }),
      )
    },
    async listFiles(partition, path) {
      const query = new URLSearchParams({ partition, path })
      const body = await requestJson(requireFetch(), `${base}/files?${query.toString()}`)
      if (typeof body !== 'object' || body === null || !Array.isArray((body as { entries?: unknown }).entries)) {
        throw new Error('GET /api/router/files returned a payload that is not a listing')
      }
      return body as FileListingView
    },
    async readMemory(partition) {
      const query = new URLSearchParams({ partition })
      const body = await requestJson(requireFetch(), `${base}/memory?${query.toString()}`)
      if (typeof body !== 'object' || body === null || !Array.isArray((body as { notes?: unknown }).notes)) {
        throw new Error('GET /api/router/memory returned a payload that is not a partition memory')
      }
      return body as PartitionMemoryView
    },
    async addMemoryNote(partition, text) {
      return await requestJson(requireFetch(), `${base}/memory`, jsonPost({ partition, text })) as MemoryNoteView
    },
    async removeMemoryNote(partition, id) {
      const query = new URLSearchParams({ partition, id })
      await requestJson(requireFetch(), `${base}/memory?${query.toString()}`, { method: 'DELETE' })
    },
    async readApprovals() {
      const body = await requestJson(requireFetch(), `${base}/approvals`) as Partial<ApprovalsView> | undefined
      if (body === undefined || !Array.isArray(body.pending)) throw new Error('GET /api/router/approvals returned a payload that is not an approval list')
      return { pending: body.pending, recent: Array.isArray(body.recent) ? body.recent : [] }
    },
    async decideApproval(id, decision, note) {
      return await requestJson(requireFetch(), `${base}/approvals`, jsonPost({ id, decision, ...(note === undefined || note === '' ? {} : { note }) })) as ApprovalView
    },
    async readAudit(limit = 100) {
      const body = await requestJson(requireFetch(), `${base}/audit?limit=${String(limit)}`) as { entries?: AuditEntryView[] } | undefined
      return Array.isArray(body?.entries) ? body.entries : []
    },
    async readLive(taskId, after = -1) {
      const query = new URLSearchParams({ taskId, after: String(after) })
      const body = await requestJson(requireFetch(), `${base}/live?${query.toString()}`) as Partial<LiveView> | undefined
      if (body === undefined || !Array.isArray(body.segments)) throw new Error('GET /api/router/live returned a payload that is not live output')
      return body as LiveView
    },
    async listModels() {
      const body = await requestJson(requireFetch(), `${base}/tiers`) as { models?: ModelChoiceView[] } | undefined
      return Array.isArray(body?.models) ? body.models : []
    },
    async reassign(input) {
      return await requestJson(requireFetch(), `${base}/reassign`, jsonPost(input)) as ReassignResult
    },
    async batch(taskIds, action, value) {
      return await requestJson(requireFetch(), `${base}/batch`, jsonPost({ taskIds, action, ...(value === undefined ? {} : { value }) })) as BatchResultView
    },
    subscribe(listener) {
      let stream: EventSource | undefined
      let poll: ReturnType<typeof setInterval> | undefined

      const stopPolling = (): void => {
        if (poll === undefined) return
        clearInterval(poll)
        poll = undefined
      }
      const startPolling = (): void => {
        if (poll !== undefined || typeof setInterval !== 'function') return
        poll = setInterval(listener, POLL_INTERVAL_MS)
      }

      if (typeof EventSource === 'function') {
        try {
          stream = new EventSource(`${base}/events`)
          // The bridge opens with a `hello` frame; until it arrives, and whenever
          // the stream drops, the panel polls so it never silently stops updating.
          startPolling()
          stream.addEventListener('hello', stopPolling)
          stream.addEventListener('changed', () => { listener() })
          stream.onerror = () => { startPolling() }
        } catch {
          stream = undefined
          startPolling()
        }
      } else {
        startPolling()
      }

      return () => {
        stopPolling()
        stream?.close()
        stream = undefined
      }
    },
  }
}

/**
 * The write actions the panel's rail offers, over the same bridge.
 *
 * Deliberately minimal: a control whose Host action does not exist here is left
 * out of the object, which the view renders as "not wired" instead of pretending.
 * @param options - bridge prefix and a test `fetch`.
 * @returns the actions the bridge implements.
 */
export function createHttpActions(options: { readonly base?: string; readonly fetchImpl?: typeof fetch } = {}): {
  setPartitionEnabled(partitionId: string, enabled: boolean): Promise<void>
} {
  const base = options.base ?? BRIDGE_BASE
  const doFetch = fetchOf(options)
  return {
    async setPartitionEnabled(partitionId, enabled) {
      if (doFetch === undefined) throw new Error('this environment has no fetch(); the router bridge is unreachable')
      await requestJson(doFetch, `${base}/partition`, jsonPost({ id: partitionId, enabled }))
    },
  }
}

/**
 * Pick the source for this client: the Host's HTTP bridge. A failed read is an
 * error the panel shows with a retry button; it never turns into sample tasks
 * that could pass for real ones.
 *
 * The factory parameter stays for a Host that publishes a Remote: when it is
 * supplied the caller's source wins, so nothing about the Remote path is lost.
 * @param factory - returns a source when the caller has one (a Remote).
 * @returns the source to read.
 */
export function resolveSource(factory: (() => BoardSource) | undefined): BoardSource {
  return factory === undefined ? createHttpSource() : factory()
}

export { createMockSource }
