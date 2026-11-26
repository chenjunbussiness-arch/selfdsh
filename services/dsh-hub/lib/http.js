/**
 * HTTP layer of dsh-hub (protocol dsh-agent/2.0, docs/DSH-HUB-PROTOCOL-v2.md section 5).
 *
 * Every request:
 *   1. client address (socket.remoteAddress; X-Forwarded-For only with
 *      trustProxy: true, and then its RIGHTMOST hop) must pass the allow list;
 *   2. path + method must be a known route (404 / 405);
 *   3. except /v1/health, `?id=<registered name>` is required (exactly once);
 *      a token in the query is refused;
 *   4. token routes: header X-DSH-Token must be valid (401), belong to `id`
 *      (401) and have the route's role: worker (dsha_) or controller (dshc_)
 *      (403);
 *   5. POST bodies must be application/json and under the route's limit
 *      (16 KiB enroll/heartbeat, 64 KiB event and small control calls,
 *      maxResultBytes (20 MiB) result and dispatch).
 * Errors are always `{ error: { code, message } }`; a 500 never carries details.
 * `GET /v1/health` and the 403 `ip-not-allowed` answer also carry `client_ip`:
 * the address the hub saw for THIS request (after the trustProxy rule), so a
 * client behind a proxy node learns which exit IP to put into `allow`.
 *
 * @module dsh-hub/http
 */

import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'

import { AGENT_ID_RE, HubError, MAX_WAIT_SECONDS, POOL_RE, PROFILE_RE, TASK_ID_RE, VERSION, WORKSPACE_RE } from './hub.js'
import { MCP_PATH, McpGateway, TOKEN_PATH } from './mcp.js'

export const API_BASE = '/v1'
export const TOKEN_HEADER = 'x-dsh-token'
export const SMALL_BODY = 16 * 1024
export const EVENT_BODY = 64 * 1024
export const DEFAULT_MAX_RESULT_BYTES = 20 * 1024 * 1024
export const TASK_STATUSES = ['pending', 'accepted', 'running', 'waiting_input', 'completed', 'failed', 'cancelled', 'dead']
export const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'all']

// --- addresses and the allow list ---------------------------------------------

/** Strict dotted IPv4 -> uint32, or undefined. */
export function parseIPv4(text) {
  if (typeof text !== 'string') return undefined
  const parts = text.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return undefined
    const n = Number(part)
    if (n > 255) return undefined
    value = value * 256 + n
  }
  return value >>> 0
}

/** IPv6 text -> 8 lowercase hex groups without leading zeros, or undefined. */
export function expandIPv6(text) {
  if (typeof text !== 'string' || text === '' || !/^[0-9a-fA-F:.]+$/.test(text)) return undefined
  let s = text.toLowerCase()
  // Embedded IPv4 tail (::ffff:1.2.3.4, ::1.2.3.4).
  const lastColon = s.lastIndexOf(':')
  if (s.includes('.')) {
    const v4 = parseIPv4(s.slice(lastColon + 1))
    if (v4 === undefined) return undefined
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return undefined
  const head = halves[0] === '' ? [] : halves[0].split(':')
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : []
  let groups
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length
    if (fill < 1) return undefined
    groups = [...head, ...Array(fill).fill('0'), ...tail]
  } else {
    groups = head
  }
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return undefined
  return groups.map(g => parseInt(g, 16).toString(16))
}

/**
 * Canonical form for comparison: IPv4 dotted (also for ::ffff:a.b.c.d and its
 * hex form), IPv6 as 8 expanded groups. Brackets and zone ids are dropped.
 */
export function normalizeIp(raw) {
  if (typeof raw !== 'string') return undefined
  let ip = raw.trim()
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1)
  const zone = ip.indexOf('%')
  if (zone >= 0) ip = ip.slice(0, zone)
  const v4 = parseIPv4(ip)
  if (v4 !== undefined) return ipv4Text(v4)
  const groups = expandIPv6(ip)
  if (groups === undefined) return undefined
  if (groups.slice(0, 6).join(':') === '0:0:0:0:0:ffff') {
    return ipv4Text(((parseInt(groups[6], 16) << 16) | parseInt(groups[7], 16)) >>> 0)
  }
  return groups.join(':')
}

const ipv4Text = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')

/**
 * Compile the `allow` list. Entries: IPv4 address or CIDR (`1.2.3.4`,
 * `10.0.0.0/8`), IPv6 exact address (`2001:db8::1`, optionally `/128`),
 * `::ffff:1.2.3.4` (treated as IPv4). Throws on anything else, including IPv6
 * prefixes (only exact IPv6 matching is supported). An empty list allows all.
 */
export function compileAllow(list) {
  if (list === undefined || list === null) list = []
  if (!Array.isArray(list)) throw new Error('allow must be a list of addresses / CIDRs')
  const rules = list.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') throw new Error(`allow: invalid entry ${JSON.stringify(entry)}`)
    const [addr, bitsText, extra] = entry.trim().split('/')
    if (extra !== undefined) throw new Error(`allow: invalid entry ${entry}`)
    const ip = normalizeIp(addr)
    if (ip === undefined) throw new Error(`allow: invalid address ${entry}`)
    if (ip.includes('.')) {
      let bits = 32
      if (bitsText !== undefined) {
        if (!/^(0|[1-9][0-9]{0,2})$/.test(bitsText)) throw new Error(`allow: invalid prefix length in ${entry}`)
        bits = Number(bitsText)
        // ::ffff:a.b.c.d/n is written against the 128-bit form; accept only 96..128 then.
        if (addr.includes(':')) {
          if (bits < 96 || bits > 128) throw new Error(`allow: invalid prefix length in ${entry}`)
          bits -= 96
        } else if (bits > 32) throw new Error(`allow: invalid prefix length in ${entry}`)
      }
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
      return { kind: 4, net: (parseIPv4(ip) & mask) >>> 0, mask, text: entry }
    }
    if (bitsText !== undefined && bitsText !== '128') throw new Error(`allow: IPv6 prefixes are not supported (exact addresses only): ${entry}`)
    return { kind: 6, ip, text: entry }
  })
  return { rules }
}

/** Is `ip` (any textual form) allowed by a compiled list? Unknown / unparsable addresses are denied. */
export function ipAllowed(allow, ip) {
  if (allow.rules.length === 0) return true
  const norm = normalizeIp(ip)
  if (norm === undefined) return false
  if (norm.includes('.')) {
    const n = parseIPv4(norm)
    return allow.rules.some(r => r.kind === 4 && ((n & r.mask) >>> 0) === r.net)
  }
  return allow.rules.some(r => r.kind === 6 && r.ip === norm)
}

/**
 * Client address. Without trustProxy only the socket counts (X-Forwarded-For
 * is client-controlled). With trustProxy the RIGHTMOST X-Forwarded-For hop is
 * used: that is the one the (single) trusted proxy appended itself.
 */
export function clientAddress(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const header = req.headers?.['x-forwarded-for']
    const text = Array.isArray(header) ? header.join(',') : header
    if (typeof text === 'string' && text.trim() !== '') {
      const hops = text.split(',').map(s => s.trim()).filter(Boolean)
      return normalizeIp(hops.at(-1))
    }
  }
  return normalizeIp(req.socket?.remoteAddress)
}

// --- url / query ------------------------------------------------------------------

/** `req.url` -> `{ path, query }` (trailing slash dropped). */
export function parseRequestUrl(rawUrl) {
  let url
  try { url = new URL(typeof rawUrl === 'string' && rawUrl !== '' ? rawUrl : '/', 'http://hub.invalid') } catch { throw new HubError(400, 'bad-request', 'invalid url') }
  let path = url.pathname
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return { path, query: url.searchParams }
}

/** A query parameter given at most once (repeats are ambiguous and refused). */
export function queryOne(query, key) {
  const all = query.getAll(key)
  if (all.length > 1) throw new HubError(400, 'bad-query', `${key} must be given once`)
  return all.length === 1 ? all[0].trim() : undefined
}

/** `?id=` -> validated registered name. */
export function parseId(query) {
  const id = queryOne(query, 'id')
  if (id === undefined || id === '') throw new HubError(400, 'bad-query', 'id is required in the query')
  if (!AGENT_ID_RE.test(id)) throw new HubError(400, 'bad-query', 'id must match /^[a-z][a-z0-9-]{1,47}$/')
  return id
}

/** `?status=&agent=&workspace=&limit=` -> validated filter for hub.listTasks. */
export function parseTaskQuery(query) {
  const status = queryOne(query, 'status') ?? ''
  const agent = queryOne(query, 'agent') ?? ''
  const workspace = queryOne(query, 'workspace') ?? ''
  const limitText = queryOne(query, 'limit') ?? ''
  const filter = {}
  if (status !== '' && status !== 'all') {
    if (!TASK_STATUSES.includes(status)) throw new HubError(400, 'bad-query', `status must be one of all, ${TASK_STATUSES.join(', ')}`)
    filter.status = status
  }
  if (agent !== '') {
    if (!AGENT_ID_RE.test(agent) && !POOL_RE.test(agent)) throw new HubError(400, 'bad-query', 'agent must be an agent id or pool:<capability>')
    filter.agent = agent
  }
  if (workspace !== '') {
    if (!WORKSPACE_RE.test(workspace)) throw new HubError(400, 'bad-query', 'workspace must be a workspace name')
    filter.workspace = workspace
  }
  const history = queryOne(query, 'history') ?? ''
  if (history !== '') {
    if (!['hide', 'include', 'only'].includes(history)) throw new HubError(400, 'bad-query', 'history must be hide, include or only')
    filter.history = history
  }
  const profile = queryOne(query, 'dsh_profile') ?? ''
  if (profile !== '') {
    if (!PROFILE_RE.test(profile)) throw new HubError(400, 'bad-query', 'dsh_profile must be a DSH profile name')
    filter.dsh_profile = profile
  }
  const origin = queryOne(query, 'origin') ?? ''
  if (origin !== '') {
    if (!['controller', 'agent', 'local'].includes(origin)) throw new HubError(400, 'bad-query', 'origin must be controller, agent or local')
    filter.origin = origin
  }
  filter.limit = 50
  if (limitText !== '') {
    const n = Number(limitText)
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new HubError(400, 'bad-query', 'limit must be an integer 1..200')
    filter.limit = n
  }
  return filter
}

/** `?max=1&wait=25` -> `{ max, wait }`; wait is capped at 55 seconds. */
export function parsePollQuery(query) {
  const maxText = queryOne(query, 'max') ?? ''
  const waitText = queryOne(query, 'wait') ?? ''
  let max = 1
  if (maxText !== '') {
    max = Number(maxText)
    if (!Number.isInteger(max) || max < 1 || max > 32) throw new HubError(400, 'bad-query', 'max must be an integer 1..32')
  }
  let wait = 0
  if (waitText !== '') {
    wait = Number(waitText)
    if (!Number.isFinite(wait) || wait < 0) throw new HubError(400, 'bad-query', 'wait must be a number of seconds >= 0')
    wait = Math.min(wait, MAX_WAIT_SECONDS)
  }
  return { max, wait }
}

const requireTaskId = (value, key = 'task_id') => {
  if (typeof value !== 'string' || !TASK_ID_RE.test(value)) throw new HubError(400, 'bad-request', `${key} is required`)
  return value
}

// --- body / responses ---------------------------------------------------------------

/** JSON body with a size limit; must be a JSON object (empty body = {}). */
export async function readJson(req, maxBytes) {
  const essence = String(req.headers?.['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
  if (essence !== 'application/json') throw new HubError(415, 'unsupported-media-type', 'content-type must be application/json')
  const declared = Number(req.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) throw new HubError(413, 'body-too-large', `request body exceeds ${maxBytes} bytes`)
  const raw = typeof req.on === 'function' && typeof req.resume === 'function' ? await collectStream(req, maxBytes) : await collectIterable(req, maxBytes)
  req.dshBodyRead = true
  const text = raw.toString('utf8').trim()
  if (text === '') return {}
  let value
  try { value = JSON.parse(text) } catch { throw new HubError(400, 'bad-request', 'request body is not JSON') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HubError(400, 'bad-request', 'request body must be a JSON object')
  return value
}

const tooLarge = maxBytes => new HubError(413, 'body-too-large', `request body exceeds ${maxBytes} bytes`)
const asBuffer = chunk => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))

/** Async-iterable body (tests, generic streams). */
async function collectIterable(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = asBuffer(chunk)
    size += buffer.length
    if (size > maxBytes) throw tooLarge(maxBytes)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * node:http IncomingMessage. Over the limit we stop buffering and drain the
 * rest (resume), so the 413 answer still reaches the client; the error path
 * adds `connection: close`.
 */
function collectStream(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (error, value) => {
      if (done) return
      done = true
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAborted)
      if (error) { req.resume(); reject(error) } else resolve(value)
    }
    const onData = (chunk) => {
      const buffer = asBuffer(chunk)
      size += buffer.length
      if (size > maxBytes) { finish(tooLarge(maxBytes)); return }
      chunks.push(buffer)
    }
    const onEnd = () => finish(undefined, Buffer.concat(chunks))
    const onError = error => finish(error)
    const onAborted = () => finish(new HubError(400, 'bad-request', 'request aborted'))
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('aborted', onAborted)
  })
}

const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

export function sendJson(res, status, value, extra = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...BASE_HEADERS, ...extra })
  res.end(body)
}

function sendBytes(res, bytes, name) {
  res.writeHead(200, {
    'content-type': 'application/octet-stream', 'content-length': bytes.length, ...BASE_HEADERS,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  })
  res.end(bytes)
}

/** AbortSignal-like object that fires when the client goes away before the response is finished. */
export function closeSignal(res) {
  const listeners = new Set()
  const signal = {
    aborted: false,
    addEventListener(_type, fn) { listeners.add(fn) },
    removeEventListener(_type, fn) { listeners.delete(fn) },
  }
  const fire = () => {
    if (signal.aborted || res.writableFinished) return
    signal.aborted = true
    for (const fn of [...listeners]) { try { fn() } catch { /* ignore */ } }
  }
  if (typeof res.on === 'function') res.on('close', fire)
  if (res.destroyed) fire()
  return signal
}

// --- routes -----------------------------------------------------------------------------

const now = () => new Date().toISOString()

/**
 * Route table. auth: none | enroll (no token, id required) | worker | controller.
 * body: limit name for POST bodies. Handlers return a JSON value, or
 * `{ bytes, name }` for downloads, or `undefined` when they answered themselves.
 */
export const ROUTES = {
  '/v1/health': { method: 'GET', auth: 'none', run: ({ ip }) => ({ ok: true, version: VERSION, client_ip: ip ?? null }) },

  // worker
  '/v1/enroll': { method: 'POST', auth: 'enroll', body: 'small', run: ({ hub, id, body, ip }) => hub.requestEnrollment({ ...body, agent_id: id, from: ip ?? '' }) },
  '/v1/enroll/status': { method: 'POST', auth: 'enroll', body: 'small', run: ({ hub, id, body }) => hub.enrollmentStatus(body, { agentId: id }) },
  '/v1/heartbeat': { method: 'POST', auth: 'worker', body: 'small', run: ({ hub, id, body }) => hub.heartbeat(id, body) },
  '/v1/me': { method: 'GET', auth: 'worker', run: async ({ hub, id, ip }) => ({ ...(await hub.me(id)), client_ip: ip ?? null }) },
  '/v1/leave': { method: 'POST', auth: 'worker', body: 'small', run: ({ hub, id, body }) => hub.leave(id, body) },
  '/v1/poll': { method: 'GET', auth: 'worker', run: runPoll },
  '/v1/event': { method: 'POST', auth: 'worker', body: 'event', run: ({ hub, id, body }) => hub.progress(id, body) },
  '/v1/result': { method: 'POST', auth: 'worker', body: 'result', run: ({ hub, id, body }) => hub.submitResult(id, body) },
  '/v1/release': { method: 'POST', auth: 'worker', body: 'event', run: ({ hub, id, body }) => hub.release(id, body) },
  // full session log of a task this worker holds or just finished (redacted on the hub)
  '/v1/session': { method: 'POST', auth: 'worker', body: 'result', run: ({ hub, id, body }) => hub.agentSession(id, body) },
  // dispatcher agents (role dispatcher, own worker token): create and follow their own tasks
  '/v1/dispatch': { method: 'POST', auth: 'worker', body: 'result', run: ({ hub, id, body }) => hub.agentDispatch(id, body) },
  '/v1/dispatched': {
    method: 'GET', auth: 'worker',
    run: async ({ hub, id, query }) => {
      const filter = parseTaskQuery(query)
      return { generated_at: now(), tasks: await hub.agentTasks(id, filter) }
    },
  },
  '/v1/cancel': { method: 'POST', auth: 'worker', body: 'event', run: ({ hub, id, body }) => hub.agentCancel(id, requireTaskId(body.task_id), body.reason) },
  '/v1/answer': { method: 'POST', auth: 'worker', body: 'event', run: ({ hub, id, body }) => hub.answer(undefined, { task_id: requireTaskId(body.task_id), answer: body.answer }, { asAgent: id }) },
  '/v1/artifact': {
    method: 'GET', auth: 'worker',
    run: async ({ hub, id, query }) => {
      const name = queryOne(query, 'name')
      const bytes = await hub.artifact(id, { task_id: queryOne(query, 'task_id'), from_task: queryOne(query, 'from_task') || undefined, name })
      return { bytes, name }
    },
  },

  // controller
  '/v1/ctl/dispatch': { method: 'POST', auth: 'controller', body: 'result', run: ({ hub, id, body }) => hub.dispatch(id, body) },
  '/v1/ctl/tasks': {
    method: 'GET', auth: 'controller',
    run: async ({ hub, query }) => {
      const filter = parseTaskQuery(query)
      const tasks = await hub.listTasks(filter)
      return { generated_at: now(), filter: { status: filter.status ?? 'all', agent: filter.agent, workspace: filter.workspace, limit: filter.limit }, tasks }
    },
  },
  '/v1/ctl/task': { method: 'GET', auth: 'controller', run: async ({ hub, query }) => ({ generated_at: now(), task: await hub.getTask(requireTaskId(queryOne(query, 'task_id'))) }) },
  '/v1/ctl/output': {
    method: 'GET', auth: 'controller',
    run: async ({ hub, query }) => {
      const name = queryOne(query, 'name')
      return { bytes: await hub.readOutput(requireTaskId(queryOne(query, 'task_id')), name), name }
    },
  },
  '/v1/ctl/cancel': { method: 'POST', auth: 'controller', body: 'event', run: ({ hub, id, body }) => hub.cancel(id, requireTaskId(body.task_id), body.reason) },
  '/v1/ctl/retry': { method: 'POST', auth: 'controller', body: 'event', run: ({ hub, id, body }) => hub.retry(id, requireTaskId(body.task_id), { agent: body.agent }) },
  '/v1/ctl/agents': {
    method: 'GET', auth: 'controller',
    run: async ({ hub }) => {
      const agents = await hub.listAgents()
      return { generated_at: now(), online: agents.filter(a => a.online).length, agents }
    },
  },
  '/v1/ctl/requests': {
    method: 'GET', auth: 'controller',
    run: async ({ hub, query }) => {
      const status = queryOne(query, 'status') || 'pending'
      if (!REQUEST_STATUSES.includes(status)) throw new HubError(400, 'bad-query', `status must be one of ${REQUEST_STATUSES.join(', ')}`)
      return { generated_at: now(), filter: { status }, requests: await hub.listRequests({ status }) }
    },
  },
  '/v1/ctl/approve': {
    method: 'POST', auth: 'controller', body: 'event',
    run: ({ hub, id, body }) => hub.approveRequest(id, body.request_id, { capabilities: body.capabilities, workspaces: body.workspaces, max_concurrency: body.max_concurrency, role: body.role, pull_every_seconds: body.pull_every_seconds }),
  },
  '/v1/ctl/reject': { method: 'POST', auth: 'controller', body: 'event', run: ({ hub, id, body }) => hub.rejectRequest(id, body.request_id, body.reason) },
  '/v1/ctl/revoke': { method: 'POST', auth: 'controller', body: 'event', run: ({ hub, id, body }) => hub.revokeAgent(id, body.agent_id) },
  '/v1/ctl/provision': {
    method: 'POST', auth: 'controller', body: 'event',
    run: async ({ hub, id, body }) => ({ ...(await hub.provisionAgent(id, body)), note: 'Store this token now; it is not shown again.' }),
  },
  '/v1/ctl/overview': { method: 'GET', auth: 'controller', run: ({ hub }) => hub.overview() },
  // the event stream every DSH follows (long poll by cursor)
  '/v1/ctl/events': { method: 'GET', auth: 'controller', run: runEvents },
  '/v1/ctl/ack': { method: 'POST', auth: 'controller', body: 'event', run: ({ hub, id, body }) => hub.acknowledge(id, requireTaskId(body.task_id)) },
  // the task lifecycle: answer a worker's question, mark results shown, one task's timeline, numbers
  '/v1/ctl/answer': { method: 'POST', auth: 'controller', body: 'event', run: ({ hub, id, body }) => hub.answer(id, { task_id: requireTaskId(body.task_id), answer: body.answer, profile: profileValue(body.profile) }) },
  '/v1/ctl/delivered': { method: 'POST', auth: 'controller', body: 'event', run: ({ hub, id, body }) => hub.delivered(id, { task_ids: body.task_ids, profile: profileValue(body.profile) }) },
  '/v1/ctl/timeline': { method: 'GET', auth: 'controller', run: ({ hub, query }) => hub.timeline(requireTaskId(queryOne(query, 'task_id'))) },
  '/v1/ctl/metrics': { method: 'GET', auth: 'controller', run: ({ hub, query }) => hub.metrics({ hours: intQuery(query, 'hours', 1, 24 * 90, 168) }) },
  // full session logs: DSH uploads those of the tasks it runs itself; any controller reads any
  '/v1/ctl/session': { method: 'POST', auth: 'controller', body: 'result', run: ({ hub, id, body }) => hub.controllerSession(id, body) },
  '/v1/ctl/session/read': {
    method: 'GET', auth: 'controller',
    run: ({ hub, query }) => hub.readSession(requireTaskId(queryOne(query, 'task_id')), { after: intQuery(query, 'after', 0, 1e9, 0), limit: intQuery(query, 'limit', 1, 2000, 500) }),
  },
  // DSH fallback: the controller acts as the built-in dsh-self
  '/v1/ctl/fallback': {
    method: 'GET', auth: 'controller',
    run: async ({ hub, id, query }) => ({ generated_at: now(), tasks: await hub.listFallback(id, { workspaces: workspaceQuery(query), profile: profileQuery(query) }) }),
  },
  '/v1/ctl/fallback/take': { method: 'POST', auth: 'controller', body: 'event', run: ({ hub, id, body }) => hub.takeFallback(id, { task_id: body.task_id, workspaces: body.workspaces, profile: profileValue(body.profile) }) },
  '/v1/ctl/fallback/event': { method: 'POST', auth: 'controller', body: 'event', run: ({ hub, id, body }) => hub.fallbackProgress(id, body) },
  '/v1/ctl/fallback/result': { method: 'POST', auth: 'controller', body: 'result', run: ({ hub, id, body }) => hub.fallbackResult(id, body) },
  '/v1/ctl/fallback/input': {
    method: 'GET', auth: 'controller',
    run: async ({ hub, id, query }) => {
      const name = queryOne(query, 'name')
      const bytes = await hub.fallbackInput(id, { task_id: queryOne(query, 'task_id'), from_task: queryOne(query, 'from_task') || undefined, name })
      return { bytes, name }
    },
  },
}

/** `?workspaces=a,b` -> list, or undefined (no filter). */
function workspaceQuery(query) {
  const raw = queryOne(query, 'workspaces')
  if (raw === undefined) return undefined
  const list = raw.split(',').map(s => s.trim()).filter(Boolean)
  if (list.length > 64 || list.some(w => !WORKSPACE_RE.test(w))) throw new HubError(400, 'bad-query', 'workspaces must be workspace names, comma separated')
  return list
}

/** `?key=n` -> integer in min..max, or `fallback` when absent. */
function intQuery(query, key, min, max, fallback) {
  const raw = queryOne(query, key)
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new HubError(400, 'bad-query', `${key} must be an integer ${min}..${max}`)
  return n
}

/** `?profile=<DSH profile>` (optional). */
function profileQuery(query) {
  return profileValue(queryOne(query, 'profile') ?? '')
}

/** A DSH profile name, '' / undefined = none; anything else is a 400. */
function profileValue(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !PROFILE_RE.test(value)) throw new HubError(400, 'bad-profile', 'profile must be a DSH profile name')
  return value
}

/** `?after=<seq>&wait=<s>&limit=&inbox=mine&profile=` on the controllers' event stream. */
async function runEvents({ hub, id, query, res }) {
  const after = intQuery(query, 'after', 0, Number.MAX_SAFE_INTEGER, 0)
  const wait = intQuery(query, 'wait', 0, MAX_WAIT_SECONDS, 0)
  const limit = intQuery(query, 'limit', 1, 1000, 200)
  // `inbox=mine`: only this controller's mail (tasks it published, for `profile` when given).
  // Without it the whole stream (an observer, or an older DSH).
  const scope = queryOne(query, 'inbox') ?? ''
  if (scope !== '' && scope !== 'mine' && scope !== 'all') throw new HubError(400, 'bad-query', 'inbox must be mine or all')
  const inbox = scope === 'mine' ? { controller: id, profile: profileQuery(query) } : undefined
  const out = await hub.feed({ after, wait, limit, inbox, signal: closeSignal(res) })
  return res.destroyed ? undefined : { generated_at: now(), ...out }
}

/** Long poll; tasks leased for a connection that closed meanwhile are handed back. */
async function runPoll({ hub, id, query, res }) {
  const { max, wait } = parsePollQuery(query)
  const signal = closeSignal(res)
  const out = await hub.poll(id, { max, wait, signal })
  if (signal.aborted || res.destroyed) {
    if (out.tasks.length > 0) await hub.unlease(id, out.tasks.map(t => t.task_id), 'poll connection closed before delivery')
    return undefined
  }
  return out
}

/** path + method -> route, or 404 / 405. */
export function matchRoute(method, path) {
  const route = Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined
  if (route === undefined) throw new HubError(404, 'not-found', 'no such endpoint')
  if (method !== route.method) throw new HubError(405, 'method-not-allowed', `use ${route.method}`)
  return route
}

/**
 * @param {{ hub: import('./hub.js').AgentHub, logger?: any, allow?: string[], trustProxy?: boolean, maxResultBytes?: number }} options
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createHandler({ hub, logger, allow = [], trustProxy = false, maxResultBytes = DEFAULT_MAX_RESULT_BYTES, mcp = true }) {
  const allowList = compileAllow(allow)
  const limits = { small: SMALL_BODY, event: EVENT_BODY, result: maxResultBytes }
  const gateway = mcp === false ? undefined : (mcp instanceof McpGateway ? mcp : new McpGateway({ hub }))
  return async function handle(req, res) {
    let path = '?'
    let id
    let ip
    try {
      ip = clientAddress(req, { trustProxy })
      if (!ipAllowed(allowList, ip)) {
        // Only the caller's own address goes back: it needs it to fix `allow` (proxy exit IP).
        const denied = new HubError(403, 'ip-not-allowed', 'client address is not allowed')
        denied.clientIp = ip ?? null
        throw denied
      }
      const parsed = parseRequestUrl(req.url)
      path = parsed.path
      if (gateway !== undefined && (path === MCP_PATH || path === TOKEN_PATH)) {
        if (parsed.query.has('token') || parsed.query.has('access_token')) throw new HubError(400, 'token-in-query', 'never put a token in the query')
        await (path === TOKEN_PATH ? handleToken : handleMcp)({ gateway, req, res, limits })
        return
      }
      const route = matchRoute(req.method, path)
      if (route.auth === 'none') { sendJson(res, 200, await route.run({ hub, ip })); return }
      if (parsed.query.has('token') || parsed.query.has('x-dsh-token')) throw new HubError(400, 'token-in-query', 'send the token in the X-DSH-Token header, never in the query')
      id = parseId(parsed.query)
      if (route.auth === 'worker' || route.auth === 'controller') {
        const header = req.headers?.[TOKEN_HEADER]
        const who = await hub.authenticateToken(Array.isArray(header) ? undefined : header)
        if (who.id !== id) throw new HubError(401, 'unauthorized', 'token does not belong to id')
        if (who.role !== route.auth) throw new HubError(403, 'forbidden', `a ${who.role} token cannot call ${path}`)
      }
      const body = route.method === 'POST' ? await readJson(req, limits[route.body]) : undefined
      const out = await route.run({ hub, id, query: parsed.query, body, ip, req, res })
      if (out === undefined || res.writableEnded || res.destroyed) return
      if (Buffer.isBuffer(out.bytes)) sendBytes(res, out.bytes, out.name ?? 'download')
      else sendJson(res, 200, out)
    } catch (error) {
      if (res.headersSent || res.writableEnded || res.destroyed) return
      // A POST answered before its body was read: do not keep the connection.
      const extra = req.method === 'POST' && req.dshBodyRead !== true ? { connection: 'close' } : {}
      if (error instanceof HubError && error.oauth === true) {
        try { logger?.warn?.(`dsh-hub: ${error.status} ${error.code} ${req.method} ${path} ip=${ip ?? '-'}`) } catch { /* ignore */ }
        sendJson(res, error.status, { error: error.code, error_description: error.message }, { ...extra, 'cache-control': 'no-store' })
        return
      }
      if (error instanceof HubError && error.status === 401 && path === MCP_PATH) extra['www-authenticate'] = 'Bearer realm="dsh-hub"'
      if (error instanceof HubError) {
        if (error.status === 401 || error.status === 403) {
          try { logger?.warn?.(`dsh-hub: ${error.status} ${error.code} ${req.method} ${path} id=${id ?? '-'} ip=${ip ?? '-'}`) } catch { /* ignore */ }
        }
        const payload = { code: error.code, message: error.message }
        if (error.code === 'ip-not-allowed') payload.client_ip = error.clientIp ?? null
        sendJson(res, error.status, { error: payload }, extra)
        return
      }
      try { logger?.warn?.(`dsh-hub: ${req.method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`) } catch { /* ignore */ }
      sendJson(res, 500, { error: { code: 'internal', message: 'internal error' } }, extra)
    }
  }
}

// --- MCP and OAuth ----------------------------------------------------------------------

/** POST /oauth/token: form or JSON body; client id / secret may also come as HTTP Basic. */
async function handleToken({ gateway, req, res, limits }) {
  if (req.method !== 'POST') throw new HubError(405, 'method-not-allowed', 'use POST')
  const essence = String(req.headers?.['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
  let body
  if (essence === 'application/json') body = await readJson(req, limits.small)
  else if (essence === 'application/x-www-form-urlencoded') {
    const raw = typeof req.on === 'function' && typeof req.resume === 'function' ? await collectStream(req, limits.small) : await collectIterable(req, limits.small)
    req.dshBodyRead = true
    body = Object.fromEntries(new URLSearchParams(raw.toString('utf8')))
  } else throw new HubError(415, 'unsupported-media-type', 'content-type must be application/x-www-form-urlencoded or application/json')
  const basic = /^Basic\s+(\S+)$/i.exec(String(req.headers?.authorization ?? ''))
  if (basic !== null) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8')
    const at = decoded.indexOf(':')
    if (at > 0) { body.client_id = decodeURIComponent(decoded.slice(0, at)); body.client_secret = decodeURIComponent(decoded.slice(at + 1)) }
  }
  sendJson(res, 200, await gateway.issueToken(body), { 'cache-control': 'no-store', pragma: 'no-cache' })
}

/** POST /mcp: one JSON-RPC message or a batch; notifications only -> 202. GET (SSE) is not offered. */
async function handleMcp({ gateway, req, res, limits }) {
  if (req.method !== 'POST') throw new HubError(405, 'method-not-allowed', 'use POST (this server sends no SSE stream)')
  const agentId = gateway.agentFor(req.headers?.authorization)
  const essence = String(req.headers?.['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
  if (essence !== 'application/json') throw new HubError(415, 'unsupported-media-type', 'content-type must be application/json')
  const raw = typeof req.on === 'function' && typeof req.resume === 'function' ? await collectStream(req, limits.result) : await collectIterable(req, limits.result)
  req.dshBodyRead = true
  let message
  try { message = JSON.parse(raw.toString('utf8')) } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    return
  }
  const batch = Array.isArray(message)
  const answers = []
  for (const m of batch ? message.slice(0, 50) : [message]) {
    const answer = await gateway.handle(m, agentId)
    if (answer !== undefined) answers.push(answer)
  }
  if (answers.length === 0) { res.writeHead(202, { ...BASE_HEADERS }); res.end(); return }
  sendJson(res, 200, batch ? answers : answers[0])
}

// --- server -------------------------------------------------------------------------------

/**
 * Listen address. Without TLS only 127.0.0.1 is allowed (tokens would cross
 * the network in clear text); with TLS the default is 0.0.0.0.
 */
export function resolveListenHost({ host, tls } = {}) {
  const hasTls = tls !== undefined && tls !== null
  const chosen = host ?? (hasTls ? '0.0.0.0' : '127.0.0.1')
  if (!hasTls && chosen !== '127.0.0.1') {
    throw new HubError(500, 'insecure-listen', `refusing to listen on ${chosen} without TLS: set tls.cert / tls.key in hub.json, or use host 127.0.0.1 behind a TLS proxy`)
  }
  return chosen
}

/**
 * @param {{ hub: any, logger?: any, config: { host?: string, tls?: any, allow?: string[], trustProxy?: boolean, maxResultBytes?: number },
 *           tlsMaterial?: { cert: Buffer | string, key: Buffer | string } }} options
 * @returns {{ server: import('node:http').Server, host: string, handler: Function }}
 */
export function createHubServer({ hub, logger, config, tlsMaterial }) {
  const host = resolveListenHost(config)
  if (config.tls && !tlsMaterial) throw new HubError(500, 'tls-missing', 'tls is configured but no certificate material was loaded')
  const handler = createHandler({ hub, logger, allow: config.allow, trustProxy: config.trustProxy === true, maxResultBytes: config.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES, mcp: config.mcp?.enabled !== false })
  const server = config.tls
    ? createHttpsServer({ cert: tlsMaterial.cert, key: tlsMaterial.key, minVersion: 'TLSv1.2' }, handler)
    : createHttpServer(handler)
  // Long polls hold a request for up to 55 s; uploads may be large.
  server.headersTimeout = 30_000
  server.requestTimeout = 10 * 60_000
  server.keepAliveTimeout = 65_000
  return { server, host, handler }
}
