/**
 * DSH-only control tools for dsh-agent-hub (controller side of `dsh-agent/2.0`).
 *
 * These are registered on the Harness tool registry, so only the DSH model (and
 * the operator driving it) can call them. Each tool is one call to the hub's
 * controller API (`/v1/ctl/*`, docs/DSH-HUB-PROTOCOL-v2.md 5.2) through
 * hub-client.js; the hub does the validation, routing and isolation (cancel /
 * retry only by the creating controller).
 *
 * The controller token (DSH_HUB_TOKEN) never appears in a tool result or error.
 * It comes from the process environment or <DSH home>/agent-hub/controller.env,
 * never from <DSH home>/.env (DSH refuses to start on DSH_* lines there).
 * `agent_provision` returns the new WORKER token exactly once, by design.
 *
 * @module host-agent-hub/tools
 */

import { HubError } from './hub-client.js'
import { DEFAULT_ROLE, ROLES, agentRole, roleRefusal } from './roles.js'

const objectSchema = { type: 'object' }
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }]
const str = { type: 'string' }
const strList = { type: 'array', items: str }
const roleParam = description => ({ type: 'string', enum: [...ROLES], description })

const ROLE_HINT = `${ROLES.join(' | ')}; default ${DEFAULT_ROLE} (any task). tester takes test tasks only (type custom/review, or a 冒烟/测试/smoke/test title); dispatcher and observer never take tasks (task_dispatch refuses them with role-not-dispatchable).`

/**
 * Roles the hub reported for its agents, for the task_dispatch pre-check.
 * Best effort ON PURPOSE: an older hub that sends no roles (or a failed lookup)
 * answers "unknown" and the task goes to the hub, whose dispatch() owns the
 * authoritative gate (hub.js checkTargetRole). Never throws.
 */
async function roleIndex(client) {
  try {
    const agents = await client.listAgents()
    return {
      ok: true,
      agents: (Array.isArray(agents) ? agents : [])
        .filter(agent => typeof agent?.agent_id === 'string')
        .map(agent => ({ agent_id: agent.agent_id, role: agentRole(agent), capabilities: Array.isArray(agent.capabilities) ? agent.capabilities : [] })),
    }
  } catch {
    return { ok: false, agents: [] }
  }
}

/**
 * Why the target role refuses this task (`role-not-dispatchable` /
 * `role-not-testable`), or `undefined` when it accepts it or nothing is known.
 * A `pool:` is refused only when every member with that capability refuses it.
 */
async function dispatchRoleRefusal(client, task) {
  if (typeof task.agent !== 'string') return undefined
  const index = await roleIndex(client)
  if (!index.ok) return undefined
  const probe = { type: task.type ?? 'custom', title: String(task.title ?? '') }
  if (task.agent.startsWith('pool:')) {
    const capability = task.agent.slice(5)
    const members = index.agents.filter(agent => agent.capabilities.includes(capability))
    if (members.length === 0) return undefined
    const refusals = members.map(agent => roleRefusal(probe, agent.role, task.agent))
    return refusals.every(refusal => refusal !== undefined) ? refusals[0] : undefined
  }
  const agent = index.agents.find(entry => entry.agent_id === task.agent)
  return agent === undefined ? undefined : roleRefusal(probe, agent.role, task.agent)
}

export const TOOL_NAMES = [
  'agent_provision', 'agent_revoke', 'agent_list', 'agent_requests', 'agent_approve', 'agent_reject',
  'task_dispatch', 'task_list', 'task_get', 'task_cancel', 'task_retry',
]

/**
 * Run one tool body: the output goes through `client.scrub` (the controller token
 * can never be part of a tool result); a HubError gets `[code]` in front of its message.
 */
async function run(client, fn) {
  try {
    return client.scrub(await fn())
  } catch (error) {
    if (error instanceof HubError) {
      throw new HubError(error.status, error.code, `[${error.code}] ${client.redact(error.message)}`, { fromHub: error.fromHub })
    }
    throw error
  }
}

/**
 * @param {{ client: ReturnType<typeof import('./hub-client.js').createHubClient> }} deps
 */
export function createTools({ client }) {
  const tools = []
  const define = def => tools.push({
    isConcurrencySafe: () => false,
    output: { schema: objectSchema, render: renderJson },
    ...def,
    parameters: { type: 'object', additionalProperties: false, ...def.parameters },
    execute: (raw, options) => run(client, () => def.execute(raw ?? {}, options)),
  })
  const workerEndpoint = () => (client.config.hubUrl === undefined ? undefined : `${client.config.hubUrl}/v1`)

  define({
    name: 'agent_provision',
    description: 'Directly issue a worker (agent) on the hub, e.g. "quick-mydesk". Returns the worker token ONCE (only its hash is kept on the hub); the worker sends it as X-DSH-Token with ?id=<agent_id> to the hub endpoint. Re-provisioning re-keys. Prefer the enrollment flow (agent_requests / agent_approve) for workers on other machines.',
    parameters: {
      required: ['agent_id'],
      properties: {
        agent_id: { type: 'string', description: 'Worker id, /^[a-z][a-z0-9-]{1,47}$/, suggested <agent>-<machine>, e.g. "quick-mydesk".' },
        platform: { type: 'string', description: 'aws-quick | claude-code | kiro | custom ...' },
        mode: { type: 'string', enum: ['poll', 'push'], description: 'poll = scheduled pickup (AWS Quick); push = long-running worker.' },
        node: { type: 'string', description: 'Machine name the worker runs on (mydesk / cloud ...), used by task routing (task.node).' },
        workspaces: { ...strList, description: 'Workspace names (router-b partition names) the worker is granted, e.g. ["deepseek-harness"].' },
        capabilities: { ...strList, description: 'For pool:<capability> routing, e.g. research, document, data, code.' },
        max_concurrency: { type: 'integer', minimum: 1, maximum: 32 },
        role: roleParam(`dispatcher | tester | worker | observer. Omit for ${DEFAULT_ROLE}. ${ROLE_HINT}`),
        pull_every_seconds: { type: 'integer', minimum: 60, maximum: 86400, description: 'Only for a worker that is not always on (AWS Quick on a schedule, a cron `bridge --once`): how often it comes back, in seconds. The hub then waits 90 s + this long before it counts the worker offline and requeues its tasks. Omit for an always-on worker.' },
        description: str,
      },
    },
    async execute(raw) {
      const out = await client.provision(raw)
      return { ...out, endpoint: workerEndpoint(), note: 'Store this worker token now; it is not shown again.' }
    },
  })

  define({
    name: 'agent_revoke',
    description: 'Revoke a worker: its token stops working at once and its running tasks go back to the queue.',
    parameters: { required: ['agent_id'], properties: { agent_id: str } },
    execute: raw => client.revoke(raw.agent_id),
  })

  define({
    name: 'agent_list',
    description: 'List the workers known to the hub: status (pending = approved but token not collected, online = heartbeat / poll within 90 s, offline, left = said goodbye, revoked), last_seen, client version, node, workspaces, capabilities, role (worker when the hub does not send one), running tasks and `runtime`: what each worker can be asked to run (modes fast/balanced/smart, thinking levels, its default effort per task type, and the named agents of its platform). Read it before task_dispatch to choose the worker and its effort.',
    parameters: { properties: {} },
    isConcurrencySafe: () => true,
    execute: async () => ({ agents: (await client.listAgents()).map(agent => ({ ...agent, role: agentRole(agent) })) }),
  })

  define({
    name: 'agent_requests',
    description: 'List enrollment requests from workers asking to join (default: pending). Review platform, node, workspaces, capabilities, runtime (modes / thinking / agents it offers) and source address before approving.',
    parameters: { properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'expired', 'all'] } } },
    isConcurrencySafe: () => true,
    execute: async raw => ({ requests: await client.listRequests(raw.status ?? 'pending') }),
  })

  define({
    name: 'agent_approve',
    description: 'Approve an enrollment request. Optionally NARROW its capabilities, workspaces, role or max_concurrency (the hub refuses widening: 400 grant-widened / role-widened). The worker collects its token itself; DSH never sees it.',
    parameters: {
      required: ['request_id'],
      properties: {
        request_id: str,
        capabilities: strList,
        workspaces: { ...strList, description: 'Subset of the requested workspace names to grant.' },
        max_concurrency: { type: 'integer', minimum: 1, maximum: 32 },
        role: roleParam(`NARROW the requested role only (a worker request may be approved as tester, not the other way round); widening answers 400 role-widened. Omit to keep what the agent asked for (default ${DEFAULT_ROLE}).`),
        pull_every_seconds: { type: 'integer', minimum: 60, maximum: 86400, description: 'Only for a worker that is not always on (AWS Quick on a schedule, a cron `bridge --once`): how often it comes back, in seconds. The hub then waits 90 s + this long before it counts the worker offline and requeues its tasks. Omit for an always-on worker.' },
      },
    },
    execute: raw => client.approve(raw),
  })

  define({
    name: 'agent_reject',
    description: 'Reject an enrollment request.',
    parameters: { required: ['request_id'], properties: { request_id: str, reason: str } },
    execute: raw => client.reject(raw.request_id, raw.reason),
  })

  define({
    name: 'task_dispatch',
    description: 'Dispatch a task to one worker ("quick-mydesk") or to any worker with a capability ("pool:research"). Workers only get tasks when they poll, so a task for an offline worker waits in the queue: the answer then has warnings (agent-offline / no-online-worker); pass require_online: true to refuse instead. The instruction must be self-contained. `workspace` is a workspace NAME (never a path; required for type "code"); `node` pins a machine; `ref` is the git branch/commit the worker checks out first. `effort` picks how the worker runs it: mode fast (quick lookups, small documents), balanced (most documents, research, ordinary code) or smart (hard programming / reasoning), a thinking level, and optionally one of the worker\'s named agents; only values listed in the worker\'s runtime (agent_list) are accepted (409 unsupported-effort), and a pool only hands the task to workers that support them. Omit effort to use the worker\'s own default for the task type. Role gate (agent_list shows each role): a dispatcher or observer target is refused (400 role-not-dispatchable), a tester target takes test tasks only (type custom/review or a 冒烟/测试/smoke/test title, else 400 role-not-testable), worker takes anything, and pool: only routes to worker / tester agents. Inputs are small files given inline. Use depends_on to chain tasks: upstream outputs become inputs of the next task.',
    parameters: {
      required: ['agent', 'title', 'instruction'],
      properties: {
        agent: { type: 'string', description: 'Worker id or pool:<capability>.' },
        title: str,
        instruction: str,
        type: { type: 'string', enum: ['research', 'document', 'data', 'code', 'review', 'custom'] },
        workspace: { type: 'string', description: 'Workspace name (router-b partition name), e.g. "deepseek-harness". Required when type is "code".' },
        node: { type: 'string', description: 'Optional: only a worker on this machine (mydesk / cloud ...) may take it.' },
        ref: { type: 'string', description: 'Optional git branch or commit to check out before working.' },
        task_id: { type: 'string', description: 'Optional; generated when omitted.' },
        inputs: { type: 'array', items: { type: 'object', properties: { name: str, text: str, base64: str }, required: ['name'] } },
        output: { type: 'object', description: '{ format, filename, requirements }' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        deadline: { type: 'string', description: 'ISO 8601 with offset.' },
        lease_seconds: { type: 'integer', minimum: 60 },
        depends_on: strList,
        parent_task_id: str,
        context: { type: 'object' },
        effort: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional: how the worker runs the task. Must fit the worker\'s runtime (agent_list). Omitted: the worker\'s runtime default for this task type (AWS Quick: code -> smart/medium, everything else -> balanced/low).',
          properties: {
            mode: { type: 'string', enum: ['fast', 'balanced', 'smart'], description: 'fast = quick lookups / small documents; balanced = most documents, research, ordinary code; smart = hard programming and reasoning.' },
            thinking: { type: 'string', enum: ['off', 'low', 'medium', 'high'], description: 'Only for balanced / smart; fast has no thinking.' },
            agent: { type: 'string', description: 'Optional: one of the named agents in the worker\'s runtime.agents (e.g. a specific AWS Quick agent). Omit for the worker\'s default agent.' },
          },
        },
        require_online: { type: 'boolean', description: 'Refuse (409 agent-offline / no-online-worker) instead of queueing when no suitable worker is online right now. Default false: the task is queued and the answer carries warnings ["agent-offline"] or ["no-online-worker"].' },
      },
    },
    async execute(raw) {
      if (raw.type === 'code' && (typeof raw.workspace !== 'string' || raw.workspace.trim() === '')) {
        throw new HubError(400, 'bad-task', 'workspace is required for type "code" (a workspace name, not a path)')
      }
      const task = { ...raw }
      const effort = raw.effort
      if (effort !== undefined) {
        if (effort === null || typeof effort !== 'object' || Array.isArray(effort)) throw new HubError(400, 'bad-task', 'effort must be an object { mode, thinking, agent }')
        if (effort.mode === 'fast' && effort.thinking !== undefined && effort.thinking !== 'off') {
          throw new HubError(400, 'bad-task', 'effort.thinking needs mode balanced or smart (fast has no thinking)')
        }
        // Top-level `effort` is checked and routed by the hub (>= runtime support); the copy in
        // context.effort reaches the worker through an older hub that drops unknown task fields.
        const context = task.context && typeof task.context === 'object' && !Array.isArray(task.context) ? task.context : {}
        task.effort = { ...effort }
        task.context = { ...context, effort: { ...effort } }
      }
      // Role gate (roles.js): a dispatcher / observer never takes a task, a tester only
      // test tasks, a pool only the tasks one of its worker / tester members accepts.
      const refusal = await dispatchRoleRefusal(client, task)
      if (refusal !== undefined) throw new HubError(400, refusal.code, refusal.message)
      return client.dispatch(task)
    },
  })

  define({
    name: 'task_list',
    description: 'List tasks, newest first, optionally by status (pending/accepted/running/completed/failed/cancelled/dead), agent (id or pool:<capability>) or workspace name.',
    parameters: { properties: { status: str, agent: str, workspace: str, limit: { type: 'integer', minimum: 1, maximum: 200 } } },
    isConcurrencySafe: () => true,
    execute: async raw => ({ tasks: await client.listTasks({ status: raw.status, agent: raw.agent, workspace: raw.workspace, limit: raw.limit }) }),
  })

  define({
    name: 'task_get',
    description: 'Full task: instruction, history, result summary and output file list. Pass output_name to also read one output file as text (first 60000 chars).',
    parameters: { required: ['task_id'], properties: { task_id: str, output_name: str } },
    isConcurrencySafe: () => true,
    async execute(raw) {
      const task = { ...await client.getTask(raw.task_id) }
      if (raw.output_name) {
        const bytes = await client.readOutput(raw.task_id, raw.output_name)
        task.output_text = bytes.toString('utf8').slice(0, 60000)
      }
      return task
    },
  })

  define({
    name: 'task_cancel',
    description: 'Cancel a task that is not finished (only tasks this DSH dispatched). The worker will be refused when it reports on it.',
    parameters: { required: ['task_id'], properties: { task_id: str, reason: str } },
    execute: raw => client.cancel(raw.task_id, raw.reason),
  })

  define({
    name: 'task_retry',
    description: 'Put a finished (failed/cancelled/dead/completed) task back in the queue, optionally to another worker or pool (only tasks this DSH dispatched).',
    parameters: { required: ['task_id'], properties: { task_id: str, agent: str } },
    execute: raw => client.retry(raw.task_id, raw.agent),
  })

  return tools
}
