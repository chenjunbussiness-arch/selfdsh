/**
 * Agent roles — one optional field on top of `dsh-agent/1.0` / `dsh-agent/2.0`.
 *
 *   worker      takes any task. THE DEFAULT: an agent that never sends a role,
 *               and every agent stored before roles existed, is a worker.
 *   tester      takes test tasks only: `type` is custom or review, or the title
 *               names a test (冒烟 / 测试 / smoke / test). Anything else is refused.
 *   dispatcher  dispatches work and never takes any: task_dispatch refuses it.
 *   observer    read-only (panel / lists), never takes any: task_dispatch refuses it.
 *
 * Everything here is a pure function so the same policy serves
 *   - the hub core (hub.js: enroll, approve, dispatch, poll, listings) and
 *   - the controller tools (tools.js: a task_dispatch pre-check, agent_approve).
 * Errors are returned as `{ code, message }` (the caller throws its own HubError),
 * so this module stays free of either HubError class.
 *
 * Code names follow the existing hub style (`bad-mode`, `grant-widened`):
 *   bad-role              not one of the four roles
 *   role-widened          approve tried to WIDEN the requested role
 *   role-not-dispatchable the target role never takes tasks (dispatcher / observer)
 *   role-not-testable     the target is a tester and the task is not a test
 *
 * @module host-agent-hub/roles
 */

/** The four roles, in listing order. */
export const ROLES = ['dispatcher', 'tester', 'worker', 'observer']

/** Role of an agent that never sent one (backward compatible). */
export const DEFAULT_ROLE = 'worker'

/** Task types a tester accepts beyond a test-shaped title. */
export const TEST_TASK_TYPES = ['custom', 'review']

/** A title naming a test (`冒烟` / `测试` / `smoke` / `test`, any case). */
export const TEST_TITLE_RE = /冒烟|测试|smoke|test/i

/**
 * How much work a role may do: 0 = nothing, 3 = anything. `approve` may only
 * lower it (a request may ask for a wider role than DSH grants, never the
 * other way round), which is what `role-widened` guards.
 */
export const ROLE_RANK = Object.freeze({ observer: 0, dispatcher: 1, tester: 2, worker: 3 })

/** True for one of the four role names. */
export function isRole(value) {
  return typeof value === 'string' && ROLES.includes(value)
}

/**
 * Normalize a caller-supplied role: absent / empty means {@link DEFAULT_ROLE},
 * an unknown value means `undefined` (the caller answers `bad-role`).
 */
export function roleOf(value) {
  if (value === undefined || value === null) return DEFAULT_ROLE
  if (typeof value !== 'string') return undefined
  const role = value.trim()
  if (role === '') return DEFAULT_ROLE
  return isRole(role) ? role : undefined
}

/** The role of a stored agent record: `worker` when the record has none. */
export function agentRole(agent) {
  return isRole(agent?.role) ? agent.role : DEFAULT_ROLE
}

/** `bad-role` refusal, or `undefined` for a valid role. */
export function roleProblem(value, label = 'role') {
  const role = roleOf(value)
  if (role === undefined) return { code: 'bad-role', message: `${label} must be one of ${ROLES.join(', ')} (default ${DEFAULT_ROLE})` }
  return undefined
}

/** True when the task is a test: `type` custom / review, or a test-shaped title. */
export function isTestTask(task) {
  if (TEST_TASK_TYPES.includes(task?.type)) return true
  return typeof task?.title === 'string' && TEST_TITLE_RE.test(task.title)
}

/** True when an agent of this role may take this task at all. */
export function roleAccepts(role, task) {
  if (role === 'worker') return true
  if (role === 'tester') return isTestTask(task)
  return false // dispatcher and observer never take tasks
}

/** True for the two roles that may take tasks (the only ones pool routing picks). */
export function roleTakesWork(role) {
  return role === 'worker' || role === 'tester'
}

/**
 * Why dispatching `task` to `target` (an agent id or `pool:<capability>`) is
 * refused by the target's role; `undefined` when it is allowed.
 * @returns {{ code: string, message: string } | undefined}
 */
export function roleRefusal(task, role, target) {
  const who = target === undefined ? `this ${String(role)}` : `${String(target)} (${String(role)})`
  if (role === 'dispatcher') {
    return { code: 'role-not-dispatchable', message: `${who} is a dispatcher: dispatchers dispatch work and never take tasks; dispatch to a worker instead` }
  }
  if (role === 'observer') {
    return { code: 'role-not-dispatchable', message: `${who} is an observer: observers only read the board and never take tasks; dispatch to a worker instead` }
  }
  if (role === 'tester' && !isTestTask(task)) {
    return {
      code: 'role-not-testable',
      message: `${who} is a tester: testers only take test tasks (type ${TEST_TASK_TYPES.join('/')}, or a title naming 冒烟/测试/smoke/test), but this task is type "${String(task?.type ?? 'custom')}" titled "${String(task?.title ?? '').slice(0, 80)}"`,
    }
  }
  return undefined
}

/** Why `granted` widens the requested role; `undefined` when it narrows or keeps it. */
export function roleWidening(requested, granted) {
  const asked = agentRole({ role: requested })
  const want = agentRole({ role: granted })
  if (ROLE_RANK[want] <= ROLE_RANK[asked]) return undefined
  return { code: 'role-widened', message: `role can only be narrowed at approval (${asked} -> ${want} widens it)` }
}

/** True when the role is stored (so `publicAgent` can always report it). */
export function hasRole(agent) {
  return isRole(agent?.role)
}
