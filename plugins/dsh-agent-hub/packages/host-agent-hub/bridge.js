/**
 * HTTP bridge for dsh-agent-hub (controller side of `dsh-agent/2.0`).
 *
 * Workers no longer talk to DSH: they connect straight to the standalone hub
 * (`services/dsh-hub`, port 7891). The old `/api/agent-hub/v1/*` worker routes
 * are gone. What remains are the read-only, DSH-login-guarded panel routes, with
 * the SAME paths and response shapes as before
 * (packages/client-ui-agent-hub/src/client/contract.ts):
 *
 *   GET  /api/agent-hub/admin/overview                      <- GET /v1/ctl/overview
 *   GET  /api/agent-hub/admin/agents                        <- GET /v1/ctl/agents
 *   GET  /api/agent-hub/admin/tasks?status=&agent=&limit=   <- GET /v1/ctl/tasks
 *   GET  /api/agent-hub/admin/task?task_id=                 <- GET /v1/ctl/task
 *   GET  /api/agent-hub/admin/requests?status=              <- GET /v1/ctl/requests
 *
 * Each route fetches from the hub (hub-client.js) and re-projects the answer
 * through the same explicit whitelists as v1: no token, token hash or poll
 * secret can pass, and anything shaped like `dsha_...` / `dshc_...` in free
 * text (summary, message, history, instruction) is masked.
 *
 * Errors are `{ error: { code, message } }`:
 *   400 bad-query                    invalid query (checked before calling the hub)
 *   405 method-not-allowed           anything but GET
 *   503 hub-unreachable              hub down, refused, DNS, TLS or timeout
 *   503 hub-not-configured | hub-token-missing | hub-token-mismatch | hub-ca-unreadable
 *   502 hub-unauthorized             the hub refused the controller token (NOT 401:
 *                                    the panel reads 401 as "log in to DSH again")
 *   502 hub-error | hub-bad-response the hub failed or answered garbage
 *   4xx <hub code>                   other hub refusals pass through (e.g. 404 task-not-found)
 *   500 internal                     unexpected; logged as a warning, no details sent
 *
 * @module host-agent-hub/bridge
 */

import { CONFIG_CODES, HubError, ID_RE, POOL_RE, TASK_ID_RE } from './hub-client.js'
import { DEFAULT_ROLE, ROLES } from './roles.js'

export const BRIDGE_BASE = '/api/agent-hub'
export const ADMIN_BASE = `${BRIDGE_BASE}/admin`

/** Task / request statuses the admin filters accept. */
export const TASK_STATUSES = ['pending', 'accepted', 'running', 'completed', 'failed', 'cancelled', 'dead']
export const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'all']
const TOKEN_RE = /dsh[ac]_[A-Za-z0-9_-]+/g

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/** Status and code the panel sees for a hub-client failure. */
export function adminFailure(error) {
  if (CONFIG_CODES.has(error.code) || error.code === 'hub-unreachable') return { status: 503, code: error.code }
  if (error.fromHub && (error.status === 401 || error.status === 403)) return { status: 502, code: 'hub-unauthorized' }
  if (error.fromHub && error.status >= 500) return { status: 502, code: 'hub-error' }
  if (error.code === 'hub-bad-response') return { status: 502, code: error.code }
  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) return { status: error.status, code: error.code }
  return { status: 502, code: 'hub-error' }
}

/** Wrap a handler: errors become `{ error: { code, message } }`. */
function guard(logger, label, redact, run) {
  return async (req, res) => {
    try {
      await run(req, res)
    } catch (error) {
      if (error instanceof HubError) {
        const { status, code } = adminFailure(error)
        sendJson(res, status, { error: { code, message: clean(redact(error.message), 2000) } })
        return
      }
      logger?.warn?.(`agent-hub: ${label} failed: ${clean(redact(error instanceof Error ? error.message : String(error)), 500)}`)
      sendJson(res, 500, { error: { code: 'internal', message: 'internal error' } })
    }
  }
}

/** Mask anything that looks like a hub token, and cap the length. */
function clean(value, max = 4000) {
  if (value === undefined || value === null) return undefined
  const text = String(value).replace(TOKEN_RE, m => `${m.slice(0, 5)}***`)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

const strings = list => (Array.isArray(list) ? list.filter(x => typeof x === 'string').map(x => clean(x, 200)) : [])
const num = value => (Number.isFinite(value) ? value : undefined)
const int = value => (Number.isInteger(value) ? value : undefined)
const text = (value, max) => (typeof value === 'string' ? clean(value, max) : undefined)
const oneOf = (value, list) => (list.includes(value) ? value : undefined)
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A small JSON object (the task's `output` spec) with tokens masked; too big → undefined. */
function cleanObject(value, max = 8000) {
  if (!plainObject(value)) return undefined
  let json
  try { json = JSON.stringify(value) } catch { return undefined }
  if (json.length > max) return undefined
  // Token characters never include quotes or backslashes, so the JSON stays valid.
  return JSON.parse(json.replace(TOKEN_RE, m => `${m.slice(0, 5)}***`))
}

/** Whitelisted agent row (never a token or hash). */
export function adminAgent(a) {
  return {
    agent_id: text(a?.agent_id ?? a?.id, 64), platform: text(a?.platform, 200), mode: oneOf(a?.mode, ['poll', 'push']), capabilities: strings(a?.capabilities),
    max_concurrency: int(a?.max_concurrency), description: text(a?.description, 1000), revoked: a?.revoked === true,
    // Additive: a hub (or an agent record) without a role is a worker.
    role: oneOf(a?.role, ROLES) ?? DEFAULT_ROLE,
    online: a?.online === true, last_seen: text(a?.last_seen, 64), reported_status: oneOf(a?.reported_status, ['idle', 'busy']),
    status: oneOf(a?.status, ['pending', 'online', 'offline', 'left', 'revoked']), version: text(a?.version, 64), left_at: text(a?.left_at, 64),
    running_tasks: strings(a?.running_tasks), created_at: text(a?.created_at, 64),
    // Additive: scheduled pullers (AWS Quick, cron) say how often they come back.
    pull_every_seconds: int(a?.pull_every_seconds), offline_after_ms: int(a?.offline_after_ms),
  }
}

function adminError(error) {
  if (!plainObject(error)) return undefined
  return { code: text(error.code, 64), message: text(error.message, 2000), retryable: error.retryable === true }
}

function adminOutputs(result) {
  return (Array.isArray(result?.outputs) ? result.outputs : []).map(o => ({
    name: clean(String(o?.name ?? ''), 200), bytes: num(o?.bytes),
    type: text(o?.type, 32), description: text(o?.description, 300),
  }))
}

/** Whitelisted task row for the list. */
export function adminTaskRow(t) {
  const outputs = adminOutputs(t?.result)
  return {
    task_id: text(t?.task_id, 96), agent: text(t?.agent, 64), assigned_to: text(t?.assigned_to, 64), type: text(t?.type, 32), title: clean(t?.title, 300),
    status: text(t?.status, 32), priority: text(t?.priority, 16), attempts: int(t?.attempts) ?? 0, progress: num(t?.progress), message: clean(t?.message, 500),
    created_at: text(t?.created_at, 64), lease_until: text(t?.lease_until, 64), depends_on: strings(t?.depends_on),
    result: !plainObject(t?.result) ? undefined : {
      status: text(t.result.status, 32), summary: clean(t.result.summary, 300), error: adminError(t.result.error),
      needs_input: clean(t.result.needs_input, 300), output_count: outputs.length,
    },
  }
}

/** Whitelisted task detail: row + instruction, inputs, history, result summary and output file names. */
export function adminTaskDetail(t) {
  const outputs = adminOutputs(t?.result)
  const row = adminTaskRow(t)
  // v1 listed input names; accept `{name}` objects too.
  const inputs = (Array.isArray(t?.inputs) ? t.inputs : []).map(i => (typeof i === 'string' ? i : i?.name)).filter(x => typeof x === 'string').map(x => clean(x, 200))
  return {
    ...row,
    instruction: clean(t?.instruction, 8000),
    inputs,
    output: cleanObject(t?.output),
    context_keys: plainObject(t?.context) ? Object.keys(t.context).slice(0, 50).map(k => clean(k, 100)) : [],
    history: (Array.isArray(t?.history) ? t.history : []).map(h => ({ at: text(h?.at, 64), event: clean(h?.event, 64), message: clean(h?.message, 500) })),
    result: !plainObject(t?.result) ? undefined : {
      status: text(t.result.status, 32), summary: clean(t.result.summary, 4000), error: adminError(t.result.error),
      needs_input: clean(t.result.needs_input, 2000), outputs,
    },
    output_files: outputs.map(o => o.name),
  }
}

/** Whitelisted enrollment request (never a poll secret or its hash). */
export function adminRequest(r) {
  return {
    request_id: text(r?.request_id, 96), status: text(r?.status, 32), agent_id: text(r?.agent_id ?? r?.id, 64), platform: text(r?.platform, 200), mode: oneOf(r?.mode, ['poll', 'push']),
    capabilities: strings(r?.capabilities), max_concurrency: int(r?.max_concurrency), description: text(r?.description, 1000),
    role: oneOf(r?.role, ROLES) ?? DEFAULT_ROLE,
    from: text(r?.from, 100), requested_at: text(r?.requested_at, 64), decided_at: text(r?.decided_at, 64), reason: text(r?.reason, 500),
  }
}

/** Overview, re-projected: `{ protocol, agents, task_counts, pending_requests }`. */
export function adminOverview(o) {
  const counts = {}
  const raw = plainObject(o?.task_counts) ? o.task_counts : {}
  for (const status of TASK_STATUSES) if (Number.isInteger(raw[status]) && raw[status] >= 0) counts[status] = raw[status]
  const agentCounts = {}
  const rawAgents = plainObject(o?.agent_counts) ? o.agent_counts : {}
  for (const status of ['pending', 'online', 'offline', 'left', 'revoked']) {
    if (Number.isInteger(rawAgents[status]) && rawAgents[status] >= 0) agentCounts[status] = rawAgents[status]
  }
  return {
    protocol: text(o?.protocol, 64) ?? 'dsh-agent/2.0',
    agents: (Array.isArray(o?.agents) ? o.agents : []).map(adminAgent),
    task_counts: counts,
    ...(Object.keys(agentCounts).length > 0 ? { agent_counts: agentCounts } : {}),
    pending_requests: Number.isInteger(o?.pending_requests) ? o.pending_requests : 0,
  }
}

/** `?status=&agent=&limit=` → validated filter for `GET /v1/ctl/tasks`. */
export function parseTaskQuery(q) {
  const status = (q.get('status') ?? '').trim()
  const agent = (q.get('agent') ?? '').trim()
  const limitText = (q.get('limit') ?? '').trim()
  const filter = {}
  if (status !== '' && status !== 'all') {
    if (!TASK_STATUSES.includes(status)) throw new HubError(400, 'bad-query', `status must be one of all, ${TASK_STATUSES.join(', ')}`)
    filter.status = status
  }
  if (agent !== '') {
    if (!ID_RE.test(agent) && !POOL_RE.test(agent)) throw new HubError(400, 'bad-query', 'agent must be an agent id or pool:<capability>')
    filter.agent = agent
  }
  filter.limit = 50
  if (limitText !== '') {
    const n = Number(limitText)
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new HubError(400, 'bad-query', 'limit must be an integer 1..200')
    filter.limit = n
  }
  return filter
}

/**
 * @param {{ client: ReturnType<typeof import('./hub-client.js').createHubClient>, logger?: any }} deps
 * @returns {{ adminRoutes: any[] }}
 */
export function createRoutes({ client, logger }) {
  const redact = typeof client?.redact === 'function' ? client.redact : (x => String(x))

  /** Read-only admin GET; the caller wraps it in requireLogin. */
  const adminGet = (path, label, fn) => ({
    kind: 'exact',
    path: `${ADMIN_BASE}/${path}`,
    handler: guard(logger, label, redact, async (req, res) => {
      if (req.method !== 'GET') throw new HubError(405, 'method-not-allowed', 'use GET')
      const q = new URL(req.url ?? '/', 'http://localhost').searchParams
      sendJson(res, 200, await fn(q))
    }),
  })

  const adminRoutes = [
    adminGet('overview', 'overview', async () => adminOverview(await client.overview())),
    adminGet('agents', 'admin-agents', async () => {
      const agents = (await client.listAgents()).map(adminAgent)
      return { generated_at: new Date().toISOString(), online: agents.filter(a => a.online).length, agents }
    }),
    adminGet('tasks', 'admin-tasks', async (q) => {
      const filter = parseTaskQuery(q)
      const tasks = (await client.listTasks(filter)).map(adminTaskRow)
      return { generated_at: new Date().toISOString(), filter: { status: filter.status ?? 'all', agent: filter.agent, limit: filter.limit }, tasks }
    }),
    adminGet('task', 'admin-task', async (q) => {
      const id = (q.get('task_id') ?? '').trim()
      if (!TASK_ID_RE.test(id)) throw new HubError(400, 'bad-query', 'task_id is required')
      return { generated_at: new Date().toISOString(), task: adminTaskDetail(await client.getTask(id)) }
    }),
    adminGet('requests', 'admin-requests', async (q) => {
      const status = (q.get('status') ?? '').trim() || 'pending'
      if (!REQUEST_STATUSES.includes(status)) throw new HubError(400, 'bad-query', `status must be one of ${REQUEST_STATUSES.join(', ')}`)
      const requests = (await client.listRequests(status)).map(adminRequest)
      return { generated_at: new Date().toISOString(), filter: { status }, requests }
    }),
  ]
  return { adminRoutes }
}

/** Same login re-check as host-token-stats: a plugin route outranks `/api`. */
export function requireLogin(route, connection) {
  return {
    ...route,
    handler: async (req, res) => {
      const check = connection()
      const rejection = typeof check?.requestRejection === 'function' ? check.requestRejection(req) : 503
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(rejection === 401 ? 'unauthorized' : rejection === 403 ? 'forbidden' : 'login service unavailable')
        return
      }
      await route.handler(req, res)
    },
  }
}
