/**
 * Roles: dispatcher / tester / worker / observer.
 *
 * Covers the model (hub.js: enroll, approve, dispatch, poll, listings), the
 * bridge whitelist and the task_dispatch pre-check (tools.js). Backward
 * compatibility is asserted all along: an agent (or a stored record) without a
 * role is a worker and behaves exactly like before.
 *
 * hub.js and tools.js each carry their own HubError class, so the assertions
 * check the right one for the layer under test.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { adminAgent, adminRequest } from '../bridge.js'
import { HubError as ToolHubError } from '../hub-client.js'
import { AgentHub, HubError as ModelHubError } from '../hub.js'
import { DEFAULT_ROLE, ROLE_RANK, ROLES, agentRole, isRole, isTestTask, roleOf } from '../roles.js'
import { createTools } from '../tools.js'
import { makeClient } from './helpers.mjs'

/** A hub in a throwaway directory; removed when the test ends. */
async function makeHub(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-hub-roles-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const hub = new AgentHub({ dataDir: dir, logger: { info() {} }, ...options })
  return { hub, dir, stateFile: join(dir, 'state.json') }
}

/** Assert a call rejects with a hub error of this status and code, and return it. */
async function rejectsWith(run, status, code, kind = 'model') {
  const type = kind === 'tool' ? ToolHubError : ModelHubError
  let caught
  // `async` wrapper: hub.js validates BEFORE it returns a promise, so a synchronous
  // throw must become a rejection for assert.rejects to inspect it.
  await assert.rejects(async () => run(), (error) => {
    assert.ok(error instanceof type, `expected ${kind} HubError, got ${String(error?.stack ?? error)}`)
    assert.equal(error.status, status, `${error.code}: ${error.message}`)
    assert.equal(error.code, code, error.message)
    caught = error
    return true
  })
  return caught
}

/** Enroll an agent (pending) and return the request id and poll secret. */
async function enrollOnly(hub, agentId, extra = {}) {
  const { request_id: requestId, poll_secret: pollSecret } = await hub.requestEnrollment({ agent_id: agentId, capabilities: ['code'], platform: 'custom', ...extra })
  return { requestId, pollSecret }
}

/** Enroll an agent, approve it and collect its token (required before it can poll). */
async function enroll(hub, agentId, extra = {}, approve = {}) {
  const { requestId, pollSecret } = await enrollOnly(hub, agentId, extra)
  const approved = await hub.approveRequest(requestId, approve)
  const issued = await hub.enrollmentStatus({ request_id: requestId, poll_secret: pollSecret })
  return { requestId, approved, token: issued.token }
}

// --- the model (roles.js) ---------------------------------------------------

test('roles: the four names, worker by default, invalid values stay invalid', () => {
  assert.deepEqual(ROLES, ['dispatcher', 'tester', 'worker', 'observer'])
  assert.equal(DEFAULT_ROLE, 'worker')
  assert.equal(roleOf(undefined), 'worker', 'no role at all = worker (old agents, old enroll calls)')
  assert.equal(roleOf(null), 'worker')
  assert.equal(roleOf('  '), 'worker')
  assert.equal(roleOf(' tester '), 'tester')
  for (const bad of ['boss', 'Worker', 'workers', 42, {}, []]) assert.equal(roleOf(bad), undefined, String(bad))
  assert.equal(isRole('observer'), true)
  assert.equal(agentRole({}), 'worker')
  assert.equal(agentRole({ role: 'nonsense' }), 'worker', 'a corrupted record is a worker')
  assert.equal(agentRole({ role: 'tester' }), 'tester')
  // Narrower = may do less work; approve can only lower it.
  assert.ok(ROLE_RANK.worker > ROLE_RANK.tester && ROLE_RANK.tester > ROLE_RANK.dispatcher && ROLE_RANK.dispatcher > ROLE_RANK.observer)
})

test('roles: a task is a "test" by type custom/review or by a 冒烟/测试/smoke/test title', () => {
  for (const type of ['custom', 'review']) assert.equal(isTestTask({ type, title: 'anything' }), true, type)
  for (const title of ['冒烟测试', '测试登录', 'smoke the login flow', 'Smoke test', 'run the tests', 'Test the api']) assert.equal(isTestTask({ type: 'research', title }), true, title)
  for (const title of ['write the docs', 'fix a bug', 'compare providers']) assert.equal(isTestTask({ type: 'research', title }), false, title)
})

// --- 1. enroll / provision: the optional field, validated and persisted ------

test('enroll: no role is still accepted and the agent becomes a worker (persisted)', async (t) => {
  const { hub, stateFile } = await makeHub(t)
  const { approved } = await enroll(hub, 'quick-mydesk')
  assert.equal(approved.agent.role, 'worker')
  assert.equal(approved.status, 'approved')
  const stored = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(stored.agents['quick-mydesk'].role, 'worker', 'role is written to the state file')
  assert.equal((await hub.listAgents())[0].role, 'worker')
  // The requested agent record also carries it.
  const requests = await hub.listRequests({ status: 'all' })
  assert.equal(requests[0].role, 'worker')
})

test('enroll: every role value is accepted and persisted', async (t) => {
  const { hub, stateFile } = await makeHub(t)
  for (const [index, role] of ROLES.entries()) await enroll(hub, `agent-${String(index)}`, { role })
  const stored = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.deepEqual(ROLES.map((_, index) => stored.agents[`agent-${String(index)}`].role), ROLES, 'state.json keeps all four')
})

test('enroll: an illegal role is a 400 bad-role and nothing is stored', async (t) => {
  const { hub, stateFile } = await makeHub(t)
  for (const role of ['boss', 'Worker', 'workers', 3, [], {}]) {
    await rejectsWith(() => hub.requestEnrollment({ agent_id: 'quick-mydesk', role }), 400, 'bad-role')
  }
  assert.deepEqual(await hub.listRequests({ status: 'all' }), [])
  await assert.rejects(() => readFile(stateFile, 'utf8'), /ENOENT/, 'no state file was written')
  // No role (or an empty one) is still fine: 201-equivalent, pending.
  const pending = await hub.requestEnrollment({ agent_id: 'quick-mydesk' })
  assert.equal(pending.status, 'pending')
  assert.equal((await hub.listRequests({ status: 'pending' }))[0].role, 'worker')
})

test('provision: the role is validated, stored and reported', async (t) => {
  const { hub, stateFile } = await makeHub(t)
  const { agent } = await hub.provisionAgent({ agent_id: 'docker-worker', role: 'tester' })
  assert.equal(agent.role, 'tester')
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).agents['docker-worker'].role, 'tester')
  assert.equal((await hub.overview()).agents[0].role, 'tester')
  await rejectsWith(() => hub.provisionAgent({ agent_id: 'other', role: 'root' }), 400, 'bad-role')
})

test('a record stored before roles existed is a worker: listing, overview, dispatch, poll all work', async (t) => {
  const { hub, stateFile } = await makeHub(t)
  // Exactly what an older version wrote: an agent record with no `role` key at all.
  const legacy = {
    id: 'legacy-mydesk', platform: 'aws-quick', mode: 'poll', capabilities: ['code'], maxConcurrency: 1,
    description: '', tokenHash: 'ab'.repeat(32), createdAt: '2026-01-01T00:00:00.000Z', revoked: false,
  }
  await writeFile(stateFile, `${JSON.stringify({ protocol: 'dsh-agent/1.0', agents: { 'legacy-mydesk': legacy }, tasks: {}, requests: {}, seq: 0 }, undefined, 2)}\n`, 'utf8')
  assert.equal((await hub.listAgents())[0].role, 'worker')
  assert.equal((await hub.overview()).agents[0].role, 'worker')
  const task = await hub.dispatch({ agent: 'legacy-mydesk', type: 'code', title: 'Fix it', instruction: 'Fix the bug.' })
  assert.equal(task.status, 'pending', 'dispatch to an old worker is unchanged')
  const leased = await hub.poll('legacy-mydesk', { max: 1 })
  assert.deepEqual(leased.tasks.map(x => x.task_id), [task.task_id], 'an old worker still leases work')
})

// --- 2. approve: narrow only ------------------------------------------------

test('approve: a worker request may be approved as tester (narrowing), and the role is stored', async (t) => {
  const { hub, stateFile } = await makeHub(t)
  const { requestId } = await enrollOnly(hub, 'quick-mydesk', { role: 'worker' })
  const approved = await hub.approveRequest(requestId, { role: 'tester' })
  assert.equal(approved.agent.role, 'tester')
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).agents['quick-mydesk'].role, 'tester')
  assert.equal((await hub.listRequests({ status: 'all' }))[0].role, 'tester', 'the decided request shows the granted role')
})

test('approve: without a role the requested one is kept (default worker)', async (t) => {
  const { hub } = await makeHub(t)
  assert.equal((await hub.approveRequest((await enrollOnly(hub, 'no-role-asked')).requestId)).agent.role, 'worker')
  const asked = await enrollOnly(hub, 'asks-test', { role: 'tester' })
  assert.equal((await hub.approveRequest(asked.requestId)).agent.role, 'tester', 'an explicit request is kept as sent')
})

test('approve: widening the role is 400 role-widened (same shape as grant-widened)', async (t) => {
  const { hub } = await makeHub(t)
  const { requestId } = await enrollOnly(hub, 'quick-mydesk', { role: 'tester' })
  const error = await rejectsWith(() => hub.approveRequest(requestId, { role: 'worker' }), 400, 'role-widened')
  assert.match(error.message, /narrow/)
  await rejectsWith(() => hub.approveRequest(requestId, { role: 'boss' }), 400, 'bad-role')
  assert.deepEqual((await hub.listRequests({ status: 'pending' })).map(r => r.request_id), [requestId], 'a refused approval leaves the request pending')
  assert.equal((await hub.approveRequest(requestId, { role: 'observer' })).agent.role, 'observer', 'narrowing to observer is allowed')
})

test('approve: narrowing is allowed in any direction downward, never upward', async (t) => {
  const { hub } = await makeHub(t)
  const dispatcher = await enrollOnly(hub, 'disp-mydesk', { role: 'dispatcher' })
  assert.equal((await hub.approveRequest(dispatcher.requestId, { role: 'observer' })).agent.role, 'observer')
  const worker = await enrollOnly(hub, 'worker-mydesk', { role: 'worker' })
  assert.equal((await hub.approveRequest(worker.requestId, { role: 'dispatcher' })).agent.role, 'dispatcher', 'a dispatcher takes less work than a worker, so this narrows')
  const tester = await enrollOnly(hub, 'qa-mydesk', { role: 'tester' })
  await rejectsWith(() => hub.approveRequest(tester.requestId, { role: 'worker' }), 400, 'role-widened')
})

// --- 3. dispatch: the role gate --------------------------------------------

test('dispatch: a dispatcher or observer target is refused with role-not-dispatchable', async (t) => {
  const { hub } = await makeHub(t)
  for (const [agent, role] of [['disp-mydesk', 'dispatcher'], ['watch-mydesk', 'observer']]) await enroll(hub, agent, { role })
  const dispatcher = await rejectsWith(() => hub.dispatch({ agent: 'disp-mydesk', title: 'Fix it', instruction: 'Fix the bug.' }), 400, 'role-not-dispatchable')
  assert.match(dispatcher.message, /dispatcher/)
  const observer = await rejectsWith(() => hub.dispatch({ agent: 'watch-mydesk', title: 'Fix it', instruction: 'Fix the bug.' }), 400, 'role-not-dispatchable')
  assert.match(observer.message, /observer/)
  assert.deepEqual(await hub.listTasks({}), [], 'nothing was queued')
})

test('dispatch + poll: a tester gets test tasks only, a worker gets anything', async (t) => {
  const { hub } = await makeHub(t)
  await enroll(hub, 'qa-mydesk', { role: 'tester' })
  await enroll(hub, 'quick-mydesk', { role: 'worker' })
  const testTask = await hub.dispatch({ agent: 'qa-mydesk', type: 'custom', title: '冒烟测试登录', instruction: 'Smoke it.' })
  await rejectsWith(() => hub.dispatch({ agent: 'qa-mydesk', type: 'research', title: 'Compare providers', instruction: 'Compare.' }), 400, 'role-not-testable')
  await rejectsWith(() => hub.dispatch({ agent: 'qa-mydesk', type: 'document', title: 'Write the README', instruction: 'Write.' }), 400, 'role-not-testable')
  await hub.dispatch({ agent: 'quick-mydesk', type: 'document', title: 'Write the README', instruction: 'Write.' })
  const qa = await hub.poll('qa-mydesk', { max: 5 })
  assert.deepEqual(qa.tasks.map(x => x.task_id), [testTask.task_id], 'only the test task was leased')
  const worker = await hub.poll('quick-mydesk', { max: 5 })
  assert.equal(worker.tasks.length, 1, 'the worker leases the non-test task')
})

// --- 4. pool: role filtering ----------------------------------------------

test('pool: only worker / tester agents lease, and a tester only a test task', async (t) => {
  const { hub } = await makeHub(t)
  await enroll(hub, 'disp-pool', { role: 'dispatcher' })
  await enroll(hub, 'watch-pool', { role: 'observer' })
  await enroll(hub, 'qa-pool', { role: 'tester' })
  await enroll(hub, 'quick-pool', { role: 'worker' })
  const plain = await hub.dispatch({ agent: 'pool:code', type: 'code', title: 'Fix it', instruction: 'Fix the bug.' })
  assert.deepEqual((await hub.poll('disp-pool', { max: 5 })).tasks, [], 'a dispatcher leases nothing from a pool')
  assert.deepEqual((await hub.poll('watch-pool', { max: 5 })).tasks, [], 'an observer leases nothing from a pool')
  assert.deepEqual((await hub.poll('qa-pool', { max: 5 })).tasks, [], 'a tester does not lease a non-test pool task')
  const worker = await hub.poll('quick-pool', { max: 5 })
  assert.deepEqual(worker.tasks.map(x => x.task_id), [plain.task_id], 'the worker leases the pool task')
  const testPool = await hub.dispatch({ agent: 'pool:code', type: 'custom', title: 'smoke test the api', instruction: 'Smoke.' })
  const qa = await hub.poll('qa-pool', { max: 5 })
  assert.deepEqual(qa.tasks.map(x => x.task_id), [testPool.task_id], 'the tester leases the test pool task')
})

test('pool: a dispatch nobody in the pool can serve is refused; an empty pool still queues (old behaviour)', async (t) => {
  const { hub } = await makeHub(t)
  await enroll(hub, 'disp-pool', { role: 'dispatcher' })
  await enroll(hub, 'watch-pool', { role: 'observer' })
  await rejectsWith(() => hub.dispatch({ agent: 'pool:code', title: 'Fix it', instruction: 'Fix the bug.' }), 400, 'role-not-dispatchable')
  const empty = await hub.dispatch({ agent: 'pool:research', title: 'Fix it', instruction: 'Fix the bug.' })
  assert.equal(empty.status, 'pending', 'a pool with no member stays queued, as before roles existed')
})

// --- 5. task_dispatch tool: the controller-side pre-check -------------------

/** The task_dispatch tool wired to a fake hub whose agents carry these roles. */
function toolSetup(agents, handler) {
  const post = handler ?? (() => ({ body: { task_id: 't1', status: 'pending' } }))
  const base = makeClient((call) => (call.path === '/v1/ctl/agents' ? { body: { agents } } : post(call)))
  const tools = new Map(createTools({ client: base.client }).map(tool => [tool.name, tool]))
  const call = async (name, args = {}) => {
    const tool = tools.get(name)
    assert.ok(tool, `tool ${name} missing`)
    return tool.execute(args, { signal: new AbortController().signal })
  }
  const posts = () => base.calls.filter(c => c.method === 'POST')
  return { ...base, call, posts }
}

test('task_dispatch: a dispatcher / observer agent is refused before the hub sees the task', async () => {
  const { call, posts } = toolSetup([
    { agent_id: 'disp-mydesk', role: 'dispatcher', capabilities: ['code'] },
    { agent_id: 'watch-mydesk', role: 'observer', capabilities: ['code'] },
    { agent_id: 'qa-mydesk', role: 'tester', capabilities: ['code'] },
    { agent_id: 'quick-mydesk', role: 'worker', capabilities: ['code'] },
  ])
  const dispatcher = await rejectsWith(() => call('task_dispatch', { agent: 'disp-mydesk', title: 'Fix', instruction: 'Fix it.' }), 400, 'role-not-dispatchable', 'tool')
  assert.match(dispatcher.message, /dispatcher/)
  assert.ok(dispatcher.message.startsWith('[role-not-dispatchable] '), dispatcher.message)
  await rejectsWith(() => call('task_dispatch', { agent: 'watch-mydesk', title: 'Fix', instruction: 'Fix it.' }), 400, 'role-not-dispatchable', 'tool')
  assert.deepEqual(posts(), [], 'no task was sent to the hub')
})

test('task_dispatch: a tester takes test tasks, everything else is role-not-testable', async () => {
  const { call, posts } = toolSetup([{ agent_id: 'qa-mydesk', role: 'tester', capabilities: ['code'] }])
  await call('task_dispatch', { agent: 'qa-mydesk', title: '冒烟测试', instruction: 'Smoke it.' })
  await call('task_dispatch', { agent: 'qa-mydesk', type: 'review', title: 'Review the patch', instruction: 'Review.' })
  const refused = await rejectsWith(() => call('task_dispatch', { agent: 'qa-mydesk', type: 'document', title: 'Write the README', instruction: 'Write.' }), 400, 'role-not-testable', 'tool')
  assert.match(refused.message, /tester/)
  assert.equal(posts().length, 2, 'only the two test tasks were dispatched')
})

test('task_dispatch: pool: is checked against its members; an unknown hub is left to the hub', async () => {
  const pool = toolSetup([
    { agent_id: 'disp-pool', role: 'dispatcher', capabilities: ['code'] },
    { agent_id: 'watch-pool', role: 'observer', capabilities: ['code'] },
  ])
  await rejectsWith(() => pool.call('task_dispatch', { agent: 'pool:code', title: 'Fix', instruction: 'Fix it.' }), 400, 'role-not-dispatchable', 'tool')
  assert.deepEqual(pool.posts(), [])
  const mixed = toolSetup([
    { agent_id: 'disp-pool', role: 'dispatcher', capabilities: ['research'] },
    { agent_id: 'quick-pool', role: 'worker', capabilities: ['research'] },
  ])
  await mixed.call('task_dispatch', { agent: 'pool:research', title: 'Fix', instruction: 'Fix it.' })
  assert.equal(mixed.posts().length, 1, 'one worker member is enough')
  // An older hub that sends no agents list (or no roles) is not second-guessed:
  // the hub itself owns the authoritative check.
  const legacy = makeClient(() => ({ body: { task_id: 't1', status: 'pending' } }))
  legacy.client.listAgents = async () => { throw new ToolHubError(502, 'hub-bad-response', 'hub response has no agents list') }
  const tool = new Map(createTools({ client: legacy.client }).map(entry => [entry.name, entry])).get('task_dispatch')
  const out = await tool.execute({ agent: 'disp-mydesk', title: 'Fix', instruction: 'Fix it.' }, {})
  assert.equal(out.status, 'pending', 'the dispatch still reaches the hub')
})

test('task_dispatch: agents without a role are workers, so nothing changes for them', async () => {
  const { call, posts } = toolSetup([{ agent_id: 'quick-mydesk', capabilities: ['code'] }])
  const out = await call('task_dispatch', { agent: 'quick-mydesk', type: 'code', title: 'Fix', instruction: 'Fix it.', workspace: 'deepseek-harness' })
  assert.equal(out.status, 'pending')
  assert.equal(posts().length, 1)
})

// --- 6. output surfaces: agent_list / overview / bridge whitelist ----------

test('bridge whitelist: role passes through, defaults to worker and drops junk', () => {
  assert.equal(adminAgent({ agent_id: 'a', role: 'observer' }).role, 'observer')
  assert.equal(adminAgent({ agent_id: 'a' }).role, 'worker')
  assert.equal(adminAgent({ agent_id: 'a', role: 'boss' }).role, 'worker', 'an unknown stored value is not passed on')
  assert.equal(adminAgent({ agent_id: 'a', role: 42 }).role, 'worker')
  assert.equal(adminRequest({ request_id: 'r', role: 'tester' }).role, 'tester')
  assert.equal(adminRequest({ request_id: 'r' }).role, 'worker')
  assert.equal(adminRequest({ request_id: 'r', role: 'nope' }).role, 'worker')
})

test('overview, agent list and enrollment requests report the role of every agent', async (t) => {
  const { hub } = await makeHub(t)
  await enroll(hub, 'quick-mydesk', { role: 'worker' })
  await enroll(hub, 'qa-mydesk', { role: 'tester' })
  await enroll(hub, 'watch-mydesk', { role: 'observer' })
  const overview = await hub.overview()
  assert.deepEqual(overview.agents.map(a => [a.agent_id, a.role]), [['quick-mydesk', 'worker'], ['qa-mydesk', 'tester'], ['watch-mydesk', 'observer']])
  assert.deepEqual((await hub.listAgents()).map(a => a.role).sort(), ['observer', 'tester', 'worker'])
  assert.deepEqual((await hub.listRequests({ status: 'all' })).map(r => [r.agent_id, r.role]), [['watch-mydesk', 'observer'], ['qa-mydesk', 'tester'], ['quick-mydesk', 'worker']])
  // Only additive: every field the old contract promised is still there.
  for (const agent of overview.agents) {
    for (const key of ['agent_id', 'platform', 'mode', 'capabilities', 'max_concurrency', 'description', 'revoked', 'online', 'last_seen', 'reported_status', 'running_tasks', 'created_at', 'role']) {
      assert.ok(key in agent, key)
    }
  }
})
