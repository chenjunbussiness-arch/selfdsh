/**
 * Data source of the panel: the host plugin's same-origin, login-guarded,
 * read-only admin routes (`/api/agent-hub/admin/*`).
 *
 * `credentials: 'same-origin'` carries the Web shell's session cookie. The panel
 * reads with GET; its one write is {@link ackTask} (put a failed task away).
 * It cannot dispatch, approve or cancel anything — control stays with DSH (the
 * model tools).
 */

import type { AgentsDoc, Overview, RequestsDoc, SessionDoc, TaskDoc, TaskFilter, TaskRow, TasksDoc } from './contract.ts'

/** Where the host bridge lives. Mirrors `BRIDGE_BASE` in host-agent-hub/bridge.js. */
export const ADMIN_BASE = '/api/agent-hub/admin'

/** A failed request, with the HTTP status so the page can say "log in again". */
export class SourceError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** `{ error: { code, message } }` → parts, or `undefined`. */
function errorOf(body: unknown): { code?: string; message?: string } | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const error = (body as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return undefined
  const { code, message } = error as { code?: unknown; message?: unknown }
  return {
    code: typeof code === 'string' ? code : undefined,
    message: typeof message === 'string' ? message : undefined,
  }
}

/** GET one admin document. */
function getJson<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  const text = query.toString()
  return send<T>(`${ADMIN_BASE}/${path}${text === '' ? '' : `?${text}`}`, { method: 'GET' })
}

/** One same-origin request; errors become {@link SourceError}. */
async function send<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init, headers: { accept: 'application/json', ...(init.headers ?? {}) } })
  } catch (error) {
    throw new SourceError(error instanceof Error ? error.message : String(error), 0)
  }
  const raw = await response.text()
  let body: unknown
  if (raw.trim() !== '') {
    try { body = JSON.parse(raw) } catch { body = undefined }
  }
  if (!response.ok) {
    const parts = errorOf(body)
    throw new SourceError(parts?.message ?? `HTTP ${String(response.status)}`, response.status, parts?.code)
  }
  if (typeof body !== 'object' || body === null) throw new SourceError('empty response', response.status)
  return body as T
}

/** Task counts, agents and pending-request count in one document. */
export function fetchOverview(): Promise<Overview> {
  return getJson<Overview>('overview')
}

/** Every agent (online flag, platform, capabilities, running tasks, last heartbeat). */
export function fetchAgents(): Promise<AgentsDoc> {
  return getJson<AgentsDoc>('agents')
}

/** Newest tasks first, filtered by status and agent. */
export function fetchTasks(filter: TaskFilter): Promise<TasksDoc> {
  return getJson<TasksDoc>('tasks', {
    status: filter.status === 'all' ? undefined : filter.status,
    agent: filter.agent === '' ? undefined : filter.agent,
    limit: filter.limit,
    history: filter.history === undefined || filter.history === 'hide' ? undefined : filter.history,
  })
}

/** One task with instruction, history, result summary and output file names. */
export function fetchTask(taskId: string): Promise<TaskDoc> {
  return getJson<TaskDoc>('task', { task_id: taskId })
}

/** Enrollment requests of one status (`pending` by default, or `all`). */
export function fetchRequests(status: string): Promise<RequestsDoc> {
  return getJson<RequestsDoc>('requests', { status })
}

/** A slice of a task's stored session, from entry `after` on. */
export function fetchSession(taskId: string, after = 0, limit = 200): Promise<SessionDoc> {
  return getJson<SessionDoc>('session', { task_id: taskId, after, limit })
}

/** Put a failed task away now (it moves to 历史). */
export async function ackTask(taskId: string): Promise<TaskRow> {
  const body = await send<{ task: TaskRow }>(`${ADMIN_BASE}/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task_id: taskId }),
  })
  return body.task
}
