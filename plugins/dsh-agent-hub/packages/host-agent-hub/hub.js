/**
 * Core of dsh-agent-hub: agent registry, task queue, leases and retries.
 *
 * Control model (the whole point of this module):
 *   - Only DSH creates agents, creates tasks, routes, cancels and retries.
 *   - An agent is identified by a DSH-issued token (only its sha256 is stored).
 *   - An agent can only see / lease / update tasks routed to itself
 *     (`agent: "<id>"`, or `agent: "pool:<capability>"` it declared), and once
 *     leased a task belongs to exactly one agent until it finishes or the lease
 *     expires. There is no agent-facing operation that creates or routes work.
 *   - An agent may ASK to join (enrollment request); it gets nothing until DSH
 *     approves, and the token is minted once when the requester collects it.
 *
 * Roles (roles.js): every agent carries one optional `role` — worker (default,
 * takes any task), tester (test tasks only), dispatcher / observer (never take
 * tasks). It arrives with enroll / provision, is stored with the agent, can only
 * be NARROWED at approval (`role-widened`) and is enforced by dispatch() and
 * poll(). An agent stored before roles existed is a worker.
 *
 * State lives in one JSON file written atomically; artifacts live on disk next
 * to it. Single process, so an in-memory promise chain serializes mutations.
 *
 * @module host-agent-hub/hub
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { DEFAULT_ROLE, ROLES, agentRole, roleAccepts, roleOf, roleRefusal, roleWidening } from './roles.js'

export const PROTOCOL = 'dsh-agent/1.0'
export const AGENT_ID_RE = /^[a-z][a-z0-9-]{1,47}$/
export const TASK_ID_RE = /^[A-Za-z0-9_.-]{1,96}$/
export const CAP_RE = /^[a-z][a-z0-9-]{0,47}$/
export const FILE_NAME_RE = /^[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff _.()-]{0,127}$/
export const TASK_TYPES = ['research', 'document', 'data', 'code', 'review', 'custom']
export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'dead'])
const PRIORITY = { high: 0, normal: 1, low: 2 }

/** A caller-visible failure with an HTTP status and a stable code. */
export class HubError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}

/** Own-property lookup: ids from callers must never reach Object.prototype. */
export const own = (obj, key) => (obj != null && typeof key === 'string' && Object.hasOwn(obj, key) ? obj[key] : undefined)

const sha256 = text => createHash('sha256').update(text, 'utf8').digest()
const nowIso = (now = Date.now()) => new Date(now).toISOString()

/** Reject names that could escape a directory. */
export function safeFileName(raw) {
  if (typeof raw !== 'string' || !FILE_NAME_RE.test(raw) || raw.includes('..') || basename(raw) !== raw) {
    throw new HubError(400, 'bad-file-name', `invalid file name: ${String(raw).slice(0, 80)}`)
  }
  return raw
}

export class AgentHub {
  /**
   * @param {{ dataDir: string, offlineAfterMs?: number, maxRetries?: number, logger?: any, clock?: () => number }} options
   */
  constructor(options) {
    this.dataDir = options.dataDir
    this.statePath = join(this.dataDir, 'state.json')
    this.artifactDir = join(this.dataDir, 'artifacts')
    this.offlineAfterMs = options.offlineAfterMs ?? 120_000
    this.maxRetries = options.maxRetries ?? 2
    this.maxPendingRequests = options.maxPendingRequests ?? 20
    this.requestTtlMs = options.requestTtlMs ?? 24 * 3600 * 1000
    this.logger = options.logger
    this.clock = options.clock ?? Date.now
    this.state = undefined
    this.queue = Promise.resolve()
  }

  // --- persistence ---------------------------------------------------------

  async load() {
    if (this.state !== undefined) return this.state
    await mkdir(this.artifactDir, { recursive: true })
    try {
      this.state = JSON.parse(await readFile(this.statePath, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      this.state = { protocol: PROTOCOL, agents: {}, tasks: {}, requests: {}, seq: 0 }
    }
    return this.state
  }

  async save() {
    const temp = `${this.statePath}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temp, `${JSON.stringify(this.state, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, this.statePath)
  }

  /** Serialize every mutation; save after it. */
  mutate(fn) {
    const run = this.queue.then(async () => {
      const state = await this.load()
      const value = await fn(state)
      await this.save()
      return value
    })
    this.queue = run.catch(() => {})
    return run
  }

  async read(fn) { await this.queue; return fn(await this.load()) }

  log(message) { try { this.logger?.info?.(message) } catch { /* ignore */ } }

  // --- agents (DSH only) ---------------------------------------------------

  /** Validate the agent description shared by provision and enrollment. */
  validateAgent(input) {
    const id = input?.agent_id
    if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) throw new HubError(400, 'bad-agent-id', 'agent_id must match /^[a-z][a-z0-9-]{1,47}$/')
    const caps = input.capabilities ?? []
    if (!Array.isArray(caps) || caps.length > 32 || caps.some(c => typeof c !== 'string' || !CAP_RE.test(c))) throw new HubError(400, 'bad-capabilities', 'capabilities must be lowercase identifiers')
    const mode = input.mode ?? 'poll'
    if (mode !== 'poll' && mode !== 'push') throw new HubError(400, 'bad-mode', 'mode must be poll or push')
    const maxConcurrency = input.max_concurrency ?? 1
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32) throw new HubError(400, 'bad-concurrency', 'max_concurrency must be 1..32')
    // Optional: absent / empty = worker (an agent that never reports a role, and every
    // record stored before roles existed, takes work like it always did).
    const role = roleOf(input.role)
    if (role === undefined) throw new HubError(400, 'bad-role', `role must be one of ${ROLES.join(', ')} (default ${DEFAULT_ROLE})`)
    return {
      id, mode, maxConcurrency, capabilities: [...new Set(caps)], role,
      platform: String(input.platform ?? 'custom').slice(0, 64),
      description: String(input.description ?? '').slice(0, 500),
    }
  }

  newToken(id) { return `dsha_${id}_${randomBytes(24).toString('base64url')}` }

  writeAgent(state, v, tokenHash) {
    const previous = own(state.agents, v.id)
    state.agents[v.id] = {
      id: v.id, platform: v.platform, mode: v.mode, capabilities: v.capabilities, maxConcurrency: v.maxConcurrency,
      role: v.role ?? DEFAULT_ROLE, description: v.description, tokenHash,
      createdAt: previous?.createdAt ?? nowIso(this.clock()),
      rekeyedAt: previous === undefined ? undefined : nowIso(this.clock()),
      lastSeen: undefined, reportedStatus: undefined, revoked: false,
    }
    return previous
  }

  /** DSH creates or re-keys an agent directly. Returns the token ONCE; only its hash is kept. */
  provisionAgent(input) {
    const v = this.validateAgent(input)
    const token = this.newToken(v.id)
    return this.mutate((state) => {
      const previous = this.writeAgent(state, v, sha256(token).toString('hex'))
      this.log(`agent-hub: ${previous === undefined ? 'provisioned' : 're-keyed'} agent ${v.id}`)
      return { agent: this.publicAgent(own(state.agents, v.id), state), token }
    })
  }

  // --- enrollment: agent asks, DSH decides ---------------------------------

  /**
   * Unauthenticated: an agent asks to join. Nothing is granted: the request
   * only shows up in DSH (`agent_requests`) until DSH approves or rejects it.
   * Returns a poll secret (kept only as a hash) for checking the outcome.
   */
  requestEnrollment(input) {
    const v = this.validateAgent(input)
    const pollSecret = randomBytes(24).toString('base64url')
    return this.mutate((state) => {
      state.requests = state.requests ?? {}
      const pending = Object.values(state.requests).filter(r => r.status === 'pending' && this.clock() - Date.parse(r.requested_at) <= this.requestTtlMs)
      if (own(state.agents, v.id) !== undefined && !own(state.agents, v.id).revoked) throw new HubError(409, 'agent-exists', `agent already registered: ${v.id}`)
      if (pending.some(r => r.agent.id === v.id)) throw new HubError(409, 'request-pending', `a request for ${v.id} is already pending`)
      if (pending.length >= this.maxPendingRequests) throw new HubError(429, 'too-many-requests', 'too many pending enrollment requests')
      const requestId = `req_${randomBytes(9).toString('base64url')}`
      state.requests[requestId] = {
        request_id: requestId, agent: v, status: 'pending', secretHash: sha256(pollSecret).toString('hex'),
        requested_at: nowIso(this.clock()), from: String(input.from ?? '').slice(0, 100),
        decided_at: undefined, reason: undefined, tokenIssued: false,
      }
      this.log(`agent-hub: enrollment request ${requestId} for ${v.id} (${v.platform}) awaiting DSH approval`)
      return { request_id: requestId, poll_secret: pollSecret, status: 'pending' }
    })
  }

  /**
   * Unauthenticated but secret-bound: the requester checks its request. The
   * token is minted on the FIRST read after approval and never again, so no
   * plaintext token is ever stored.
   */
  enrollmentStatus(body = {}) {
    return this.mutate((state) => {
      const request = own(state.requests, body.request_id)
      const want = request ? Buffer.from(request.secretHash, 'hex') : Buffer.alloc(32)
      if (!timingSafeEqual(want, sha256(String(body.poll_secret ?? ''))) || request === undefined) throw new HubError(404, 'request-not-found', 'unknown request or wrong poll secret')
      if (request.status !== 'approved') return { request_id: request.request_id, status: request.status, reason: request.reason }
      if (request.tokenIssued) return { request_id: request.request_id, status: 'approved', token_issued: true, note: 'token was already delivered; ask DSH to re-key if lost' }
      const agent = own(state.agents, request.agent.id)
      if (agent === undefined || agent.revoked) return { request_id: request.request_id, status: 'revoked' }
      const token = this.newToken(agent.id)
      agent.tokenHash = sha256(token).toString('hex')
      request.tokenIssued = true
      this.log(`agent-hub: token delivered to ${agent.id} (${request.request_id})`)
      return { request_id: request.request_id, status: 'approved', agent_id: agent.id, token }
    })
  }

  listRequests({ status = 'pending' } = {}) {
    return this.read(state => Object.values(state.requests ?? {})
      .filter(r => status === 'all' || r.status === status)
      .sort((a, b) => b.requested_at.localeCompare(a.requested_at))
      .map(r => ({
        request_id: r.request_id, status: r.status, agent_id: r.agent.id, platform: r.agent.platform, mode: r.agent.mode,
        capabilities: r.agent.capabilities, max_concurrency: r.agent.maxConcurrency, description: r.agent.description,
        role: agentRole(r.agent),
        from: r.from, requested_at: r.requested_at, decided_at: r.decided_at, reason: r.reason,
      })))
  }

  /** DSH approves; it may narrow (or set) capabilities, concurrency and role. */
  approveRequest(requestId, overrides = {}) {
    return this.mutate((state) => {
      const request = own(state.requests, requestId)
      if (request === undefined) throw new HubError(404, 'request-not-found', `request not found: ${requestId}`)
      if (request.status !== 'pending') throw new HubError(409, 'request-decided', `request is ${request.status}`)
      const asked = agentRole(request.agent)
      const role = overrides.role === undefined ? asked : roleOf(overrides.role)
      if (role === undefined) throw new HubError(400, 'bad-role', `role must be one of ${ROLES.join(', ')} (default ${DEFAULT_ROLE})`)
      // Narrow only, like capabilities / workspaces / max_concurrency (`grant-widened`).
      const widened = roleWidening(asked, role)
      if (widened !== undefined) throw new HubError(400, widened.code, widened.message)
      const v = this.validateAgent({
        agent_id: request.agent.id, platform: request.agent.platform, mode: request.agent.mode, description: request.agent.description,
        role,
        capabilities: overrides.capabilities ?? request.agent.capabilities,
        max_concurrency: overrides.max_concurrency ?? request.agent.maxConcurrency,
      })
      if (own(state.agents, v.id) !== undefined && !own(state.agents, v.id).revoked) throw new HubError(409, 'agent-exists', `agent already registered: ${v.id}`)
      this.writeAgent(state, v, '') // no usable token until the requester collects it
      request.status = 'approved'
      request.decided_at = nowIso(this.clock())
      request.agent = v
      this.log(`agent-hub: approved ${requestId} -> agent ${v.id}`)
      return { request_id: requestId, status: 'approved', agent: this.publicAgent(own(state.agents, v.id), state) }
    })
  }

  rejectRequest(requestId, reason = '') {
    return this.mutate((state) => {
      const request = own(state.requests, requestId)
      if (request === undefined) throw new HubError(404, 'request-not-found', `request not found: ${requestId}`)
      if (request.status !== 'pending') throw new HubError(409, 'request-decided', `request is ${request.status}`)
      request.status = 'rejected'
      request.decided_at = nowIso(this.clock())
      request.reason = String(reason).slice(0, 500)
      this.log(`agent-hub: rejected ${requestId} (${request.agent.id})`)
      return { request_id: requestId, status: 'rejected' }
    })
  }

  revokeAgent(id) {
    return this.mutate((state) => {
      const agent = own(state.agents, id)
      if (agent === undefined) throw new HubError(404, 'agent-not-found', `agent not found: ${id}`)
      agent.revoked = true
      agent.tokenHash = ''
      // Hand its running work back to the queue.
      for (const task of Object.values(state.tasks)) {
        if (task.assignedTo === id && (task.status === 'accepted' || task.status === 'running')) this.requeue(task, 'agent revoked')
      }
      this.log(`agent-hub: revoked agent ${id}`)
      return this.publicAgent(agent, state)
    })
  }

  listAgents() {
    return this.read(state => Object.values(state.agents).map(a => this.publicAgent(a, state)))
  }

  online(agent) {
    if (agent.revoked || agent.lastSeen === undefined) return false
    return this.clock() - Date.parse(agent.lastSeen) <= this.offlineAfterMs
  }

  publicAgent(agent, state) {
    const running = Object.values(state.tasks).filter(t => t.assignedTo === agent.id && (t.status === 'accepted' || t.status === 'running')).map(t => t.task_id)
    return {
      agent_id: agent.id, platform: agent.platform, mode: agent.mode, capabilities: agent.capabilities,
      max_concurrency: agent.maxConcurrency, description: agent.description, revoked: agent.revoked,
      // Additive field: a record stored before roles existed is a worker.
      role: agentRole(agent),
      online: this.online(agent), last_seen: agent.lastSeen, reported_status: agent.reportedStatus,
      running_tasks: running, created_at: agent.createdAt,
    }
  }

  /** Token → agent, or throw 401. Constant-time compare on the hash. */
  async authenticate(token) {
    if (typeof token !== 'string' || !token.startsWith('dsha_')) throw new HubError(401, 'unauthorized', 'missing or malformed agent token')
    const id = token.slice(5).split('_', 1)[0]
    return this.read((state) => {
      const agent = own(state.agents, id)
      const want = agent?.tokenHash ? Buffer.from(agent.tokenHash, 'hex') : Buffer.alloc(32)
      const got = sha256(token)
      const ok = timingSafeEqual(want, got) && agent !== undefined && !agent.revoked && agent.tokenHash !== ''
      if (!ok) throw new HubError(401, 'unauthorized', 'invalid agent token')
      return agent.id
    })
  }

  // --- tasks (DSH only) ----------------------------------------------------

  /** DSH creates a task. Inputs are files given inline (text or base64). */
  dispatch(input) {
    const t = input ?? {}
    for (const key of ['title', 'instruction']) {
      if (typeof t[key] !== 'string' || t[key].trim() === '') throw new HubError(400, 'bad-task', `${key} is required`)
    }
    const type = t.type ?? 'custom'
    if (!TASK_TYPES.includes(type)) throw new HubError(400, 'bad-task', `type must be one of ${TASK_TYPES.join(', ')}`)
    const target = t.agent
    if (typeof target !== 'string' || !(AGENT_ID_RE.test(target) || /^pool:[a-z][a-z0-9-]{0,47}$/.test(target))) {
      throw new HubError(400, 'bad-task', 'agent must be an agent id or pool:<capability>')
    }
    const priority = t.priority ?? 'normal'
    if (typeof priority !== 'string' || !Object.hasOwn(PRIORITY, priority)) throw new HubError(400, 'bad-task', 'priority must be low, normal or high')
    const deps = t.depends_on ?? []
    if (!Array.isArray(deps) || deps.some(d => typeof d !== 'string')) throw new HubError(400, 'bad-task', 'depends_on must be a list of task ids')
    const inputs = t.inputs ?? []
    if (!Array.isArray(inputs)) throw new HubError(400, 'bad-task', 'inputs must be a list')
    const leaseSeconds = t.lease_seconds ?? 3600
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 7 * 86400) throw new HubError(400, 'bad-task', 'lease_seconds must be 60..604800')

    return this.mutate(async (state) => {
      if (AGENT_ID_RE.test(target) && own(state.agents, target) === undefined) throw new HubError(404, 'agent-not-found', `agent not provisioned: ${target}`)
      // Role gate (roles.js): dispatcher / observer never take tasks, tester only takes tests.
      this.checkTargetRole(state, target, { type, title: t.title.trim() })
      for (const dep of deps) if (own(state.tasks, dep) === undefined) throw new HubError(404, 'task-not-found', `depends_on task not found: ${dep}`)
      const names = inputs.map(file => safeFileName(file?.name))
      if (new Set(names).size !== names.length) throw new HubError(400, 'bad-task', 'duplicate input file name')
      const day = nowIso(this.clock()).slice(0, 10).replace(/-/g, '')
      const id = t.task_id ?? `task_${day}_${String((state.seq ?? 0) + 1).padStart(4, '0')}`
      if (typeof id !== 'string' || !TASK_ID_RE.test(id)) throw new HubError(400, 'bad-task', 'invalid task_id')
      if (own(state.tasks, id) !== undefined) throw new HubError(409, 'task-exists', `task already exists: ${id}`)
      if (t.task_id === undefined) state.seq = (state.seq ?? 0) + 1

      const dir = join(this.artifactDir, id, 'inputs')
      await mkdir(dir, { recursive: true })
      const inputNames = []
      for (const [index, file] of inputs.entries()) {
        const name = names[index]
        const body = typeof file.base64 === 'string' ? Buffer.from(file.base64, 'base64') : Buffer.from(String(file.text ?? ''), 'utf8')
        await writeFile(join(dir, name), body)
        inputNames.push(name)
      }
      const task = {
        protocol: PROTOCOL, task_id: id, agent: target, type, title: t.title.trim(), instruction: t.instruction,
        inputs: inputNames, output: t.output ?? {}, priority, deadline: t.deadline, lease_seconds: leaseSeconds,
        parent_task_id: t.parent_task_id, depends_on: deps, context: t.context ?? {},
        created_by: 'dsh', created_at: nowIso(this.clock()),
        status: 'pending', attempts: 0, assignedTo: undefined, leaseUntil: undefined,
        progress: undefined, message: undefined, result: undefined, history: [],
      }
      this.event(task, 'created', `-> ${target}`)
      state.tasks[id] = task
      this.log(`agent-hub: dispatched ${id} to ${target}`)
      return this.publicTask(task)
    })
  }

  /**
   * Role gate of one dispatch target.
   * - `worker` accepts anything (and an agent without a stored role is a worker);
   * - a `pool:` is refused only when EVERY member with that capability refuses the
   *   task (a pool nobody can serve stays queued, exactly as before roles existed);
   * - `dispatcher` / `observer` are refused with `role-not-dispatchable`, a
   *   `tester` with a non-test task with `role-not-testable`.
   */
  checkTargetRole(state, target, task) {
    if (AGENT_ID_RE.test(target)) {
      const refusal = roleRefusal(task, agentRole(own(state.agents, target)), target)
      if (refusal !== undefined) throw new HubError(400, refusal.code, refusal.message)
      return
    }
    const capability = target.slice(5)
    const members = Object.values(state.agents).filter(a => !a.revoked && a.capabilities.includes(capability))
    const refusals = members.map(a => roleRefusal(task, agentRole(a), target))
    if (refusals.length > 0 && refusals.every(r => r !== undefined)) throw new HubError(400, refusals[0].code, refusals[0].message)
  }

  cancel(id, reason = 'cancelled by dsh') {
    return this.mutate((state) => {
      const task = this.mustTask(state, id)
      if (TERMINAL.has(task.status)) throw new HubError(409, 'task-finished', `task already ${task.status}`)
      task.status = 'cancelled'
      task.leaseUntil = undefined
      this.event(task, 'cancelled', reason)
      return this.publicTask(task)
    })
  }

  retry(id, { agent } = {}) {
    return this.mutate((state) => {
      const task = this.mustTask(state, id)
      if (!TERMINAL.has(task.status)) throw new HubError(409, 'task-active', `task is ${task.status}; cancel it first`)
      if (agent !== undefined) {
        const target = AGENT_ID_RE.test(agent) ? own(state.agents, agent) : undefined
        if (!(target && !target.revoked) && !/^pool:[a-z][a-z0-9-]{0,47}$/.test(agent)) throw new HubError(400, 'bad-task', 'unknown target agent')
        task.agent = agent
      }
      task.status = 'pending'; task.assignedTo = undefined; task.leaseUntil = undefined; task.attempts = 0; task.result = undefined
      this.event(task, 'retried', `-> ${task.agent}`)
      return this.publicTask(task)
    })
  }

  listTasks(filter = {}) {
    return this.read(state => Object.values(state.tasks)
      .filter(t => (filter.status === undefined || t.status === filter.status) && (filter.agent === undefined || t.agent === filter.agent || t.assignedTo === filter.agent))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, filter.limit ?? 50)
      .map(t => this.publicTask(t)))
  }

  getTask(id) { return this.read(state => this.publicTask(this.mustTask(state, id), { full: true })) }

  mustTask(state, id) {
    const task = own(state.tasks, id)
    if (task === undefined) throw new HubError(404, 'task-not-found', `task not found: ${id}`)
    return task
  }

  publicTask(task, { full = false } = {}) {
    const out = {
      task_id: task.task_id, agent: task.agent, assigned_to: task.assignedTo, type: task.type, title: task.title,
      status: task.status, priority: task.priority, attempts: task.attempts, progress: task.progress, message: task.message,
      created_at: task.created_at, lease_until: task.leaseUntil, depends_on: task.depends_on,
      result: task.result === undefined ? undefined : { status: task.result.status, summary: task.result.summary, outputs: task.result.outputs, error: task.result.error, needs_input: task.result.needs_input },
    }
    if (full) { out.instruction = task.instruction; out.inputs = task.inputs; out.output = task.output; out.history = task.history; out.context = task.context }
    return out
  }

  event(task, kind, message) {
    task.history.push({ at: nowIso(this.clock()), event: kind, message })
    if (task.history.length > 200) task.history.splice(0, task.history.length - 200)
  }

  requeue(task, why) {
    if (task.attempts > this.maxRetries) {
      task.status = 'dead'
      this.event(task, 'dead', `${why}; retries exhausted`)
    } else {
      task.status = 'pending'
      this.event(task, 'requeued', why)
    }
    task.assignedTo = undefined
    task.leaseUntil = undefined
  }

  // --- agent side (token-scoped) -------------------------------------------

  /** Re-check inside the mutation: a revoke between authenticate() and here must win. */
  liveAgent(state, agentId) {
    const agent = own(state.agents, agentId)
    if (agent === undefined || agent.revoked || agent.tokenHash === '') throw new HubError(401, 'unauthorized', 'agent revoked')
    return agent
  }

  heartbeat(agentId, body = {}) {
    return this.mutate((state) => {
      const agent = this.liveAgent(state, agentId)
      agent.lastSeen = nowIso(this.clock())
      agent.reportedStatus = ['idle', 'busy'].includes(body.status) ? body.status : undefined
      // An agent may narrow its capabilities, never widen what DSH granted.
      return { ok: true, agent_id: agentId, server_time: agent.lastSeen }
    })
  }

  /** Lease up to `max` tasks routed to this agent. */
  poll(agentId, { max = 1 } = {}) {
    return this.mutate((state) => {
      const agent = this.liveAgent(state, agentId)
      agent.lastSeen = nowIso(this.clock())
      const role = agentRole(agent)
      const running = Object.values(state.tasks).filter(t => t.assignedTo === agentId && (t.status === 'accepted' || t.status === 'running')).length
      const room = Math.max(0, Math.min(Number.isInteger(max) ? max : 1, agent.maxConcurrency - running))
      const candidates = Object.values(state.tasks)
        .filter(t => t.status === 'pending')
        .filter(t => t.agent === agentId || (t.agent.startsWith('pool:') && agent.capabilities.includes(t.agent.slice(5))))
        // Role gate: a pool only picks worker / tester agents, a tester only picks
        // test tasks, and a dispatcher / observer leases nothing at all.
        .filter(t => roleAccepts(role, t))
        .filter(t => t.depends_on.every(d => own(state.tasks, d)?.status === 'completed'))
        .sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.created_at.localeCompare(b.created_at))
        .slice(0, room)
      const leased = []
      for (const task of candidates) {
        task.status = 'accepted'
        task.assignedTo = agentId
        task.attempts += 1
        task.leaseUntil = nowIso(this.clock() + task.lease_seconds * 1000)
        this.event(task, 'accepted', `leased by ${agentId} (attempt ${task.attempts})`)
        // Upstream outputs become downloadable inputs.
        const upstream = task.depends_on.flatMap(d => (own(state.tasks, d).result?.outputs ?? []).map(o => ({ from_task: d, name: o.name })))
        leased.push({
          protocol: PROTOCOL, task_id: task.task_id, type: task.type, title: task.title, instruction: task.instruction,
          inputs: task.inputs.map(name => ({ name, from_task: task.task_id })).concat(upstream),
          output: task.output, priority: task.priority, deadline: task.deadline, lease_until: task.leaseUntil,
          parent_task_id: task.parent_task_id, context: task.context, attempt: task.attempts,
        })
      }
      return { tasks: leased }
    })
  }

  /** The task must be leased by this very agent. */
  owned(state, agentId, taskId) {
    this.liveAgent(state, agentId)
    const task = own(state.tasks, taskId)
    if (task === undefined || task.assignedTo !== agentId) throw new HubError(404, 'task-not-found', 'no such task leased by this agent')
    if (task.status !== 'accepted' && task.status !== 'running') throw new HubError(409, 'task-not-active', `task is ${task.status}`)
    return task
  }

  progress(agentId, body = {}) {
    return this.mutate((state) => {
      const task = this.owned(state, agentId, body.task_id)
      task.status = 'running'
      if (typeof body.progress === 'number' && body.progress >= 0 && body.progress <= 1) task.progress = body.progress
      if (typeof body.message === 'string') task.message = body.message.slice(0, 1000)
      task.leaseUntil = nowIso(this.clock() + task.lease_seconds * 1000) // progress renews the lease
      this.event(task, 'progress', task.message)
      return { ok: true, lease_until: task.leaseUntil }
    })
  }

  /** Final result. Files are inline (base64) and land under outputs/. */
  submitResult(agentId, body = {}) {
    const status = body.status
    if (!['completed', 'failed', 'partial'].includes(status)) throw new HubError(400, 'bad-result', 'status must be completed, failed or partial')
    const files = body.files ?? []
    if (!Array.isArray(files) || files.length > 50) throw new HubError(400, 'bad-result', 'files must be a list of at most 50')
    return this.mutate(async (state) => {
      const task = this.owned(state, agentId, body.task_id)
      const dir = join(this.artifactDir, task.task_id, 'outputs')
      await mkdir(dir, { recursive: true })
      const outputs = []
      for (const file of files) {
        const name = safeFileName(file?.name)
        const data = Buffer.from(String(file.base64 ?? ''), 'base64')
        await writeFile(join(dir, name), data)
        outputs.push({ name, bytes: data.length, type: String(file.type ?? '').slice(0, 32), description: String(file.description ?? '').slice(0, 300) })
      }
      const error = body.error && typeof body.error === 'object'
        ? { code: String(body.error.code ?? 'AGENT_ERROR').slice(0, 64), message: String(body.error.message ?? '').slice(0, 2000), retryable: body.error.retryable === true }
        : undefined
      task.result = {
        status, summary: String(body.summary ?? '').slice(0, 4000), outputs, error,
        needs_input: body.needs_input === undefined ? undefined : String(body.needs_input).slice(0, 2000),
        finished_at: nowIso(this.clock()), agent: agentId,
      }
      task.leaseUntil = undefined
      if (status === 'completed') { task.status = 'completed'; task.progress = 1 }
      else if (status === 'partial') { task.status = 'failed'; task.result.error = task.result.error ?? { code: 'NEEDS_HUMAN', message: task.result.needs_input ?? '', retryable: false } }
      else if (error?.retryable) { this.requeue(task, `retryable failure: ${error.code}`) }
      else task.status = 'failed'
      if (task.status !== 'pending') this.event(task, task.status, task.result.summary.slice(0, 200))
      this.log(`agent-hub: ${agentId} finished ${task.task_id}: ${task.status}`)
      return { ok: true, task_status: task.status }
    })
  }

  /** Bytes of an input (or an upstream output) of a task THIS agent holds. */
  async artifact(agentId, { task_id: taskId, from_task: fromTask, name }) {
    const safe = safeFileName(name)
    const source = await this.read((state) => {
      const task = this.owned(state, agentId, taskId)
      const from = fromTask ?? taskId
      if (from === taskId) {
        if (!task.inputs.includes(safe)) throw new HubError(404, 'artifact-not-found', 'not an input of this task')
        return join(this.artifactDir, taskId, 'inputs', safe)
      }
      if (!task.depends_on.includes(from)) throw new HubError(403, 'forbidden', 'from_task is not an upstream of this task')
      if (!(own(state.tasks, from).result?.outputs ?? []).some(o => o.name === safe)) throw new HubError(404, 'artifact-not-found', 'not an output of the upstream task')
      return join(this.artifactDir, from, 'outputs', safe)
    })
    return readFile(source)
  }

  /** DSH side: read an output file of any task (for review). */
  async readOutput(taskId, name) {
    const safe = safeFileName(name)
    await this.read(state => this.mustTask(state, taskId))
    return readFile(join(this.artifactDir, taskId, 'outputs', safe))
  }

  // --- sweeper -------------------------------------------------------------

  /** Expire leases and requeue; returns how many tasks changed. */
  sweep() {
    return this.mutate((state) => {
      let changed = 0
      const now = this.clock()
      for (const task of Object.values(state.tasks)) {
        if ((task.status === 'accepted' || task.status === 'running') && task.leaseUntil && Date.parse(task.leaseUntil) < now) {
          this.requeue(task, `lease expired (${task.assignedTo})`)
          changed++
        }
        if (task.status === 'pending' && task.depends_on.some(d => ['failed', 'cancelled', 'dead'].includes(own(state.tasks, d)?.status))) {
          task.status = 'failed'
          task.result = { status: 'failed', summary: '', outputs: [], error: { code: 'UPSTREAM_FAILED', message: 'a depends_on task did not complete', retryable: false } }
          this.event(task, 'failed', 'upstream failed')
          changed++
        }
      }
      for (const request of Object.values(state.requests ?? {})) {
        if (request.status === 'pending' && now - Date.parse(request.requested_at) > this.requestTtlMs) {
          request.status = 'expired'
          request.decided_at = nowIso(now)
          changed++
        }
      }
      return changed
    })
  }

  overview() {
    return this.read(state => {
      const counts = {}
      for (const t of Object.values(state.tasks)) counts[t.status] = (counts[t.status] ?? 0) + 1
      const pendingRequests = Object.values(state.requests ?? {}).filter(r => r.status === 'pending').length
      return { protocol: PROTOCOL, agents: Object.values(state.agents).map(a => this.publicAgent(a, state)), task_counts: counts, pending_requests: pendingRequests }
    })
  }
}

