/**
 * Core of the standalone dsh-hub service (protocol dsh-agent/2.0).
 *
 * Started from plugins/dsh-agent-hub/packages/host-agent-hub/hub.js (v1) and
 * extended for docs/DSH-HUB-PROTOCOL-v2.md:
 *
 *   - Controllers (DSH instances such as dsh-cloud / dsh-local) are a second
 *     registry. Their tokens (`dshc_<id>_<random>`) are minted only by the CLI
 *     on the hub machine and only their sha256 is stored, in controllers.json
 *     next to state.json. The CLI writes that file; the running service only
 *     reads it (on every controller authentication and again inside every
 *     controller mutation), so `controller add / revoke` takes effect at once
 *     without a restart and without the two processes fighting over state.json.
 *   - Workers (dsha_ tokens) carry `node`, the workspace names granted at
 *     approval (`workspaces`) and the names they currently report
 *     (`reportedWorkspaces`, always a subset of the grant: extra names in a
 *     heartbeat are dropped and listed back as `ignored_workspaces`).
 *   - Tasks carry `workspace`, `node`, `ref` and `created_by` (the dispatching
 *     controller). Only the creator may cancel or retry; reads are open to
 *     every controller.
 *   - Routing (contract section 4): target (id or pool:<cap>) AND workspace
 *     reported+granted AND node equal AND depends_on completed AND room under
 *     max_concurrency.
 *   - Long polling: poll() waits up to `wait` seconds (cap 55) and is woken
 *     through an EventEmitter when a task that could go to this worker becomes
 *     pending (dispatch, retry, requeue, freed slot, completed upstream,
 *     heartbeat that changed the reported workspaces).
 *   - Runtime and effort (docs section 10): a worker may declare what it can be
 *     asked to run (`runtime`: modes, thinking levels, defaults per task type and
 *     named agents/personas of its platform) at enrollment and in every heartbeat;
 *     it is descriptive, not a grant, so a heartbeat may change it. A task may
 *     carry `effort` {mode, thinking, agent}: dispatch to a worker that declared a
 *     runtime refuses what it does not support (409 unsupported-effort), pools
 *     only hand the task to workers that support it, and a worker that declared
 *     nothing gets the task with a warning (it may ignore effort).
 *   - Presence (docs section 9): a worker is `pending` (approved, token not
 *     collected yet), `online` (last heartbeat / poll / event within
 *     offlineAfterMs, default 90 s), `offline`, `left` (it called leave) or
 *     `revoked`. Tasks are only handed out when the worker itself polls, so
 *     only online workers get work. A heartbeat may list the tasks the worker
 *     still holds (`running`): tasks the hub no longer gives it come back as
 *     `abort`, tasks the hub thinks it holds but it did not list are requeued
 *     (`worker-lost`, after a short grace for leases still in flight). A
 *     worker that goes offline or leaves has its tasks requeued by the next
 *     sweep / at once, without waiting for the lease to run out.
 *
 * Kept from v1 (security fixes): own() never reaches Object.prototype; every
 * mutation re-checks that the caller (worker or controller) is still live;
 * input is validated before anything is written.
 *
 * State lives in one JSON file written atomically; artifacts live on disk next
 * to it. Single process, so an in-memory promise chain serializes mutations.
 *
 * @module dsh-hub/hub
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { DEFAULT_ROLE, ROLES, agentRole, roleAccepts, roleOf, roleRefusal, roleTakesWork, roleWidening } from './roles.js'

export const PROTOCOL = 'dsh-agent/2.0'
export const VERSION = '2.0.0'
export const AGENT_ID_RE = /^[a-z][a-z0-9-]{1,47}$/
export const TASK_ID_RE = /^[A-Za-z0-9_.-]{1,96}$/
export const CAP_RE = /^[a-z][a-z0-9-]{0,47}$/
export const NODE_RE = /^[a-z][a-z0-9-]{0,47}$/
/** Workspace names follow router-b partition names (e.g. deepseek-harness, rca-ab-test). */
export const WORKSPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
/** A git branch / tag / commit; never starts with "-" (no option injection on the worker). */
export const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/
export const POOL_RE = /^pool:[a-z][a-z0-9-]{0,47}$/
export const FILE_NAME_RE = /^[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff _.()-]{0,127}$/
export const TASK_TYPES = ['research', 'document', 'data', 'code', 'review', 'custom']
export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'dead'])
/** The built-in executor: DSH itself, taking tasks nobody suitable picked up (fallback). */
export const FALLBACK_AGENT = 'dsh-self'
/**
 * `decided_by` of an enrollment approved by `hub.json` "autoApprove": no
 * controller token and no human were involved (see requestEnrollment).
 */
export const AUTO_APPROVED_BY = 'auto-approve'
/** Default wait before DSH takes a task over: 10 min; a named scheduled puller gets two of its periods. */
export const FALLBACK_MIN_WAIT_SECONDS = 600
/** Capabilities DSH never takes over by default (only that agent may touch the data). */
export const DEFAULT_NO_FALLBACK = ['quick']
export const MAX_WAIT_SECONDS = 55
const PRIORITY = { high: 0, normal: 1, low: 2 }
const MAX_WORKSPACES = 64
const MAX_RUNNING = 64
export const DEFAULT_OFFLINE_AFTER_MS = 90_000
/** A lease younger than this is never treated as lost by heartbeat reconciliation (poll answer may still be in flight). */
export const RECONCILE_GRACE_MS = 30_000
export const AGENT_STATUSES = ['pending', 'online', 'offline', 'left', 'revoked']
/** A scheduled puller (AWS Quick, a cron job) declares how often it comes back: 60 s .. 1 day. */
export const MIN_PULL_EVERY_SECONDS = 60
export const MAX_PULL_EVERY_SECONDS = 86_400
/** Prefix of `created_by` for tasks dispatched by a dispatcher-role worker (controllers have none). */
export const AGENT_CREATOR_PREFIX = 'agent:'
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9 ._+\/()-]{0,63}$/
export const EFFORT_MODES = ['fast', 'balanced', 'smart']
export const EFFORT_THINKING = ['off', 'low', 'medium', 'high']
/** Named agents / personas a worker platform offers (e.g. an AWS Quick agent, a Claude Code sub-agent). */
export const PERSONA_RE = /^[a-z][a-z0-9-]{0,47}$/
const MAX_PERSONAS = 32

/** A caller-visible failure with an HTTP status and a stable code. */
export class HubError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}

/** Own-property lookup: ids from callers must never reach Object.prototype. */
export const own = (obj, key) => (obj != null && typeof key === 'string' && Object.hasOwn(obj, key) ? obj[key] : undefined)

const sha256 = text => createHash('sha256').update(text, 'utf8').digest()
const nowIso = (now = Date.now()) => new Date(now).toISOString()
const isActive = task => task.status === 'accepted' || task.status === 'running'

/** Reject names that could escape a directory. */
export function safeFileName(raw) {
  if (typeof raw !== 'string' || !FILE_NAME_RE.test(raw) || raw.includes('..') || basename(raw) !== raw) {
    throw new HubError(400, 'bad-file-name', `invalid file name: ${String(raw).slice(0, 80)}`)
  }
  return raw
}

/** A git ref the worker can safely `fetch` / `checkout`. */
export function validRef(ref) {
  return typeof ref === 'string' && REF_RE.test(ref) && !ref.includes('..') && !ref.includes('//')
    && !ref.endsWith('/') && !ref.endsWith('.') && !ref.endsWith('.lock')
}

/** Validate an optional list of names; returns a de-duplicated copy. */
/**
 * Capabilities: `name` or `name:N`, where N (1..32) caps how many tasks of that
 * capability the worker runs at once (a local DSH: `browser:1,test,code`).
 * Returns the names and the per-capability limits.
 */
/** Validate a result body; returns the checked output file names. */
function checkResult(b) {
  if (!['completed', 'failed', 'partial'].includes(b.status)) throw new HubError(400, 'bad-result', 'status must be completed, failed or partial')
  const files = b.files ?? []
  if (!Array.isArray(files) || files.length > 50) throw new HubError(400, 'bad-result', 'files must be a list of at most 50')
  const names = files.map(file => safeFileName(file?.name)) // all names checked before anything is written
  if (new Set(names).size !== names.length) throw new HubError(400, 'bad-result', 'duplicate output file name')
  return names
}

/** A task's workspace is one DSH has (no list given = do not filter). */
function fallbackWorkspaceOk(task, workspaces) {
  return task.workspace === undefined || !Array.isArray(workspaces) || workspaces.includes(task.workspace)
}

/** Path of an input of `task` or of an output of one of its upstream tasks. */
function inputPath(artifactDir, state, task, fromTask, safe) {
  const from = fromTask ?? task.task_id
  if (from === task.task_id) {
    if (!task.inputs.includes(safe)) throw new HubError(404, 'artifact-not-found', 'not an input of this task')
    return join(artifactDir, task.task_id, 'inputs', safe)
  }
  if (!task.depends_on.includes(from)) throw new HubError(403, 'forbidden', 'from_task is not an upstream of this task')
  if (!(own(state.tasks, from)?.result?.outputs ?? []).some(o => o.name === safe)) throw new HubError(404, 'artifact-not-found', 'not an output of the upstream task')
  return join(artifactDir, from, 'outputs', safe)
}

export function parseCapabilities(value) {
  const caps = value ?? []
  if (!Array.isArray(caps) || caps.length > 32) throw new HubError(400, 'bad-capabilities', 'capabilities must be a list of at most 32 entries')
  const names = []
  const limits = {}
  for (const entry of caps) {
    const m = typeof entry === 'string' ? /^([a-z][a-z0-9-]{0,47})(?::([1-9][0-9]?))?$/.exec(entry) : null
    if (m === null || (m[2] !== undefined && Number(m[2]) > 32)) throw new HubError(400, 'bad-capabilities', 'capabilities must be lowercase names, optionally name:N with N 1..32')
    if (!names.includes(m[1])) names.push(m[1])
    if (m[2] !== undefined) limits[m[1]] = Math.min(limits[m[1]] ?? 32, Number(m[2]))
  }
  return { names, limits }
}

/** The capability list again in `name[:N]` form (to re-validate a stored grant). */
export function capabilityEntries(agent) {
  const limits = agent?.capabilityLimits ?? {}
  return (agent?.capabilities ?? []).map(c => (limits[c] === undefined ? c : `${c}:${limits[c]}`))
}

function nameList(value, re, code, message, max) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || !re.test(v))) throw new HubError(400, code, message)
  return [...new Set(value)]
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * `pull_every_seconds`: how often a scheduled worker (AWS Quick, cron `bridge --once`)
 * comes back to pull. undefined = not declared, null = clear (heartbeat only).
 */
export function validatePullEvery(value, { allowNull = false } = {}) {
  if (value === undefined) return undefined
  if (value === null) {
    if (allowNull) return null
    return undefined
  }
  if (!Number.isInteger(value) || value < MIN_PULL_EVERY_SECONDS || value > MAX_PULL_EVERY_SECONDS) {
    throw new HubError(400, 'bad-schedule', `pull_every_seconds must be an integer ${MIN_PULL_EVERY_SECONDS}..${MAX_PULL_EVERY_SECONDS} (how often this worker comes back to pull)`)
  }
  return value
}

/** Validate a task's `effort` ({ mode, thinking, agent }, all optional). Returns a clean copy or undefined. */
export function validateEffort(raw, code = 'bad-task') {
  if (raw === undefined || raw === null) return undefined
  if (!isPlainObject(raw)) throw new HubError(400, code, 'effort must be an object { mode, thinking, agent }')
  const out = {}
  if (raw.mode !== undefined) {
    if (!EFFORT_MODES.includes(raw.mode)) throw new HubError(400, code, `effort.mode must be one of ${EFFORT_MODES.join(', ')}`)
    out.mode = raw.mode
  }
  if (raw.thinking !== undefined) {
    if (!EFFORT_THINKING.includes(raw.thinking)) throw new HubError(400, code, `effort.thinking must be one of ${EFFORT_THINKING.join(', ')}`)
    out.thinking = raw.thinking
  }
  if (out.mode === 'fast' && out.thinking !== undefined && out.thinking !== 'off') throw new HubError(400, code, 'effort.thinking needs mode balanced or smart (fast has no thinking)')
  if (raw.agent !== undefined) {
    if (typeof raw.agent !== 'string' || !PERSONA_RE.test(raw.agent)) throw new HubError(400, code, 'effort.agent must match /^[a-z][a-z0-9-]{0,47}$/')
    out.agent = raw.agent
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** A subset of `allowed`, in canonical order. */
function choiceList(value, allowed, label) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some(v => !allowed.includes(v))) throw new HubError(400, 'bad-runtime', `runtime.${label} must be a list of ${allowed.join(', ')}`)
  return allowed.filter(v => value.includes(v))
}

/**
 * Validate a worker's `runtime` declaration. Unknown keys are dropped.
 *   modes     ["fast", "balanced", "smart"]        what effort.mode may ask for
 *   thinking  ["off", "low", "medium", "high"]     what effort.thinking may ask for
 *   default   { mode, thinking, agent }            used when a task names no effort
 *   defaults  { <task type>: { mode, thinking, agent } }
 *   agents    [{ name, description }]              named agents effort.agent may pick
 *   note      free text (<= 300)
 */
export function validateRuntime(raw) {
  if (raw === undefined || raw === null) return undefined
  if (!isPlainObject(raw)) throw new HubError(400, 'bad-runtime', 'runtime must be an object')
  const agentsIn = raw.agents ?? []
  if (!Array.isArray(agentsIn) || agentsIn.length > MAX_PERSONAS) throw new HubError(400, 'bad-runtime', `runtime.agents must be a list of at most ${MAX_PERSONAS} entries`)
  const agents = []
  for (const a of agentsIn) {
    const entry = typeof a === 'string' ? { name: a } : a
    if (!isPlainObject(entry) || typeof entry.name !== 'string' || !PERSONA_RE.test(entry.name)) throw new HubError(400, 'bad-runtime', 'runtime.agents[].name must match /^[a-z][a-z0-9-]{0,47}$/')
    if (agents.some(x => x.name === entry.name)) continue
    const clean = { name: entry.name }
    if (entry.description !== undefined) clean.description = String(entry.description).slice(0, 200)
    agents.push(clean)
  }
  const rt = { modes: choiceList(raw.modes, EFFORT_MODES, 'modes'), thinking: choiceList(raw.thinking, EFFORT_THINKING, 'thinking'), agents }
  const check = (effort, where) => {
    const e = validateEffort(effort, 'bad-runtime')
    const why = effortProblem(rt, e)
    if (why !== null) throw new HubError(400, 'bad-runtime', `${where}: ${why}`)
    return e
  }
  if (raw.default !== undefined && raw.default !== null) {
    const e = check(raw.default, 'runtime.default')
    if (e !== undefined) rt.default = e
  }
  if (raw.defaults !== undefined && raw.defaults !== null) {
    if (!isPlainObject(raw.defaults)) throw new HubError(400, 'bad-runtime', 'runtime.defaults must be an object of task type -> effort')
    const defaults = {}
    for (const [type, effort] of Object.entries(raw.defaults)) {
      if (!TASK_TYPES.includes(type)) throw new HubError(400, 'bad-runtime', `runtime.defaults: unknown task type ${type.slice(0, 32)}`)
      const e = check(effort, `runtime.defaults.${type}`)
      if (e !== undefined) defaults[type] = e
    }
    if (Object.keys(defaults).length > 0) rt.defaults = defaults
  }
  if (raw.note !== undefined && raw.note !== null) rt.note = String(raw.note).slice(0, 300)
  return rt
}

/**
 * Why this runtime cannot honour this effort, or null. No effort -> null. No runtime
 * declared -> only a named agent is a problem (mode / thinking are best effort).
 */
/** A worker that lists no capabilities takes any kind of task sent to it by id. */
export function hasCapability(agent, capability) {
  return capability === undefined || (agent.capabilities ?? []).length === 0 || agent.capabilities.includes(capability)
}

export function effortProblem(runtime, effort) {
  if (effort === undefined) return null
  if (runtime === undefined) return effort.agent !== undefined ? `declares no agents (asked for agent ${effort.agent})` : null
  if (effort.mode !== undefined && runtime.modes.length > 0 && !runtime.modes.includes(effort.mode)) return `does not offer mode ${effort.mode} (offers ${runtime.modes.join(', ')})`
  if (effort.thinking !== undefined && runtime.thinking.length > 0 && !runtime.thinking.includes(effort.thinking)) return `does not offer thinking ${effort.thinking} (offers ${runtime.thinking.join(', ')})`
  if (effort.agent !== undefined && !runtime.agents.some(a => a.name === effort.agent)) {
    return `has no agent ${effort.agent} (has ${runtime.agents.map(a => a.name).join(', ') || 'none'})`
  }
  return null
}

/** Constant-time check of a token against a stored hex sha256 ('' = no usable token). */
function tokenMatches(storedHex, token) {
  const want = typeof storedHex === 'string' && storedHex.length === 64 ? Buffer.from(storedHex, 'hex') : Buffer.alloc(32)
  return timingSafeEqual(want, sha256(token)) && typeof storedHex === 'string' && storedHex !== ''
}

/** `dsha_<id>_<random>` / `dshc_<id>_<random>` -> id (the random part may contain "_"). */
function tokenId(token, prefix) {
  if (typeof token !== 'string' || !token.startsWith(prefix)) return undefined
  return token.slice(prefix.length).split('_', 1)[0]
}

export class AgentHub {
  /**
   * @param {{ dataDir: string, offlineAfterMs?: number, maxRetries?: number, maxPendingRequests?: number,
   *           requestTtlMs?: number, maxWaitSeconds?: number, maxWaitersPerAgent?: number,
   *           autoApprove?: boolean, logger?: any, clock?: () => number }} options
   */
  constructor(options) {
    this.dataDir = options.dataDir
    this.statePath = join(this.dataDir, 'state.json')
    this.controllersPath = join(this.dataDir, 'controllers.json')
    this.artifactDir = join(this.dataDir, 'artifacts')
    this.offlineAfterMs = options.offlineAfterMs ?? DEFAULT_OFFLINE_AFTER_MS
    this.maxRetries = options.maxRetries ?? 2
    this.maxPendingRequests = options.maxPendingRequests ?? 20
    this.requestTtlMs = options.requestTtlMs ?? 24 * 3600 * 1000
    this.maxWaitSeconds = Math.min(options.maxWaitSeconds ?? MAX_WAIT_SECONDS, MAX_WAIT_SECONDS)
    this.maxWaitersPerAgent = options.maxWaitersPerAgent ?? 8
    // Off unless hub.json says so (config.js refuses autoApprove without an allow list).
    this.autoApprove = options.autoApprove === true
    const fb = options.fallback ?? {}
    this.fallback = {
      enabled: fb.enabled !== false,
      noFallback: Array.isArray(fb.noFallbackCapabilities) ? fb.noFallbackCapabilities.filter(c => typeof c === 'string') : DEFAULT_NO_FALLBACK,
    }
    this.logger = options.logger
    this.clock = options.clock ?? Date.now
    this.state = undefined
    this.queue = Promise.resolve()
    this.ctlQueue = Promise.resolve()
    this.events = new EventEmitter()
    this.events.setMaxListeners(0)
    this.wakes = new Set()
    this.waiters = new Map()
    this.closed = false
  }

  // --- persistence ---------------------------------------------------------

  async load() {
    if (this.state !== undefined) return this.state
    await mkdir(this.artifactDir, { recursive: true })
    let state
    try {
      state = JSON.parse(await readFile(this.statePath, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      state = { protocol: PROTOCOL, agents: {}, tasks: {}, requests: {}, seq: 0 }
    }
    this.state = this.upgrade(state)
    return this.state
  }

  /** Bring a v1 (or partial) state document up to the v2 shape in memory. */
  upgrade(state) {
    if (state === null || typeof state !== 'object' || Array.isArray(state)) throw new HubError(500, 'bad-state', 'state.json is not an object')
    state.protocol = PROTOCOL
    for (const key of ['agents', 'tasks', 'requests']) if (state[key] === null || typeof state[key] !== 'object') state[key] = {}
    state.seq = Number.isInteger(state.seq) ? state.seq : 0
    for (const agent of Object.values(state.agents)) {
      if (!Array.isArray(agent.workspaces)) agent.workspaces = []
      if (!Array.isArray(agent.reportedWorkspaces)) agent.reportedWorkspaces = []
    }
    for (const request of Object.values(state.requests)) {
      if (request?.agent && !Array.isArray(request.agent.workspaces)) request.agent.workspaces = []
    }
    return state
  }

  async save() {
    const temp = `${this.statePath}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temp, `${JSON.stringify(this.state, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, this.statePath)
  }

  /** Serialize every mutation; save after it; then wake the workers it marked. */
  mutate(fn) {
    const run = this.queue.then(async () => {
      const state = await this.load()
      this.wakes.clear()
      try {
        const value = await fn(state)
        await this.save()
        const ids = [...this.wakes]
        this.wakes.clear()
        for (const id of ids) this.events.emit(`wake:${id}`)
        return value
      } catch (error) {
        this.wakes.clear()
        throw error
      }
    })
    this.queue = run.catch(() => {})
    return run
  }

  async read(fn) { await this.queue; return fn(await this.load()) }

  log(message) { try { this.logger?.info?.(message) } catch { /* ignore */ } }
  warn(message) { try { (this.logger?.warn ?? this.logger?.info)?.call(this.logger, message) } catch { /* ignore */ } }

  /** Stop: wake every long poll so it returns at once; resolves when pending writes are done. */
  close() {
    this.closed = true
    this.events.emit('shutdown')
    return this.queue
  }

  // --- controllers (minted by the CLI on the hub machine only) -------------

  async readControllers() {
    let doc
    try {
      doc = JSON.parse(await readFile(this.controllersPath, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return {}
      throw error
    }
    return doc !== null && typeof doc === 'object' && doc.controllers !== null && typeof doc.controllers === 'object' ? doc.controllers : {}
  }

  async writeControllers(controllers) {
    await mkdir(this.dataDir, { recursive: true })
    const temp = `${this.controllersPath}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temp, `${JSON.stringify({ protocol: PROTOCOL, controllers }, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, this.controllersPath)
  }

  ctlMutate(fn) {
    const run = this.ctlQueue.then(async () => {
      const controllers = await this.readControllers()
      const value = await fn(controllers)
      await this.writeControllers(controllers)
      return value
    })
    this.ctlQueue = run.catch(() => {})
    return run
  }

  publicController(c) {
    return { controller_id: c.id, revoked: c.revoked === true, created_at: c.createdAt, revoked_at: c.revokedAt }
  }

  /** CLI only: mint a controller token. Returned ONCE; only its sha256 is written. */
  addController(id) {
    if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) throw new HubError(400, 'bad-controller-id', 'controller id must match /^[a-z][a-z0-9-]{1,47}$/')
    const token = `dshc_${id}_${randomBytes(24).toString('base64url')}`
    return this.ctlMutate((controllers) => {
      const previous = own(controllers, id)
      if (previous !== undefined && previous.revoked !== true) throw new HubError(409, 'controller-exists', `controller already exists: ${id} (revoke it first to re-issue)`)
      controllers[id] = { id, tokenHash: sha256(token).toString('hex'), createdAt: nowIso(this.clock()), revoked: false, revokedAt: undefined }
      this.log(`dsh-hub: controller ${id} ${previous === undefined ? 'added' : 're-issued'}`)
      return { controller: this.publicController(controllers[id]), token }
    })
  }

  async listControllers() {
    const controllers = await this.readControllers()
    return Object.values(controllers).map(c => this.publicController(c)).sort((a, b) => a.controller_id.localeCompare(b.controller_id))
  }

  revokeController(id) {
    return this.ctlMutate((controllers) => {
      const c = own(controllers, id)
      if (c === undefined) throw new HubError(404, 'controller-not-found', `controller not found: ${id}`)
      c.revoked = true
      c.tokenHash = ''
      c.revokedAt = nowIso(this.clock())
      this.log(`dsh-hub: controller ${id} revoked`)
      return this.publicController(c)
    })
  }

  /** Token -> controller id, or 401. Reads controllers.json every time (CLI changes apply at once). */
  async authenticateController(token) {
    const id = tokenId(token, 'dshc_')
    if (id === undefined) throw new HubError(401, 'unauthorized', 'missing or malformed controller token')
    const c = own(await this.readControllers(), id)
    const ok = tokenMatches(c?.tokenHash, token) && c !== undefined && c.revoked !== true
    if (!ok) throw new HubError(401, 'unauthorized', 'invalid controller token')
    return c.id
  }

  /** Re-check inside a mutation: a revoke between authenticate and here must win. */
  async liveController(id) {
    const c = own(await this.readControllers(), id)
    if (c === undefined || c.revoked === true || !c.tokenHash) throw new HubError(401, 'unauthorized', 'controller revoked')
    return c
  }

  /** Any hub token -> { role: 'worker' | 'controller', id }, or 401. */
  async authenticateToken(token) {
    if (typeof token === 'string' && token.startsWith('dsha_')) return { role: 'worker', id: await this.authenticate(token) }
    if (typeof token === 'string' && token.startsWith('dshc_')) return { role: 'controller', id: await this.authenticateController(token) }
    throw new HubError(401, 'unauthorized', 'missing or malformed token')
  }

  // --- workers (controllers only) -------------------------------------------

  /** Validate the worker description shared by provision and enrollment. */
  validateAgent(input) {
    const id = input?.agent_id
    if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) throw new HubError(400, 'bad-agent-id', 'agent_id must match /^[a-z][a-z0-9-]{1,47}$/')
    if (id === FALLBACK_AGENT) throw new HubError(400, 'bad-agent-id', `${FALLBACK_AGENT} is reserved for DSH itself`)
    const caps = parseCapabilities(input.capabilities)
    const mode = input.mode ?? 'poll'
    if (mode !== 'poll' && mode !== 'push') throw new HubError(400, 'bad-mode', 'mode must be poll or push')
    const maxConcurrency = input.max_concurrency ?? 1
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32) throw new HubError(400, 'bad-concurrency', 'max_concurrency must be 1..32')
    const node = input.node ?? undefined
    if (node !== undefined && (typeof node !== 'string' || !NODE_RE.test(node))) throw new HubError(400, 'bad-node', 'node must match /^[a-z][a-z0-9-]{0,47}$/')
    const workspaces = nameList(input.workspaces, WORKSPACE_RE, 'bad-workspaces', `workspaces must be a list of at most ${MAX_WORKSPACES} workspace names`, MAX_WORKSPACES)
    const role = roleOf(input.role)
    if (role === undefined) throw new HubError(400, 'bad-role', `role must be one of ${ROLES.join(', ')} (default ${DEFAULT_ROLE})`)
    const pullEverySeconds = validatePullEvery(input.pull_every_seconds)
    return {
      id, mode, maxConcurrency, capabilities: caps.names, capabilityLimits: caps.limits, node, workspaces, role, pullEverySeconds,
      platform: String(input.platform ?? 'custom').slice(0, 64),
      description: String(input.description ?? '').slice(0, 500),
      runtime: validateRuntime(input.runtime),
    }
  }

  newToken(id) { return `dsha_${id}_${randomBytes(24).toString('base64url')}` }

  writeAgent(state, v, tokenHash, reported = []) {
    const previous = own(state.agents, v.id)
    state.agents[v.id] = {
      id: v.id, platform: v.platform, mode: v.mode, node: v.node, capabilities: v.capabilities,
      capabilityLimits: v.capabilityLimits ?? {}, workspaces: v.workspaces, reportedWorkspaces: reported.filter(w => v.workspaces.includes(w)),
      maxConcurrency: v.maxConcurrency, description: v.description, runtime: v.runtime, tokenHash,
      role: v.role ?? DEFAULT_ROLE, pullEverySeconds: v.pullEverySeconds,
      createdAt: previous?.createdAt ?? nowIso(this.clock()),
      rekeyedAt: previous === undefined ? undefined : nowIso(this.clock()),
      lastSeen: undefined, reportedStatus: undefined, revoked: false,
      clientVersion: undefined, leftAt: undefined, ignoredWorkspaces: [],
    }
    return previous
  }

  /** A controller creates or re-keys a worker directly. Returns the token ONCE; only its hash is kept. */
  provisionAgent(controllerId, input) {
    const v = this.validateAgent(input)
    const token = this.newToken(v.id)
    return this.mutate(async (state) => {
      await this.liveController(controllerId)
      // Nothing reported yet: workspace tasks wait for the first heartbeat.
      const previous = this.writeAgent(state, v, sha256(token).toString('hex'), [])
      this.wakes.add(v.id)
      this.log(`dsh-hub: ${controllerId} ${previous === undefined ? 'provisioned' : 're-keyed'} worker ${v.id}`)
      return { agent: this.publicAgent(own(state.agents, v.id), state), token }
    })
  }

  // --- enrollment: worker asks, a controller decides -------------------------

  /**
   * Unauthenticated: a worker asks to join. Nothing is granted: the request
   * only shows up for controllers until one approves or rejects it.
   * Returns a poll secret (kept only as a hash) for checking the outcome.
   *
   * With `autoApprove` (hub.json) the request is granted on the spot, exactly
   * as a controller approving it WITHOUT overrides would be: the stored grant
   * is the validated request itself (platform, capabilities, workspaces,
   * concurrency, role), so nothing is added or widened. The HTTP allow list ran
   * before this route (http.js createHandler: clientAddress -> ipAllowed), so
   * only allow-listed peers can reach it.
   */
  requestEnrollment(input) {
    const v = this.validateAgent(input)
    const pollSecret = randomBytes(24).toString('base64url')
    return this.mutate((state) => {
      const pending = Object.values(state.requests).filter(r => r.status === 'pending' && this.clock() - Date.parse(r.requested_at) <= this.requestTtlMs)
      if (own(state.agents, v.id) !== undefined && !own(state.agents, v.id).revoked) throw new HubError(409, 'agent-exists', `agent already registered: ${v.id}`)
      if (pending.some(r => r.agent.id === v.id)) throw new HubError(409, 'request-pending', `a request for ${v.id} is already pending`)
      if (pending.length >= this.maxPendingRequests) throw new HubError(429, 'too-many-requests', 'too many pending enrollment requests')
      const requestId = `req_${randomBytes(9).toString('base64url')}`
      const from = String(input.from ?? '').slice(0, 100)
      state.requests[requestId] = {
        request_id: requestId, agent: v, status: 'pending', secretHash: sha256(pollSecret).toString('hex'),
        requested_at: nowIso(this.clock()), from,
        decided_at: undefined, decided_by: undefined, reason: undefined, tokenIssued: false, auto_approved: false,
      }
      this.log(`dsh-hub: enrollment request ${requestId} for ${v.id} (${v.platform}, node ${v.node ?? '-'}) from ${from || '-'} awaiting approval`)
      if (this.autoApprove !== true) return { request_id: requestId, poll_secret: pollSecret, status: 'pending' }
      const request = state.requests[requestId]
      this.grantRequest(state, request, v, AUTO_APPROVED_BY)
      request.auto_approved = true
      const granted = v.capabilities.map(c => (v.capabilityLimits?.[c] === undefined ? c : `${c}:${v.capabilityLimits[c]}`)).join(',')
      this.log(`dsh-hub: AUTO-APPROVE ${requestId} agent=${v.id} at=${request.decided_at} from=${from || '-'} platform=${v.platform} node=${v.node ?? '-'} role=${v.role} capabilities=[${granted}] workspaces=[${(v.workspaces ?? []).join(',')}] max_concurrency=${v.maxConcurrency} decided_by=${AUTO_APPROVED_BY} (hub.json autoApprove: no controller token, no human)`)
      return { request_id: requestId, poll_secret: pollSecret, status: 'approved', auto_approved: true }
    })
  }

  /**
   * Unauthenticated but secret-bound: the requester checks its request. The
   * token is minted on the FIRST read after approval and never again, so no
   * plaintext token is ever stored. `agentId` (the query id) must match.
   */
  enrollmentStatus(body = {}, { agentId } = {}) {
    return this.mutate((state) => {
      const request = own(state.requests, body?.request_id)
      const secretOk = tokenMatches(request?.secretHash, String(body?.poll_secret ?? ''))
      if (!secretOk || request === undefined || (agentId !== undefined && request.agent.id !== agentId)) throw new HubError(404, 'request-not-found', 'unknown request or wrong poll secret')
      if (request.status !== 'approved') return { request_id: request.request_id, status: request.status, reason: request.reason }
      if (request.tokenIssued) return { request_id: request.request_id, status: 'approved', token_issued: true, note: 'token was already delivered; ask a controller to re-provision if lost' }
      const agent = own(state.agents, request.agent.id)
      if (agent === undefined || agent.revoked) return { request_id: request.request_id, status: 'revoked' }
      const token = this.newToken(agent.id)
      agent.tokenHash = sha256(token).toString('hex')
      request.tokenIssued = true
      this.wakes.add(agent.id)
      this.log(`dsh-hub: token delivered to ${agent.id} (${request.request_id})`)
      return { request_id: request.request_id, status: 'approved', agent_id: agent.id, token }
    })
  }

  listRequests({ status = 'pending' } = {}) {
    return this.read(state => Object.values(state.requests)
      .filter(r => status === 'all' || r.status === status)
      .sort((a, b) => b.requested_at.localeCompare(a.requested_at))
      .map(r => ({
        request_id: r.request_id, status: r.status, agent_id: r.agent.id, platform: r.agent.platform, mode: r.agent.mode,
        node: r.agent.node, workspaces: r.agent.workspaces ?? [], capabilities: r.agent.capabilities, capability_limits: r.agent.capabilityLimits ?? {}, max_concurrency: r.agent.maxConcurrency,
        description: r.agent.description, runtime: r.agent.runtime, role: agentRole(r.agent), pull_every_seconds: r.agent.pullEverySeconds, auto_approved: r.auto_approved === true, from: r.from, requested_at: r.requested_at, decided_at: r.decided_at, decided_by: r.decided_by, reason: r.reason,
      })))
  }

  /**
   * Store the grant of one decided request: `v` is the already validated and
   * never-widened worker record. No usable token yet — the requester collects
   * it through /v1/enroll/status. Shared by a controller approval and by
   * autoApprove so both grant exactly the same shape.
   */
  grantRequest(state, request, v, decidedBy) {
    // The enrollment itself reported the requested names; what is granted of them counts as reported.
    this.writeAgent(state, v, '', request.agent.workspaces ?? [])
    request.status = 'approved'
    request.decided_at = nowIso(this.clock())
    request.decided_by = decidedBy
    request.agent = v
    return request
  }

  /** A controller approves; it may only NARROW capabilities, workspaces and concurrency. */
  approveRequest(controllerId, requestId, overrides = {}) {
    return this.mutate(async (state) => {
      await this.liveController(controllerId)
      const request = own(state.requests, requestId)
      if (request === undefined) throw new HubError(404, 'request-not-found', `request not found: ${requestId}`)
      if (request.status !== 'pending') throw new HubError(409, 'request-decided', `request is ${request.status}`)
      const asked = request.agent
      const o = overrides ?? {}
      const askedRole = agentRole(asked)
      const v = this.validateAgent({
        agent_id: asked.id, platform: asked.platform, mode: asked.mode, description: asked.description, node: asked.node,
        runtime: asked.runtime,
        capabilities: o.capabilities ?? capabilityEntries(asked),
        workspaces: o.workspaces ?? asked.workspaces,
        max_concurrency: o.max_concurrency ?? asked.maxConcurrency,
        role: o.role ?? askedRole,
        // Descriptive (how often it comes back), not a grant: the controller may set it.
        pull_every_seconds: o.pull_every_seconds ?? asked.pullEverySeconds,
      })
      const widened = roleWidening(askedRole, v.role)
      if (widened !== undefined) throw new HubError(400, widened.code, widened.message)
      if (v.capabilities.some(c => !asked.capabilities.includes(c))) throw new HubError(400, 'grant-widened', 'capabilities can only be narrowed at approval')
      const askedLimit = c => asked.capabilityLimits?.[c] ?? asked.maxConcurrency
      if (v.capabilities.some(c => (v.capabilityLimits[c] ?? v.maxConcurrency) > askedLimit(c))) throw new HubError(400, 'grant-widened', 'a capability limit can only be lowered at approval')
      if (v.workspaces.some(w => !(asked.workspaces ?? []).includes(w))) throw new HubError(400, 'grant-widened', 'workspaces can only be narrowed at approval')
      if (v.maxConcurrency > asked.maxConcurrency) throw new HubError(400, 'grant-widened', 'max_concurrency can only be lowered at approval')
      if (own(state.agents, v.id) !== undefined && !own(state.agents, v.id).revoked) throw new HubError(409, 'agent-exists', `agent already registered: ${v.id}`)
      this.grantRequest(state, request, v, controllerId)
      this.log(`dsh-hub: ${controllerId} approved ${requestId} -> worker ${v.id}`)
      return { request_id: requestId, status: 'approved', agent: this.publicAgent(own(state.agents, v.id), state) }
    })
  }

  rejectRequest(controllerId, requestId, reason = '') {
    return this.mutate(async (state) => {
      await this.liveController(controllerId)
      const request = own(state.requests, requestId)
      if (request === undefined) throw new HubError(404, 'request-not-found', `request not found: ${requestId}`)
      if (request.status !== 'pending') throw new HubError(409, 'request-decided', `request is ${request.status}`)
      request.status = 'rejected'
      request.decided_at = nowIso(this.clock())
      request.decided_by = controllerId
      request.reason = String(reason ?? '').slice(0, 500)
      this.log(`dsh-hub: ${controllerId} rejected ${requestId} (${request.agent.id})`)
      return { request_id: requestId, status: 'rejected' }
    })
  }

  revokeAgent(controllerId, id) {
    return this.mutate(async (state) => {
      await this.liveController(controllerId)
      const agent = own(state.agents, id)
      if (agent === undefined) throw new HubError(404, 'agent-not-found', `agent not found: ${id}`)
      agent.revoked = true
      agent.tokenHash = ''
      // Hand its running work back to the queue.
      for (const task of Object.values(state.tasks)) {
        if (task.assignedTo === id && isActive(task)) this.requeue(state, task, 'agent revoked')
      }
      this.wakes.add(id) // its own long polls re-check and fail with 401
      this.log(`dsh-hub: ${controllerId} revoked worker ${id}`)
      return this.publicAgent(agent, state)
    })
  }

  listAgents() {
    return this.read(state => Object.values(state.agents).map(a => this.publicAgent(a, state)))
  }

  online(agent) { return this.agentStatus(agent) === 'online' }

  /** pending | online | offline | left | revoked (see the module comment). */
  agentStatus(agent) {
    if (agent.revoked) return 'revoked'
    if (agent.leftAt !== undefined) return 'left'
    if (agent.lastSeen === undefined) return agent.tokenHash === '' ? 'pending' : 'offline'
    return this.clock() - Date.parse(agent.lastSeen) <= this.offlineWindow(agent) ? 'online' : 'offline'
  }

  /**
   * How long this worker may stay silent before it counts as offline: offlineAfterMs,
   * plus its declared pull interval for a scheduled puller (AWS Quick every 15 min,
   * a cron `bridge --once`), so it is not marked offline, and its tasks are not
   * requeued, between two of its scheduled visits.
   */
  offlineWindow(agent) {
    const every = Number.isInteger(agent?.pullEverySeconds) ? agent.pullEverySeconds * 1000 : 0
    return this.offlineAfterMs + every
  }

  /** The worker showed up (heartbeat, poll, event, result): online again, also after a leave. */
  seen(agent) {
    agent.lastSeen = nowIso(this.clock())
    agent.leftAt = undefined
  }

  publicAgent(agent, state) {
    const running = Object.values(state.tasks).filter(t => t.assignedTo === agent.id && isActive(t)).map(t => t.task_id)
    const status = this.agentStatus(agent)
    return {
      agent_id: agent.id, platform: agent.platform, mode: agent.mode, node: agent.node, capabilities: agent.capabilities,
      capability_limits: agent.capabilityLimits ?? {}, workspaces: agent.workspaces, reported_workspaces: agent.reportedWorkspaces,
      max_concurrency: agent.maxConcurrency, description: agent.description, runtime: agent.runtime, revoked: agent.revoked,
      status, online: status === 'online', last_seen: agent.lastSeen, left_at: agent.leftAt, version: agent.clientVersion,
      reported_status: agent.reportedStatus, running_tasks: running, created_at: agent.createdAt,
      role: agentRole(agent), pull_every_seconds: agent.pullEverySeconds, offline_after_ms: this.offlineWindow(agent),
    }
  }

  /** GET /v1/me: the hub's view of the calling worker. */
  me(agentId) {
    return this.read((state) => {
      const agent = this.liveAgent(state, agentId)
      return {
        ...this.publicAgent(agent, state),
        ignored_workspaces: agent.ignoredWorkspaces ?? [],
        offline_after_ms: this.offlineWindow(agent), server_time: nowIso(this.clock()),
      }
    })
  }

  /** POST /v1/leave: the worker goes away on purpose; its tasks go back to the queue at once. */
  leave(agentId, body = {}) {
    const why = typeof body?.reason === 'string' && body.reason.trim() !== '' ? body.reason.trim().slice(0, 200) : 'worker left'
    return this.mutate((state) => {
      const agent = this.liveAgent(state, agentId)
      agent.leftAt = nowIso(this.clock())
      agent.reportedStatus = undefined
      const requeued = []
      for (const task of Object.values(state.tasks)) {
        if (task.assignedTo === agentId && isActive(task)) { this.requeue(state, task, `${why} (${agentId})`); requeued.push(task.task_id) }
      }
      this.log(`dsh-hub: ${agentId} left${requeued.length ? `; requeued ${requeued.join(', ')}` : ''}`)
      return { ok: true, agent_id: agentId, status: 'left', requeued, server_time: agent.leftAt }
    })
  }

  /** Worker token -> worker id, or throw 401. Constant-time compare on the hash. */
  async authenticate(token) {
    const id = tokenId(token, 'dsha_')
    if (id === undefined) throw new HubError(401, 'unauthorized', 'missing or malformed agent token')
    return this.read((state) => {
      const agent = own(state.agents, id)
      const ok = tokenMatches(agent?.tokenHash, token) && agent !== undefined && !agent.revoked
      if (!ok) throw new HubError(401, 'unauthorized', 'invalid agent token')
      return agent.id
    })
  }

  // --- routing ---------------------------------------------------------------

  /** Condition 1: the task targets this worker (by id or pool capability). */
  targets(task, agent) {
    return task.agent === agent.id || (task.agent.startsWith('pool:') && agent.capabilities.includes(task.agent.slice(5)))
  }

  /** Conditions 1-3 (4 = depends_on and room, checked when leasing). */
  routable(task, agent) {
    if (!this.targets(task, agent)) return false
    if (!hasCapability(agent, task.capability)) return false
    if ((task.declined ?? []).includes(agent.id)) return false // it gave this one back (release)
    if (!roleAccepts(agentRole(agent), task)) return false // dispatcher / observer never, tester only tests
    if (task.workspace !== undefined && !(agent.workspaces.includes(task.workspace) && agent.reportedWorkspaces.includes(task.workspace))) return false
    if (task.node !== undefined && task.node !== agent.node) return false
    if (effortProblem(agent.runtime, task.effort) !== null) return false
    return true
  }

  /** Mark every live worker that could take this pending task, to wake its long polls. */
  wakeFor(state, task) {
    if (task.status !== 'pending') return
    for (const agent of Object.values(state.agents)) if (!agent.revoked && this.routable(task, agent)) this.wakes.add(agent.id)
  }

  // --- tasks (controllers only) -----------------------------------------------

  /** A controller creates a task. Inputs are files given inline (text or base64). */
  dispatch(controllerId, input, { asAgent } = {}) {
    const t = input ?? {}
    for (const key of ['title', 'instruction']) {
      if (typeof t[key] !== 'string' || t[key].trim() === '') throw new HubError(400, 'bad-task', `${key} is required`)
    }
    const type = t.type ?? 'custom'
    if (!TASK_TYPES.includes(type)) throw new HubError(400, 'bad-task', `type must be one of ${TASK_TYPES.join(', ')}`)
    const target = t.agent
    if (typeof target !== 'string' || !(AGENT_ID_RE.test(target) || POOL_RE.test(target))) {
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
    const workspace = t.workspace ?? undefined
    if (workspace !== undefined && (typeof workspace !== 'string' || !WORKSPACE_RE.test(workspace))) throw new HubError(400, 'bad-task', 'workspace must be a workspace name')
    if (type === 'code' && workspace === undefined) throw new HubError(400, 'bad-task', 'workspace is required for code tasks')
    const node = t.node ?? undefined
    if (node !== undefined && (typeof node !== 'string' || !NODE_RE.test(node))) throw new HubError(400, 'bad-task', 'node must be a node name')
    const ref = t.ref ?? undefined
    if (ref !== undefined && !validRef(ref)) throw new HubError(400, 'bad-task', 'ref must be a git branch, tag or commit')
    const names = inputs.map(file => safeFileName(file?.name))
    if (new Set(names).size !== names.length) throw new HubError(400, 'bad-task', 'duplicate input file name')
    if (t.task_id !== undefined && (typeof t.task_id !== 'string' || !TASK_ID_RE.test(t.task_id))) throw new HubError(400, 'bad-task', 'invalid task_id')
    if (t.require_online !== undefined && typeof t.require_online !== 'boolean') throw new HubError(400, 'bad-task', 'require_online must be true or false')
    const requireOnline = t.require_online === true
    const effort = validateEffort(t.effort)
    // What kind of work this is (browser / test / code ...), so a worker that does many
    // things knows which of its lanes runs it and the hub can keep per-lane limits.
    const fallback = t.fallback ?? 'dsh'
    if (fallback !== 'dsh' && fallback !== 'none') throw new HubError(400, 'bad-task', 'fallback must be dsh or none')
    const fallbackAfter = t.fallback_after_seconds ?? undefined
    if (fallbackAfter !== undefined && (!Number.isInteger(fallbackAfter) || fallbackAfter < 60 || fallbackAfter > 7 * 86400)) throw new HubError(400, 'bad-task', 'fallback_after_seconds must be 60..604800')
    let capability = t.capability ?? undefined
    if (capability !== undefined && (typeof capability !== 'string' || !CAP_RE.test(capability))) throw new HubError(400, 'bad-task', 'capability must be a capability name')
    if (POOL_RE.test(target)) {
      if (capability !== undefined && capability !== target.slice(5)) throw new HubError(400, 'bad-task', `capability ${capability} does not match ${target}`)
      capability = target.slice(5)
    }

    return this.mutate(async (state) => {
      const creator = await this.creator(state, controllerId, asAgent)
      if (target === FALLBACK_AGENT) throw new HubError(400, 'bad-task', `${FALLBACK_AGENT} takes tasks by fallback only; send it to a worker or pool and leave fallback on`)
      const warnings = []
      if (AGENT_ID_RE.test(target)) {
        const agent = own(state.agents, target)
        if (agent === undefined) {
          const asked = Object.values(state.requests).some(r => r.status === 'pending' && r.agent?.id === target)
          if (asked) throw new HubError(409, 'agent-not-approved', `${target} has asked to join but is not approved yet (agent_requests / agent_approve)`)
          throw new HubError(404, 'agent-not-found', `agent not registered: ${target}`)
        }
        if (agent.revoked) throw new HubError(409, 'agent-revoked', `${target} is revoked`)
        if (!hasCapability(agent, capability)) throw new HubError(409, 'unroutable', `${target} does not offer capability ${capability} (it offers ${agent.capabilities.join(', ')})`)
        const refused = roleRefusal({ type, title: t.title }, agentRole(agent), target)
        if (refused !== undefined) throw new HubError(400, refused.code, refused.message)
        // Fail fast instead of leaving a task no one can ever lease.
        if (workspace !== undefined && !agent.workspaces.includes(workspace)) throw new HubError(409, 'unroutable', `${target} was not granted workspace ${workspace}`)
        if (node !== undefined && agent.node !== node) throw new HubError(409, 'unroutable', `${target} is not on node ${node}`)
        const why = effortProblem(agent.runtime, effort)
        if (why !== null) throw new HubError(409, 'unsupported-effort', `${target} ${why}`)
        if (effort !== undefined && agent.runtime === undefined) warnings.push('effort-not-declared')
        const status = this.agentStatus(agent)
        if (status !== 'online') {
          if (requireOnline) throw new HubError(409, 'agent-offline', `${target} is ${status} (last seen ${agent.lastSeen ?? 'never'})`)
          warnings.push('agent-offline')
        }
      } else {
        const probe = { agent: target, workspace, node, type, title: t.title }
        const members = Object.values(state.agents).filter(a => !a.revoked && this.targets(probe, a))
        if (members.length > 0 && members.every(a => !roleAccepts(agentRole(a), probe))) {
          const refused = roleRefusal(probe, agentRole(members[0]), members[0].id)
          throw new HubError(400, refused?.code ?? 'role-not-dispatchable', `no agent in ${target} may take this task by its role: ${refused?.message ?? ''}`)
        }
        const ready = members.some(a => this.agentStatus(a) === 'online' && roleAccepts(agentRole(a), probe)
          && (workspace === undefined || (a.workspaces.includes(workspace) && a.reportedWorkspaces.includes(workspace)))
          && (node === undefined || a.node === node)
          && effortProblem(a.runtime, effort) === null)
        if (!ready) {
          if (requireOnline) throw new HubError(409, 'no-online-worker', `no online worker can take ${target}${workspace ? ` [${workspace}]` : ''}${node ? ` @${node}` : ''} right now`)
          warnings.push('no-online-worker')
        }
      }
      for (const dep of deps) if (own(state.tasks, dep) === undefined) throw new HubError(404, 'task-not-found', `depends_on task not found: ${dep}`)
      const day = nowIso(this.clock()).slice(0, 10).replace(/-/g, '')
      const id = t.task_id ?? `task_${day}_${String(state.seq + 1).padStart(4, '0')}`
      if (own(state.tasks, id) !== undefined) throw new HubError(409, 'task-exists', `task already exists: ${id}`)
      if (t.task_id === undefined) state.seq += 1

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
        workspace, node, ref, effort, capability,
        inputs: inputNames, output: t.output ?? {}, priority, deadline: t.deadline, lease_seconds: leaseSeconds,
        parent_task_id: t.parent_task_id, depends_on: deps, context: t.context ?? {},
        created_by: creator, created_at: nowIso(this.clock()), pendingSince: nowIso(this.clock()),
        fallback, fallback_after_seconds: fallbackAfter,
        status: 'pending', attempts: 0, assignedTo: undefined, leaseUntil: undefined,
        progress: undefined, message: undefined, result: undefined, history: [],
      }
      this.event(task, 'created', `${creator} -> ${target}${workspace ? ` [${workspace}]` : ''}${node ? ` @${node}` : ''}`)
      state.tasks[id] = task
      this.wakeFor(state, task)
      this.log(`dsh-hub: ${creator} dispatched ${id} to ${target}${warnings.length ? ` (${warnings.join(', ')})` : ''}`)
      const out = this.publicTask(task)
      if (warnings.length > 0) out.warnings = warnings
      return out
    })
  }

  /**
   * Who is acting: a live controller (its id), or a live agent with the
   * dispatcher role (`agent:<id>`). Dispatcher agents see and control only
   * the tasks they created.
   */
  async creator(state, controllerId, asAgent) {
    if (asAgent === undefined) { await this.liveController(controllerId); return controllerId }
    const agent = this.liveAgent(state, asAgent)
    if (agentRole(agent) !== 'dispatcher') throw new HubError(403, 'not-dispatcher', `${asAgent} is a ${agentRole(agent)}; only a dispatcher agent may dispatch`)
    this.seen(agent)
    return `agent:${asAgent}`
  }

  /** A dispatcher agent creates a task with its own worker token (created_by agent:<id>). */
  agentDispatch(agentId, input) { return this.dispatch(undefined, input, { asAgent: agentId }) }

  /** A dispatcher agent cancels a task it created. */
  agentCancel(agentId, id, reason) { return this.cancel(undefined, id, reason, { asAgent: agentId }) }

  /** The tasks a dispatcher agent created, newest first. */
  async agentTasks(agentId, filter = {}) {
    await this.read(state => this.creator(state, undefined, agentId))
    return this.listTasks({ ...filter, created_by: `agent:${agentId}` })
  }

  /** Only the creator may control a task. */
  mustOwnTask(state, controllerId, id) {
    const task = this.mustTask(state, id)
    if (task.created_by !== controllerId) throw new HubError(403, 'not-creator', `task ${task.task_id} was created by another controller`)
    return task
  }

  cancel(controllerId, id, reason, { asAgent } = {}) {
    return this.mutate(async (state) => {
      controllerId = await this.creator(state, controllerId, asAgent)
      const task = this.mustOwnTask(state, controllerId, id)
      if (TERMINAL.has(task.status)) throw new HubError(409, 'task-finished', `task already ${task.status}`)
      const holder = isActive(task) ? task.assignedTo : undefined
      task.status = 'cancelled'
      task.leaseUntil = undefined
      this.event(task, 'cancelled', reason === undefined || reason === null || reason === '' ? `cancelled by ${controllerId}` : String(reason).slice(0, 500))
      if (holder !== undefined) this.wakes.add(holder) // a slot was freed
      return this.publicTask(task)
    })
  }

  retry(controllerId, id, { agent } = {}) {
    return this.mutate(async (state) => {
      await this.liveController(controllerId)
      const task = this.mustOwnTask(state, controllerId, id)
      if (!TERMINAL.has(task.status)) throw new HubError(409, 'task-active', `task is ${task.status}; cancel it first`)
      if (agent !== undefined && agent !== null) {
        const target = typeof agent === 'string' && AGENT_ID_RE.test(agent) ? own(state.agents, agent) : undefined
        if (!(target && !target.revoked) && !(typeof agent === 'string' && POOL_RE.test(agent))) throw new HubError(400, 'bad-task', 'unknown target agent')
        if (target && task.workspace !== undefined && !target.workspaces.includes(task.workspace)) throw new HubError(409, 'unroutable', `${agent} was not granted workspace ${task.workspace}`)
        if (target && task.node !== undefined && target.node !== task.node) throw new HubError(409, 'unroutable', `${agent} is not on node ${task.node}`)
        const why = target ? effortProblem(target.runtime, task.effort) : null
        if (why !== null) throw new HubError(409, 'unsupported-effort', `${agent} ${why}`)
        const refused = target ? roleRefusal(task, agentRole(target), agent) : undefined
        if (refused !== undefined) throw new HubError(400, refused.code, refused.message)
        if (target && !hasCapability(target, task.capability)) throw new HubError(409, 'unroutable', `${agent} does not offer capability ${task.capability}`)
        // A pool target names the capability; moving to another pool moves the lane too.
        if (POOL_RE.test(agent)) task.capability = agent.slice(5)
        task.agent = agent
      }
      task.status = 'pending'; task.assignedTo = undefined; task.leaseUntil = undefined; task.attempts = 0; task.result = undefined
      task.pendingSince = nowIso(this.clock()); task.fallbackBy = undefined; task.declined = undefined
      this.event(task, 'retried', `${controllerId} -> ${task.agent}`)
      this.wakeFor(state, task)
      return this.publicTask(task)
    })
  }

  listTasks(filter = {}) {
    return this.read(state => Object.values(state.tasks)
      .filter(t => (filter.status === undefined || t.status === filter.status)
        && (filter.agent === undefined || t.agent === filter.agent || t.assignedTo === filter.agent)
        && (filter.workspace === undefined || t.workspace === filter.workspace)
        && (filter.created_by === undefined || t.created_by === filter.created_by))
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
      workspace: task.workspace, node: task.node, ref: task.ref, effort: task.effort, capability: task.capability, created_by: task.created_by,
      status: task.status, priority: task.priority, attempts: task.attempts, progress: task.progress, message: task.message,
      created_at: task.created_at, lease_until: task.leaseUntil, depends_on: task.depends_on,
      fallback: task.fallback ?? 'dsh', fallback_after_seconds: task.fallback_after_seconds, fallback_by: task.fallbackBy,
      result: task.result === undefined ? undefined : { status: task.result.status, summary: task.result.summary, outputs: task.result.outputs, error: task.result.error, needs_input: task.result.needs_input },
    }
    if (full) { out.instruction = task.instruction; out.inputs = task.inputs; out.output = task.output; out.history = task.history; out.context = task.context }
    return out
  }

  event(task, kind, message) {
    task.history.push({ at: nowIso(this.clock()), event: kind, message })
    if (task.history.length > 200) task.history.splice(0, task.history.length - 200)
  }

  requeue(state, task, why) {
    const holder = task.assignedTo
    if (task.attempts > this.maxRetries) {
      task.status = 'dead'
      this.event(task, 'dead', `${why}; retries exhausted`)
    } else {
      task.status = 'pending'
      task.pendingSince = nowIso(this.clock())
      this.event(task, 'requeued', why)
    }
    task.assignedTo = undefined
    task.leaseUntil = undefined
    task.leasedAt = undefined
    // Remember who had it: a scheduled puller that comes back still working on it
    // (or with its result) may take it back while nobody else has leased it.
    if (holder !== undefined) { task.lastHolder = holder; this.wakes.add(holder) }
    this.wakeFor(state, task)
  }

  /** A requeued task its last holder may take back: still pending, nobody else has it. */
  reclaimable(task, agentId) {
    return task !== undefined && task.status === 'pending' && task.assignedTo === undefined && task.lastHolder === agentId
  }

  /** Give a requeued task back to the worker that was still on it (no new attempt). */
  reclaim(state, task, agentId) {
    task.status = 'running'
    task.assignedTo = agentId
    task.leaseUntil = nowIso(this.clock() + task.lease_seconds * 1000)
    task.leasedAt = nowIso(this.clock())
    task.lastHolder = undefined
    this.event(task, 'reclaimed', `${agentId} came back still working on it`)
    this.log(`dsh-hub: ${agentId} reclaimed ${task.task_id}`)
  }

  // --- worker side (token-scoped) ----------------------------------------------

  /** Re-check inside the mutation: a revoke between authenticate() and here must win. */
  liveAgent(state, agentId) {
    const agent = own(state.agents, agentId)
    if (agent === undefined || agent.revoked || agent.tokenHash === '') throw new HubError(401, 'unauthorized', 'agent revoked')
    return agent
  }

  /**
   * `workspaces` (optional) replaces the reported set. Names outside the grant
   * are DROPPED (not an error) and returned as `ignored_workspaces`, because a
   * worker derives its list from the local profile and may know more names
   * than it was granted.
   */
  heartbeat(agentId, body = {}) {
    const b = body ?? {}
    const reported = b.workspaces === undefined ? undefined : nameList(b.workspaces, WORKSPACE_RE, 'bad-workspaces', `workspaces must be a list of at most ${MAX_WORKSPACES} workspace names`, MAX_WORKSPACES)
    const running = b.running === undefined || b.running === null ? undefined : nameList(b.running, TASK_ID_RE, 'bad-running', `running must be a list of at most ${MAX_RUNNING} task ids`, MAX_RUNNING)
    const version = typeof b.client_version === 'string' && VERSION_RE.test(b.client_version) ? b.client_version : undefined
    const runtime = b.runtime === undefined ? undefined : validateRuntime(b.runtime) // descriptive, not a grant: may change
    // Its own schedule, not a grant: it only widens the silence allowed before it counts as offline.
    const pullEvery = b.pull_every_seconds === undefined ? undefined : validatePullEvery(b.pull_every_seconds, { allowNull: true })
    return this.mutate((state) => {
      const agent = this.liveAgent(state, agentId)
      this.seen(agent)
      if (b.pull_every_seconds !== undefined && (pullEvery ?? undefined) !== agent.pullEverySeconds) {
        agent.pullEverySeconds = pullEvery ?? undefined
        this.log(`dsh-hub: ${agentId} pulls ${agent.pullEverySeconds === undefined ? 'continuously' : `every ${agent.pullEverySeconds} s`}`)
      }
      if (b.runtime !== undefined && JSON.stringify(runtime) !== JSON.stringify(agent.runtime)) {
        agent.runtime = runtime
        this.wakes.add(agentId) // pool tasks it can now take
        this.log(`dsh-hub: ${agentId} runtime ${runtime === undefined ? 'cleared' : `modes ${runtime.modes.join('/') || '-'}, agents ${runtime.agents.map(a => a.name).join('/') || '-'}`}`)
      }
      agent.reportedStatus = ['idle', 'busy'].includes(b.status) ? b.status : undefined
      if (version !== undefined) agent.clientVersion = version
      let ignored = []
      if (reported !== undefined) {
        const accepted = reported.filter(w => agent.workspaces.includes(w))
        ignored = reported.filter(w => !agent.workspaces.includes(w))
        const before = agent.reportedWorkspaces.join('\n')
        agent.reportedWorkspaces = accepted
        agent.ignoredWorkspaces = ignored
        if (accepted.join('\n') !== before) this.wakes.add(agentId)
        if (ignored.length > 0) this.warn(`dsh-hub: ${agentId} reported workspaces outside its grant (ignored): ${ignored.join(', ')}`)
      }
      // Reconciliation: only when the worker says what it holds.
      const abort = []
      const requeued = []
      const reclaimed = []
      if (running !== undefined) {
        for (const id of running) {
          const task = own(state.tasks, id)
          if (this.reclaimable(task, agentId)) { this.reclaim(state, task, agentId); reclaimed.push(id); continue }
          if (task === undefined || task.assignedTo !== agentId || !isActive(task)) abort.push(id)
        }
        const now = this.clock()
        for (const task of Object.values(state.tasks)) {
          if (task.assignedTo !== agentId || !isActive(task) || running.includes(task.task_id)) continue
          const leasedAt = Date.parse(task.leasedAt ?? '')
          if (Number.isFinite(leasedAt) && now - leasedAt < RECONCILE_GRACE_MS) continue // poll answer may still be on its way
          this.requeue(state, task, `worker-lost: ${agentId} no longer reports it`)
          requeued.push(task.task_id)
        }
        if (abort.length > 0) this.log(`dsh-hub: ${agentId} told to abort ${abort.join(', ')}`)
        if (requeued.length > 0) this.warn(`dsh-hub: ${agentId} lost ${requeued.join(', ')}; requeued`)
      }
      return {
        ok: true, agent_id: agentId, status: 'online', server_time: agent.lastSeen,
        workspaces: agent.reportedWorkspaces, ignored_workspaces: ignored, abort, requeued, reclaimed,
        pull_every_seconds: agent.pullEverySeconds, offline_after_ms: this.offlineWindow(agent),
      }
    })
  }

  /**
   * Lease up to `max` tasks routed to this worker. With `wait` > 0 (seconds,
   * capped at 55) and nothing to lease, wait until woken or the time is up.
   * `signal` (AbortSignal-like: aborted + addEventListener/removeEventListener)
   * ends the wait without leasing, e.g. when the HTTP connection closed.
   */
  async poll(agentId, { max = 1, wait = 0, signal } = {}) {
    const waitSeconds = typeof wait === 'number' && Number.isFinite(wait) && wait > 0 ? Math.min(wait, this.maxWaitSeconds) : 0
    if (waitSeconds === 0) return this.lease(agentId, max)
    const count = this.waiters.get(agentId) ?? 0
    if (count >= this.maxWaitersPerAgent) throw new HubError(429, 'too-many-waiters', `at most ${this.maxWaitersPerAgent} concurrent long polls per worker`)
    this.waiters.set(agentId, count + 1)
    let woken = false
    let release
    const onWake = () => { woken = true; release?.('wake') }
    this.events.on(`wake:${agentId}`, onWake)
    this.events.on('shutdown', onWake)
    try {
      const deadline = Date.now() + waitSeconds * 1000
      for (;;) {
        if (signal?.aborted) return { tasks: [] }
        woken = false
        const out = await this.lease(agentId, max)
        if (out.tasks.length > 0 || this.closed) return out
        const remaining = deadline - Date.now()
        if (remaining <= 0) return out
        if (woken) continue // woken while leasing: look again at once
        const why = await new Promise((resolve) => {
          const onAbort = () => done('abort')
          const timer = setTimeout(() => done('timeout'), remaining)
          function done(reason) {
            clearTimeout(timer)
            release = undefined
            signal?.removeEventListener?.('abort', onAbort)
            resolve(reason)
          }
          release = done
          signal?.addEventListener?.('abort', onAbort, { once: true })
        })
        if (why !== 'wake' || this.closed) return { tasks: [] }
      }
    } finally {
      this.events.off(`wake:${agentId}`, onWake)
      this.events.off('shutdown', onWake)
      const left = (this.waiters.get(agentId) ?? 1) - 1
      if (left <= 0) this.waiters.delete(agentId)
      else this.waiters.set(agentId, left)
    }
  }

  /** One leasing pass (contract section 4, all four conditions). */
  lease(agentId, max = 1) {
    return this.mutate((state) => {
      const agent = this.liveAgent(state, agentId)
      this.seen(agent)
      const held = Object.values(state.tasks).filter(t => t.assignedTo === agentId && isActive(t))
      const room = Math.max(0, Math.min(Number.isInteger(max) ? max : 1, agent.maxConcurrency - held.length))
      // Per-capability lanes: `browser:1` keeps a second browser task pending while one runs.
      const inLane = {}
      for (const t of held) if (t.capability !== undefined) inLane[t.capability] = (inLane[t.capability] ?? 0) + 1
      const limits = agent.capabilityLimits ?? {}
      const candidates = []
      for (const t of Object.values(state.tasks)
        .filter(t => t.status === 'pending')
        .filter(t => this.routable(t, agent))
        .filter(t => t.depends_on.every(d => own(state.tasks, d)?.status === 'completed'))
        .sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.created_at.localeCompare(b.created_at))) {
        if (candidates.length >= room) break
        const lane = t.capability
        if (lane !== undefined && limits[lane] !== undefined && (inLane[lane] ?? 0) >= limits[lane]) continue
        if (lane !== undefined) inLane[lane] = (inLane[lane] ?? 0) + 1
        candidates.push(t)
      }
      const leased = []
      for (const task of candidates) {
        task.status = 'accepted'
        task.assignedTo = agentId
        task.attempts += 1
        task.leaseUntil = nowIso(this.clock() + task.lease_seconds * 1000)
        task.leasedAt = nowIso(this.clock())
        this.event(task, 'accepted', `leased by ${agentId} (attempt ${task.attempts})`)
        // Upstream outputs become downloadable inputs.
        const upstream = task.depends_on.flatMap(d => (own(state.tasks, d).result?.outputs ?? []).map(o => ({ from_task: d, name: o.name })))
        leased.push({
          protocol: PROTOCOL, task_id: task.task_id, type: task.type, title: task.title, instruction: task.instruction,
          workspace: task.workspace, node: task.node, ref: task.ref, effort: task.effort, capability: task.capability, created_by: task.created_by,
          inputs: task.inputs.map(name => ({ name, from_task: task.task_id })).concat(upstream),
          output: task.output, priority: task.priority, deadline: task.deadline, lease_until: task.leaseUntil,
          parent_task_id: task.parent_task_id, context: task.context, attempt: task.attempts,
        })
      }
      return { tasks: leased }
    })
  }

  /**
   * Give back tasks leased by a poll whose response could not be delivered
   * (connection closed). The attempt is not counted.
   */
  unlease(agentId, taskIds, why = 'response not delivered') {
    return this.mutate((state) => {
      let changed = 0
      for (const id of taskIds ?? []) {
        const task = own(state.tasks, id)
        if (task === undefined || task.assignedTo !== agentId || task.status !== 'accepted') continue
        task.status = 'pending'
        task.assignedTo = undefined
        task.leaseUntil = undefined
        task.leasedAt = undefined
        task.attempts = Math.max(0, task.attempts - 1)
        this.event(task, 'released', why)
        this.wakeFor(state, task)
        changed++
      }
      return changed
    })
  }

  /**
   * A worker gives a task back it cannot do (`release_task`): it goes back to
   * the queue for someone else, the attempt does not count, and this worker
   * is not offered it again (so a named task falls to the DSH fallback).
   */
  release(agentId, body = {}) {
    const b = body ?? {}
    return this.mutate((state) => {
      const task = this.owned(state, agentId, b.task_id)
      task.status = 'pending'
      task.assignedTo = undefined
      task.leaseUntil = undefined
      task.leasedAt = undefined
      task.attempts = Math.max(0, task.attempts - 1)
      task.pendingSince = nowIso(this.clock())
      task.declined = [...new Set([...(task.declined ?? []), agentId])]
      const reason = typeof b.reason === 'string' && b.reason.trim() !== '' ? b.reason.trim().slice(0, 500) : 'given back'
      this.event(task, 'released', `${agentId}: ${reason}`)
      this.wakes.add(agentId)
      this.wakeFor(state, task)
      return { ok: true, task_status: task.status }
    })
  }

  /** The task must be leased by this very worker. */
  owned(state, agentId, taskId, { reclaim = false } = {}) {
    this.seen(this.liveAgent(state, agentId))
    const task = own(state.tasks, taskId)
    if (reclaim && this.reclaimable(task, agentId)) this.reclaim(state, task, agentId) // late progress or result after a requeue (mutations only)
    if (task === undefined || task.assignedTo !== agentId) throw new HubError(404, 'task-not-found', 'no such task leased by this agent')
    if (!isActive(task)) throw new HubError(409, 'task-not-active', `task is ${task.status}`)
    return task
  }

  progress(agentId, body = {}) {
    const b = body ?? {}
    return this.mutate((state) => {
      const task = this.owned(state, agentId, b.task_id, { reclaim: true })
      task.status = 'running'
      if (typeof b.progress === 'number' && b.progress >= 0 && b.progress <= 1) task.progress = b.progress
      if (typeof b.message === 'string') task.message = b.message.slice(0, 1000)
      task.leaseUntil = nowIso(this.clock() + task.lease_seconds * 1000) // progress renews the lease
      this.event(task, 'progress', task.message)
      return { ok: true, lease_until: task.leaseUntil }
    })
  }

  /** Final result. Files are inline (base64) and land under outputs/. */
  submitResult(agentId, body = {}) {
    const b = body ?? {}
    const names = checkResult(b)
    return this.mutate(async (state) => {
      const task = this.owned(state, agentId, b.task_id, { reclaim: true })
      return this.finish(state, task, b, names, agentId)
    })
  }

  /** Store a result (shared by workers and the DSH fallback; the fallback never retries). */
  async finish(state, task, b, names, agentId, { retry = true } = {}) {
      const status = b.status
      const files = b.files ?? []
      const dir = join(this.artifactDir, task.task_id, 'outputs')
      await mkdir(dir, { recursive: true })
      const outputs = []
      for (const [index, file] of files.entries()) {
        const name = names[index]
        const data = Buffer.from(String(file.base64 ?? ''), 'base64')
        await writeFile(join(dir, name), data)
        outputs.push({ name, bytes: data.length, type: String(file.type ?? '').slice(0, 32), description: String(file.description ?? '').slice(0, 300) })
      }
      const error = b.error && typeof b.error === 'object'
        ? { code: String(b.error.code ?? 'AGENT_ERROR').slice(0, 64), message: String(b.error.message ?? '').slice(0, 2000), retryable: b.error.retryable === true }
        : undefined
      task.result = {
        status, summary: String(b.summary ?? '').slice(0, 4000), outputs, error,
        needs_input: b.needs_input === undefined || b.needs_input === null ? undefined : String(b.needs_input).slice(0, 2000),
        finished_at: nowIso(this.clock()), agent: agentId,
      }
      task.leaseUntil = undefined
      if (status === 'completed') { task.status = 'completed'; task.progress = 1 }
      else if (status === 'partial') { task.status = 'failed'; task.result.error = task.result.error ?? { code: 'NEEDS_HUMAN', message: task.result.needs_input ?? '', retryable: false } }
      else if (error?.retryable && retry) { this.requeue(state, task, `retryable failure: ${error.code}`) }
      else task.status = 'failed'
      if (task.status !== 'pending') this.event(task, task.status, task.result.summary.slice(0, 200))
      this.wakes.add(agentId) // a slot was freed
      if (task.status === 'completed') {
        for (const other of Object.values(state.tasks)) if (other.status === 'pending' && other.depends_on.includes(task.task_id)) this.wakeFor(state, other)
      }
      this.log(`dsh-hub: ${agentId} finished ${task.task_id}: ${task.status}`)
      return { ok: true, task_status: task.status }
  }

  // --- DSH fallback (controllers act as the built-in dsh-self) ------------------

  /** Seconds a pending task waits before DSH may take it over. */
  fallbackWait(state, task) {
    if (task.fallback_after_seconds !== undefined) return task.fallback_after_seconds
    const named = AGENT_ID_RE.test(task.agent) ? own(state.agents, task.agent) : undefined
    const every = named?.pullEverySeconds
    return every === undefined ? FALLBACK_MIN_WAIT_SECONDS : Math.max(FALLBACK_MIN_WAIT_SECONDS, 2 * every)
  }

  /** When a pending task becomes due for the fallback (ms), or undefined when it never will. */
  fallbackDueAt(state, task) {
    if (!this.fallback.enabled || task.status !== 'pending' || (task.fallback ?? 'dsh') !== 'dsh') return undefined
    if (task.capability !== undefined && this.fallback.noFallback.includes(task.capability)) return undefined
    if (task.fallbackBy !== undefined) return undefined // DSH already tried once
    let ready = Date.parse(task.pendingSince ?? task.created_at)
    for (const d of task.depends_on) {
      const dep = own(state.tasks, d)
      if (dep?.status !== 'completed') return undefined
      const done = Date.parse(dep.result?.finished_at ?? '')
      if (Number.isFinite(done) && done > ready) ready = done
    }
    return ready + this.fallbackWait(state, task) * 1000
  }

  /** Tasks DSH may take over now (optionally only those whose workspace DSH has). */
  listFallback(controllerId, { workspaces } = {}) {
    return this.mutate(async (state) => {
      await this.liveController(controllerId)
      const now = this.clock()
      return Object.values(state.tasks)
        .map(task => ({ task, due: this.fallbackDueAt(state, task) }))
        .filter(({ task, due }) => due !== undefined && due <= now && fallbackWorkspaceOk(task, workspaces))
        .sort((a, b) => PRIORITY[a.task.priority] - PRIORITY[b.task.priority] || a.task.created_at.localeCompare(b.task.created_at))
        .map(({ task, due }) => ({ ...this.publicTask(task), waited_seconds: Math.round((now - due) / 1000) + this.fallbackWait(state, task) }))
    })
  }

  /**
   * DSH takes a due task over (task_id, or the most urgent due one). It is held
   * by dsh-self: the original worker gets `abort` if it still reports it and
   * can no longer submit. One attempt: a failure or an expired lease fails it.
   */
  takeFallback(controllerId, { task_id: taskId, workspaces } = {}) {
    return this.mutate(async (state) => {
      await this.liveController(controllerId)
      const now = this.clock()
      const due = task => { const at = this.fallbackDueAt(state, task); return at !== undefined && at <= now && fallbackWorkspaceOk(task, workspaces) }
      let task
      if (taskId !== undefined) {
        task = this.mustTask(state, taskId)
        if (!due(task)) {
          const at = this.fallbackDueAt(state, task)
          const why = at === undefined ? 'it is not a pending task DSH may take over'
            : at > now ? `it is not due yet (in ${Math.ceil((at - now) / 1000)} s)` : 'DSH does not have its workspace'
          throw new HubError(409, 'not-fallback', `${task.task_id}: ${why}`)
        }
      } else {
        task = Object.values(state.tasks).filter(due)
          .sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.created_at.localeCompare(b.created_at))[0]
        if (task === undefined) return { task: null }
      }
      task.status = 'running'
      task.assignedTo = FALLBACK_AGENT
      task.fallbackBy = controllerId
      task.attempts += 1
      task.leaseUntil = nowIso(now + task.lease_seconds * 1000)
      task.leasedAt = nowIso(now)
      task.lastHolder = undefined
      this.event(task, 'fallback', `nobody took it in time; DSH (${controllerId}) does it itself`)
      this.log(`dsh-hub: ${controllerId} took ${task.task_id} over as ${FALLBACK_AGENT}`)
      const upstream = task.depends_on.flatMap(d => (own(state.tasks, d).result?.outputs ?? []).map(o => ({ from_task: d, name: o.name })))
      return {
        task: {
          ...this.publicTask(task, { full: true }),
          inputs: task.inputs.map(name => ({ name, from_task: task.task_id })).concat(upstream),
        },
      }
    })
  }

  /** The fallback task held by DSH (and taken by this controller). */
  heldByFallback(state, controllerId, taskId) {
    const task = this.mustTask(state, taskId)
    if (task.assignedTo !== FALLBACK_AGENT || !isActive(task)) throw new HubError(409, 'task-not-active', `${task.task_id} is not held by ${FALLBACK_AGENT}`)
    if (task.fallbackBy !== controllerId) throw new HubError(403, 'not-creator', `${task.task_id} was taken over by another controller`)
    return task
  }

  fallbackProgress(controllerId, body = {}) {
    const b = body ?? {}
    return this.mutate(async (state) => {
      await this.liveController(controllerId)
      const task = this.heldByFallback(state, controllerId, b.task_id)
      if (typeof b.progress === 'number' && b.progress >= 0 && b.progress <= 1) task.progress = b.progress
      if (typeof b.message === 'string') task.message = b.message.slice(0, 1000)
      task.leaseUntil = nowIso(this.clock() + task.lease_seconds * 1000)
      this.event(task, 'progress', task.message)
      return { ok: true, lease_until: task.leaseUntil }
    })
  }

  fallbackResult(controllerId, body = {}) {
    const b = body ?? {}
    const names = checkResult(b)
    return this.mutate(async (state) => {
      await this.liveController(controllerId)
      const task = this.heldByFallback(state, controllerId, b.task_id)
      return this.finish(state, task, b, names, FALLBACK_AGENT, { retry: false })
    })
  }

  /** Bytes of an input / upstream output of a task DSH holds as the fallback. */
  async fallbackInput(controllerId, { task_id: taskId, from_task: fromTask, name } = {}) {
    await this.liveController(controllerId)
    const safe = safeFileName(name)
    const source = await this.read((state) => {
      const task = this.heldByFallback(state, controllerId, taskId)
      return inputPath(this.artifactDir, state, task, fromTask, safe)
    })
    return readFile(source)
  }

  /** Bytes of an input (or an upstream output) of a task THIS worker holds. */
  async artifact(agentId, { task_id: taskId, from_task: fromTask, name } = {}) {
    const safe = safeFileName(name)
    const source = await this.read((state) => {
      const task = this.owned(state, agentId, taskId)
      return inputPath(this.artifactDir, state, task, fromTask, safe)
    })
    return readFile(source)
  }

  /** Controller side: read an output file of any task (viewing is open to every controller). */
  async readOutput(taskId, name) {
    const safe = safeFileName(name)
    const task = await this.read(state => this.mustTask(state, taskId))
    if (!(task.result?.outputs ?? []).some(o => o.name === safe)) throw new HubError(404, 'artifact-not-found', 'not an output of this task')
    return readFile(join(this.artifactDir, task.task_id, 'outputs', safe))
  }

  // --- sweeper -------------------------------------------------------------

  /** Expire leases and requeue; returns how many tasks / requests changed. */
  sweep() {
    return this.mutate((state) => {
      let changed = 0
      const now = this.clock()
      for (const task of Object.values(state.tasks)) {
        if (isActive(task) && task.assignedTo === FALLBACK_AGENT && task.leaseUntil && Date.parse(task.leaseUntil) < now) {
          task.status = 'failed'
          task.leaseUntil = undefined
          task.result = { status: 'failed', summary: '', outputs: [], error: { code: 'FALLBACK_TIMEOUT', message: 'DSH took it over but did not finish in time', retryable: false }, finished_at: nowIso(now), agent: FALLBACK_AGENT }
          this.event(task, 'failed', 'fallback lease expired')
          changed++
          continue
        }
        if (isActive(task) && task.leaseUntil && Date.parse(task.leaseUntil) < now) {
          this.requeue(state, task, `lease expired (${task.assignedTo})`)
          changed++
          continue
        }
        // The holder went offline (no heartbeat / poll / event for offlineAfterMs) or left: do not wait for the lease.
        const holder = isActive(task) ? own(state.agents, task.assignedTo) : undefined
        if (holder !== undefined && ['offline', 'left'].includes(this.agentStatus(holder))) {
          this.requeue(state, task, `worker-offline: ${holder.id} ${this.agentStatus(holder) === 'left' ? 'left' : `not seen for ${Math.round((now - Date.parse(holder.lastSeen)) / 1000)} s`}`)
          changed++
        }
      }
      for (const task of Object.values(state.tasks)) {
        if (task.status === 'pending' && task.depends_on.some(d => ['failed', 'cancelled', 'dead'].includes(own(state.tasks, d)?.status))) {
          task.status = 'failed'
          task.result = { status: 'failed', summary: '', outputs: [], error: { code: 'UPSTREAM_FAILED', message: 'a depends_on task did not complete', retryable: false } }
          this.event(task, 'failed', 'upstream failed')
          changed++
        }
      }
      for (const request of Object.values(state.requests)) {
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
    return this.read((state) => {
      const counts = {}
      for (const t of Object.values(state.tasks)) counts[t.status] = (counts[t.status] ?? 0) + 1
      const pendingRequests = Object.values(state.requests).filter(r => r.status === 'pending').length
      const agents = Object.values(state.agents).map(a => this.publicAgent(a, state))
      const agentCounts = Object.fromEntries(AGENT_STATUSES.map(s => [s, agents.filter(a => a.status === s).length]))
      const now = this.clock()
      const fallbackDue = Object.values(state.tasks).filter(t => { const at = this.fallbackDueAt(state, t); return at !== undefined && at <= now }).length
      return { protocol: PROTOCOL, agents, agent_counts: agentCounts, task_counts: counts, pending_requests: pendingRequests, fallback_due: fallbackDue }
    })
  }
}
