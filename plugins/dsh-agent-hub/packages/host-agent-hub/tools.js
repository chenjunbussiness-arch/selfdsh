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

const ROLE_HINT = 'tester: test tasks only; dispatcher / observer: no tasks.'

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
  'fallback_list', 'fallback_take', 'fallback_submit',
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
    description: 'Issue a worker directly. Returns its token once. Prefer agent_requests / agent_approve for other machines.',
    parameters: {
      required: ['agent_id'],
      properties: {
        agent_id: { type: 'string', description: '<agent>-<machine>, e.g. quick-mydesk.' },
        platform: { type: 'string', description: 'aws-quick | claude-code | kiro | dsh | custom' },
        mode: { type: 'string', enum: ['poll', 'push'], description: 'poll = scheduled; push = always on.' },
        node: { type: 'string', description: 'Machine name.' },
        workspaces: { ...strList, description: 'Workspace names granted.' },
        capabilities: { ...strList, description: 'Kinds of work: name or name:N (N at once), e.g. browser:1.' },
        max_concurrency: { type: 'integer', minimum: 1, maximum: 32 },
        role: roleParam(`Default ${DEFAULT_ROLE}. ${ROLE_HINT}`),
        pull_every_seconds: { type: 'integer', minimum: 60, maximum: 86400, description: 'Scheduled workers only: seconds between pulls. Omit for always-on.' },
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
    description: 'Revoke a worker; its tasks are requeued.',
    parameters: { required: ['agent_id'], properties: { agent_id: str } },
    execute: raw => client.revoke(raw.agent_id),
  })

  define({
    name: 'agent_list',
    description: 'Workers: status, node, workspaces, capabilities, role, running tasks, runtime (efforts it accepts). Read before task_dispatch.',
    parameters: { properties: {} },
    isConcurrencySafe: () => true,
    execute: async () => ({ agents: (await client.listAgents()).map(agent => ({ ...agent, role: agentRole(agent) })) }),
  })

  define({
    name: 'agent_requests',
    description: 'Enrollment requests (default pending).',
    parameters: { properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'expired', 'all'] } } },
    isConcurrencySafe: () => true,
    execute: async raw => ({ requests: await client.listRequests(raw.status ?? 'pending') }),
  })

  define({
    name: 'agent_approve',
    description: 'Approve a request; may only narrow what it asked for.',
    parameters: {
      required: ['request_id'],
      properties: {
        request_id: str,
        capabilities: strList,
        workspaces: { ...strList, description: 'Subset of the requested workspaces.' },
        max_concurrency: { type: 'integer', minimum: 1, maximum: 32 },
        role: roleParam('Narrow only (worker -> tester). Omit to keep the request.'),
        pull_every_seconds: { type: 'integer', minimum: 60, maximum: 86400, description: 'Scheduled workers only: seconds between pulls. Omit for always-on.' },
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
    description: 'Send a task to a worker id or pool:<capability>. Queued if nobody is online (warnings say so). Instruction must stand alone. depends_on chains tasks; upstream outputs become inputs.',
    parameters: {
      required: ['agent', 'title', 'instruction'],
      properties: {
        agent: { type: 'string', description: 'Worker id or pool:<capability>.' },
        capability: { type: 'string', description: 'Which of the worker\'s capabilities to use.' },
        title: str,
        instruction: str,
        type: { type: 'string', enum: ['research', 'document', 'data', 'code', 'review', 'custom'] },
        workspace: { type: 'string', description: 'Workspace name, not a path. Required for code.' },
        node: { type: 'string', description: 'Pin to one machine.' },
        ref: { type: 'string', description: 'Git branch or commit.' },
        task_id: { type: 'string', description: 'Generated if omitted.' },
        inputs: { type: 'array', items: { type: 'object', properties: { name: str, text: str, base64: str }, required: ['name'] } },
        output: { type: 'object', description: '{ format, filename, requirements }' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        deadline: { type: 'string', description: 'ISO 8601.' },
        lease_seconds: { type: 'integer', minimum: 60 },
        depends_on: strList,
        parent_task_id: str,
        context: { type: 'object' },
        effort: {
          type: 'object',
          additionalProperties: false,
          description: 'Must fit the worker\'s runtime (agent_list). Omit for its default.',
          properties: {
            mode: { type: 'string', enum: ['fast', 'balanced', 'smart'], description: 'fast: lookups; balanced: most work; smart: hard code / reasoning.' },
            thinking: { type: 'string', enum: ['off', 'low', 'medium', 'high'], description: 'Not with fast.' },
            agent: { type: 'string', description: 'One of runtime.agents.' },
          },
        },
        require_online: { type: 'boolean', description: 'Refuse instead of queueing when nobody is online.' },
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
    description: 'Tasks, newest first; filter by status, agent or workspace.',
    parameters: { properties: { status: str, agent: str, workspace: str, limit: { type: 'integer', minimum: 1, maximum: 200 } } },
    isConcurrencySafe: () => true,
    execute: async raw => ({ tasks: await client.listTasks({ status: raw.status, agent: raw.agent, workspace: raw.workspace, limit: raw.limit }) }),
  })

  define({
    name: 'task_get',
    description: 'Full task. output_name also reads that output as text.',
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
    description: 'Cancel an unfinished task you dispatched.',
    parameters: { required: ['task_id'], properties: { task_id: str, reason: str } },
    execute: raw => client.cancel(raw.task_id, raw.reason),
  })

  define({
    name: 'task_retry',
    description: 'Requeue a finished task you dispatched, optionally to another agent.',
    parameters: { required: ['task_id'], properties: { task_id: str, agent: str } },
    execute: raw => client.retry(raw.task_id, raw.agent),
  })

  define({
    name: 'fallback_list',
    description: 'Tasks nobody took in time, for DSH to do itself. workspaces: skip code tasks you lack.',
    parameters: { properties: { workspaces: strList } },
    isConcurrencySafe: () => true,
    execute: async raw => ({ tasks: await client.fallbackList(raw.workspaces) }),
  })

  define({
    name: 'fallback_take',
    description: 'Take one fallback task (or the most urgent). Do it, then fallback_submit. One try only.',
    parameters: { properties: { task_id: str, workspaces: strList } },
    async execute(raw) {
      const out = await client.fallbackTake({ task_id: raw.task_id, workspaces: raw.workspaces })
      const task = out.task
      if (task === null || task === undefined) return { task: null }
      const inputs = []
      let budget = 60000
      for (const item of Array.isArray(task.inputs) ? task.inputs : []) {
        const from = item.from_task === task.task_id ? undefined : item.from_task
        const bytes = budget > 0 ? await client.fallbackInput(task.task_id, item.name, from) : undefined
        const text = bytes === undefined ? undefined : bytes.toString('utf8').slice(0, budget)
        if (text !== undefined) budget -= text.length
        inputs.push({ ...item, text })
      }
      return { task: { ...task, inputs } }
    },
  })

  define({
    name: 'fallback_submit',
    description: 'Finish a fallback task.',
    parameters: {
      required: ['task_id', 'status', 'summary'],
      properties: {
        task_id: str,
        status: { type: 'string', enum: ['completed', 'failed'] },
        summary: str,
        files: { type: 'array', items: { type: 'object', properties: { name: str, text: str }, required: ['name', 'text'] } },
      },
    },
    execute: raw => client.fallbackResult({
      task_id: raw.task_id, status: raw.status, summary: raw.summary,
      files: (raw.files ?? []).map(f => ({ name: f.name, base64: Buffer.from(String(f.text), 'utf8').toString('base64') })),
    }),
  })

  return tools
}
