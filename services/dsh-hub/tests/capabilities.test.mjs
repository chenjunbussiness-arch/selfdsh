/**
 * One worker, many kinds of work: capabilities with per-capability limits
 * (`browser:1,test,code`) and the task's `capability` field.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCapabilities } from '../lib/hub.js'
import { CTL, dispatchTask, expectHubError, makeHub, provision } from './helpers.mjs'

test('capabilities parse as names with optional per-capability limits', () => {
  assert.deepEqual(parseCapabilities(['browser:1', 'test', 'code:2', 'test']), { names: ['browser', 'test', 'code'], limits: { browser: 1, code: 2 } })
  assert.deepEqual(parseCapabilities(undefined), { names: [], limits: {} })
  for (const bad of [['Browser'], ['browser:0'], ['browser:33'], ['browser:x'], [7]]) {
    assert.throws(() => parseCapabilities(bad), { code: 'bad-capabilities' })
  }
})

test('a local DSH runs one browser task at a time, tests and code beside it', async (t) => {
  const { hub } = await makeHub(t)
  const { agent } = await provision(hub, 'dsh-mydesk', { capabilities: ['browser:1', 'test', 'code'], max_concurrency: 4 })
  assert.deepEqual(agent.capabilities, ['browser', 'test', 'code'])
  assert.deepEqual(agent.capability_limits, { browser: 1 })
  await hub.heartbeat('dsh-mydesk', { status: 'idle' })
  await dispatchTask(hub, { task_id: 'b1', agent: 'pool:browser' })
  await dispatchTask(hub, { task_id: 'b2', agent: 'dsh-mydesk', capability: 'browser' })
  await dispatchTask(hub, { task_id: 't1', agent: 'pool:test' })
  const first = await hub.poll('dsh-mydesk', { max: 4 })
  assert.deepEqual(first.tasks.map(x => [x.task_id, x.capability]), [['b1', 'browser'], ['t1', 'test']])
  assert.equal((await hub.getTask('b2')).status, 'pending', 'second browser task waits for the lane')
  await hub.submitResult('dsh-mydesk', { task_id: 'b1', status: 'completed', summary: 'ok' })
  assert.deepEqual((await hub.poll('dsh-mydesk', { max: 4 })).tasks.map(x => x.task_id), ['b2'])
})

test('a task for a capability the worker does not offer is refused up front', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'quick-mydesk', { capabilities: ['research', 'document'] })
  await expectHubError(() => dispatchTask(hub, { agent: 'quick-mydesk', capability: 'browser' }), 409, 'unroutable')
  await expectHubError(() => dispatchTask(hub, { agent: 'pool:research', capability: 'code' }), 400, 'bad-task')
  await expectHubError(() => dispatchTask(hub, { agent: 'quick-mydesk', capability: 'Bad' }), 400, 'bad-task')
  // A worker that lists no capabilities takes any kind sent to it by id.
  await provision(hub, 'plain')
  assert.equal((await dispatchTask(hub, { agent: 'plain', capability: 'browser' })).capability, 'browser')
})

test('approval may lower a capability limit, never raise it', async (t) => {
  const { hub } = await makeHub(t)
  const ask = () => hub.requestEnrollment({ agent_id: 'dsh-lab', platform: 'dsh', capabilities: ['browser:2', 'code'], max_concurrency: 3 })
  const req = await ask()
  await expectHubError(() => hub.approveRequest(CTL, req.request_id, { capabilities: ['browser:3'] }), 400, 'grant-widened')
  await expectHubError(() => hub.approveRequest(CTL, req.request_id, { capabilities: ['browser', 'code'] }), 400, 'grant-widened')
  const { agent } = await hub.approveRequest(CTL, req.request_id, { capabilities: ['browser:1', 'code:2'] })
  assert.deepEqual(agent.capability_limits, { browser: 1, code: 2 })
  const listed = (await hub.listRequests({ status: 'all' }))[0]
  assert.deepEqual(listed.capability_limits, { browser: 1, code: 2 })
})

test('an approval without overrides keeps the asked limits', async (t) => {
  const { hub } = await makeHub(t)
  const req = await hub.requestEnrollment({ agent_id: 'dsh-lab', platform: 'dsh', capabilities: ['browser:1', 'code'] })
  const { agent } = await hub.approveRequest(CTL, req.request_id)
  assert.deepEqual(agent.capability_limits, { browser: 1 })
})
