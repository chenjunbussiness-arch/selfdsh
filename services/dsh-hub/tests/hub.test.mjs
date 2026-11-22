/**
 * Hub core tests. Part 1 is the v1 suite (plugins/dsh-agent-hub/packages/
 * host-agent-hub/tests/hub.test.mjs) ported to the v2 signatures: every
 * controller operation now names its controller (CTL) as the first argument.
 * Part 2 (hub-v2.test.mjs) covers what is new in dsh-agent/2.0.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { AgentHub, HubError, PROTOCOL, safeFileName } from '../lib/hub.js'
import { CTL, T0, b64, dispatchTask, expectHubError, iso, makeHub, provision } from './helpers.mjs'

const sha256hex = text => createHash('sha256').update(text, 'utf8').digest('hex')
const ids = result => result.tasks.map(t => t.task_id)

// --- construction ------------------------------------------------------------

test('constructor defaults', () => {
  const hub = new AgentHub({ dataDir: 'unused' })
  assert.equal(hub.offlineAfterMs, 90_000)
  assert.equal(hub.maxRetries, 2)
  assert.equal(hub.maxPendingRequests, 20)
  assert.equal(hub.requestTtlMs, 24 * 3600 * 1000)
  assert.equal(hub.maxWaitSeconds, 55)
  assert.equal(new AgentHub({ dataDir: 'unused', maxWaitSeconds: 600 }).maxWaitSeconds, 55, 'never above 55 s')
  assert.equal(hub.state, undefined, 'nothing is read before first use')
})

test('safeFileName accepts plain names and rejects anything that could escape', () => {
  for (const ok of ['a.md', 'report (1).csv', '数据 表.xlsx', 'A_b-c.d', 'x'.repeat(128)]) assert.equal(safeFileName(ok), ok)
  for (const bad of [undefined, null, 5, '', '.', '..', '.hidden', '../x', 'a/b', 'a\\b', 'a..b', '/abs', 'C:\\x', 'x'.repeat(129), ' lead']) {
    assert.throws(() => safeFileName(bad), e => e instanceof HubError && e.status === 400 && e.code === 'bad-file-name', String(bad))
  }
})

// --- provision / re-key / revoke --------------------------------------------

test('provisionAgent returns a dsha_ token once and stores only its sha256', async (t) => {
  const { hub, dataDir, logger } = await makeHub(t)
  const { token, agent } = await provision(hub, 'worker', { capabilities: ['research', 'research', 'code'], max_concurrency: 2, mode: 'push', description: 'd' })
  assert.match(token, /^dsha_worker_[A-Za-z0-9_-]{32}$/)
  assert.equal(agent.agent_id, 'worker')
  assert.deepEqual(agent.capabilities, ['research', 'code'], 'capabilities are de-duplicated')
  assert.equal(agent.max_concurrency, 2)
  assert.equal(agent.mode, 'push')
  assert.equal(agent.revoked, false)
  assert.equal(agent.online, false)
  assert.deepEqual(agent.running_tasks, [])
  assert.equal(agent.created_at, iso(T0))
  assert.equal(await hub.authenticate(token), 'worker')
  const text = await readFile(join(dataDir, 'state.json'), 'utf8')
  assert.ok(!text.includes(token), 'plaintext token is never written')
  assert.ok(text.includes(sha256hex(token)))
  assert.ok(logger.lines.some(l => l.includes('provisioned worker worker')))
})

test('re-provisioning re-keys: old token stops working, createdAt is kept', async (t) => {
  const { hub, clock, logger } = await makeHub(t)
  const first = await provision(hub, 'worker')
  clock.advance(60_000)
  const second = await provision(hub, 'worker', { capabilities: ['code'] })
  assert.notEqual(first.token, second.token)
  await expectHubError(() => hub.authenticate(first.token), 401, 'unauthorized')
  assert.equal(await hub.authenticate(second.token), 'worker')
  assert.equal(second.agent.created_at, iso(T0))
  assert.equal(hub.state.agents.worker.rekeyedAt, iso(T0 + 60_000))
  assert.deepEqual(second.agent.capabilities, ['code'])
  assert.equal((await hub.listAgents()).length, 1)
  assert.ok(logger.lines.some(l => l.includes('re-keyed worker worker')))
})

test('revokeAgent kills the token and hands running work back to the queue', async (t) => {
  const { hub } = await makeHub(t)
  const { token } = await provision(hub, 'worker')
  await dispatchTask(hub, { task_id: 't1' })
  await hub.poll('worker')
  assert.deepEqual((await hub.listAgents())[0].running_tasks, ['t1'])
  const revoked = await hub.revokeAgent(CTL, 'worker')
  assert.equal(revoked.revoked, true)
  assert.deepEqual(revoked.running_tasks, [])
  assert.equal(revoked.online, false, 'a revoked agent is never online')
  await expectHubError(() => hub.authenticate(token), 401, 'unauthorized')
  const task = await hub.getTask('t1')
  assert.equal(task.status, 'pending')
  assert.equal(task.assigned_to, undefined)
  assert.equal(task.lease_until, undefined)
  assert.equal(task.history.at(-1).event, 'requeued')
  assert.equal(task.history.at(-1).message, 'agent revoked')
  await expectHubError(() => hub.revokeAgent(CTL, 'ghost'), 404, 'agent-not-found')
})

test('agent descriptions are validated', async (t) => {
  const { hub } = await makeHub(t)
  const cases = [
    [undefined, 'bad-agent-id'], [{}, 'bad-agent-id'], [{ agent_id: 'x' }, 'bad-agent-id'], [{ agent_id: 'Worker' }, 'bad-agent-id'],
    [{ agent_id: '1abc' }, 'bad-agent-id'], [{ agent_id: 'a_b' }, 'bad-agent-id'], [{ agent_id: `a${'b'.repeat(48)}` }, 'bad-agent-id'],
    [{ agent_id: 'ok', capabilities: 'research' }, 'bad-capabilities'], [{ agent_id: 'ok', capabilities: ['Research'] }, 'bad-capabilities'],
    [{ agent_id: 'ok', capabilities: [1] }, 'bad-capabilities'], [{ agent_id: 'ok', capabilities: Array.from({ length: 33 }, (_, i) => `c${i}`) }, 'bad-capabilities'],
    [{ agent_id: 'ok', mode: 'pull' }, 'bad-mode'],
    [{ agent_id: 'ok', max_concurrency: 0 }, 'bad-concurrency'], [{ agent_id: 'ok', max_concurrency: 33 }, 'bad-concurrency'],
    [{ agent_id: 'ok', max_concurrency: 1.5 }, 'bad-concurrency'], [{ agent_id: 'ok', max_concurrency: '2' }, 'bad-concurrency'],
    // v2
    [{ agent_id: 'ok', node: 'MyDesk' }, 'bad-node'], [{ agent_id: 'ok', node: 5 }, 'bad-node'], [{ agent_id: 'ok', node: '' }, 'bad-node'],
    [{ agent_id: 'ok', workspaces: 'deepseek-harness' }, 'bad-workspaces'], [{ agent_id: 'ok', workspaces: ['a/b'] }, 'bad-workspaces'],
    [{ agent_id: 'ok', workspaces: ['../x'] }, 'bad-workspaces'], [{ agent_id: 'ok', workspaces: [3] }, 'bad-workspaces'],
    [{ agent_id: 'ok', workspaces: Array.from({ length: 65 }, (_, i) => `w${i}`) }, 'bad-workspaces'],
  ]
  for (const [input, code] of cases) {
    await expectHubError(() => hub.provisionAgent(CTL, input), 400, code)
    await expectHubError(() => hub.requestEnrollment(input), 400, code)
  }
  assert.deepEqual(await hub.listAgents(), [])
  assert.deepEqual(await hub.listRequests({ status: 'all' }), [])
})

// --- authenticate ----------------------------------------------------------------

test('authenticate rejects malformed, wrong, unknown and revoked tokens', async (t) => {
  const { hub } = await makeHub(t)
  const { token } = await provision(hub, 'worker')
  const bad = [
    undefined, null, 42, '', 'Bearer x', token.slice(5), 'dsha_', `dsha_worker_${'A'.repeat(32)}`, `${token}x`,
    token.replace('dsha_worker_', 'dsha_other_'), 'dsha___proto___x', 'dsha_constructor_x', 'dsha_tostring_x',
  ]
  for (const value of bad) await expectHubError(() => hub.authenticate(value), 401, 'unauthorized')
  assert.equal(await hub.authenticate(token), 'worker')
  await hub.revokeAgent(CTL, 'worker')
  await expectHubError(() => hub.authenticate(token), 401, 'unauthorized')
})

test('the revoked flag alone is enough to refuse a token (e.g. hand-edited or older state)', async (t) => {
  const { hub } = await makeHub(t)
  const { token } = await provision(hub, 'worker')
  hub.state.agents.worker.revoked = true // tokenHash left in place
  await expectHubError(() => hub.authenticate(token), 401, 'unauthorized')
})

test('an approved agent has no usable token until it collects one', async (t) => {
  const { hub } = await makeHub(t)
  const req = await hub.requestEnrollment({ agent_id: 'quick', platform: 'aws-quick' })
  await hub.approveRequest(CTL, req.request_id)
  assert.equal(hub.state.agents.quick.tokenHash, '')
  await expectHubError(() => hub.authenticate(`dsha_quick_${'x'.repeat(32)}`), 401, 'unauthorized')
  await expectHubError(() => hub.authenticate('dsha_quick_'), 401, 'unauthorized')
  await expectHubError(() => hub.authenticate('dsha_quick'), 401, 'unauthorized')
})

// --- enrollment ------------------------------------------------------------------

test('enrollment: request, approve with a narrowed grant, token minted exactly once', async (t) => {
  const { hub, clock, dataDir } = await makeHub(t)
  const req = await hub.requestEnrollment({
    agent_id: 'quick', platform: 'aws-quick', capabilities: ['research', 'document', 'code'], max_concurrency: 4, description: 'Quick', from: '10.0.0.7',
    node: 'mydesk', workspaces: ['deepseek-harness', 'rca-ab-test'],
  })
  assert.equal(req.status, 'pending')
  assert.match(req.request_id, /^req_[A-Za-z0-9_-]{12}$/)
  assert.equal(typeof req.poll_secret, 'string')
  assert.deepEqual(await hub.listAgents(), [], 'asking grants nothing')

  const [listed] = await hub.listRequests()
  assert.equal(listed.request_id, req.request_id)
  assert.equal(listed.agent_id, 'quick')
  assert.equal(listed.platform, 'aws-quick')
  assert.equal(listed.from, '10.0.0.7')
  assert.equal(listed.node, 'mydesk')
  assert.deepEqual(listed.workspaces, ['deepseek-harness', 'rca-ab-test'])
  assert.deepEqual(listed.capabilities, ['research', 'document', 'code'])
  assert.equal(listed.max_concurrency, 4)
  assert.equal(listed.requested_at, iso(T0))
  assert.ok(!('secretHash' in listed) && !('poll_secret' in listed))

  const secret = { request_id: req.request_id, poll_secret: req.poll_secret }
  assert.deepEqual(await hub.enrollmentStatus(secret), { request_id: req.request_id, status: 'pending', reason: undefined })

  clock.advance(1000)
  const approved = await hub.approveRequest(CTL, req.request_id, { capabilities: ['research'], max_concurrency: 1, workspaces: ['deepseek-harness'] })
  assert.equal(approved.status, 'approved')
  assert.deepEqual(approved.agent.capabilities, ['research'])
  assert.equal(approved.agent.max_concurrency, 1)
  assert.equal(approved.agent.platform, 'aws-quick')
  assert.equal(approved.agent.node, 'mydesk')
  assert.deepEqual(approved.agent.workspaces, ['deepseek-harness'])
  const [decided] = await hub.listRequests({ status: 'approved' })
  assert.equal(decided.decided_at, iso(T0 + 1000))
  assert.equal(decided.decided_by, CTL)
  assert.deepEqual(decided.capabilities, ['research'])
  assert.deepEqual(await hub.listRequests(), [], 'no longer pending')

  const first = await hub.enrollmentStatus(secret)
  assert.equal(first.status, 'approved')
  assert.equal(first.agent_id, 'quick')
  assert.match(first.token, /^dsha_quick_[A-Za-z0-9_-]{32}$/)
  assert.equal(await hub.authenticate(first.token), 'quick')

  const second = await hub.enrollmentStatus(secret)
  assert.equal(second.status, 'approved')
  assert.equal(second.token, undefined, 'the token is delivered only once')
  assert.equal(second.token_issued, true)
  assert.equal(await hub.authenticate(first.token), 'quick', 'a second read does not rotate the token')

  const text = await readFile(join(dataDir, 'state.json'), 'utf8')
  assert.ok(!text.includes(first.token))
  assert.ok(!text.includes(req.poll_secret))

  await expectHubError(() => hub.approveRequest(CTL, req.request_id), 409, 'request-decided')
  await expectHubError(() => hub.rejectRequest(CTL, req.request_id), 409, 'request-decided')
  await expectHubError(() => hub.requestEnrollment({ agent_id: 'quick' }), 409, 'agent-exists')
})

test('approval without overrides keeps the requested grant', async (t) => {
  const { hub } = await makeHub(t)
  const req = await hub.requestEnrollment({ agent_id: 'quick', capabilities: ['data'], max_concurrency: 3, mode: 'push', workspaces: ['w1'] })
  const { agent } = await hub.approveRequest(CTL, req.request_id)
  assert.deepEqual(agent.capabilities, ['data'])
  assert.equal(agent.max_concurrency, 3)
  assert.equal(agent.mode, 'push')
  assert.deepEqual(agent.workspaces, ['w1'])
  await expectHubError(() => hub.approveRequest(CTL, 'req_missing'), 404, 'request-not-found')
  const other = await hub.requestEnrollment({ agent_id: 'other' })
  await expectHubError(() => hub.approveRequest(CTL, other.request_id, { capabilities: ['Bad Cap'] }), 400, 'bad-capabilities')
  assert.equal((await hub.listRequests())[0].request_id, other.request_id, 'a failed approval leaves the request pending')
})

test('duplicate pending request and already registered agent are refused with 409', async (t) => {
  const { hub } = await makeHub(t)
  await hub.requestEnrollment({ agent_id: 'quick' })
  await expectHubError(() => hub.requestEnrollment({ agent_id: 'quick', platform: 'other' }), 409, 'request-pending')
  await provision(hub, 'worker')
  await expectHubError(() => hub.requestEnrollment({ agent_id: 'worker' }), 409, 'agent-exists')
  assert.equal((await hub.listRequests()).length, 1)
})

test('too many pending requests are refused with 429 until one is decided', async (t) => {
  const { hub } = await makeHub(t, { maxPendingRequests: 3 })
  for (const id of ['a1', 'a2', 'a3']) await hub.requestEnrollment({ agent_id: id })
  await expectHubError(() => hub.requestEnrollment({ agent_id: 'a4' }), 429, 'too-many-requests')
  const [one] = await hub.listRequests()
  await hub.rejectRequest(CTL, one.request_id)
  assert.equal((await hub.requestEnrollment({ agent_id: 'a4' })).status, 'pending')
  await expectHubError(() => hub.requestEnrollment({ agent_id: 'a5' }), 429, 'too-many-requests')
})

test('wrong or missing poll secret looks exactly like an unknown request', async (t) => {
  const { hub } = await makeHub(t)
  const req = await hub.requestEnrollment({ agent_id: 'quick' })
  await hub.approveRequest(CTL, req.request_id)
  const bad = [
    { request_id: req.request_id, poll_secret: 'wrong' }, { request_id: req.request_id }, { request_id: req.request_id, poll_secret: '' },
    { request_id: 'req_missing', poll_secret: req.poll_secret }, {}, undefined,
  ]
  for (const body of bad) await expectHubError(() => hub.enrollmentStatus(body), 404, 'request-not-found')
  // v2: the query id must be the requester
  await expectHubError(() => hub.enrollmentStatus({ request_id: req.request_id, poll_secret: req.poll_secret }, { agentId: 'someone-else' }), 404, 'request-not-found')
  assert.equal(hub.state.requests[req.request_id].tokenIssued, false, 'nothing minted for a wrong secret')
  assert.match((await hub.enrollmentStatus({ request_id: req.request_id, poll_secret: req.poll_secret }, { agentId: 'quick' })).token, /^dsha_quick_/)
})

test('rejected request: reason is reported, nothing is granted, the id may ask again', async (t) => {
  const { hub } = await makeHub(t)
  const req = await hub.requestEnrollment({ agent_id: 'quick' })
  assert.deepEqual(await hub.rejectRequest(CTL, req.request_id, 'not today'), { request_id: req.request_id, status: 'rejected' })
  assert.deepEqual(await hub.enrollmentStatus({ request_id: req.request_id, poll_secret: req.poll_secret }), { request_id: req.request_id, status: 'rejected', reason: 'not today' })
  assert.deepEqual(await hub.listAgents(), [])
  assert.equal((await hub.listRequests({ status: 'rejected' }))[0].reason, 'not today')
  await expectHubError(() => hub.rejectRequest(CTL, 'req_missing'), 404, 'request-not-found')
  assert.equal((await hub.requestEnrollment({ agent_id: 'quick' })).status, 'pending')
})

test('pending requests expire after 24h (sweep)', async (t) => {
  const { hub, clock } = await makeHub(t)
  const req = await hub.requestEnrollment({ agent_id: 'quick' })
  clock.advance(24 * 3600 * 1000)
  assert.equal(await hub.sweep(), 0, 'exactly 24h is not yet expired')
  clock.advance(1)
  assert.equal(await hub.sweep(), 1)
  assert.equal((await hub.enrollmentStatus({ request_id: req.request_id, poll_secret: req.poll_secret })).status, 'expired')
  const [expired] = await hub.listRequests({ status: 'expired' })
  assert.equal(expired.decided_at, iso(T0 + 24 * 3600 * 1000 + 1))
  await expectHubError(() => hub.approveRequest(CTL, req.request_id), 409, 'request-decided')
  assert.equal(await hub.sweep(), 0, 'expired once')
  assert.equal((await hub.requestEnrollment({ agent_id: 'quick' })).status, 'pending')
  assert.equal((await hub.listRequests({ status: 'all' })).length, 2)
})

test('approved but revoked before collection reports revoked; revoked ids may re-enroll', async (t) => {
  const { hub } = await makeHub(t)
  const req = await hub.requestEnrollment({ agent_id: 'quick' })
  await hub.approveRequest(CTL, req.request_id)
  await hub.revokeAgent(CTL, 'quick')
  assert.deepEqual(await hub.enrollmentStatus({ request_id: req.request_id, poll_secret: req.poll_secret }), { request_id: req.request_id, status: 'revoked' })
  const again = await hub.requestEnrollment({ agent_id: 'quick' })
  await hub.approveRequest(CTL, again.request_id)
  const { token } = await hub.enrollmentStatus({ request_id: again.request_id, poll_secret: again.poll_secret })
  assert.equal(await hub.authenticate(token), 'quick')
})

// --- dispatch --------------------------------------------------------------------

test('dispatch validates every field', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker')
  const base = { title: 'T', instruction: 'I', agent: 'worker' }
  const cases = [
    { title: undefined }, { title: '   ' }, { title: 5 }, { instruction: undefined }, { instruction: '' }, { instruction: ' \n ' },
    { type: 'poem' }, { agent: undefined }, { agent: 'Worker' }, { agent: 'w' }, { agent: 'pool:' }, { agent: 'pool:Research' }, { agent: 'pool:a/b' },
    { priority: 'urgent' }, { depends_on: 'x' }, { depends_on: [1] }, { inputs: {} }, { inputs: 'a.txt' },
    { lease_seconds: 59 }, { lease_seconds: 604_801 }, { lease_seconds: 90.5 }, { lease_seconds: '600' },
    { task_id: 'has/slash' }, { task_id: '' }, { task_id: 'x'.repeat(97) }, { task_id: 'a b' }, { task_id: 5 },
    // v2 fields
    { workspace: 'a/b' }, { workspace: '' }, { workspace: 5 }, { workspace: '../x' }, { type: 'code' },
    { node: 'MYDESK' }, { node: 7 },
    { ref: '-rf' }, { ref: 'a..b' }, { ref: 'a b' }, { ref: 'x.lock' }, { ref: 'feature/' }, { ref: '' }, { ref: 12 }, { ref: 'a//b' },
  ]
  for (const patch of cases) await expectHubError(() => hub.dispatch(CTL, { ...base, ...patch }), 400, 'bad-task')
  await expectHubError(() => hub.dispatch(CTL, undefined), 400, 'bad-task')
  assert.deepEqual(await hub.listTasks(), [])
  // boundaries that are fine
  for (const lease of [60, 604_800]) assert.equal((await hub.dispatch(CTL, { ...base, lease_seconds: lease })).status, 'pending')
  for (const ref of ['main', 'feature/x-1', '0123abcd', 'v2.0.0', 'release_2026.11']) assert.equal((await hub.dispatch(CTL, { ...base, ref })).ref, ref)
})

test('dispatch refuses unknown agents, unknown dependencies, duplicate ids and bad input names', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker')
  await expectHubError(() => dispatchTask(hub, { agent: 'ghost' }), 404, 'agent-not-found')
  const pooled = await dispatchTask(hub, { agent: 'pool:research', task_id: 'pooled' })
  assert.equal(pooled.agent, 'pool:research', 'a pool needs no registered agent yet')
  await expectHubError(() => dispatchTask(hub, { depends_on: ['nope'] }), 404, 'task-not-found')
  await expectHubError(() => dispatchTask(hub, { depends_on: ['pooled', 'nope'] }), 404, 'task-not-found')
  await dispatchTask(hub, { task_id: 'fixed' })
  await expectHubError(() => dispatchTask(hub, { task_id: 'fixed' }), 409, 'task-exists')
  for (const name of ['../evil.txt', 'a/b.txt', 'a\\b.txt', '.hidden', 'a..b', '', undefined]) {
    await expectHubError(() => dispatchTask(hub, { inputs: [{ name, text: 'x' }] }), 400, 'bad-file-name')
  }
  await expectHubError(() => dispatchTask(hub, { inputs: [null] }), 400, 'bad-file-name')
  await expectHubError(() => dispatchTask(hub, { inputs: [{ name: 'a.txt' }, { name: 'a.txt' }] }), 400, 'bad-task')
  assert.deepEqual((await hub.listTasks()).map(t => t.task_id).sort(), ['fixed', 'pooled'])
})

test('dispatch generates sequential ids and serializes parallel calls', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker')
  const results = await Promise.all([1, 2, 3, 4, 5].map(i => dispatchTask(hub, { title: `T${i}` })))
  assert.deepEqual(results.map(r => r.task_id), [1, 2, 3, 4, 5].map(i => `task_20260101_000${i}`))
  const [first] = results
  assert.equal(first.status, 'pending')
  assert.equal(first.attempts, 0)
  assert.equal(first.priority, 'normal')
  assert.equal(first.type, 'custom')
  assert.equal(first.created_at, iso(T0))
  assert.equal(first.created_by, CTL)
  assert.deepEqual(first.depends_on, [])
  assert.equal(first.assigned_to, undefined)
  assert.equal(hub.state.seq, 5)
})

test('dispatch stores inline inputs (text and base64) and the full task', async (t) => {
  const { hub, dataDir } = await makeHub(t)
  await provision(hub, 'worker')
  await dispatchTask(hub, {
    task_id: 't1', type: 'research', title: '  Brief  ',
    inputs: [{ name: 'brief.md', text: '# hi' }, { name: '数据 (1).csv', base64: b64('a,b\n1,2') }, { name: 'empty.txt' }],
    output: { format: 'md' }, context: { k: 1 }, parent_task_id: 'p', deadline: '2026-01-02T00:00:00+08:00',
  })
  const full = await hub.getTask('t1')
  assert.equal(full.title, 'Brief', 'title is trimmed')
  assert.equal(full.type, 'research')
  assert.equal(full.instruction, 'Do the thing.')
  assert.deepEqual(full.inputs, ['brief.md', '数据 (1).csv', 'empty.txt'])
  assert.deepEqual(full.output, { format: 'md' })
  assert.deepEqual(full.context, { k: 1 })
  assert.equal(full.history[0].event, 'created')
  assert.equal(full.history[0].message, `${CTL} -> worker`)
  const dir = join(dataDir, 'artifacts', 't1', 'inputs')
  assert.equal(await readFile(join(dir, 'brief.md'), 'utf8'), '# hi')
  assert.equal(await readFile(join(dir, '数据 (1).csv'), 'utf8'), 'a,b\n1,2')
  assert.equal(await readFile(join(dir, 'empty.txt'), 'utf8'), '')
  const brief = (await hub.listTasks())[0]
  assert.equal(brief.instruction, undefined, 'list view is not the full task')
  await expectHubError(() => hub.getTask('nope'), 404, 'task-not-found')
})

// --- poll ------------------------------------------------------------------------

test('poll leases only tasks routed to the calling agent, once', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'alpha', { max_concurrency: 4 })
  await provision(hub, 'beta', { max_concurrency: 4 })
  await dispatchTask(hub, { agent: 'alpha', task_id: 'for-alpha', lease_seconds: 600 })
  assert.deepEqual(await hub.poll('beta', { max: 5 }), { tasks: [] })
  const { tasks } = await hub.poll('alpha', { max: 5 })
  assert.equal(tasks.length, 1)
  const [leased] = tasks
  assert.equal(leased.protocol, PROTOCOL)
  assert.equal(leased.task_id, 'for-alpha')
  assert.equal(leased.attempt, 1)
  assert.equal(leased.lease_until, iso(T0 + 600_000))
  assert.deepEqual(leased.inputs, [])
  assert.equal(leased.instruction, 'Do the thing.')
  assert.equal(leased.created_by, CTL)
  assert.deepEqual(await hub.poll('alpha', { max: 5 }), { tasks: [] }, 'not handed out twice')
  assert.deepEqual(await hub.poll('beta', { max: 5 }), { tasks: [] })
  const task = await hub.getTask('for-alpha')
  assert.equal(task.status, 'accepted')
  assert.equal(task.assigned_to, 'alpha')
  const agents = Object.fromEntries((await hub.listAgents()).map(a => [a.agent_id, a]))
  assert.equal(agents.alpha.online, true, 'polling counts as seen')
  assert.deepEqual(agents.alpha.running_tasks, ['for-alpha'])
  assert.deepEqual(agents.beta.running_tasks, [])
})

test('pool:<capability> goes only to agents that declared the capability', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'researcher', { capabilities: ['research'], max_concurrency: 4 })
  await provision(hub, 'coder', { capabilities: ['code'], max_concurrency: 4 })
  await dispatchTask(hub, { agent: 'pool:research', task_id: 'r1' })
  await dispatchTask(hub, { agent: 'pool:code', task_id: 'c1' })
  await dispatchTask(hub, { agent: 'pool:data', task_id: 'd1' })
  await dispatchTask(hub, { agent: 'coder', task_id: 'direct' })
  assert.deepEqual(ids(await hub.poll('researcher', { max: 4 })), ['r1'])
  assert.deepEqual(ids(await hub.poll('coder', { max: 4 })).sort(), ['c1', 'direct'])
  assert.equal((await hub.getTask('r1')).assigned_to, 'researcher')
  assert.equal((await hub.getTask('r1')).agent, 'pool:research')
  assert.equal((await hub.getTask('d1')).status, 'pending')
})

test('poll orders by priority, then by age; default max is 1', async (t) => {
  const { hub, clock } = await makeHub(t)
  await provision(hub, 'worker', { max_concurrency: 4 })
  for (const [id, priority] of [['low', 'low'], ['normal-1', 'normal'], ['high', 'high'], ['normal-2', 'normal']]) {
    await dispatchTask(hub, { task_id: id, priority })
    clock.advance(1000)
  }
  assert.deepEqual(ids(await hub.poll('worker')), ['high'])
  assert.deepEqual(ids(await hub.poll('worker', { max: 3 })), ['normal-1', 'normal-2', 'low'])
})

test('poll respects max_concurrency (accepted and running both count)', async (t) => {
  const { hub, clock } = await makeHub(t)
  await provision(hub, 'worker', { max_concurrency: 2 })
  for (const id of ['a', 'b', 'c', 'd']) { await dispatchTask(hub, { task_id: id }); clock.advance(1000) }
  assert.deepEqual(ids(await hub.poll('worker', { max: 5 })), ['a', 'b'])
  assert.deepEqual(await hub.poll('worker', { max: 5 }), { tasks: [] })
  await hub.progress('worker', { task_id: 'b', progress: 0.1 })
  await hub.submitResult('worker', { task_id: 'a', status: 'completed' })
  assert.deepEqual(ids(await hub.poll('worker', { max: 5 })), ['c'])
  assert.deepEqual(await hub.poll('worker', { max: 5 }), { tasks: [] }, 'b (running) and c fill the slots')
  for (const max of [0, -1]) assert.deepEqual(await hub.poll('worker', { max }), { tasks: [] })
})

test('a non-integer max falls back to 1', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker', { max_concurrency: 4 })
  for (const id of ['a', 'b', 'c']) await dispatchTask(hub, { task_id: id })
  assert.equal((await hub.poll('worker', { max: '3' })).tasks.length, 1)
  assert.equal((await hub.poll('worker', { max: 2.5 })).tasks.length, 1)
})

test('tasks wait for depends_on; upstream outputs become downstream inputs', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker', { max_concurrency: 4 })
  await dispatchTask(hub, { task_id: 'up' })
  await dispatchTask(hub, { task_id: 'down', depends_on: ['up'], inputs: [{ name: 'notes.txt', text: 'n' }] })
  assert.deepEqual(ids(await hub.poll('worker', { max: 4 })), ['up'])
  await hub.progress('worker', { task_id: 'up', progress: 0.5 })
  assert.deepEqual(await hub.poll('worker', { max: 4 }), { tasks: [] }, 'running upstream is not completed')
  await hub.submitResult('worker', { task_id: 'up', status: 'completed', files: [{ name: 'report.md', base64: b64('# report') }] })
  const { tasks: [down] } = await hub.poll('worker', { max: 4 })
  assert.equal(down.task_id, 'down')
  assert.deepEqual(down.inputs, [{ name: 'notes.txt', from_task: 'down' }, { name: 'report.md', from_task: 'up' }])
})

// --- progress ----------------------------------------------------------------------

test('progress marks running, renews the lease and is scoped to the holder', async (t) => {
  const { hub, clock } = await makeHub(t)
  await provision(hub, 'worker')
  await provision(hub, 'other')
  await dispatchTask(hub, { task_id: 't1', lease_seconds: 120 })
  await hub.poll('worker')
  clock.advance(100_000)
  assert.deepEqual(await hub.progress('worker', { task_id: 't1', progress: 0.5, message: 'half' }), { ok: true, lease_until: iso(T0 + 220_000) })
  clock.advance(50_000) // past the original lease, inside the renewed one
  assert.equal(await hub.sweep(), 0)
  let task = await hub.getTask('t1')
  assert.equal(task.status, 'running')
  assert.equal(task.progress, 0.5)
  assert.equal(task.message, 'half')
  assert.equal(task.history.at(-1).event, 'progress')
  await hub.progress('worker', { task_id: 't1', progress: 2, message: 'x'.repeat(1500) })
  await hub.progress('worker', { task_id: 't1', progress: -0.1 })
  await hub.progress('worker', { task_id: 't1', progress: '0.9' })
  task = await hub.getTask('t1')
  assert.equal(task.progress, 0.5, 'out-of-range or non-number progress is ignored')
  assert.equal(task.message.length, 1000)
  await expectHubError(() => hub.progress('other', { task_id: 't1', progress: 0.9 }), 404, 'task-not-found')
  await expectHubError(() => hub.progress('worker', { task_id: 'nope' }), 404, 'task-not-found')
  await expectHubError(() => hub.progress('worker'), 404, 'task-not-found')
})

// --- results -----------------------------------------------------------------------

test('completed result stores outputs, sets progress 1 and ends the lease', async (t) => {
  const { hub, dataDir, clock } = await makeHub(t)
  await provision(hub, 'worker')
  await dispatchTask(hub, { task_id: 't1' })
  await hub.poll('worker')
  clock.advance(5000)
  const r = await hub.submitResult('worker', {
    task_id: 't1', status: 'completed', summary: 'done',
    files: [{ name: 'out.md', base64: b64('hello'), type: 'markdown', description: 'main' }],
  })
  assert.deepEqual(r, { ok: true, task_status: 'completed' })
  const task = await hub.getTask('t1')
  assert.equal(task.status, 'completed')
  assert.equal(task.progress, 1)
  assert.equal(task.lease_until, undefined)
  assert.deepEqual(task.result, {
    status: 'completed', summary: 'done', outputs: [{ name: 'out.md', bytes: 5, type: 'markdown', description: 'main' }], error: undefined, needs_input: undefined,
  })
  assert.equal(task.history.at(-1).event, 'completed')
  assert.equal(await readFile(join(dataDir, 'artifacts', 't1', 'outputs', 'out.md'), 'utf8'), 'hello')
  assert.equal((await hub.readOutput('t1', 'out.md')).toString('utf8'), 'hello')
  await expectHubError(() => hub.readOutput('t1', '../state.json'), 400, 'bad-file-name')
  await expectHubError(() => hub.readOutput('t1', 'missing.md'), 404, 'artifact-not-found')
  await expectHubError(() => hub.readOutput('nope', 'out.md'), 404, 'task-not-found')
  await expectHubError(() => hub.submitResult('worker', { task_id: 't1', status: 'completed' }), 409, 'task-not-active')
  assert.deepEqual((await hub.listAgents())[0].running_tasks, [])
})

test('failed, retryable failure and partial results', async (t) => {
  const { hub, clock } = await makeHub(t)
  await provision(hub, 'worker', { max_concurrency: 3 })
  for (const id of ['f', 'r', 'p']) { await dispatchTask(hub, { task_id: id }); clock.advance(1000) }
  await hub.poll('worker', { max: 3 })

  assert.equal((await hub.submitResult('worker', { task_id: 'f', status: 'failed', error: { code: 'BOOM', message: 'bad', retryable: false } })).task_status, 'failed')
  assert.deepEqual((await hub.getTask('f')).result.error, { code: 'BOOM', message: 'bad', retryable: false })

  assert.equal((await hub.submitResult('worker', { task_id: 'r', status: 'failed', error: { code: 'FLAKY', retryable: true } })).task_status, 'pending')
  let r = await hub.getTask('r')
  assert.equal(r.status, 'pending')
  assert.equal(r.assigned_to, undefined)
  assert.equal(r.attempts, 1)
  assert.equal(r.history.at(-1).event, 'requeued')
  assert.equal(r.history.at(-1).message, 'retryable failure: FLAKY')
  const { tasks: [again] } = await hub.poll('worker')
  assert.equal(again.task_id, 'r')
  assert.equal(again.attempt, 2)
  assert.equal((await hub.submitResult('worker', { task_id: 'r', status: 'failed' })).task_status, 'failed')
  r = await hub.getTask('r')
  assert.equal(r.result.error, undefined)

  assert.equal((await hub.submitResult('worker', { task_id: 'p', status: 'partial', needs_input: 'need creds' })).task_status, 'failed')
  const p = await hub.getTask('p')
  assert.deepEqual(p.result.error, { code: 'NEEDS_HUMAN', message: 'need creds', retryable: false })
  assert.equal(p.result.needs_input, 'need creds')
  assert.equal(p.result.status, 'partial')
})

test('a retryable failure past maxRetries is dead', async (t) => {
  const { hub } = await makeHub(t, { maxRetries: 1 })
  await provision(hub, 'worker')
  await dispatchTask(hub, { task_id: 't1' })
  const fail = { task_id: 't1', status: 'failed', error: { code: 'FLAKY', retryable: true } }
  await hub.poll('worker')
  assert.equal((await hub.submitResult('worker', fail)).task_status, 'pending')
  await hub.poll('worker')
  assert.equal((await hub.submitResult('worker', fail)).task_status, 'dead')
})

test('submitResult validation, ownership and cancellation', async (t) => {
  const { hub, dataDir } = await makeHub(t)
  await provision(hub, 'worker')
  await provision(hub, 'other')
  await dispatchTask(hub, { task_id: 't1' })
  await hub.poll('worker')
  for (const status of [undefined, 'done', 'cancelled', 'COMPLETED']) {
    await expectHubError(() => hub.submitResult('worker', { task_id: 't1', status }), 400, 'bad-result')
  }
  await expectHubError(() => hub.submitResult('worker', { task_id: 't1', status: 'completed', files: {} }), 400, 'bad-result')
  const many = Array.from({ length: 51 }, (_, i) => ({ name: `f${i}.txt`, base64: '' }))
  await expectHubError(() => hub.submitResult('worker', { task_id: 't1', status: 'completed', files: many }), 400, 'bad-result')
  for (const name of ['../x.md', 'a/b.md', '..', '.env']) {
    await expectHubError(() => hub.submitResult('worker', { task_id: 't1', status: 'completed', files: [{ name: 'good.md', base64: b64('x') }, { name, base64: b64('x') }] }), 400, 'bad-file-name')
  }
  await expectHubError(() => hub.submitResult('worker', { task_id: 't1', status: 'completed', files: [{ name: 'a.md' }, { name: 'a.md' }] }), 400, 'bad-result')
  await assert.rejects(readdir(join(dataDir, 'artifacts', 't1', 'outputs')), { code: 'ENOENT' }, 'v2: nothing is written before every name is checked')
  assert.equal((await hub.getTask('t1')).status, 'accepted', 'rejected submissions change nothing')
  await expectHubError(() => hub.submitResult('other', { task_id: 't1', status: 'completed' }), 404, 'task-not-found')
  await expectHubError(() => hub.submitResult('worker', { task_id: 'nope', status: 'completed' }), 404, 'task-not-found')
  await hub.cancel(CTL, 't1')
  await expectHubError(() => hub.submitResult('worker', { task_id: 't1', status: 'completed' }), 409, 'task-not-active')
  await expectHubError(() => hub.progress('worker', { task_id: 't1' }), 409, 'task-not-active')
  assert.equal((await hub.getTask('t1')).status, 'cancelled')
})

// --- artifacts ---------------------------------------------------------------------

test('artifact: own inputs and upstream outputs only, no path tricks', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker', { max_concurrency: 2 })
  await provision(hub, 'other')
  await dispatchTask(hub, { task_id: 'up' })
  await dispatchTask(hub, { task_id: 'side' })
  await hub.poll('worker', { max: 2 })
  await hub.submitResult('worker', { task_id: 'up', status: 'completed', files: [{ name: 'report.md', base64: b64('# report') }] })
  await hub.submitResult('worker', { task_id: 'side', status: 'completed', files: [{ name: 'secret.md', base64: b64('nope') }] })
  await dispatchTask(hub, { task_id: 'down', depends_on: ['up'], inputs: [{ name: 'in.txt', text: 'input!' }] })
  await dispatchTask(hub, { task_id: 'theirs', agent: 'other', inputs: [{ name: 'x.txt', text: 'x' }] })
  assert.deepEqual(ids(await hub.poll('worker')), ['down'])
  assert.deepEqual(ids(await hub.poll('other')), ['theirs'])

  assert.equal((await hub.artifact('worker', { task_id: 'down', name: 'in.txt' })).toString('utf8'), 'input!')
  assert.equal((await hub.artifact('worker', { task_id: 'down', from_task: 'down', name: 'in.txt' })).toString('utf8'), 'input!')
  assert.equal((await hub.artifact('worker', { task_id: 'down', from_task: 'up', name: 'report.md' })).toString('utf8'), '# report')

  await expectHubError(() => hub.artifact('worker', { task_id: 'down', from_task: 'side', name: 'secret.md' }), 403, 'forbidden')
  await expectHubError(() => hub.artifact('worker', { task_id: 'down', from_task: 'up', name: 'missing.md' }), 404, 'artifact-not-found')
  await expectHubError(() => hub.artifact('worker', { task_id: 'down', name: 'report.md' }), 404, 'artifact-not-found')
  for (const name of ['../state.json', '..\\state.json', 'inputs/../../state.json', '../../up/outputs/report.md', '.', '', undefined, null]) {
    await expectHubError(() => hub.artifact('worker', { task_id: 'down', name }), 400, 'bad-file-name')
    await expectHubError(() => hub.artifact('worker', { task_id: 'down', from_task: 'up', name }), 400, 'bad-file-name')
  }
  await expectHubError(() => hub.artifact('worker', { task_id: 'theirs', name: 'x.txt' }), 404, 'task-not-found')
  await expectHubError(() => hub.artifact('worker', { task_id: 'up', from_task: 'up', name: 'report.md' }), 409, 'task-not-active')
  await hub.submitResult('worker', { task_id: 'down', status: 'completed' })
  await expectHubError(() => hub.artifact('worker', { task_id: 'down', name: 'in.txt' }), 409, 'task-not-active')
})

// --- sweep -------------------------------------------------------------------------

test('sweep requeues expired leases; retries exhausted means dead', async (t) => {
  const { hub, clock } = await makeHub(t, { maxRetries: 1 })
  await provision(hub, 'worker')
  await dispatchTask(hub, { task_id: 't1', lease_seconds: 60 })
  assert.equal((await hub.poll('worker')).tasks[0].attempt, 1)
  clock.advance(60_000)
  assert.equal(await hub.sweep(), 0, 'lease_until == now is still valid')
  clock.advance(1)
  assert.equal(await hub.sweep(), 1)
  let task = await hub.getTask('t1')
  assert.equal(task.status, 'pending')
  assert.equal(task.assigned_to, undefined)
  assert.equal(task.lease_until, undefined)
  assert.equal(task.attempts, 1)
  assert.equal(task.history.at(-1).message, 'lease expired (worker)')

  assert.equal((await hub.poll('worker')).tasks[0].attempt, 2)
  clock.advance(60_001)
  assert.equal(await hub.sweep(), 1)
  task = await hub.getTask('t1')
  assert.equal(task.status, 'dead')
  assert.equal(task.history.at(-1).event, 'dead')
  assert.equal(task.history.at(-1).message, 'lease expired (worker); retries exhausted')
  assert.deepEqual(await hub.poll('worker'), { tasks: [] })
  assert.equal(await hub.sweep(), 0)
})

test('default maxRetries=2 allows three attempts', async (t) => {
  const { hub, clock } = await makeHub(t)
  await provision(hub, 'worker')
  await dispatchTask(hub, { task_id: 't1', lease_seconds: 60 })
  for (const expected of ['pending', 'pending', 'dead']) {
    await hub.poll('worker')
    clock.advance(61_000)
    await hub.sweep()
    assert.equal((await hub.getTask('t1')).status, expected)
  }
  assert.equal((await hub.getTask('t1')).attempts, 3)
})

test('sweep fails pending tasks whose upstream failed, was cancelled or died', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker', { max_concurrency: 2 })
  await dispatchTask(hub, { task_id: 'a' })
  await dispatchTask(hub, { task_id: 'b', depends_on: ['a'] })
  await dispatchTask(hub, { task_id: 'c', depends_on: ['b'] })
  await dispatchTask(hub, { task_id: 'x' })
  await dispatchTask(hub, { task_id: 'y', depends_on: ['x'] })
  await dispatchTask(hub, { task_id: 'z' })
  assert.deepEqual(ids(await hub.poll('worker', { max: 2 })), ['a', 'x'])
  await hub.submitResult('worker', { task_id: 'a', status: 'failed' })
  await hub.cancel(CTL, 'x')
  assert.equal(await hub.sweep(), 3)
  for (const id of ['b', 'c', 'y']) {
    const task = await hub.getTask(id)
    assert.equal(task.status, 'failed', id)
    assert.deepEqual(task.result.error, { code: 'UPSTREAM_FAILED', message: 'a depends_on task did not complete', retryable: false })
    assert.equal(task.history.at(-1).message, 'upstream failed')
  }
  assert.equal((await hub.getTask('z')).status, 'pending', 'unrelated tasks untouched')
  assert.equal(await hub.sweep(), 0)
})

// --- cancel / retry ----------------------------------------------------------------

test('cancel and retry', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker')
  await provision(hub, 'other')
  await dispatchTask(hub, { task_id: 't1' })
  const cancelled = await hub.cancel(CTL, 't1')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await hub.getTask('t1')).history.at(-1).message, `cancelled by ${CTL}`)
  await expectHubError(() => hub.cancel(CTL, 't1'), 409, 'task-finished')
  await expectHubError(() => hub.cancel(CTL, 'ghost'), 404, 'task-not-found')
  await expectHubError(() => hub.retry(CTL, 'ghost'), 404, 'task-not-found')

  await dispatchTask(hub, { task_id: 't2' })
  await hub.poll('worker')
  await expectHubError(() => hub.retry(CTL, 't2'), 409, 'task-active')
  await hub.cancel(CTL, 't2', 'changed my mind')
  assert.equal((await hub.getTask('t2')).history.at(-1).message, 'changed my mind')
  assert.deepEqual((await hub.listAgents()).find(a => a.agent_id === 'worker').running_tasks, [])

  const retried = await hub.retry(CTL, 't2', { agent: 'other' })
  assert.equal(retried.status, 'pending')
  assert.equal(retried.agent, 'other')
  assert.equal(retried.attempts, 0)
  assert.equal(retried.assigned_to, undefined)
  assert.equal(retried.result, undefined)
  assert.deepEqual(await hub.poll('worker'), { tasks: [] })
  assert.deepEqual(ids(await hub.poll('other')), ['t2'])
  await hub.submitResult('other', { task_id: 't2', status: 'completed' })

  await expectHubError(() => hub.retry(CTL, 't2', { agent: 'nobody' }), 400, 'bad-task')
  await expectHubError(() => hub.retry(CTL, 't2', { agent: 'Bad Agent' }), 400, 'bad-task')
  const pooled = await hub.retry(CTL, 't2', { agent: 'pool:code' })
  assert.equal(pooled.agent, 'pool:code')
  assert.equal(pooled.status, 'pending')
  assert.equal((await hub.getTask('t2')).history.at(-1).event, 'retried')
  const same = await hub.retry(CTL, 't1')
  assert.equal(same.agent, 'worker', 'retry without agent keeps the target')
})

// --- reads, heartbeat, overview ------------------------------------------------------

test('heartbeat, online window, listTasks filters and overview', async (t) => {
  const { hub, clock } = await makeHub(t)
  await provision(hub, 'worker')
  assert.equal((await hub.listAgents())[0].online, false)
  assert.deepEqual(await hub.heartbeat('worker', { status: 'busy' }), { ok: true, agent_id: 'worker', status: 'online', server_time: iso(T0), workspaces: [], ignored_workspaces: [], abort: [], requeued: [] })
  let [agent] = await hub.listAgents()
  assert.equal(agent.online, true)
  assert.equal(agent.reported_status, 'busy')
  assert.equal(agent.last_seen, iso(T0))
  await hub.heartbeat('worker', { status: 'sleeping' })
  assert.equal((await hub.listAgents())[0].reported_status, undefined)
  clock.advance(90_000)
  assert.equal((await hub.listAgents())[0].online, true, 'exactly offlineAfterMs is still online')
  clock.advance(1)
  ;[agent] = await hub.listAgents()
  assert.equal(agent.online, false)

  await dispatchTask(hub, { task_id: 't1' }); clock.advance(1000)
  await dispatchTask(hub, { task_id: 't2' }); clock.advance(1000)
  await dispatchTask(hub, { task_id: 't3', agent: 'pool:x' })
  await hub.cancel(CTL, 't3')
  assert.deepEqual((await hub.listTasks()).map(t => t.task_id), ['t3', 't2', 't1'], 'newest first')
  assert.deepEqual((await hub.listTasks({ status: 'cancelled' })).map(t => t.task_id), ['t3'])
  assert.deepEqual((await hub.listTasks({ agent: 'worker' })).map(t => t.task_id), ['t2', 't1'])
  assert.deepEqual((await hub.listTasks({ limit: 1 })).map(t => t.task_id), ['t3'])

  await hub.requestEnrollment({ agent_id: 'quick' })
  const overview = await hub.overview()
  assert.equal(overview.protocol, PROTOCOL)
  assert.deepEqual(overview.task_counts, { pending: 2, cancelled: 1 })
  assert.equal(overview.pending_requests, 1)
  assert.deepEqual(overview.agents.map(a => a.agent_id), ['worker'])
})

// --- persistence ---------------------------------------------------------------------

test('state survives a restart: a new instance reads state.json back', async (t) => {
  const { hub, dataDir, clock } = await makeHub(t)
  const { token } = await provision(hub, 'worker')
  const req = await hub.requestEnrollment({ agent_id: 'quick' })
  await dispatchTask(hub, { task_id: 't1', inputs: [{ name: 'a.txt', text: 'A' }] })
  await hub.poll('worker')

  const doc = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'))
  assert.equal(doc.protocol, PROTOCOL)
  assert.equal(doc.seq ?? 0, 0, 'an explicit task_id does not consume a sequence number')
  assert.deepEqual(Object.keys(doc.agents), ['worker'])
  assert.deepEqual(Object.keys(doc.tasks), ['t1'])
  assert.equal((await readdir(dataDir)).filter(n => n.includes('.tmp')).length, 0, 'no temp files left behind')

  const reopened = new AgentHub({ dataDir, clock })
  assert.equal(await reopened.authenticate(token), 'worker')
  const task = await reopened.getTask('t1')
  assert.equal(task.status, 'accepted')
  assert.equal(task.assigned_to, 'worker')
  assert.equal((await reopened.listRequests())[0].request_id, req.request_id)
  assert.equal((await reopened.artifact('worker', { task_id: 't1', name: 'a.txt' })).toString('utf8'), 'A')
  assert.equal((await reopened.dispatch(CTL, { title: 'n', instruction: 'n', agent: 'worker' })).task_id, 'task_20260101_0001', 'seq continues from the saved state')
  await reopened.approveRequest(CTL, req.request_id)
  const { token: quickToken } = await reopened.enrollmentStatus({ request_id: req.request_id, poll_secret: req.poll_secret })
  const third = new AgentHub({ dataDir, clock })
  assert.equal(await third.authenticate(quickToken), 'quick')
})

test('a corrupt state.json is an error, not a silent reset', async (t) => {
  const { dataDir, clock } = await makeHub(t)
  await writeFile(join(dataDir, 'state.json'), '{ not json')
  const hub = new AgentHub({ dataDir, clock })
  await assert.rejects(() => hub.listAgents(), SyntaxError)
})

// --- v1 security fixes, kept ---------------------------------------------------------

test('inherited object keys are treated as unknown ids', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker')
  await expectHubError(() => hub.enrollmentStatus({ request_id: 'constructor', poll_secret: 'x' }), 404, 'request-not-found')
  await expectHubError(() => hub.approveRequest(CTL, 'toString'), 404, 'request-not-found')
  await expectHubError(() => dispatchTask(hub, { depends_on: ['constructor'] }), 404, 'task-not-found')
  await expectHubError(() => hub.cancel(CTL, 'constructor'), 404, 'task-not-found')
  await expectHubError(() => dispatchTask(hub, { priority: 'constructor' }), 400, 'bad-task')
  await expectHubError(() => hub.revokeController('constructor'), 404, 'controller-not-found')
  await expectHubError(() => hub.authenticateController('dshc_constructor_x'), 401, 'unauthorized')
  await expectHubError(() => hub.authenticateController('dshc___proto___x'), 401, 'unauthorized')
})

test('poll and heartbeat refuse an agent revoked after authenticate', async (t) => {
  const { hub } = await makeHub(t)
  const { token } = await provision(hub, 'worker')
  await dispatchTask(hub, { task_id: 't1' })
  const id = await hub.authenticate(token)
  await hub.revokeAgent(CTL, 'worker') // a controller revokes while the request is in flight
  await expectHubError(() => hub.poll(id), 401, 'unauthorized')
  await expectHubError(() => hub.heartbeat(id, {}), 401, 'unauthorized')
  assert.equal((await hub.getTask('t1')).status, 'pending')
})
