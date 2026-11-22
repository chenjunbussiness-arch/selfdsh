/**
 * What is new in dsh-agent/2.0 at the hub layer: the controller registry,
 * worker node / workspaces, routing by workspace and node, heartbeat
 * reporting (truncated to the grant), creator isolation, long polling.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { AgentHub, PROTOCOL } from '../lib/hub.js'
import { CTL, CTL2, T0, b64, dispatchTask, expectHubError, fakeSignal, iso, makeHub, provision, sleep, tempDir } from './helpers.mjs'

const sha256hex = text => createHash('sha256').update(text, 'utf8').digest('hex')
const ids = result => result.tasks.map(t => t.task_id)
const WS = 'deepseek-harness'

/** A worker that was granted and reports `workspaces`, on `node`. */
async function worker(hub, id, { node = 'mydesk', workspaces = [WS], report = workspaces, ...extra } = {}) {
  const out = await provision(hub, id, { node, workspaces, ...extra })
  if (report !== undefined) await hub.heartbeat(id, { status: 'idle', workspaces: report })
  return out
}

// --- controllers ----------------------------------------------------------------

test('controller add: dshc_ token returned once, only sha256 in controllers.json, never in state.json', async (t) => {
  const { hub, dataDir, ctlToken } = await makeHub(t)
  assert.match(ctlToken, /^dshc_dsh-cloud_[A-Za-z0-9_-]{32}$/)
  assert.equal(await hub.authenticateController(ctlToken), CTL)
  assert.deepEqual(await hub.authenticateToken(ctlToken), { role: 'controller', id: CTL })
  const text = await readFile(join(dataDir, 'controllers.json'), 'utf8')
  assert.ok(!text.includes(ctlToken))
  assert.ok(text.includes(sha256hex(ctlToken)))
  await provision(hub, 'worker')
  assert.ok(!(await readFile(join(dataDir, 'state.json'), 'utf8')).includes('dshc_'), 'controllers are not in state.json')
  const list = await hub.listControllers()
  assert.deepEqual(list.map(c => [c.controller_id, c.revoked]), [[CTL, false], [CTL2, false]])
  assert.ok(list.every(c => !('tokenHash' in c) && !('token' in c)))
})

test('controller ids are validated; duplicates refused; revoke then re-issue', async (t) => {
  const { hub, ctlToken } = await makeHub(t)
  for (const bad of [undefined, '', 'X', 'a', 'a_b', '__proto__', 'constructor!', 5]) await expectHubError(() => hub.addController(bad), 400, 'bad-controller-id')
  await expectHubError(() => hub.addController(CTL), 409, 'controller-exists')
  const revoked = await hub.revokeController(CTL)
  assert.equal(revoked.revoked, true)
  assert.equal(revoked.revoked_at, iso(T0))
  await expectHubError(() => hub.authenticateController(ctlToken), 401, 'unauthorized')
  await expectHubError(() => hub.revokeController('ghost'), 404, 'controller-not-found')
  const again = await hub.addController(CTL)
  assert.notEqual(again.token, ctlToken)
  assert.equal(await hub.authenticateController(again.token), CTL)
  await expectHubError(() => hub.authenticateController(ctlToken), 401, 'unauthorized')
})

test('authenticateToken tells roles apart and rejects everything else', async (t) => {
  const { hub, ctlToken } = await makeHub(t)
  const { token } = await provision(hub, 'worker')
  assert.deepEqual(await hub.authenticateToken(token), { role: 'worker', id: 'worker' })
  assert.deepEqual(await hub.authenticateToken(ctlToken), { role: 'controller', id: CTL })
  const forged = [undefined, '', 'Bearer x', `dshc_worker_${token.slice(12)}`, `dsha_${CTL}_${ctlToken.slice(15)}`, ctlToken.replace('dshc_dsh-cloud_', 'dshc_dsh-local_'), 'dshx_a_b']
  for (const value of forged) await expectHubError(() => hub.authenticateToken(value), 401, 'unauthorized')
})

test('CLI changes to controllers.json (another process) apply to a running hub at once', async (t) => {
  const { hub, dataDir, ctl2Token } = await makeHub(t)
  const cli = new AgentHub({ dataDir }) // what `node server.mjs controller ...` does
  const { token } = await cli.addController('dsh-third')
  assert.equal(await hub.authenticateController(token), 'dsh-third')
  await cli.revokeController(CTL2)
  await expectHubError(() => hub.authenticateController(ctl2Token), 401, 'unauthorized')
  await expectHubError(() => hub.dispatch(CTL2, { title: 't', instruction: 'i', agent: 'pool:x' }), 401, 'unauthorized')
})

test('every controller mutation re-checks revocation inside the mutation', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker')
  await dispatchTask(hub, { task_id: 't1' })
  const req = await hub.requestEnrollment({ agent_id: 'quick' })
  await hub.revokeController(CTL) // revoked after its request was authenticated
  await expectHubError(() => dispatchTask(hub, { task_id: 't2' }), 401, 'unauthorized')
  await expectHubError(() => hub.cancel(CTL, 't1'), 401, 'unauthorized')
  await expectHubError(() => hub.retry(CTL, 't1'), 401, 'unauthorized')
  await expectHubError(() => hub.approveRequest(CTL, req.request_id), 401, 'unauthorized')
  await expectHubError(() => hub.rejectRequest(CTL, req.request_id), 401, 'unauthorized')
  await expectHubError(() => hub.revokeAgent(CTL, 'worker'), 401, 'unauthorized')
  await expectHubError(() => provision(hub, 'other'), 401, 'unauthorized')
  assert.deepEqual((await hub.listTasks()).map(x => x.task_id), ['t1'], 'nothing changed')
  assert.equal((await hub.listRequests())[0].status, 'pending')
  await expectHubError(() => hub.dispatch('nobody', { title: 't', instruction: 'i', agent: 'pool:x' }), 401, 'unauthorized')
})

// --- workers: node / workspaces --------------------------------------------------------

test('provisioned worker: node and granted workspaces; nothing reported until the first heartbeat', async (t) => {
  const { hub } = await makeHub(t)
  const { agent } = await provision(hub, 'quick-mydesk', { node: 'mydesk', workspaces: [WS, 'rca-ab-test', WS] })
  assert.equal(agent.node, 'mydesk')
  assert.deepEqual(agent.workspaces, [WS, 'rca-ab-test'])
  assert.deepEqual(agent.reported_workspaces, [])
})

test('approved worker: what it reported at enrollment, cut to the grant, counts as reported', async (t) => {
  const { hub } = await makeHub(t)
  const req = await hub.requestEnrollment({ agent_id: 'kiro-mydesk', node: 'mydesk', workspaces: [WS, 'rca-ab-test'], capabilities: ['code'] })
  const { agent } = await hub.approveRequest(CTL, req.request_id, { workspaces: [WS] })
  assert.deepEqual(agent.workspaces, [WS])
  assert.deepEqual(agent.reported_workspaces, [WS])
})

test('approval can only narrow capabilities, workspaces and concurrency', async (t) => {
  const { hub } = await makeHub(t)
  const req = await hub.requestEnrollment({ agent_id: 'quick', capabilities: ['research'], workspaces: [WS], max_concurrency: 2 })
  await expectHubError(() => hub.approveRequest(CTL, req.request_id, { capabilities: ['research', 'code'] }), 400, 'grant-widened')
  await expectHubError(() => hub.approveRequest(CTL, req.request_id, { workspaces: [WS, 'other'] }), 400, 'grant-widened')
  await expectHubError(() => hub.approveRequest(CTL, req.request_id, { max_concurrency: 3 }), 400, 'grant-widened')
  await expectHubError(() => hub.approveRequest(CTL, req.request_id, { workspaces: ['bad/name'] }), 400, 'bad-workspaces')
  assert.equal((await hub.listRequests())[0].status, 'pending', 'refused approvals leave it pending')
  const ok = await hub.approveRequest(CTL2, req.request_id, { capabilities: [], workspaces: [], max_concurrency: 1 })
  assert.deepEqual(ok.agent.capabilities, [])
  assert.deepEqual(ok.agent.workspaces, [])
  assert.equal((await hub.listRequests({ status: 'approved' }))[0].decided_by, CTL2, 'any controller may approve')
})

test('heartbeat workspaces beyond the grant are dropped (truncated), not an error', async (t) => {
  const { hub, logger } = await makeHub(t)
  await provision(hub, 'quick', { workspaces: [WS, 'rca-ab-test'] })
  const out = await hub.heartbeat('quick', { status: 'idle', workspaces: ['secret-repo', WS, WS] })
  assert.deepEqual(out.workspaces, [WS])
  assert.deepEqual(out.ignored_workspaces, ['secret-repo'])
  assert.deepEqual((await hub.listAgents())[0].reported_workspaces, [WS])
  assert.ok(logger.lines.some(l => l.startsWith('warn ') && l.includes('secret-repo')))
  // omitted: unchanged; empty list: nothing reported any more
  assert.deepEqual((await hub.heartbeat('quick', { status: 'busy' })).workspaces, [WS])
  assert.deepEqual((await hub.heartbeat('quick', { workspaces: [] })).workspaces, [])
  for (const bad of ['x', [5], ['../etc'], Array.from({ length: 65 }, (_, i) => `w${i}`)]) {
    await expectHubError(() => hub.heartbeat('quick', { workspaces: bad }), 400, 'bad-workspaces')
  }
})

// --- routing (contract section 4) ------------------------------------------------------

test('routing condition 2: the workspace must be granted AND currently reported', async (t) => {
  const { hub } = await makeHub(t)
  await worker(hub, 'granted-reported', { workspaces: [WS], capabilities: ['code'] })
  await worker(hub, 'granted-silent', { workspaces: [WS], report: [], capabilities: ['code'] })
  await worker(hub, 'reports-ungranted', { workspaces: ['other'], report: [WS, 'other'], capabilities: ['code'] })
  await dispatchTask(hub, { task_id: 'c1', agent: 'pool:code', type: 'code', workspace: WS })
  assert.deepEqual(ids(await hub.poll('granted-silent')), [])
  assert.deepEqual(ids(await hub.poll('reports-ungranted')), [])
  assert.deepEqual(ids(await hub.poll('granted-reported')), ['c1'])
  // a task without workspace goes to any worker of the pool
  await dispatchTask(hub, { task_id: 'any', agent: 'pool:code' })
  assert.deepEqual(ids(await hub.poll('reports-ungranted')), ['any'])
})

test('a worker that stops reporting a workspace stops getting its tasks', async (t) => {
  const { hub } = await makeHub(t)
  await worker(hub, 'worker', { workspaces: [WS], max_concurrency: 4 })
  await hub.heartbeat('worker', { workspaces: [] })
  await dispatchTask(hub, { task_id: 'c1', type: 'code', workspace: WS })
  assert.deepEqual(ids(await hub.poll('worker')), [])
  await hub.heartbeat('worker', { workspaces: [WS] })
  assert.deepEqual(ids(await hub.poll('worker')), ['c1'])
})

test('routing condition 3: node must match; workers without a node never get node-bound tasks', async (t) => {
  const { hub } = await makeHub(t)
  await worker(hub, 'claude-cloud', { node: 'cloud', capabilities: ['code'] })
  await worker(hub, 'claude-mydesk', { node: 'mydesk', capabilities: ['code'] })
  await provision(hub, 'nodeless', { capabilities: ['code'] })
  await dispatchTask(hub, { task_id: 'on-cloud', agent: 'pool:code', node: 'cloud' })
  await dispatchTask(hub, { task_id: 'anywhere', agent: 'pool:code' })
  assert.deepEqual(ids(await hub.poll('claude-mydesk')), ['anywhere'])
  assert.deepEqual(ids(await hub.poll('nodeless')), [])
  assert.deepEqual(ids(await hub.poll('claude-cloud')), ['on-cloud'])
})

test('all four conditions together, and the leased task carries workspace / node / ref', async (t) => {
  const { hub } = await makeHub(t)
  await worker(hub, 'kiro-mydesk', { node: 'mydesk', capabilities: ['code'], max_concurrency: 1 })
  await dispatchTask(hub, { task_id: 'up', agent: 'kiro-mydesk', type: 'code', workspace: WS })
  await dispatchTask(hub, { task_id: 'down', agent: 'pool:code', type: 'code', workspace: WS, node: 'mydesk', ref: 'feature/hub-v2', depends_on: ['up'] })
  assert.deepEqual(ids(await hub.poll('kiro-mydesk', { max: 5 })), ['up'], 'down waits for up')
  assert.deepEqual(ids(await hub.poll('kiro-mydesk', { max: 5 })), [], 'max_concurrency 1 is full')
  await hub.submitResult('kiro-mydesk', { task_id: 'up', status: 'completed', files: [{ name: 'changes.patch', base64: b64('diff') }] })
  const { tasks: [down] } = await hub.poll('kiro-mydesk', { max: 5 })
  assert.equal(down.task_id, 'down')
  assert.equal(down.workspace, WS)
  assert.equal(down.node, 'mydesk')
  assert.equal(down.ref, 'feature/hub-v2')
  assert.equal(down.created_by, CTL)
  assert.equal(down.protocol, PROTOCOL)
  assert.deepEqual(down.inputs, [{ from_task: 'up', name: 'changes.patch' }])
})

test('dispatch to a named worker that cannot take the workspace / node fails fast with 409', async (t) => {
  const { hub } = await makeHub(t)
  await worker(hub, 'quick', { node: 'mydesk', workspaces: [WS] })
  await expectHubError(() => dispatchTask(hub, { agent: 'quick', type: 'code', workspace: 'other' }), 409, 'unroutable')
  await expectHubError(() => dispatchTask(hub, { agent: 'quick', node: 'cloud' }), 409, 'unroutable')
  assert.equal((await dispatchTask(hub, { agent: 'quick', type: 'code', workspace: WS, node: 'mydesk' })).status, 'pending')
  assert.equal((await dispatchTask(hub, { agent: 'pool:code', type: 'code', workspace: 'other' })).status, 'pending', 'pools are not checked')
  assert.deepEqual(await hub.listTasks({ workspace: 'other' }).then(l => l.map(x => x.agent)), ['pool:code'])
})

test('listTasks filters by workspace; tasks show workspace / node / ref / created_by', async (t) => {
  const { hub, clock } = await makeHub(t)
  await worker(hub, 'worker', { workspaces: [WS, 'rca-ab-test'] })
  await dispatchTask(hub, { task_id: 'a', workspace: WS, ref: 'main' }); clock.advance(1000)
  await dispatchTask(hub, { task_id: 'b', workspace: 'rca-ab-test' }, CTL2); clock.advance(1000)
  await dispatchTask(hub, { task_id: 'c' })
  assert.deepEqual((await hub.listTasks({ workspace: WS })).map(x => x.task_id), ['a'])
  assert.deepEqual((await hub.listTasks({ workspace: 'rca-ab-test' })).map(x => [x.task_id, x.created_by]), [['b', CTL2]])
  const a = await hub.getTask('a')
  assert.equal(a.workspace, WS)
  assert.equal(a.ref, 'main')
  assert.equal(a.node, undefined)
  assert.equal(a.created_by, CTL)
})

// --- creator isolation -----------------------------------------------------------------

test('only the creating controller may cancel or retry; every controller may read', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker')
  await dispatchTask(hub, { task_id: 'mine' }, CTL)
  await expectHubError(() => hub.cancel(CTL2, 'mine'), 403, 'not-creator')
  await hub.poll('worker')
  await hub.submitResult('worker', { task_id: 'mine', status: 'failed', files: [{ name: 'log.txt', base64: b64('boom') }] })
  await expectHubError(() => hub.retry(CTL2, 'mine'), 403, 'not-creator')
  await expectHubError(() => hub.retry(CTL2, 'mine', { agent: 'pool:x' }), 403, 'not-creator')
  assert.equal((await hub.getTask('mine')).status, 'failed', 'refused calls change nothing')
  // reads are open
  assert.equal((await hub.listTasks()).length, 1)
  assert.equal((await hub.readOutput('mine', 'log.txt')).toString('utf8'), 'boom')
  // the creator can
  assert.equal((await hub.retry(CTL, 'mine')).status, 'pending')
  assert.equal((await hub.cancel(CTL, 'mine')).status, 'cancelled')
  // 404 still wins over 403 for unknown ids
  await expectHubError(() => hub.cancel(CTL2, 'ghost'), 404, 'task-not-found')
})

test('a v1 state.json is upgraded in memory; legacy tasks (created_by "dsh") belong to no controller', async (t) => {
  const dataDir = await tempDir(t)
  await writeFile(join(dataDir, 'state.json'), JSON.stringify({
    protocol: 'dsh-agent/1.0', seq: 3,
    agents: { old: { id: 'old', platform: 'custom', mode: 'poll', capabilities: [], maxConcurrency: 1, description: '', tokenHash: '', revoked: false } },
    tasks: { legacy: { task_id: 'legacy', agent: 'old', type: 'custom', title: 'L', instruction: 'i', inputs: [], depends_on: [], status: 'pending', priority: 'normal', attempts: 0, created_by: 'dsh', created_at: iso(T0), history: [] } },
    requests: {},
  }))
  const { hub } = await makeHub(t, { dataDir })
  const [agent] = await hub.listAgents()
  assert.deepEqual([agent.workspaces, agent.reported_workspaces, agent.node], [[], [], undefined])
  assert.equal((await hub.getTask('legacy')).created_by, 'dsh')
  await expectHubError(() => hub.cancel(CTL, 'legacy'), 403, 'not-creator')
  assert.equal((await hub.overview()).protocol, PROTOCOL)
})

// --- long polling ------------------------------------------------------------------------

test('long poll: an empty poll waits and is woken by a dispatch for this worker', async (t) => {
  const { hub } = await makeHub(t)
  await worker(hub, 'quick', { capabilities: ['research'] })
  const started = Date.now()
  const waiting = hub.poll('quick', { wait: 5 })
  await sleep(30)
  assert.equal(hub.waiters.get('quick'), 1)
  await dispatchTask(hub, { task_id: 'r1', agent: 'pool:research', workspace: WS })
  const out = await waiting
  assert.deepEqual(ids(out), ['r1'])
  assert.ok(Date.now() - started < 2000, 'returned right after the dispatch, not after the wait')
  assert.equal(hub.waiters.has('quick'), false)
  assert.equal(hub.events.listenerCount('wake:quick'), 0, 'listeners are cleaned up')
  assert.equal(hub.events.listenerCount('shutdown'), 0)
})

test('long poll: dispatches for other workers do not end the wait; timeout returns empty', async (t) => {
  const { hub } = await makeHub(t)
  await worker(hub, 'quick')
  await worker(hub, 'other', { node: 'cloud' })
  const started = Date.now()
  const waiting = hub.poll('quick', { wait: 0.3 })
  await sleep(20)
  await dispatchTask(hub, { task_id: 'theirs', agent: 'other' })
  await dispatchTask(hub, { task_id: 'wrong-node', agent: 'pool:code', node: 'cloud' })
  assert.deepEqual(await waiting, { tasks: [] })
  assert.ok(Date.now() - started >= 250, 'waited for the timeout')
  assert.equal((await hub.getTask('theirs')).status, 'pending')
  assert.equal(hub.events.listenerCount('wake:quick'), 0)
})

test('long poll is woken by retry, by a lease expiry requeue and by a heartbeat that adds a workspace', async (t) => {
  const { hub, clock } = await makeHub(t)
  await worker(hub, 'wa', { capabilities: ['code'], report: [] })
  await worker(hub, 'wb', { capabilities: ['code'] })
  // retry
  await dispatchTask(hub, { task_id: 't1', agent: 'wa' })
  await hub.cancel(CTL, 't1')
  let waiting = hub.poll('wa', { wait: 5 })
  await sleep(20)
  await hub.retry(CTL, 't1')
  assert.deepEqual(ids(await waiting), ['t1'])
  // lease expiry: wb holds t2, wa waits on the same pool
  await dispatchTask(hub, { task_id: 't2', agent: 'pool:code', lease_seconds: 60 })
  assert.deepEqual(ids(await hub.poll('wb')), ['t2'])
  await hub.submitResult('wa', { task_id: 't1', status: 'completed' })
  waiting = hub.poll('wa', { wait: 5 })
  await sleep(20)
  clock.advance(61_000)
  assert.equal(await hub.sweep(), 1)
  assert.deepEqual(ids(await waiting), ['t2'])
  // heartbeat adds the workspace the pending task needs
  await hub.submitResult('wa', { task_id: 't2', status: 'completed' })
  await dispatchTask(hub, { task_id: 't3', agent: 'wa', type: 'code', workspace: WS })
  waiting = hub.poll('wa', { wait: 5, max: 2 })
  await sleep(20)
  await hub.heartbeat('wa', { workspaces: [WS] })
  assert.deepEqual(ids(await waiting), ['t3'])
})

test('long poll: a completed upstream wakes the worker waiting for the downstream task', async (t) => {
  const { hub } = await makeHub(t)
  await worker(hub, 'up-worker')
  await worker(hub, 'down-worker')
  await dispatchTask(hub, { task_id: 'up', agent: 'up-worker' })
  await dispatchTask(hub, { task_id: 'down', agent: 'down-worker', depends_on: ['up'] })
  await hub.poll('up-worker')
  const waiting = hub.poll('down-worker', { wait: 5 })
  await sleep(20)
  await hub.submitResult('up-worker', { task_id: 'up', status: 'completed' })
  assert.deepEqual(ids(await waiting), ['down'])
})

test('long poll: abort (connection closed) ends the wait without leasing', async (t) => {
  const { hub } = await makeHub(t)
  await worker(hub, 'quick')
  const signal = fakeSignal()
  const waiting = hub.poll('quick', { wait: 5, signal })
  await sleep(20)
  signal.abort()
  assert.deepEqual(await waiting, { tasks: [] })
  assert.equal(signal.listenerCount, 0)
  await dispatchTask(hub, { task_id: 't1', agent: 'quick' })
  const aborted = fakeSignal()
  aborted.abort()
  assert.deepEqual(await hub.poll('quick', { wait: 5, signal: aborted }), { tasks: [] }, 'an already closed connection leases nothing')
  assert.equal((await hub.getTask('t1')).status, 'pending')
})

test('unlease hands tasks back without counting the attempt', async (t) => {
  const { hub } = await makeHub(t)
  await worker(hub, 'quick')
  await worker(hub, 'other')
  await dispatchTask(hub, { task_id: 't1', agent: 'quick' })
  await hub.poll('quick')
  assert.equal(await hub.unlease('other', ['t1']), 0, 'only the holder can give it back')
  assert.equal(await hub.unlease('quick', ['t1', 'ghost', 'constructor']), 1)
  const task = await hub.getTask('t1')
  assert.equal(task.status, 'pending')
  assert.equal(task.attempts, 0)
  assert.equal(task.history.at(-1).event, 'released')
  assert.equal((await hub.poll('quick')).tasks[0].attempt, 1)
})

test('long poll: wait is capped at 55 s, concurrent waits per worker are capped, close() releases waiters', async (t) => {
  const { hub } = await makeHub(t, { maxWaitersPerAgent: 2 })
  await worker(hub, 'quick')
  const a = hub.poll('quick', { wait: 3600 })
  const b = hub.poll('quick', { wait: 30 })
  await sleep(20)
  await expectHubError(() => hub.poll('quick', { wait: 30 }), 429, 'too-many-waiters')
  assert.deepEqual(await hub.poll('quick'), { tasks: [] }, 'a plain poll is not a waiter')
  const started = Date.now()
  await hub.close()
  assert.deepEqual(await Promise.all([a, b]), [{ tasks: [] }, { tasks: [] }])
  assert.ok(Date.now() - started < 1000)
  assert.equal(hub.waiters.size, 0)
  assert.equal(hub.events.listenerCount('shutdown'), 0)
})

test('long poll of a worker revoked while waiting ends with 401', async (t) => {
  const { hub } = await makeHub(t)
  await worker(hub, 'quick')
  const waiting = hub.poll('quick', { wait: 5 })
  await sleep(20)
  await hub.revokeAgent(CTL, 'quick')
  await expectHubError(() => waiting, 401, 'unauthorized')
  assert.equal(hub.waiters.size, 0)
})
