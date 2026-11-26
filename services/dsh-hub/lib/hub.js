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
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

import { metricsOf, phaseOf, timelineOf } from './lifecycle.js'
import { DEFAULT_ROLE, ROLES, agentRole, needsOf, needsProblem, roleAccepts, roleBoundary, roleDuties, roleOf, roleRefusal, roleTakesWork, roleWidening } from './roles.js'

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
/**
 * Wait before DSH takes a task over while a worker that could do it is online but
 * busy: 10 min; a named scheduled puller gets two of its periods. With no such
 * worker online DSH may take it at once.
 */
export const FALLBACK_MIN_WAIT_SECONDS = 600
/** Sticky routing: how long other workers leave a task to its preferred worker, and how long a key is remembered. */
export const STICKY_HOLD_SECONDS = 120
export const STICKY_TTL_SECONDS = 86_400
const MAX_STICKY_KEYS = 2000
export const STICKY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,127}$/
/** Capabilities DSH never takes over by default (only that agent may touch the data). */
export const DEFAULT_NO_FALLBACK = ['quick']

/** The role an agent of a known platform gets when it does not name one. */
export const PLATFORM_ROLES = Object.freeze({ 'aws-quick': 'coder' })
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
/** A DSH profile name (`<DSH home>/profiles/<name>`): the local DSH a worker belongs to. */
export const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
/** Who runs a task registered by a controller that runs it itself (`dsh-self/web`, `dsh-self/web/frontend`). */
export const EXECUTOR_RE = /^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,95}$/
/** Fixed progress stages a worker (or DSH) reports with an event. */
export const STAGES = ['received', 'started', 'step', 'blocked', 'needs_input', 'uploading']
/** Roles of one entry of a task's full session log. */
export const SESSION_ROLES = ['user', 'assistant', 'tool', 'system', 'note']
export const MAX_SESSION_ENTRIES = 200
const MAX_SESSION_TEXT = 20_000
export const MAX_SESSION_BYTES = 20 * 1024 * 1024
/** Events kept for the controllers' event stream (newest kept). */
export const FEED_MAX = 5000
const MAX_FEED_WAITERS = 64
/**
 * When finished data leaves the default views (hours): done / cancelled tasks
 * go to history after 12 h, failed ones after 2 days (or at once once a
 * controller acknowledged them), agents silent for 3 days count as dormant,
 * and finished tasks are archived out of state.json after 7 days.
 */
export const DEFAULT_EXPIRY = Object.freeze({ doneHours: 12, failedHours: 48, dormantHours: 72, archiveHours: 168 })

// --- redaction: nothing secret or internal is stored from uploaded text --------

const SECRET_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/\bdsh[ac]_[A-Za-z0-9-]+_[A-Za-z0-9_-]{16,}/g, '[redacted token]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[redacted token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted token]'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, '[redacted key]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted token]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted key]'],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+\/=-]{16,}/gi, '$1 [redacted]'],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(["']?\s*[=:]\s*)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s,;"'}]{8,})/gi, '$1$2[redacted]'],
  // RFC 1918, CGNAT and link-local IPv4 addresses never leave the machine they belong to.
  [/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})\b/g, '[internal address]'],
]

/** Strip tokens, keys, passwords and internal addresses from text a worker or DSH uploaded. */
export function redact(text) {
  let out = String(text ?? '')
  for (const [re, to] of SECRET_RULES) out = out.replace(re, to)
  return out
}
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

/** When a task is expected to be done (ISO), from its due_minutes; undefined without one. */
function dueAtOf(task) {
  if (!Number.isInteger(task.due_minutes)) return undefined
  const at = Date.parse(task.created_at) + task.due_minutes * 60_000
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined
}

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
/**
 * Whether a stream event belongs in one DSH's inbox (`{ controller, profile }`): a task
 * that DSH published (created by its controller, answers to its profile, or to no
 * profile at all for tasks from before reply_to), or a cancellation of a task it runs
 * for someone else (the DSH fallback). Everything else is another DSH's mail.
 */
export function isForInbox(event, inbox) {
  if (event.created_by === inbox.controller && (event.reply_to === undefined || inbox.profile === undefined || event.reply_to === inbox.profile)) return true
  return event.held_by === inbox.controller && event.kind === 'cancelled'
}

/**
 * Whether a controller (with its profile, when it says one) published a task, so the
 * task is its to take back. Tasks a dispatcher agent published belong to no DSH: any may.
 */
export function publishedBy(task, controllerId, profile) {
  if (String(task.created_by ?? '').startsWith('agent:')) return true
  if (task.created_by !== controllerId) return false
  return profile === undefined || task.reply_to === undefined || task.reply_to === profile
}

/** A DSH profile name or undefined; anything else is a 400 with `code`. */
export function validProfile(value, code = 'bad-task') {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !PROFILE_RE.test(value)) throw new HubError(400, code, `${code === 'bad-reply-to' ? 'reply_to' : 'dsh_profile'} must be a DSH profile name (letters, digits, _ . -)`)
  return value
}

/** One stage name, or undefined. */
export function validStage(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !STAGES.includes(value)) throw new HubError(400, 'bad-stage', `stage must be one of ${STAGES.join(', ')}`)
  return value
}

/** Normalize one upload of session entries (redacted, cut, at most MAX_SESSION_ENTRIES). */
export function sessionEntries(raw, clock = Date.now) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SESSION_ENTRIES) throw new HubError(400, 'bad-session', `entries must be a list of 1..${MAX_SESSION_ENTRIES} entries`)
  return raw.map((e) => {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) throw new HubError(400, 'bad-session', 'each entry must be an object')
    const role = SESSION_ROLES.includes(e.role) ? e.role : undefined
    if (role === undefined) throw new HubError(400, 'bad-session', `role must be one of ${SESSION_ROLES.join(', ')}`)
    if (typeof e.text !== 'string') throw new HubError(400, 'bad-session', 'text must be a string')
    const text = redact(e.text)
    const at = typeof e.at === 'string' && Number.isFinite(Date.parse(e.at)) ? new Date(Date.parse(e.at)).toISOString()
      : typeof e.at === 'number' && Number.isFinite(e.at) ? new Date(e.at).toISOString() : nowIso(clock())
    const out = { at, role, text: text.length > MAX_SESSION_TEXT ? `${text.slice(0, MAX_SESSION_TEXT)}\n[... ${text.length - MAX_SESSION_TEXT} characters cut]` : text }
    if (typeof e.name === 'string' && e.name.trim() !== '') out.name = e.name.trim().slice(0, 64)
    if (e.error === true) out.error = true
    return out
  })
}

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
/** Longest due time a task may be given: 30 days. */
export const MAX_DUE_MINUTES = 43_200
export const OVERDUE_ACTIONS = ['notify', 'reassign']

/**
 * hub.json "due": expected completion times in minutes, by task type, capability (lane)
 * or `local` (a DSH's own task), with `default` for the rest, and what to do when a task
 * runs past it (`onOverdue`: notify the publisher, or reassign a worker's task to another).
 * Unknown keys and bad numbers are dropped. Nothing set = no due time unless the dispatch gives one.
 */
export function dueConfig(raw) {
  const minutes = {}
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const table = src.minutes !== null && typeof src.minutes === 'object' ? src.minutes : {}
  for (const [key, value] of Object.entries(table)) {
    if (Number.isInteger(value) && value >= 1 && value <= MAX_DUE_MINUTES && /^[a-z][a-z0-9-]{0,47}$/.test(key)) minutes[key] = value
  }
  const onOverdue = OVERDUE_ACTIONS.includes(src.onOverdue) ? src.onOverdue : 'notify'
  return { minutes, onOverdue }
}

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
    this.archiveDir = join(this.dataDir, 'archive')
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
    const st = options.sticky ?? {}
    this.sticky = {
      holdSeconds: Number.isInteger(st.holdSeconds) && st.holdSeconds >= 0 ? st.holdSeconds : STICKY_HOLD_SECONDS,
      ttlSeconds: Number.isInteger(st.ttlSeconds) && st.ttlSeconds > 0 ? st.ttlSeconds : STICKY_TTL_SECONDS,
    }
    const ex = options.expiry ?? {}
    const hours = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)
    this.expiry = {
      doneHours: hours(ex.doneHours, DEFAULT_EXPIRY.doneHours),
      failedHours: hours(ex.failedHours, DEFAULT_EXPIRY.failedHours),
      dormantHours: hours(ex.dormantHours, DEFAULT_EXPIRY.dormantHours),
      archiveHours: hours(ex.archiveHours, DEFAULT_EXPIRY.archiveHours),
    }
    this.auditDir = join(this.dataDir, 'audit')
    /** History entries not written to the audit log yet (flushed with every save). */
    this.audit = []
    this.due = dueConfig(options.due)
    this.feedWaiters = 0
    this.feedDirty = false
    this.logger = options.logger
    this.clock = options.clock ?? Date.now
    this.state = undefined
    this.queue = Promise.resolve()
    this.ctlQueue = Promise.resolve()
    this.events = new EventEmitter()
    this.events.setMaxListeners(0)
    this.wakes = new Set()
    this.waiters = new Map()
    /** agent id -> the widening role it last reported (warned once, see heartbeat). */
    this.roleWarned = new Map()
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
      state = { protocol: PROTOCOL, agents: {}, tasks: {}, requests: {}, sticky: {}, seq: 0, feed: [], feedSeq: 0 }
    }
    this.state = this.upgrade(state)
    return this.state
  }

  /** Bring a v1 (or partial) state document up to the v2 shape in memory. */
  upgrade(state) {
    if (state === null || typeof state !== 'object' || Array.isArray(state)) throw new HubError(500, 'bad-state', 'state.json is not an object')
    state.protocol = PROTOCOL
    for (const key of ['agents', 'tasks', 'requests', 'sticky']) if (state[key] === null || typeof state[key] !== 'object' || Array.isArray(state[key])) state[key] = {}
    state.seq = Number.isInteger(state.seq) ? state.seq : 0
    if (!Array.isArray(state.feed)) state.feed = []
    state.feedSeq = Number.isInteger(state.feedSeq) ? state.feedSeq : (state.feed.at(-1)?.seq ?? 0)
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
    await this.flushAudit()
  }

  /**
   * Append the entries recorded since the last save to audit/<YYYY-MM>.jsonl: one line
   * per entry, never rewritten, so every step of every task can be looked up later,
   * also after the task left state.json. A failed write is logged and retried next save.
   */
  async flushAudit() {
    if (this.audit.length === 0) return
    const batch = this.audit
    this.audit = []
    try {
      await mkdir(this.auditDir, { recursive: true, mode: 0o700 })
      const byMonth = new Map()
      for (const line of batch) byMonth.set(line.at.slice(0, 7), [...(byMonth.get(line.at.slice(0, 7)) ?? []), line])
      for (const [month, lines] of byMonth) {
        await appendFile(join(this.auditDir, `${month}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 })
      }
    } catch (error) {
      this.audit = [...batch, ...this.audit]
      this.warn(`dsh-hub: audit log not written (${error?.message ?? error}); will retry`)
    }
  }

  /** Serialize every mutation; save after it; then wake the workers it marked. */
  mutate(fn) {
    const run = this.queue.then(async () => {
      const state = await this.load()
      this.wakes.clear()
      this.feedDirty = false
      try {
        const value = await fn(state)
        await this.save()
        const ids = [...this.wakes]
        this.wakes.clear()
        for (const id of ids) this.events.emit(`wake:${id}`)
        if (this.feedDirty) { this.feedDirty = false; this.events.emit('feed') }
        return value
      } catch (error) {
        this.wakes.clear()
        if (this.feedDirty) { this.feedDirty = false; this.events.emit('feed') }
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
    // A platform that is known to have no shell (AWS Quick) is a coder unless it says otherwise.
    const role = roleOf(input.role ?? PLATFORM_ROLES[String(input.platform ?? '')])
    if (role === undefined) throw new HubError(400, 'bad-role', `role must be one of ${ROLES.join(', ')} (default ${DEFAULT_ROLE})`)
    const pullEverySeconds = validatePullEvery(input.pull_every_seconds)
    const dshProfile = validProfile(input.dsh_profile, 'bad-profile')
    return {
      id, mode, maxConcurrency, capabilities: caps.names, capabilityLimits: caps.limits, node, workspaces, role, pullEverySeconds, dshProfile,
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
      role: v.role ?? DEFAULT_ROLE, pullEverySeconds: v.pullEverySeconds, dshProfile: v.dshProfile,
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
      this.log(`dsh-hub: enrollment request ${requestId} for ${v.id} (${v.platform}, node ${v.node ?? '-'}, profile ${v.dshProfile ?? '-'}) from ${from || '-'} awaiting approval`)
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
        node: r.agent.node, dsh_profile: r.agent.dshProfile, workspaces: r.agent.workspaces ?? [], capabilities: r.agent.capabilities, capability_limits: r.agent.capabilityLimits ?? {}, max_concurrency: r.agent.maxConcurrency,
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
        runtime: asked.runtime, dsh_profile: asked.dshProfile,
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
      agent_id: agent.id, platform: agent.platform, mode: agent.mode, node: agent.node, dsh_profile: agent.dshProfile, capabilities: agent.capabilities,
      capability_limits: agent.capabilityLimits ?? {}, workspaces: agent.workspaces, reported_workspaces: agent.reportedWorkspaces,
      max_concurrency: agent.maxConcurrency, description: agent.description, runtime: agent.runtime, revoked: agent.revoked,
      status, online: status === 'online', last_seen: agent.lastSeen, left_at: agent.leftAt, version: agent.clientVersion,
      reported_status: agent.reportedStatus, running_tasks: running, created_at: agent.createdAt,
      role: agentRole(agent), duties: roleDuties(agentRole(agent)), pull_every_seconds: agent.pullEverySeconds, offline_after_ms: this.offlineWindow(agent),
      // How a task reaches it: `online` (stays connected, takes a task within seconds) or
      // `scheduled` (comes back every pull_every_seconds: a task may wait that long).
      reach: agent.pullEverySeconds === undefined ? 'online' : 'scheduled',
      dormant: this.dormant(agent, status),
    }
  }

  /** Revoked, or silent (offline / left / never came) for longer than expiry.dormantHours: out of the default view. */
  dormant(agent, status = this.agentStatus(agent)) {
    if (status === 'revoked') return true
    if (status === 'online') return false
    const since = Date.parse(agent.lastSeen ?? agent.leftAt ?? agent.createdAt ?? '')
    return Number.isFinite(since) && this.clock() - since > this.expiry.dormantHours * 3600_000
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
    if (task.dsh_profile !== undefined && task.dsh_profile !== agent.dshProfile) return false
    if (effortProblem(agent.runtime, task.effort) !== null) return false
    return true
  }

  /** Mark every live worker that could take this pending task, to wake its long polls. */
  wakeFor(state, task) {
    if (task.status !== 'pending') return
    for (const agent of Object.values(state.agents)) if (!agent.revoked && this.routable(task, agent)) this.wakes.add(agent.id)
  }

  /** Is any worker that could take this task online now (busy or not)? */
  anyOnlineFor(state, task) {
    return Object.values(state.agents).some(a => !a.revoked && this.online(a) && this.routable(task, a))
  }

  // --- sticky routing ------------------------------------------------------------
  //
  // A pool task goes back to the worker that last handled the same work: the same
  // sticky_key, else the worker that finished its parent / upstream task, else the
  // last worker on its workspace. That worker keeps its checkout, browser session
  // and context warm. It is a preference, not a pin: other workers leave the task
  // alone for sticky.holdSeconds only while the preferred one is online, can take
  // it and has room; after that (or at once if it cannot) anyone may lease it.

  /** The keys a task is remembered under (explicit key, else its workspace). */
  stickyKeys(task) {
    if (task.sticky === false) return []
    if (task.sticky_key !== undefined) return [`key:${task.sticky_key}`]
    return task.workspace !== undefined ? [this.wsKey(task)] : []
  }

  /** Sticky key of a workspace, per DSH profile when the task names one (the same name on two machines is two checkouts). */
  wsKey(task) {
    return task.dsh_profile === undefined ? `ws:${task.workspace}` : `ws:${task.dsh_profile}/${task.workspace}`
  }

  /** A worker that may be preferred for this task, or undefined. */
  stickyCandidate(state, task, id) {
    if (typeof id !== 'string' || id === FALLBACK_AGENT) return undefined
    const agent = own(state.agents, id)
    return agent !== undefined && !agent.revoked && this.routable(task, agent) ? agent.id : undefined
  }

  /** Pick the preferred worker of a new pool task. */
  preferredFor(state, task) {
    if (task.sticky === false || !task.agent.startsWith('pool:')) return undefined
    const now = this.clock()
    const fresh = e => e !== undefined && now - Date.parse(e.at) <= this.sticky.ttlSeconds * 1000
    if (task.sticky_key !== undefined) {
      const e = own(state.sticky, `key:${task.sticky_key}`)
      const hit = fresh(e) ? this.stickyCandidate(state, task, e.agent) : undefined
      if (hit !== undefined) return hit
    }
    for (const id of [task.parent_task_id, ...task.depends_on]) {
      const hit = this.stickyCandidate(state, task, own(state.tasks, id)?.result?.agent)
      if (hit !== undefined) return hit
    }
    if (task.sticky_key === undefined && task.workspace !== undefined) {
      const e = own(state.sticky, this.wsKey(task))
      if (fresh(e)) return this.stickyCandidate(state, task, e.agent)
    }
    return undefined
  }

  /** Remember who handled a task (a finished result; DSH itself is not remembered). */
  rememberSticky(state, task, agentId) {
    if (agentId === FALLBACK_AGENT) return
    const at = nowIso(this.clock())
    for (const key of this.stickyKeys(task)) state.sticky[key] = { agent: agentId, at }
    const keys = Object.keys(state.sticky)
    if (keys.length > MAX_STICKY_KEYS) {
      keys.sort((a, b) => state.sticky[a].at.localeCompare(state.sticky[b].at))
      for (const key of keys.slice(0, keys.length - MAX_STICKY_KEYS)) delete state.sticky[key]
    }
  }

  /** Does the preferred worker still hold this task back from `agentId`? */
  stickyHolds(state, task, agentId) {
    const preferred = task.preferred
    if (preferred === undefined || preferred === agentId || this.sticky.holdSeconds === 0) return false
    if (this.clock() - Date.parse(task.pendingSince ?? task.created_at) >= this.sticky.holdSeconds * 1000) return false
    const agent = own(state.agents, preferred)
    if (agent === undefined || agent.revoked || !this.online(agent) || !this.routable(task, agent)) return false
    const held = Object.values(state.tasks).filter(t => t.assignedTo === preferred && isActive(t)).length
    return held < agent.maxConcurrency
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
    const target = t.run_here === true ? (t.agent ?? FALLBACK_AGENT) : t.agent
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
    // What the work needs (code / test / git / cmd): a coder only edits (roles.js).
    const badNeeds = needsProblem(t.needs)
    if (badNeeds !== undefined) throw new HubError(400, badNeeds.code, badNeeds.message)
    const needs = needsOf(t.needs)
    // What kind of work this is (browser / test / code ...), so a worker that does many
    // things knows which of its lanes runs it and the hub can keep per-lane limits.
    const fallback = t.fallback ?? 'dsh'
    if (fallback !== 'dsh' && fallback !== 'none') throw new HubError(400, 'bad-task', 'fallback must be dsh or none')
    const fallbackAfter = t.fallback_after_seconds ?? undefined
    if (fallbackAfter !== undefined && (!Number.isInteger(fallbackAfter) || fallbackAfter < 60 || fallbackAfter > 7 * 86400)) throw new HubError(400, 'bad-task', 'fallback_after_seconds must be 60..604800')
    const dueMinutes = t.due_minutes ?? undefined
    if (dueMinutes !== undefined && (!Number.isInteger(dueMinutes) || dueMinutes < 1 || dueMinutes > MAX_DUE_MINUTES)) throw new HubError(400, 'bad-task', `due_minutes must be 1..${MAX_DUE_MINUTES}`)
    const onOverdue = t.on_overdue ?? undefined
    if (onOverdue !== undefined && !OVERDUE_ACTIONS.includes(onOverdue)) throw new HubError(400, 'bad-task', `on_overdue must be ${OVERDUE_ACTIONS.join(' or ')}`)
    const stickyKey = t.sticky_key ?? undefined
    if (stickyKey !== undefined && (typeof stickyKey !== 'string' || !STICKY_KEY_RE.test(stickyKey))) throw new HubError(400, 'bad-task', 'sticky_key must be 1-128 letters, digits or _ . : / -')
    if (t.sticky !== undefined && typeof t.sticky !== 'boolean') throw new HubError(400, 'bad-task', 'sticky must be true or false')
    let capability = t.capability ?? undefined
    if (capability !== undefined && (typeof capability !== 'string' || !CAP_RE.test(capability))) throw new HubError(400, 'bad-task', 'capability must be a capability name')
    const dshProfile = validProfile(t.dsh_profile)
    // Whose inbox the answers go to: the profile of the DSH that published the task
    // (several DSHs may share one controller id). Its events reach that DSH only.
    const replyTo = validProfile(t.reply_to, 'bad-reply-to')
    if (t.run_here !== undefined && typeof t.run_here !== 'boolean') throw new HubError(400, 'bad-task', 'run_here must be true or false')
    const runHere = t.run_here === true
    const executor = t.executor ?? undefined
    if (executor !== undefined && (typeof executor !== 'string' || !EXECUTOR_RE.test(executor))) throw new HubError(400, 'bad-task', 'executor must be a short label such as dsh-self/web')
    if (runHere) return this.registerLocal(controllerId, t, { type, priority, leaseSeconds, workspace, node, ref, capability, dshProfile, replyTo, executor, effort, asAgent })
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
        const refused = roleRefusal({ type, title: t.title, instruction: t.instruction, needs }, agentRole(agent), target)
        if (refused !== undefined) throw new HubError(400, refused.code, refused.message)
        // Fail fast instead of leaving a task no one can ever lease.
        if (workspace !== undefined && !agent.workspaces.includes(workspace)) throw new HubError(409, 'unroutable', `${target} was not granted workspace ${workspace}`)
        if (node !== undefined && agent.node !== node) throw new HubError(409, 'unroutable', `${target} is not on node ${node}`)
        if (dshProfile !== undefined && agent.dshProfile !== dshProfile) throw new HubError(409, 'unroutable', `${target} does not belong to DSH profile ${dshProfile}`)
        const why = effortProblem(agent.runtime, effort)
        if (why !== null) throw new HubError(409, 'unsupported-effort', `${target} ${why}`)
        if (effort !== undefined && agent.runtime === undefined) warnings.push('effort-not-declared')
        const status = this.agentStatus(agent)
        if (status !== 'online') {
          if (requireOnline) throw new HubError(409, 'agent-offline', `${target} is ${status} (last seen ${agent.lastSeen ?? 'never'})`)
          warnings.push('agent-offline')
        }
      } else {
        const probe = { agent: target, workspace, node, type, title: t.title, instruction: t.instruction, needs }
        const members = Object.values(state.agents).filter(a => !a.revoked && this.targets(probe, a))
        if (members.length > 0 && members.every(a => !roleAccepts(agentRole(a), probe))) {
          const refused = roleRefusal(probe, agentRole(members[0]), members[0].id)
          throw new HubError(400, refused?.code ?? 'role-not-dispatchable', `no agent in ${target} may take this task by its role: ${refused?.message ?? ''}`)
        }
        const ready = members.some(a => this.agentStatus(a) === 'online' && roleAccepts(agentRole(a), probe)
          && (workspace === undefined || (a.workspaces.includes(workspace) && a.reportedWorkspaces.includes(workspace)))
          && (node === undefined || a.node === node)
          && (dshProfile === undefined || a.dshProfile === dshProfile)
          && effortProblem(a.runtime, effort) === null)
        if (!ready) {
          if (requireOnline) throw new HubError(409, 'no-online-worker', `no online worker can take ${target}${workspace ? ` [${workspace}]` : ''}${node ? ` @${node}` : ''}${dshProfile ? ` (profile ${dshProfile})` : ''} right now`)
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
        workspace, node, ref, effort, capability, dsh_profile: dshProfile, needs, reply_to: replyTo,
        origin: { kind: asAgent === undefined ? 'controller' : 'agent', by: creator },
        inputs: inputNames, output: t.output ?? {}, priority, deadline: t.deadline, lease_seconds: leaseSeconds,
        parent_task_id: t.parent_task_id, depends_on: deps, context: t.context ?? {},
        created_by: creator, created_at: nowIso(this.clock()), pendingSince: nowIso(this.clock()),
        fallback, fallback_after_seconds: fallbackAfter,
        sticky_key: stickyKey, sticky: t.sticky === false ? false : undefined,
        due_minutes: dueMinutes ?? this.due.minutes[capability ?? ''] ?? this.due.minutes[type] ?? this.due.minutes.default,
        on_overdue: onOverdue,
        status: 'pending', attempts: 0, assignedTo: undefined, leaseUntil: undefined,
        progress: undefined, message: undefined, stage: undefined, result: undefined, history: [],
      }
      state.tasks[id] = task
      this.event(task, 'created', `${creator} -> ${target}${workspace ? ` [${workspace}]` : ''}${node ? ` @${node}` : ''}${dshProfile ? ` (profile ${dshProfile})` : ''}`, { by: creator })
      task.preferred = this.preferredFor(state, task)
      if (task.preferred !== undefined) this.event(task, 'sticky', `prefers ${task.preferred}`)
      this.wakeFor(state, task)
      this.log(`dsh-hub: ${creator} dispatched ${id} to ${target}${warnings.length ? ` (${warnings.join(', ')})` : ''}`)
      const out = this.publicTask(task)
      if (warnings.length > 0) out.warnings = warnings
      const due = this.fallbackDueAt(state, task)
      if (due !== undefined) out.fallback_in_seconds = Math.max(0, Math.ceil((due - this.clock()) / 1000))
      return out
    })
  }

  /**
   * A controller (a DSH) registers a task it runs ITSELF, so the hub's ledger
   * holds every task, wherever it was started: the task is created already
   * held by dsh-self for this controller (`origin.kind` local), is never
   * offered to a worker, and is reported with the fallback endpoints
   * (/v1/ctl/fallback/event, /result, /v1/ctl/session). One attempt, like the
   * fallback: an expired lease fails it. Dispatcher agents cannot do this.
   */
  registerLocal(controllerId, t, v) {
    if (v.asAgent !== undefined) throw new HubError(403, 'not-controller', 'only a DSH (controller) registers tasks it runs itself')
    if (t.task_id !== undefined && (typeof t.task_id !== 'string' || !TASK_ID_RE.test(t.task_id))) throw new HubError(400, 'bad-task', 'invalid task_id')
    if ((t.inputs ?? []).length > 0) throw new HubError(400, 'bad-task', 'a task run here takes no inputs through the hub')
    return this.mutate(async (state) => {
      await this.liveController(controllerId)
      const day = nowIso(this.clock()).slice(0, 10).replace(/-/g, '')
      const id = t.task_id ?? `task_${day}_${String(state.seq + 1).padStart(4, '0')}`
      const existing = own(state.tasks, id)
      if (existing !== undefined) {
        // Registering twice (a restart, a retried request) is harmless for the same DSH.
        if (existing.origin?.kind === 'local' && existing.fallbackBy === controllerId) return { ...this.publicTask(existing), already: true }
        throw new HubError(409, 'task-exists', `task already exists: ${id}`)
      }
      if (t.task_id === undefined) state.seq += 1
      const parent = typeof t.parent_task_id === 'string' && own(state.tasks, t.parent_task_id) !== undefined ? t.parent_task_id : undefined
      const now = this.clock()
      const task = {
        protocol: PROTOCOL, task_id: id, agent: FALLBACK_AGENT, type: v.type, title: t.title.trim(), instruction: t.instruction,
        workspace: v.workspace, node: v.node, ref: v.ref, effort: v.effort, capability: v.capability, dsh_profile: v.dshProfile,
        reply_to: v.replyTo ?? v.dshProfile,
        origin: { kind: 'local', by: controllerId, executor: v.executor },
        inputs: [], output: t.output ?? {}, priority: v.priority, deadline: t.deadline, lease_seconds: v.leaseSeconds,
        parent_task_id: parent, depends_on: [], context: t.context ?? {},
        created_by: controllerId, created_at: nowIso(now), pendingSince: undefined,
        fallback: 'none', fallback_after_seconds: undefined, sticky: false,
        due_minutes: Number.isInteger(t.due_minutes) && t.due_minutes >= 1 && t.due_minutes <= MAX_DUE_MINUTES ? t.due_minutes : this.due.minutes.local ?? this.due.minutes.default,
        status: 'running', attempts: 1, assignedTo: FALLBACK_AGENT, fallbackBy: controllerId,
        leaseUntil: nowIso(now + v.leaseSeconds * 1000), leasedAt: nowIso(now),
        progress: undefined, message: undefined, stage: 'received', result: undefined, history: [],
      }
      state.tasks[id] = task
      this.event(task, 'registered', `${controllerId} runs it itself${v.executor ? ` (${v.executor})` : ''}`, { stage: 'received', by: controllerId })
      this.log(`dsh-hub: ${controllerId} registered local task ${id}${v.executor ? ` (${v.executor})` : ''}`)
      return this.publicTask(task)
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
      this.event(task, 'cancelled', reason === undefined || reason === null || reason === '' ? `cancelled by ${controllerId}` : String(reason).slice(0, 500), { by: controllerId })
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
      this.event(task, 'retried', `${controllerId} -> ${task.agent}`, { by: controllerId })
      this.wakeFor(state, task)
      return this.publicTask(task)
    })
  }

  listTasks(filter = {}) {
    const history = filter.history ?? 'hide'
    return this.read(state => Object.values(state.tasks)
      .filter(t => history === 'include' || (history === 'only') === this.inHistory(t))
      .filter(t => (filter.status === undefined || t.status === filter.status)
        && (filter.agent === undefined || t.agent === filter.agent || t.assignedTo === filter.agent)
        && (filter.workspace === undefined || t.workspace === filter.workspace)
        && (filter.created_by === undefined || t.created_by === filter.created_by)
        && (filter.dsh_profile === undefined || t.dsh_profile === filter.dsh_profile)
        && (filter.origin === undefined || (t.origin?.kind ?? 'controller') === filter.origin))
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
      task_id: task.task_id, agent: task.agent, assigned_to: task.assignedTo, type: task.type, title: task.title, needs: task.needs,
      workspace: task.workspace, node: task.node, ref: task.ref, effort: task.effort, capability: task.capability, created_by: task.created_by,
      status: task.status, priority: task.priority, attempts: task.attempts, progress: task.progress, message: task.message,
      created_at: task.created_at, lease_until: task.leaseUntil, depends_on: task.depends_on,
      fallback: task.fallback ?? 'dsh', fallback_after_seconds: task.fallback_after_seconds, fallback_by: task.fallbackBy,
      sticky_key: task.sticky_key, sticky: task.sticky, preferred_agent: task.preferred,
      dsh_profile: task.dsh_profile, reply_to: task.reply_to, origin: task.origin ?? { kind: 'controller', by: task.created_by }, stage: task.stage,
      updated_at: task.history.at(-1)?.at ?? task.created_at, finished_at: task.result?.finished_at,
      acknowledged: task.acknowledged === true ? true : undefined, in_history: this.inHistory(task),
      session_entries: task.sessionEntries ?? 0, session_updated_at: task.sessionUpdatedAt,
      quiet: task.origin?.kind === 'local' && isActive(task) && task.leaseUntil !== undefined && Date.parse(task.leaseUntil) < this.clock() ? true : undefined,
      result: task.result === undefined ? undefined : { status: task.result.status, summary: task.result.summary, outputs: task.result.outputs, error: task.result.error, needs_input: task.result.needs_input },
      phase: phaseOf(task),
      question: task.question === undefined ? undefined : { text: task.question.text, at: task.question.at, by: task.question.by },
      answers_count: (task.answers ?? []).length || undefined,
      due_at: dueAtOf(task), overdue: task.overdueAt !== undefined ? true : undefined,
      delivered_at: task.deliveredAt, delivered_to: task.deliveredTo,
      acknowledged_at: task.acknowledgedAt, acknowledged_by: task.acknowledgedBy,
    }
    if (full) { out.instruction = task.instruction; out.inputs = task.inputs; out.output = task.output; out.history = task.history; out.context = task.context; out.answers = task.answers?.map(a => ({ question: a.question, answer: a.answer, at: a.at, by: a.by })) }
    return out
  }

  /**
   * Record one thing that happened to a task: in its own history and in the
   * controllers' event stream (`feed`, read with /v1/ctl/events). Text is
   * redacted before it is stored anywhere.
   */
  event(task, kind, message, { stage, feedOnly = false, historyOnly = false, by = 'hub' } = {}) {
    const at = nowIso(this.clock())
    const text = message === undefined || message === null ? undefined : redact(message)
    const entry = { at, event: kind, message: text }
    if (stage !== undefined) entry.stage = stage
    entry.by = by
    entry.phase = phaseOf(task)
    // feedOnly: a notice to the publisher that changes nothing on the task (no history entry).
    if (!feedOnly) {
      task.history.push(entry)
      // The audit log keeps every entry for good (history keeps the last 200 and is archived).
      this.audit.push({ task_id: task.task_id, ...entry, status: task.status, attempt: task.attempts })
    }
    if (task.history.length > 200) task.history.splice(0, task.history.length - 200)
    const state = this.state
    // historyOnly: a marker for the record (delivered, acknowledged) nobody needs to be told about.
    if (state === undefined || historyOnly) return
    state.feedSeq += 1
    state.feed.push({
      seq: state.feedSeq, at, task_id: task.task_id, kind, stage, message: text,
      title: task.title, status: task.status, progress: task.progress,
      agent: task.assignedTo ?? task.agent, created_by: task.created_by, origin: task.origin?.kind ?? 'controller',
      dsh_profile: task.dsh_profile, reply_to: task.reply_to, attempt: task.attempts,
      held_by: task.fallbackBy, by, phase: entry.phase,
    })
    if (state.feed.length > FEED_MAX) state.feed.splice(0, state.feed.length - FEED_MAX)
    this.feedDirty = true
  }

  /** When a finished task ended (ms), from its result or its last event. */
  endedAt(task) {
    const at = Date.parse(task.result?.finished_at ?? task.history.at(-1)?.at ?? task.created_at)
    return Number.isFinite(at) ? at : this.clock()
  }

  /**
   * A finished task out of the default views: done / cancelled after
   * expiry.doneHours, failed / dead after expiry.failedHours or at once
   * when a controller acknowledged it (ack).
   */
  inHistory(task) {
    if (!TERMINAL.has(task.status)) return false
    // Put away by a controller (a failure reported, a question dealt with): out of the default views now.
    if (task.acknowledged === true) return true
    const hours = task.status === 'completed' || task.status === 'cancelled' ? this.expiry.doneHours : this.expiry.failedHours
    return this.clock() - this.endedAt(task) > hours * 3600_000
  }

  /** A controller has dealt with a finished task (a failure, a question): it leaves the default views now. */
  acknowledge(controllerId, id) {
    return this.mutate(async (state) => {
      await this.liveController(controllerId)
      const task = this.mustTask(state, id)
      // A question nobody will answer: putting it away ends the task (cancelled), so it
      // does not sit in 等你回复 for ever.
      if (task.status === 'waiting_input') {
        task.status = 'cancelled'
        task.question = undefined
        task.leaseUntil = undefined
        this.event(task, 'cancelled', `put away by ${controllerId} without an answer`, { by: controllerId })
      }
      if (!TERMINAL.has(task.status)) throw new HubError(409, 'task-active', `task is ${task.status}`)
      if (task.acknowledged !== true) {
        task.acknowledged = true
        task.acknowledgedAt = nowIso(this.clock())
        task.acknowledgedBy = controllerId
        this.event(task, 'acknowledged', `put away by ${controllerId}`, { by: controllerId, historyOnly: true })
      }
      return this.publicTask(task)
    })
  }

  /**
   * The human's answer to a question a worker put (POST /v1/ctl/answer). The creator of
   * the task, or the DSH it reports to, answers. A task given back with the question
   * (`waiting_input`) goes back to the queue, held for the worker that asked, attempt
   * not counted; a worker still holding the task gets the answer with its next progress
   * report or heartbeat. Either way the answer travels with the task from now on
   * (`answers` in every lease).
   */
  answer(controllerId, { task_id: taskId, answer, profile } = {}, { asAgent } = {}) {
    if (typeof answer !== 'string' || answer.trim() === '') throw new HubError(400, 'bad-answer', 'answer is required')
    return this.mutate(async (state) => {
      const by = await this.creator(state, controllerId, asAgent)
      const task = this.mustTask(state, taskId)
      const replyTo = typeof profile === 'string' && profile !== '' && task.reply_to === profile
      if (task.created_by !== by && !replyTo) throw new HubError(403, 'not-creator', `task ${task.task_id} was published by another DSH`)
      if (task.origin?.kind === 'local') throw new HubError(409, 'local-task', `${task.task_id} runs in its DSH; answer it in that 作战室`)
      const asks = task.status === 'waiting_input' || (isActive(task) && task.question !== undefined)
      if (!asks) throw new HubError(409, 'no-question', `${task.task_id} is ${task.status} and asks nothing`)
      const entry = { question: task.question?.text ?? task.result?.needs_input ?? '', answer: redact(answer.trim().slice(0, 4000)), at: nowIso(this.clock()), by }
      task.answers = [...(task.answers ?? []), entry]
      task.question = undefined
      if (task.status === 'waiting_input') {
        const holder = task.lastHolder
        task.status = 'pending'
        task.stage = undefined
        task.result = undefined
        task.pendingSince = nowIso(this.clock())
        // Back to the worker that asked: others leave it alone for the sticky hold.
        if (holder !== undefined) { task.preferred = holder; this.wakes.add(holder) }
        this.event(task, 'answered', entry.answer.slice(0, 200), { by })
        this.wakeFor(state, task)
      } else {
        if (task.stage === 'needs_input') task.stage = 'step'
        this.event(task, 'answered', entry.answer.slice(0, 200), { by })
        if (task.assignedTo !== undefined) this.wakes.add(task.assignedTo)
      }
      return this.publicTask(task)
    })
  }

  /**
   * The publishing DSH put these tasks' results (or questions) in front of its 作战室
   * (POST /v1/ctl/delivered). Recorded once per task and phase, for the timeline.
   */
  delivered(controllerId, { task_ids: ids, profile } = {}) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some(id => typeof id !== 'string')) throw new HubError(400, 'bad-request', 'task_ids must be 1..100 task ids')
    return this.mutate(async (state) => {
      await this.liveController(controllerId)
      const marked = []
      for (const id of ids) {
        const task = own(state.tasks, id)
        if (task === undefined) continue
        const phase = phaseOf(task)
        if (task.deliveredPhase === phase) continue
        task.deliveredPhase = phase
        task.deliveredAt = nowIso(this.clock())
        task.deliveredTo = typeof profile === 'string' && profile !== '' ? `${controllerId}/${profile}` : controllerId
        this.event(task, 'delivered', `shown in the 作战室 of ${task.deliveredTo}`, { by: controllerId, historyOnly: true })
        marked.push(id)
      }
      return { ok: true, marked }
    })
  }

  /**
   * The whole timeline of one task (GET /v1/ctl/timeline): from state.json, else from the
   * archive; when its history was cut at 200 entries, the full list comes from the audit log.
   */
  async timeline(taskId) {
    if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) throw new HubError(400, 'bad-request', 'task_id is required')
    const live = await this.read(state => own(state.tasks, taskId))
    const task = live ?? await this.findArchived(taskId)
    if (task === undefined) throw new HubError(404, 'task-not-found', `task not found: ${taskId}`)
    let record = task
    if (Array.isArray(task.history) && task.history.length >= 200) {
      const full = await this.auditOf(taskId, task.created_at)
      if (full.length > task.history.length) record = { ...task, history: full }
    }
    const view = timelineOf(record, this.clock())
    return {
      task: this.publicTask(task), archived: live === undefined, ...view,
      truncated: view.truncated && record === task,
      answers: (task.answers ?? []).map(a => ({ question: a.question, answer: a.answer, at: a.at, by: a.by })),
    }
  }

  /** A task record moved to archive/<YYYY-MM>.jsonl.gz, newest month first. */
  async findArchived(taskId) {
    let names
    try { names = (await readdir(this.archiveDir)).filter(n => /^\d{4}-\d{2}\.jsonl\.gz$/.test(n)).sort().reverse() } catch { return undefined }
    for (const name of names) {
      let text
      try { text = gunzipSync(await readFile(join(this.archiveDir, name))).toString('utf8') } catch (error) { this.warn(`dsh-hub: archive ${name} not readable: ${error?.message ?? error}`); continue }
      let found
      for (const line of text.split('\n')) {
        if (!line.includes(`"task_id":"${taskId}"`)) continue
        try { const rec = JSON.parse(line); if (rec.task_id === taskId) found = rec } catch { /* skip a torn line */ }
      }
      if (found !== undefined) return found
    }
    return undefined
  }

  /** Every audit entry of one task, from the month it was created on. */
  async auditOf(taskId, createdAt) {
    let names
    try { names = (await readdir(this.auditDir)).filter(n => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort() } catch { return [] }
    const from = String(createdAt ?? '').slice(0, 7)
    const out = []
    for (const name of names.filter(n => n.slice(0, 7) >= from)) {
      const text = await readFile(join(this.auditDir, name), 'utf8').catch(() => '')
      for (const line of text.split('\n')) {
        if (!line.includes(`"task_id":"${taskId}"`)) continue
        try {
          const { task_id: id, status, attempt, ...entry } = JSON.parse(line)
          if (id === taskId) out.push(entry)
        } catch { /* skip a torn line */ }
      }
    }
    return out
  }

  /**
   * Numbers over the tasks created in the last `hours` (default 7 days), overall and per
   * worker (GET /v1/ctl/metrics). Covers what is still in state.json: archived tasks
   * (older than expiry.archiveHours) are left out.
   */
  metrics({ hours = 168 } = {}) {
    const span = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 90) : 168
    return this.read((state) => {
      const now = this.clock()
      const out = metricsOf(Object.values(state.tasks), { since: now - span * 3600_000, now })
      return { ...out, hours: span, archived_after_hours: this.expiry.archiveHours }
    })
  }

  /**
   * The controllers' event stream: events after `after` (a seq), oldest
   * first. With `wait` > 0 and nothing new, waits up to `wait` seconds (cap
   * maxWaitSeconds) for the next event. `reset` says events were dropped
   * (the cursor is older than the oldest kept event, or the hub was reset):
   * the reader should re-read the task list.
   */
  async feed({ after = 0, wait = 0, limit = 200, signal, inbox } = {}) {
    const start = Number.isInteger(after) && after >= 0 ? after : 0
    const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 200
    const mine = inbox === undefined ? () => true : e => isForInbox(e, inbox)
    const pick = cursor => (state) => {
      if (cursor > state.feedSeq) return { events: [], next: state.feedSeq, latest: state.feedSeq, reset: true }
      const oldest = state.feed[0]?.seq ?? state.feedSeq + 1
      const later = state.feed.filter(e => e.seq > cursor)
      const events = later.filter(mine).slice(0, max)
      // The cursor moves past events for other inboxes too, so the reader is not handed them again.
      const next = events.length === max ? events.at(-1).seq : later.at(-1)?.seq ?? cursor
      return { events, next, latest: state.feedSeq, reset: cursor > 0 && cursor < oldest - 1 }
    }
    let out = await this.read(pick(start))
    const seconds = typeof wait === 'number' && Number.isFinite(wait) && wait > 0 ? Math.min(wait, this.maxWaitSeconds) : 0
    if (out.events.length > 0 || out.reset || seconds === 0 || this.closed) return out
    if (this.feedWaiters >= MAX_FEED_WAITERS) throw new HubError(429, 'too-many-waiters', 'too many readers of the event stream')
    const deadline = Date.now() + seconds * 1000
    this.feedWaiters += 1
    try {
      // Events for other inboxes wake the wait too; keep waiting until one is for this reader.
      while (out.events.length === 0 && !out.reset && !this.closed && !signal?.aborted) {
        const left = deadline - Date.now()
        if (left <= 0) break
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer)
            this.events.off('feed', done)
            this.events.off('shutdown', done)
            signal?.removeEventListener?.('abort', done)
            resolve()
          }
          const timer = setTimeout(done, left)
          this.events.on('feed', done)
          this.events.on('shutdown', done)
          signal?.addEventListener?.('abort', done)
          if (signal?.aborted) done()
        })
        out = await this.read(pick(out.next))
      }
    } finally {
      this.feedWaiters -= 1
    }
    return out
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
    this.event(task, 'reclaimed', `${agentId} came back still working on it`, { by: agentId })
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
    const profile = validProfile(b.dsh_profile, 'bad-profile')
    const role = b.role === undefined || b.role === null ? undefined : roleOf(b.role)
    if (b.role !== undefined && b.role !== null && role === undefined) throw new HubError(400, 'bad-role', `role must be one of ${ROLES.join(', ')}`)
    return this.mutate((state) => {
      const agent = this.liveAgent(state, agentId)
      this.seen(agent)
      // The role is a grant: a worker may NARROW its own (worker -> coder when its machine
      // turns out to have no shell), never widen it; widening needs a new approval.
      if (role !== undefined && role !== agentRole(agent)) {
        if (roleWidening(agentRole(agent), role) === undefined) {
          this.log(`dsh-hub: ${agentId} role ${agentRole(agent)} -> ${role} (narrowed by the worker)`)
          agent.role = role
          this.wakes.add(agentId)
        } else if (this.roleWarned.get(agentId) !== role) {
          // Once per reported role: a client left on the default "worker" after approval
          // narrowed it would otherwise log this on every heartbeat.
          this.roleWarned.set(agentId, role)
          this.warn(`dsh-hub: ${agentId} reported role ${role} but was approved as ${agentRole(agent)} (ignored: widening needs a new approval)`)
        }
      }
      // The profile is part of the grant: a worker enrolled without one (older client) may name it
      // once; after that a different name is ignored, so it cannot pull another machine's work.
      let profileMismatch
      if (profile !== undefined && profile !== agent.dshProfile) {
        if (agent.dshProfile === undefined) {
          agent.dshProfile = profile
          this.wakes.add(agentId)
          this.log(`dsh-hub: ${agentId} belongs to DSH profile ${profile}`)
        } else {
          profileMismatch = profile
          this.warn(`dsh-hub: ${agentId} reported DSH profile ${profile} but was enrolled as ${agent.dshProfile} (ignored)`)
        }
      }
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
      // Answers to questions this worker put on tasks it still holds, not handed over yet.
      const answers = []
      for (const task of Object.values(state.tasks)) {
        if (task.assignedTo !== agentId || !isActive(task)) continue
        const reply = this.withAnswers(task, {}, agentId)
        for (const a of reply.answers ?? []) answers.push({ task_id: task.task_id, ...a })
      }
      return {
        ok: true, agent_id: agentId, status: 'online', server_time: agent.lastSeen,
        workspaces: agent.reportedWorkspaces, ignored_workspaces: ignored, abort, requeued, reclaimed,
        ...(answers.length > 0 ? { answers } : {}),
        pull_every_seconds: agent.pullEverySeconds, offline_after_ms: this.offlineWindow(agent),
        ...(agent.dshProfile === undefined ? {} : { dsh_profile: agent.dshProfile }), ...(profileMismatch === undefined ? {} : { profile_mismatch: profileMismatch }),
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
        .filter(t => !this.stickyHolds(state, t, agentId))
        .sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority]
          || Number(b.preferred === agentId) - Number(a.preferred === agentId)
          || a.created_at.localeCompare(b.created_at))) {
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
        this.event(task, 'accepted', `leased by ${agentId} (attempt ${task.attempts})`, { by: agentId })
        // Upstream outputs become downloadable inputs.
        const upstream = task.depends_on.flatMap(d => (own(state.tasks, d).result?.outputs ?? []).map(o => ({ from_task: d, name: o.name })))
        for (const a of task.answers ?? []) a.delivered = true
        leased.push({
          protocol: PROTOCOL, task_id: task.task_id, type: task.type, title: task.title, instruction: task.instruction,
          workspace: task.workspace, node: task.node, ref: task.ref, effort: task.effort, capability: task.capability, created_by: task.created_by,
          inputs: task.inputs.map(name => ({ name, from_task: task.task_id })).concat(upstream),
          output: task.output, priority: task.priority, deadline: task.deadline, lease_until: task.leaseUntil,
          parent_task_id: task.parent_task_id, context: task.context, attempt: task.attempts,
          // Questions this task asked earlier and the human's answers, oldest first: carry on from them.
          answers: (task.answers ?? []).length > 0 ? task.answers.map(a => ({ question: a.question, answer: a.answer, at: a.at })) : undefined,
          // What this worker may do here, so its agent reads the boundary before the instruction.
          needs: task.needs, duties: roleDuties(agentRole(agent)), boundary: roleBoundary(agentRole(agent)),
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
        this.event(task, 'released', why, { by: agentId })
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
      this.event(task, 'released', `${agentId}: ${reason}`, { by: agentId })
      this.wakes.add(agentId)
      this.wakeFor(state, task)
      return { ok: true, task_status: task.status }
    })
  }

  /**
   * The task must be leased by this very worker. `attempt` (optional: the `attempt` the
   * poll handed out) must be the current one, so a result or report from an earlier
   * lease of the same task, arriving late, is never taken for the current run's.
   */
  owned(state, agentId, taskId, { reclaim = false, attempt } = {}) {
    this.seen(this.liveAgent(state, agentId))
    const task = own(state.tasks, taskId)
    if (reclaim && this.reclaimable(task, agentId)) this.reclaim(state, task, agentId) // late progress or result after a requeue (mutations only)
    if (task === undefined || task.assignedTo !== agentId) throw new HubError(404, 'task-not-found', 'no such task leased by this agent')
    if (!isActive(task)) throw new HubError(409, 'task-not-active', `task is ${task.status}`)
    if (attempt !== undefined && attempt !== null && attempt !== task.attempts) {
      throw new HubError(409, 'stale-attempt', `attempt ${attempt} of ${task.task_id} is over (now attempt ${task.attempts})`)
    }
    return task
  }

  progress(agentId, body = {}) {
    const b = body ?? {}
    const stage = validStage(b.stage)
    return this.mutate((state) => {
      const task = this.owned(state, agentId, b.task_id, { reclaim: true, attempt: b.attempt })
      task.status = 'running'
      return this.applyProgress(task, b, stage, agentId)
    })
  }

  /**
   * Progress renews the lease. `renew: true` with nothing else is only that
   * (a "still working" keep-alive): no history entry, no event. So is a report
   * that changes nothing. Otherwise the stage / percentage / message are stored
   * and one event goes out.
   */
  applyProgress(task, b, stage, by) {
    task.leaseUntil = nowIso(this.clock() + task.lease_seconds * 1000)
    const said = stage !== undefined || typeof b.message === 'string' || typeof b.progress === 'number'
    if (b.renew === true && !said) return this.withAnswers(task, { ok: true, lease_until: task.leaseUntil }, by)
    const progress = typeof b.progress === 'number' && b.progress >= 0 && b.progress <= 1 ? b.progress : undefined
    const message = typeof b.message === 'string' ? redact(b.message.slice(0, 1000)) : undefined
    // A report that repeats what the task already says (an older client re-sends "working"
    // every cycle to keep its lease) is a keep-alive too: no history entry, no event.
    const changed = (stage !== undefined && stage !== task.stage)
      || (message !== undefined && message !== task.message)
      || (progress !== undefined && progress !== task.progress)
    if (!changed) return this.withAnswers(task, { ok: true, lease_until: task.leaseUntil }, by)
    if (progress !== undefined) task.progress = progress
    if (message !== undefined) task.message = message
    if (stage !== undefined) task.stage = stage
    // A question put while the worker keeps the task: it stays open until the human answers.
    if (stage === 'needs_input') task.question = { text: task.message ?? '', at: nowIso(this.clock()), by, attempt: task.attempts }
    else if (stage !== undefined && stage !== 'blocked') task.question = undefined // it moved on
    this.event(task, 'progress', task.message, { stage, by })
    return this.withAnswers(task, { ok: true, lease_until: task.leaseUntil }, by)
  }

  /**
   * Hand the worker that holds a task the answers it has not seen yet (`answers` in the
   * reply to its progress / keep-alive), and note that it got them.
   */
  withAnswers(task, reply, by) {
    const fresh = (task.answers ?? []).filter(a => a.delivered !== true)
    if (fresh.length === 0) return reply
    for (const a of fresh) a.delivered = true
    this.event(task, 'answer_delivered', `${fresh.length} answer(s) handed to ${by}`, { by, historyOnly: true })
    return { ...reply, answers: fresh.map(a => ({ question: a.question, answer: a.answer, at: a.at })) }
  }

  /** Final result. Files are inline (base64) and land under outputs/. */
  submitResult(agentId, body = {}) {
    const b = body ?? {}
    const names = checkResult(b)
    return this.mutate(async (state) => {
      const task = this.owned(state, agentId, b.task_id, { reclaim: true, attempt: b.attempt })
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
        ? { code: String(b.error.code ?? 'AGENT_ERROR').slice(0, 64), message: redact(String(b.error.message ?? '').slice(0, 2000)), retryable: b.error.retryable === true }
        : undefined
      task.result = {
        status, summary: redact(String(b.summary ?? '').slice(0, 4000)), outputs, error,
        needs_input: b.needs_input === undefined || b.needs_input === null ? undefined : redact(String(b.needs_input).slice(0, 2000)),
        finished_at: nowIso(this.clock()), agent: agentId,
      }
      task.leaseUntil = undefined
      if (status === 'completed') { task.status = 'completed'; task.progress = 1; this.rememberSticky(state, task, agentId) }
      else if (status === 'partial' && agentId !== FALLBACK_AGENT && task.result.needs_input !== undefined) {
        // A worker gave the task back with a question: it waits on the human (not a failure).
        // The answer (task_answer) puts it back in the queue for the same worker, attempt not counted.
        task.status = 'waiting_input'
        task.question = { text: task.result.needs_input, at: task.result.finished_at, by: agentId, attempt: task.attempts }
        task.assignedTo = undefined
        task.leasedAt = undefined
        task.lastHolder = agentId
        task.attempts = Math.max(0, task.attempts - 1)
      }
      else if (status === 'partial') { task.status = 'failed'; task.result.error = task.result.error ?? { code: 'NEEDS_HUMAN', message: task.result.needs_input ?? '', retryable: false } }
      else if (error?.retryable && retry) { this.requeue(state, task, `retryable failure: ${error.code}`) }
      else task.status = 'failed'
      if (task.status !== 'pending') this.event(task, task.status, (task.result.needs_input ?? (task.result.summary || task.result.error?.message || '')).slice(0, 200), { stage: task.result.needs_input === undefined ? undefined : 'needs_input', by: agentId === FALLBACK_AGENT ? (task.fallbackBy ?? agentId) : agentId })
      if (task.status === 'completed' || task.status === 'failed') task.question = undefined
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

  /**
   * When a pending task becomes due for the fallback (ms), or undefined when it never will.
   * No worker that could take it online: due as soon as it is ready. One is online but
   * nobody took it: due after fallbackWait (it is busy; give it time).
   */
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
    return this.anyOnlineFor(state, task) ? ready + this.fallbackWait(state, task) * 1000 : ready
  }

  /** Tasks DSH may take over now (optionally only those whose workspace DSH has). */
  listFallback(controllerId, { workspaces, profile } = {}) {
    return this.mutate(async (state) => {
      await this.liveController(controllerId)
      const now = this.clock()
      return Object.values(state.tasks)
        .map(task => ({ task, due: this.fallbackDueAt(state, task) }))
        .filter(({ task, due }) => due !== undefined && due <= now && fallbackWorkspaceOk(task, workspaces) && publishedBy(task, controllerId, profile))
        .sort((a, b) => PRIORITY[a.task.priority] - PRIORITY[b.task.priority] || a.task.created_at.localeCompare(b.task.created_at))
        .map(({ task }) => ({
          ...this.publicTask(task),
          waited_seconds: Math.max(0, Math.round((now - Date.parse(task.pendingSince ?? task.created_at)) / 1000)),
          fallback_reason: this.anyOnlineFor(state, task) ? 'workers-busy' : 'no-online-worker',
        }))
    })
  }

  /**
   * DSH takes a due task over (task_id, or the most urgent due one). It is held
   * by dsh-self: the original worker gets `abort` if it still reports it and
   * can no longer submit. One attempt: a failure or an expired lease fails it.
   */
  takeFallback(controllerId, { task_id: taskId, workspaces, profile } = {}) {
    return this.mutate(async (state) => {
      await this.liveController(controllerId)
      const now = this.clock()
      const due = task => { const at = this.fallbackDueAt(state, task); return at !== undefined && at <= now && fallbackWorkspaceOk(task, workspaces) && publishedBy(task, controllerId, profile) }
      let task
      if (taskId !== undefined) {
        task = this.mustTask(state, taskId)
        if (!publishedBy(task, controllerId, profile)) throw new HubError(403, 'not-publisher', `${task.task_id} goes back to the DSH that published it (${task.created_by}${task.reply_to ? `/${task.reply_to}` : ''})`)
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
      const why = this.anyOnlineFor(state, task) ? 'nobody took it in time' : 'no worker for it is online'
      this.event(task, 'fallback', `${why}; DSH (${controllerId}) does it itself`, { by: controllerId })
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
    const stage = validStage(b.stage)
    return this.mutate(async (state) => {
      await this.liveController(controllerId)
      const task = this.heldByFallback(state, controllerId, b.task_id)
      return this.applyProgress(task, b, stage, controllerId)
    })
  }

  // --- full session logs ----------------------------------------------------------
  //
  // Every task may carry the whole conversation of whoever ran it (prompts,
  // answers, tool calls and their output), uploaded in pieces while it runs
  // and kept next to its artifacts as session.jsonl. Text is redacted on the
  // way in; a log stops growing at MAX_SESSION_BYTES.

  sessionPath(taskId) { return join(this.artifactDir, taskId, 'session.jsonl') }

  async appendSession(task, entries, by) {
    const path = this.sessionPath(task.task_id)
    await mkdir(join(this.artifactDir, task.task_id), { recursive: true })
    let size = 0
    try { size = (await stat(path)).size } catch (error) { if (error?.code !== 'ENOENT') throw error }
    if (size >= MAX_SESSION_BYTES) {
      if (task.sessionFull !== true) { task.sessionFull = true; this.warn(`dsh-hub: session log of ${task.task_id} is full (${MAX_SESSION_BYTES} bytes); later entries dropped`) }
      return { ok: true, stored: 0, full: true, session_entries: task.sessionEntries ?? 0 }
    }
    await appendFile(path, entries.map(e => JSON.stringify({ ...e, by })).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
    task.sessionEntries = (task.sessionEntries ?? 0) + entries.length
    task.sessionUpdatedAt = nowIso(this.clock())
    return { ok: true, stored: entries.length, session_entries: task.sessionEntries }
  }

  /** A worker uploads part of the session of a task it holds or just finished. */
  agentSession(agentId, body = {}) {
    const b = body ?? {}
    const entries = sessionEntries(b.entries, this.clock)
    return this.mutate(async (state) => {
      this.seen(this.liveAgent(state, agentId))
      const task = own(state.tasks, b.task_id)
      const mine = task !== undefined && (task.assignedTo === agentId || task.result?.agent === agentId || task.lastHolder === agentId)
      if (!mine) throw new HubError(404, 'task-not-found', 'no such task held or finished by this agent')
      return this.appendSession(task, entries, agentId)
    })
  }

  /** DSH uploads part of the session of a task it runs itself (registered here or taken over). */
  controllerSession(controllerId, body = {}) {
    const b = body ?? {}
    const entries = sessionEntries(b.entries, this.clock)
    return this.mutate(async (state) => {
      await this.liveController(controllerId)
      const task = this.mustTask(state, b.task_id)
      if (task.fallbackBy !== controllerId) throw new HubError(403, 'not-holder', `${task.task_id} is not run by ${controllerId}`)
      return this.appendSession(task, entries, task.origin?.executor ?? FALLBACK_AGENT)
    })
  }

  /** Read a task's session log (any controller): entries from index `after` on. */
  async readSession(taskId, { after = 0, limit = 500 } = {}) {
    const task = await this.read(state => this.mustTask(state, taskId))
    let raw = ''
    try { raw = await readFile(this.sessionPath(task.task_id), 'utf8') } catch (error) { if (error?.code !== 'ENOENT') throw error }
    const lines = raw.split('\n').filter(Boolean)
    const from = Number.isInteger(after) && after >= 0 ? after : 0
    const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 2000) : 500
    const entries = []
    for (const [index, line] of lines.slice(from, from + max).entries()) {
      try { entries.push({ index: from + index, ...JSON.parse(line) }) } catch { /* a torn line */ }
    }
    return { task_id: task.task_id, total: lines.length, next: Math.min(lines.length, from + max), full: task.sessionFull === true, entries }
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
    return this.mutate(async (state) => {
      let changed = 0
      const now = this.clock()
      for (const task of Object.values(state.tasks)) {
        // A task a DSH registered and runs itself is never failed for silence: that DSH may simply be
        // offline for a while and sends its updates once it is back. It only shows as quiet (`quiet`).
        if (task.origin?.kind === 'local') continue
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
      // Past its due time: tell the publisher once (an `overdue` entry, which its DSH turns into a
      // question to the human); with on_overdue reassign, a worker's task also goes to another worker.
      for (const task of Object.values(state.tasks)) {
        if (TERMINAL.has(task.status) || task.overdueAt !== undefined) continue
        const due = Date.parse(dueAtOf(task) ?? '')
        if (!Number.isFinite(due) || due > now) continue
        task.overdueAt = nowIso(now)
        const late = `${Math.round((now - Date.parse(task.created_at)) / 60_000)} min since it was published, due after ${task.due_minutes} min`
        const holder = isActive(task) && task.assignedTo !== FALLBACK_AGENT ? task.assignedTo : undefined
        const reassign = (task.on_overdue ?? this.due.onOverdue) === 'reassign' && holder !== undefined && task.origin?.kind !== 'local'
        this.event(task, 'overdue', reassign ? `${late}; taken from ${holder} for another worker` : `${late}; ${phaseOf(task)}`, { by: 'hub' })
        if (reassign) {
          task.declined = [...new Set([...(task.declined ?? []), holder])]
          task.attempts = Math.max(0, task.attempts - 1)
          this.requeue(state, task, `overdue: reassigned from ${holder}`)
        }
        changed++
      }
      // Nobody took it in time (or nobody who could is online): hand it back to whoever
      // published it, once per wait, instead of leaving it for someone to find in a list.
      // (An announcement, not a change of the task: not counted.)
      for (const task of Object.values(state.tasks)) {
        const at = this.fallbackDueAt(state, task)
        if (at === undefined || at > now) continue
        const mark = task.pendingSince ?? task.created_at
        if (task.fallbackAnnounced === mark) continue
        task.fallbackAnnounced = mark
        const why = this.anyOnlineFor(state, task) ? 'workers-busy' : 'no-online-worker'
        this.event(task, 'fallback_due', why === 'workers-busy' ? 'nobody took it in time' : 'no worker that can take it is online', { feedOnly: true })
      }
      for (const request of Object.values(state.requests)) {
        if (request.status === 'pending' && now - Date.parse(request.requested_at) > this.requestTtlMs) {
          request.status = 'expired'
          request.decided_at = nowIso(now)
          changed++
        }
      }
      changed += await this.archive(state, now)
      return changed
    })
  }

  /**
   * Move tasks finished more than expiry.archiveHours ago out of state.json:
   * their records are appended, gzip-compressed, to archive/<YYYY-MM>.jsonl.gz
   * and their files (inputs, outputs, session log) move to archive/tasks/<id>.
   * A task an unfinished task still depends on stays. Decided enrollment
   * requests and stream events of the same age are dropped.
   */
  async archive(state, now = this.clock()) {
    const cutoff = now - this.expiry.archiveHours * 3600_000
    const needed = new Set(Object.values(state.tasks).filter(t => !TERMINAL.has(t.status)).flatMap(t => t.depends_on ?? []))
    const old = Object.values(state.tasks).filter(t => TERMINAL.has(t.status) && this.endedAt(t) < cutoff && !needed.has(t.task_id))
    let changed = 0
    if (old.length > 0) {
      await mkdir(join(this.archiveDir, 'tasks'), { recursive: true })
      const byMonth = new Map()
      for (const task of old) {
        const month = nowIso(this.endedAt(task)).slice(0, 7)
        byMonth.set(month, [...(byMonth.get(month) ?? []), task])
      }
      for (const [month, tasks] of byMonth) {
        const lines = tasks.map(t => JSON.stringify({ ...t, archived_at: nowIso(now) })).join('\n') + '\n'
        await appendFile(join(this.archiveDir, `${month}.jsonl.gz`), gzipSync(Buffer.from(lines, 'utf8')), { mode: 0o600 })
      }
      for (const task of old) {
        try { await rename(join(this.artifactDir, task.task_id), join(this.archiveDir, 'tasks', task.task_id)) } catch (error) { if (error?.code !== 'ENOENT') this.warn(`dsh-hub: could not archive files of ${task.task_id}: ${error?.message ?? error}`) }
        delete state.tasks[task.task_id]
        changed++
      }
      this.log(`dsh-hub: archived ${old.length} finished task(s) older than ${this.expiry.archiveHours} h`)
    }
    for (const [id, request] of Object.entries(state.requests)) {
      const at = Date.parse(request.decided_at ?? request.requested_at ?? '')
      if (request.status !== 'pending' && Number.isFinite(at) && at < cutoff) { delete state.requests[id]; changed++ }
    }
    const before = state.feed.length
    state.feed = state.feed.filter(e => Date.parse(e.at) >= cutoff)
    if (state.feed.length !== before) changed++
    return changed
  }

  overview() {
    return this.read((state) => {
      const counts = {}
      let history = 0
      for (const t of Object.values(state.tasks)) {
        if (this.inHistory(t)) { history++; continue }
        counts[t.status] = (counts[t.status] ?? 0) + 1
      }
      const pendingRequests = Object.values(state.requests).filter(r => r.status === 'pending').length
      const agents = Object.values(state.agents).map(a => this.publicAgent(a, state))
      const agentCounts = Object.fromEntries(AGENT_STATUSES.map(s => [s, agents.filter(a => a.status === s).length]))
      const now = this.clock()
      const fallbackDue = Object.values(state.tasks).filter(t => { const at = this.fallbackDueAt(state, t); return at !== undefined && at <= now }).length
      const local = Object.values(state.tasks).filter(t => t.origin?.kind === 'local' && isActive(t)).length
      return {
        protocol: PROTOCOL, agents, agent_counts: agentCounts, task_counts: counts, history_count: history, local_running: local,
        dormant_agents: agents.filter(a => a.dormant).length, pending_requests: pendingRequests, fallback_due: fallbackDue,
        feed_seq: state.feedSeq, expiry: this.expiry,
      }
    })
  }
}
