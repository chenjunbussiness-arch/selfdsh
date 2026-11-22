/**
 * Registration and presence (docs/DSH-HUB-PROTOCOL-v2.md section 9):
 * pending / online / offline / left / revoked, heartbeat reconciliation
 * (running -> abort, worker-lost), leave, the offline sweep, dispatch warnings
 * and require_online, GET /v1/me, POST /v1/leave, client_ip on health and on
 * the allow-list 403.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHandler } from '../lib/http.js'
import { DEFAULT_OFFLINE_AFTER_MS, RECONCILE_GRACE_MS } from '../lib/hub.js'
import { CTL, T0, callHttp, dispatchTask, expectHubError, iso, jsonHeaders, makeHub, provision } from './helpers.mjs'

const WS = 'deepseek-harness'
const ids = result => result.tasks.map(t => t.task_id)
const statusOf = async (hub, id) => (await hub.listAgents()).find(a => a.agent_id === id).status

/** Provisioned worker that has been seen once (heartbeat). */
async function online(hub, id, extra = {}) {
  const out = await provision(hub, id, { node: 'mydesk', workspaces: [WS], ...extra })
  await hub.heartbeat(id, { status: 'idle', workspaces: [WS] })
  return out
}

test('defaults: offline after 90 s, reconcile grace 30 s', () => {
  assert.equal(DEFAULT_OFFLINE_AFTER_MS, 90_000)
  assert.equal(RECONCILE_GRACE_MS, 30_000)
})

test('status lifecycle: pending -> offline -> online -> offline -> left -> online -> revoked', async (t) => {
  const { hub, clock } = await makeHub(t)
  const req = await hub.requestEnrollment({ agent_id: 'quick-mydesk', node: 'mydesk', workspaces: [WS] })
  await hub.approveRequest(CTL, req.request_id)
  assert.equal(await statusOf(hub, 'quick-mydesk'), 'pending', 'approved, token not collected yet')
  const { token } = await hub.enrollmentStatus({ request_id: req.request_id, poll_secret: req.poll_secret })
  assert.match(token, /^dsha_quick-mydesk_/)
  assert.equal(await statusOf(hub, 'quick-mydesk'), 'offline', 'has a token, never seen')
  const hb = await hub.heartbeat('quick-mydesk', { status: 'idle', client_version: 'agent_client/2.1.0' })
  assert.equal(hb.status, 'online')
  let [agent] = await hub.listAgents()
  assert.deepEqual([agent.status, agent.online, agent.last_seen, agent.version], ['online', true, iso(T0), 'agent_client/2.1.0'])
  clock.advance(90_000)
  assert.equal(await statusOf(hub, 'quick-mydesk'), 'online', 'exactly 90 s is still online')
  clock.advance(1)
  assert.equal(await statusOf(hub, 'quick-mydesk'), 'offline')
  await hub.poll('quick-mydesk')
  assert.equal(await statusOf(hub, 'quick-mydesk'), 'online', 'a poll counts as seen')
  const left = await hub.leave('quick-mydesk')
  assert.deepEqual([left.status, left.requeued], ['left', []])
  ;[agent] = await hub.listAgents()
  assert.deepEqual([agent.status, agent.online, agent.left_at], ['left', false, iso(T0 + 90_001)])
  await hub.heartbeat('quick-mydesk', {})
  assert.equal(await statusOf(hub, 'quick-mydesk'), 'online', 'coming back after leave')
  await hub.revokeAgent(CTL, 'quick-mydesk')
  assert.equal(await statusOf(hub, 'quick-mydesk'), 'revoked')
  const overview = await hub.overview()
  assert.deepEqual(overview.agent_counts, { pending: 0, online: 0, offline: 0, left: 0, revoked: 1 })
})

test('client_version is kept only when it looks like a version string', async (t) => {
  const { hub } = await makeHub(t)
  await online(hub, 'worker')
  await hub.heartbeat('worker', { client_version: 'agent_client/2.1.0 (py3.12)' })
  await hub.heartbeat('worker', { client_version: '<script>' })
  await hub.heartbeat('worker', { client_version: 'x'.repeat(65) })
  assert.equal((await hub.listAgents())[0].version, 'agent_client/2.1.0 (py3.12)')
})

test('heartbeat running: tasks the hub no longer gives the worker come back as abort', async (t) => {
  const { hub } = await makeHub(t)
  await online(hub, 'worker', { max_concurrency: 4 })
  await online(hub, 'other')
  for (const id of ['keep', 'gone', 'theirs']) await dispatchTask(hub, { task_id: id, agent: id === 'theirs' ? 'other' : 'worker' })
  await hub.poll('worker', { max: 4 })
  await hub.poll('other')
  await hub.cancel(CTL, 'gone')
  const out = await hub.heartbeat('worker', { running: ['keep', 'gone', 'theirs', 'never-existed'] })
  assert.deepEqual(out.abort, ['gone', 'theirs', 'never-existed'])
  assert.deepEqual(out.requeued, [])
  assert.equal((await hub.getTask('keep')).status, 'accepted', 'listed and held: untouched')
  assert.equal((await hub.getTask('theirs')).assigned_to, 'other', 'abort never touches another worker\'s task')
  await expectHubError(() => hub.heartbeat('worker', { running: ['../x'] }), 400, 'bad-running')
  await expectHubError(() => hub.heartbeat('worker', { running: 'keep' }), 400, 'bad-running')
})

test('heartbeat running: a held task the worker did not list is requeued (worker-lost) after the grace', async (t) => {
  const { hub, clock } = await makeHub(t)
  await online(hub, 'worker', { max_concurrency: 2 })
  await dispatchTask(hub, { task_id: 't1' })
  await hub.poll('worker')
  clock.advance(RECONCILE_GRACE_MS - 1)
  assert.deepEqual((await hub.heartbeat('worker', { running: [] })).requeued, [], 'a fresh lease may still be on its way')
  assert.equal((await hub.getTask('t1')).status, 'accepted')
  assert.deepEqual((await hub.heartbeat('worker', {})).requeued, [], 'no running list: no reconciliation')
  clock.advance(1)
  const out = await hub.heartbeat('worker', { running: [] })
  assert.deepEqual(out.requeued, ['t1'])
  const task = await hub.getTask('t1')
  assert.equal(task.status, 'pending')
  assert.equal(task.attempts, 1, 'the lost attempt counts')
  assert.match(task.history.at(-1).message, /^worker-lost: worker/)
  assert.equal((await hub.poll('worker')).tasks[0].attempt, 2)
})

test('leave: tasks go back to the queue at once (attempt counted), other workers are woken', async (t) => {
  const { hub } = await makeHub(t)
  await online(hub, 'worker', { capabilities: ['code'] })
  await online(hub, 'spare', { capabilities: ['code'] })
  await dispatchTask(hub, { task_id: 'p1', agent: 'pool:code' })
  assert.deepEqual(ids(await hub.poll('worker')), ['p1'])
  const waiting = hub.poll('spare', { wait: 5 })
  const out = await hub.leave('worker', { reason: 'shutting down' })
  assert.deepEqual(out.requeued, ['p1'])
  assert.deepEqual(ids(await waiting), ['p1'], 'requeue wakes a waiting worker')
  const task = await hub.getTask('p1')
  assert.equal(task.attempts, 2)
  assert.ok(task.history.some(h => h.event === 'requeued' && h.message === 'shutting down (worker)'))
})

test('sweep: a holder that went offline loses its tasks before the lease runs out; events keep it online', async (t) => {
  const { hub, clock } = await makeHub(t)
  await online(hub, 'busy', { max_concurrency: 2 })
  await online(hub, 'silent', { max_concurrency: 2 })
  await dispatchTask(hub, { task_id: 'b1', agent: 'busy', lease_seconds: 3600 })
  await dispatchTask(hub, { task_id: 's1', agent: 'silent', lease_seconds: 3600 })
  await hub.poll('busy')
  await hub.poll('silent')
  clock.advance(60_000)
  await hub.progress('busy', { task_id: 'b1', progress: 0.5 })
  clock.advance(40_000) // silent: 100 s without a sign of life; busy: 40 s
  assert.equal(await hub.sweep(), 1)
  assert.equal((await hub.getTask('b1')).status, 'running')
  const s1 = await hub.getTask('s1')
  assert.equal(s1.status, 'pending')
  assert.match(s1.history.at(-1).message, /^worker-offline: silent not seen for 100 s/)
  assert.equal(await hub.sweep(), 0)
})

test('dispatch to a named worker: 404 unknown, 409 not approved / revoked, offline -> warning or 409 with require_online', async (t) => {
  const { hub, clock } = await makeHub(t)
  await expectHubError(() => dispatchTask(hub, { agent: 'ghost' }), 404, 'agent-not-found')
  await hub.requestEnrollment({ agent_id: 'asking' })
  await expectHubError(() => dispatchTask(hub, { agent: 'asking' }), 409, 'agent-not-approved')
  await provision(hub, 'gone')
  await hub.revokeAgent(CTL, 'gone')
  await expectHubError(() => dispatchTask(hub, { agent: 'gone' }), 409, 'agent-revoked')
  await online(hub, 'worker')
  const fine = await dispatchTask(hub, { task_id: 'a', agent: 'worker', require_online: true })
  assert.equal(fine.warnings, undefined)
  clock.advance(90_001)
  const queued = await dispatchTask(hub, { task_id: 'b', agent: 'worker' })
  assert.deepEqual([queued.status, queued.warnings], ['pending', ['agent-offline']])
  await expectHubError(() => dispatchTask(hub, { task_id: 'c', agent: 'worker', require_online: true }), 409, 'agent-offline')
  assert.equal((await hub.listTasks()).some(x => x.task_id === 'c'), false, 'refused: nothing queued')
  await expectHubError(() => dispatchTask(hub, { agent: 'worker', require_online: 'yes' }), 400, 'bad-task')
})

test('dispatch to a pool: no-online-worker warning unless an online worker can take it (workspace / node too)', async (t) => {
  const { hub, clock } = await makeHub(t)
  const warned = await dispatchTask(hub, { task_id: 'p0', agent: 'pool:code' })
  assert.deepEqual(warned.warnings, ['no-online-worker'])
  await online(hub, 'coder', { capabilities: ['code'] })
  assert.equal((await dispatchTask(hub, { task_id: 'p1', agent: 'pool:code', type: 'code', workspace: WS })).warnings, undefined)
  assert.deepEqual((await dispatchTask(hub, { task_id: 'p2', agent: 'pool:code', node: 'cloud' })).warnings, ['no-online-worker'])
  assert.deepEqual((await dispatchTask(hub, { task_id: 'p3', agent: 'pool:code', type: 'code', workspace: 'other' })).warnings, ['no-online-worker'])
  await expectHubError(() => dispatchTask(hub, { task_id: 'p4', agent: 'pool:code', node: 'cloud', require_online: true }), 409, 'no-online-worker')
  clock.advance(90_001)
  assert.deepEqual((await dispatchTask(hub, { task_id: 'p5', agent: 'pool:code' })).warnings, ['no-online-worker'], 'offline workers do not count')
})

test('me(): the worker\'s own view, including ignored workspaces and held tasks', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker', { node: 'mydesk', workspaces: [WS], capabilities: ['code'] })
  await hub.heartbeat('worker', { workspaces: [WS, 'not-granted'], client_version: 'agent_client/2.1.0' })
  await dispatchTask(hub, { task_id: 't1' })
  await hub.poll('worker')
  const me = await hub.me('worker')
  assert.equal(me.agent_id, 'worker')
  assert.equal(me.status, 'online')
  assert.deepEqual(me.workspaces, [WS])
  assert.deepEqual(me.reported_workspaces, [WS])
  assert.deepEqual(me.ignored_workspaces, ['not-granted'])
  assert.deepEqual(me.capabilities, ['code'])
  assert.deepEqual(me.running_tasks, ['t1'])
  assert.equal(me.version, 'agent_client/2.1.0')
  assert.equal(me.offline_after_ms, 90_000)
  assert.ok(!JSON.stringify(me).includes('tokenHash'))
})

// --- HTTP --------------------------------------------------------------------------

async function setup(t, options = {}) {
  const base = await makeHub(t)
  const handler = createHandler({ hub: base.hub, logger: base.logger, ...options })
  const { token } = await provision(base.hub, 'worker', { node: 'mydesk', workspaces: [WS] })
  return { ...base, token, call: init => callHttp(handler, init) }
}

test('GET /v1/me (worker token) returns status and the client_ip the hub saw; controllers get 403', async (t) => {
  const { call, token, ctlToken } = await setup(t)
  let res = await call({ method: 'POST', url: '/v1/heartbeat?id=worker', headers: jsonHeaders({ 'X-DSH-Token': token }), body: { running: [] }, remoteAddress: '::ffff:203.0.113.9' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().abort, [])
  res = await call({ url: '/v1/me?id=worker', headers: { 'X-DSH-Token': token }, remoteAddress: '::ffff:203.0.113.9' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual([res.json().status, res.json().client_ip], ['online', '203.0.113.9'])
  res = await call({ url: `/v1/me?id=${CTL}`, headers: { 'X-DSH-Token': ctlToken } })
  assert.equal(res.statusCode, 403)
  res = await call({ url: '/v1/me?id=worker' })
  assert.equal(res.statusCode, 401)
})

test('POST /v1/leave marks the worker left and requeues its tasks', async (t) => {
  const { call, token, hub } = await setup(t)
  await dispatchTask(hub, { task_id: 't1' })
  await hub.poll('worker')
  const res = await call({ method: 'POST', url: '/v1/leave?id=worker', headers: jsonHeaders({ 'X-DSH-Token': token }), body: {} })
  assert.equal(res.statusCode, 200)
  assert.deepEqual([res.json().status, res.json().requeued], ['left', ['t1']])
  assert.equal((await hub.listAgents())[0].status, 'left')
  assert.equal((await hub.getTask('t1')).status, 'pending')
})

test('health client_ip follows the trustProxy rule; a 403 from the allow list returns only the caller\'s own address', async (t) => {
  const plain = await setup(t)
  let res = await plain.call({ url: '/v1/health', remoteAddress: '198.51.100.7', headers: { 'X-Forwarded-For': '6.6.6.6' } })
  assert.equal(res.json().client_ip, '198.51.100.7', 'X-Forwarded-For ignored without trustProxy')
  const proxied = await setup(t, { trustProxy: true, allow: ['203.0.113.0/24'] })
  res = await proxied.call({ url: '/v1/health', remoteAddress: '127.0.0.1', headers: { 'X-Forwarded-For': '6.6.6.6, 203.0.113.5' } })
  assert.deepEqual([res.statusCode, res.json().client_ip], [200, '203.0.113.5'])
  res = await proxied.call({ url: '/v1/health', remoteAddress: '127.0.0.1', headers: { 'X-Forwarded-For': '198.51.100.20' } })
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.json(), { error: { code: 'ip-not-allowed', message: 'client address is not allowed', client_ip: '198.51.100.20' } })
  res = await proxied.call({ url: '/v1/me?id=worker', remoteAddress: '127.0.0.1', headers: { 'X-Forwarded-For': '198.51.100.20' } })
  assert.deepEqual(res.json().error.client_ip, '198.51.100.20', 'every route, not only health')
  const other = await proxied.call({ url: '/v1/ctl/agents?id=dsh-cloud', headers: { 'X-DSH-Token': 'x' }, remoteAddress: '127.0.0.1' })
  assert.equal(other.statusCode, 403)
  assert.equal(other.json().error.client_ip, '127.0.0.1')
  assert.ok(!JSON.stringify(other.json()).includes('203.0.113'), 'the allow list itself is never revealed')
})
