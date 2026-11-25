/**
 * Shapes of the read-only admin routes served by `dsh-host-agent-hub`
 * (packages/host-agent-hub/bridge.js). Every projection there is a whitelist:
 * no token, tokenHash or poll-secret hash is ever part of these documents.
 */

/** Task lifecycle (hub.js). */
export type TaskStatus = 'pending' | 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'dead'

/** Display order of the task statuses. */
export const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'accepted', 'running', 'completed', 'failed', 'cancelled', 'dead']

/** Enrollment request lifecycle (hub.js). */
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'expired'

/**
 * Worker presence (protocol v2 §9, services/dsh-hub README §6.1):
 *   pending  approved, token not collected yet;
 *   online   heartbeat / poll / event / result within `offlineAfterMs` (90 s);
 *   offline  silent for longer (or never showed up after collecting the token);
 *   left     called `POST /v1/leave` and has not come back;
 *   revoked  revoked by a controller.
 */
export type AgentStatus = 'pending' | 'online' | 'offline' | 'left' | 'revoked'

/** Display and sort order of the agent statuses: online first, revoked last. */
export const AGENT_STATUSES: readonly AgentStatus[] = ['online', 'pending', 'offline', 'left', 'revoked']

/** One agent as the admin routes show it (bridge.js `adminAgent`). */
export interface AgentView {
  agent_id: string
  platform?: string
  mode?: 'poll' | 'push'
  capabilities: string[]
  max_concurrency?: number
  description?: string
  revoked: boolean
  online: boolean
  last_seen?: string
  reported_status?: 'idle' | 'busy'
  /**
   * Presence (dsh-agent/2.0). Absent from an older host bridge: the panel then
   * infers it from `revoked` / `online` (format.ts `agentStatus`).
   */
  status?: AgentStatus
  /** The worker's `client_version` from its last heartbeat. */
  version?: string
  /**
   * When the worker left (`POST /v1/leave`). Passed by bridge.js `adminAgent`;
   * optional because an older hub or bridge does not send it.
   */
  left_at?: string
  running_tasks: string[]
  created_at?: string
  /** Machine the agent runs on (registration). */
  node?: string
  /** Local DSH profile the agent belongs to (agents/<id>.json `dshProfile`). */
  dsh_profile?: string
  /** Revoked, or silent longer than the hub's dormant window (3 days): out of the default list. */
  dormant?: boolean
}

/** `GET /api/agent-hub/admin/overview` (hub.overview()). */
export interface Overview {
  protocol: string
  agents: AgentView[]
  task_counts: Partial<Record<TaskStatus, number>>
  /**
   * Agents per presence status. Passed by bridge.js `adminOverview` (only
   * non-negative integers for the five statuses); without it (older hub or
   * bridge) the panel counts the agent list itself (format.ts `agentCounts`).
   */
  agent_counts?: Partial<Record<AgentStatus, number>>
  pending_requests: number
  /** Tasks DSH may do itself now (no worker for them online, or busy too long). */
  fallback_due?: number
  /** Agents in 已停用. */
  dormant_agents?: number
}

/** `GET /api/agent-hub/admin/agents`. */
export interface AgentsDoc {
  generated_at: string
  online: number
  agents: AgentView[]
}

/** Structured failure attached to a result. */
export interface ResultError {
  code?: string
  message?: string
  retryable: boolean
}

/** One output file of a result (bytes stay on the host). */
export interface OutputFile {
  name: string
  bytes?: number
  type?: string
  description?: string
}

/** One row of the task list. */
export interface TaskRow {
  task_id: string
  agent: string
  assigned_to?: string
  /** Sticky routing: the worker this pool task goes to first. */
  preferred_agent?: string
  sticky_key?: string
  type: string
  title: string
  status: TaskStatus
  priority: 'low' | 'normal' | 'high'
  attempts: number
  progress?: number
  message?: string
  created_at: string
  lease_until?: string
  depends_on: string[]
  /** Controller that ran it itself when no worker took it. */
  fallback_by?: string
  /** Local DSH profile it belongs to. */
  dsh_profile?: string
  /** Who published it; `local` = a DSH ran it itself and only reports it here. */
  origin?: TaskOrigin
  /** Last reported stage of the executor. */
  stage?: TaskStage
  updated_at?: string
  finished_at?: string
  /** A failed task someone put away (it is then in 历史). */
  acknowledged?: boolean
  /** Past its expiry window: only in 历史. */
  in_history?: boolean
  /** A local task whose DSH has not reported for a while (it is never failed for that). */
  quiet?: boolean
  /** Number of session entries stored for it. */
  session_entries?: number
  result?: {
    status: 'completed' | 'failed' | 'partial'
    summary?: string
    error?: ResultError
    needs_input?: string
    output_count: number
  }
}

/** Executor stages (progress.jsonl `stage`). */
export type TaskStage = 'received' | 'started' | 'step' | 'blocked' | 'needs_input' | 'uploading'

export const TASK_STAGES: readonly TaskStage[] = ['received', 'started', 'step', 'blocked', 'needs_input', 'uploading']

export interface TaskOrigin {
  kind: 'controller' | 'agent' | 'local'
  by?: string
  /** For a local task: `dsh-self/<profile>/<partition>`. */
  executor?: string
}

/** `GET /api/agent-hub/admin/tasks`. */
export interface TasksDoc {
  generated_at: string
  filter: { status: string; agent?: string; limit: number; history?: HistoryView }
  tasks: TaskRow[]
}

/** One history event of a task. */
export interface HistoryEvent {
  at?: string
  event?: string
  message?: string
  stage?: TaskStage
}

/** Task detail (`GET /api/agent-hub/admin/task?task_id=`). */
export interface TaskDetail extends Omit<TaskRow, 'result'> {
  instruction?: string
  inputs: string[]
  output?: Record<string, unknown>
  context_keys: string[]
  history: HistoryEvent[]
  result?: {
    status: 'completed' | 'failed' | 'partial'
    summary?: string
    error?: ResultError
    needs_input?: string
    outputs: OutputFile[]
  }
  output_files: string[]
}

/** `GET /api/agent-hub/admin/task`. */
export interface TaskDoc {
  generated_at: string
  task: TaskDetail
}

/** One enrollment request. */
export interface RequestView {
  request_id: string
  status: RequestStatus
  agent_id: string
  platform?: string
  mode?: 'poll' | 'push'
  capabilities: string[]
  max_concurrency?: number
  description?: string
  from?: string
  requested_at: string
  decided_at?: string
  reason?: string
}

/** `GET /api/agent-hub/admin/requests`. */
export interface RequestsDoc {
  generated_at: string
  filter: { status: string }
  requests: RequestView[]
}

/** Task-list filter the page keeps. */
/** Which tasks a list shows: the default view, only the expired ones, or both. */
export type HistoryView = 'hide' | 'only' | 'include'

export interface TaskFilter {
  status: TaskStatus | 'all'
  agent: string
  limit: number
  /** Absent = `hide` (the hub's default). */
  history?: HistoryView
}

/** One entry of a task's stored session (already redacted by the hub). */
export interface SessionEntry {
  index?: number
  at?: string
  role?: string
  name?: string
  by?: string
  text?: string
}

export interface SessionDoc {
  generated_at: string
  task_id: string
  total: number
  next?: number
  full: boolean
  entries: SessionEntry[]
}
