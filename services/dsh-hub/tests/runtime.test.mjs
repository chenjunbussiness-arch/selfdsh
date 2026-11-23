/**
 * Runtime declarations and task effort (docs/DSH-HUB-PROTOCOL-v2.md section 10):
 * validation, enrollment -> approval -> listAgents, heartbeat updates, dispatch
 * checks (409 unsupported-effort, effort-not-declared warning), pool routing,
 * retry to another worker, and the effort travelling to the worker in the lease.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { EFFORT_MODES, EFFORT_THINKING, effortProblem, validateEffort, validateRuntime } from '../lib/hub.js'
import { CTL, dispatchTask, expectHubError, makeHub, provision } from './helpers.mjs'

const QUICK = {
  modes: ['smart', 'fast', 'balanced'],
  thinking: ['off', 'low', 'medium', 'high'],
  default: { mode: 'balanced', thinking: 'low' },
  defaults: { code: { mode: 'smart', thinking: 'medium' } },
  agents: [{ name: 'quick', description: 'AWS Quick default agent' }, 'reviewer', { name: 'quick' }],
  note: 'scheduled pickup every 15 min',
  extra: 'dropped',
}

test('validateRuntime: canonical order, de-duplicated agents, unknown keys dropped', () => {
  const rt = validateRuntime(QUICK)
  assert.deepEqual(rt, {
    modes: ['fast', 'balanced', 'smart'],
    thinking: ['off', 'low', 'medium', 'high'],
    agents: [{ name: 'quick', description: 'AWS Quick default agent' }, { name: 'reviewer' }],
    default: { mode: 'balanced', thinking: 'low' },
    defaults: { code: { mode: 'smart', thinking: 'medium' } },
    note: 'scheduled pickup every 15 min',
  })
  assert.deepEqual(validateRuntime(rt), rt, 'idempotent (approval re-validates the stored copy)')
  assert.equal(validateRuntime(undefined), undefined)
  assert.equal(validateRuntime(null), undefined)
  assert.deepEqual(EFFORT_MODES, ['fast', 'balanced', 'smart'])
  assert.deepEqual(EFFORT_THINKING, ['off', 'low', 'medium', 'high'])
})

test('validateRuntime rejects bad shapes and defaults the runtime cannot honour', () => {
  for (const bad of [
    [], 'x', { modes: ['turbo'] }, { thinking: 'high' }, { agents: [{ name: 'Bad Name' }] }, { agents: 'quick' },
    { modes: ['fast'], default: { mode: 'smart' } }, { default: { mode: 'fast', thinking: 'high' } },
    { defaults: { nope: { mode: 'fast' } } }, { defaults: [] }, { agents: [], default: { agent: 'ghost' } },
  ]) {
    assert.throws(() => validateRuntime(bad), e => e.code === 'bad-runtime', JSON.stringify(bad))
  }
})

test('validateEffort and effortProblem', () => {
  assert.equal(validateEffort(undefined), undefined)
  assert.equal(validateEffort({}), undefined, 'empty effort = none')
  assert.deepEqual(validateEffort({ mode: 'smart', thinking: 'high', agent: 'quick', x: 1 }), { mode: 'smart', thinking: 'high', agent: 'quick' })
  assert.deepEqual(validateEffort({ mode: 'fast', thinking: 'off' }), { mode: 'fast', thinking: 'off' })
  for (const bad of [[], 'smart', { mode: 'turbo' }, { thinking: 'max' }, { mode: 'fast', thinking: 'low' }, { agent: 'A' }]) {
    assert.throws(() => validateEffort(bad), e => e.code === 'bad-task', JSON.stringify(bad))
  }
  const rt = validateRuntime({ modes: ['fast', 'balanced'], thinking: ['off', 'low'], agents: ['quick'] })
  assert.equal(effortProblem(rt, undefined), null)
  assert.equal(effortProblem(rt, { mode: 'balanced', thinking: 'low', agent: 'quick' }), null)
  assert.match(effortProblem(rt, { mode: 'smart' }), /does not offer mode smart/)
  assert.match(effortProblem(rt, { thinking: 'high' }), /does not offer thinking high/)
  assert.match(effortProblem(rt, { agent: 'coder' }), /has no agent coder/)
  assert.equal(effortProblem(undefined, { mode: 'smart', thinking: 'high' }), null, 'no runtime: mode / thinking are best effort')
  assert.match(effortProblem(undefined, { agent: 'quick' }), /declares no agents/)
  assert.equal(effortProblem(validateRuntime({}), { mode: 'smart' }), null, 'empty lists = not restricted')
})

test('enrollment carries the runtime to the request, the approval and listAgents', async (t) => {
  const { hub } = await makeHub(t)
  const req = await hub.requestEnrollment({ agent_id: 'quick-mydesk', platform: 'aws-quick', runtime: QUICK })
  const [listed] = await hub.listRequests()
  assert.deepEqual(listed.runtime.modes, ['fast', 'balanced', 'smart'])
  assert.deepEqual(listed.runtime.agents.map(a => a.name), ['quick', 'reviewer'])
  const approved = await hub.approveRequest(CTL, req.request_id, { capabilities: [] })
  assert.deepEqual(approved.agent.runtime.default, { mode: 'balanced', thinking: 'low' })
  const [agent] = await hub.listAgents()
  assert.deepEqual(agent.runtime, validateRuntime(QUICK))
  await expectHubError(() => hub.requestEnrollment({ agent_id: 'bad-one', runtime: { modes: ['turbo'] } }), 400, 'bad-runtime')
})

test('a heartbeat may change or clear the runtime (descriptive, not a grant)', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker')
  assert.equal((await hub.listAgents())[0].runtime, undefined, 'provision declares nothing')
  await hub.heartbeat('worker', { status: 'idle', runtime: { modes: ['fast'] } })
  assert.deepEqual((await hub.listAgents())[0].runtime.modes, ['fast'])
  await hub.heartbeat('worker', { status: 'idle' })
  assert.deepEqual((await hub.listAgents())[0].runtime.modes, ['fast'], 'no runtime key = unchanged')
  await hub.heartbeat('worker', { status: 'idle', runtime: null })
  assert.equal((await hub.listAgents())[0].runtime, undefined, 'null clears it')
  await expectHubError(() => hub.heartbeat('worker', { runtime: { thinking: ['max'] } }), 400, 'bad-runtime')
})

test('dispatch to one worker: unsupported effort is refused, undeclared runtime only warns', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker')
  await hub.heartbeat('worker', { status: 'idle', runtime: { modes: ['fast', 'balanced'], thinking: ['off', 'low'], agents: ['quick'] } })
  const ok = await dispatchTask(hub, { task_id: 'e1', effort: { mode: 'balanced', thinking: 'low', agent: 'quick' } })
  assert.deepEqual(ok.effort, { mode: 'balanced', thinking: 'low', agent: 'quick' })
  assert.equal(ok.warnings, undefined)
  await expectHubError(() => dispatchTask(hub, { task_id: 'e2', effort: { mode: 'smart' } }), 409, 'unsupported-effort')
  await expectHubError(() => dispatchTask(hub, { task_id: 'e3', effort: { agent: 'coder' } }), 409, 'unsupported-effort')
  await expectHubError(() => dispatchTask(hub, { task_id: 'e4', effort: { mode: 'fast', thinking: 'high' } }), 400, 'bad-task')
  await provision(hub, 'plain')
  await hub.heartbeat('plain', { status: 'idle' })
  const plain = await dispatchTask(hub, { task_id: 'e5', agent: 'plain', effort: { mode: 'smart' } })
  assert.deepEqual(plain.warnings, ['effort-not-declared'])
  await expectHubError(() => dispatchTask(hub, { task_id: 'e6', agent: 'plain', effort: { agent: 'quick' } }), 409, 'unsupported-effort')
  const none = await dispatchTask(hub, { task_id: 'e7', agent: 'plain' })
  assert.equal(none.effort, undefined)
  assert.equal(none.warnings, undefined)
})

test('pool routing only hands effort tasks to workers that support them; the lease carries effort', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'fast-only', { capabilities: ['code'] })
  await provision(hub, 'smart-one', { capabilities: ['code'] })
  await hub.heartbeat('fast-only', { status: 'idle', runtime: { modes: ['fast'] } })
  await hub.heartbeat('smart-one', { status: 'idle', runtime: { modes: ['fast', 'balanced', 'smart'], agents: ['coder'] } })
  const queued = await dispatchTask(hub, { task_id: 'p1', agent: 'pool:code', effort: { mode: 'smart', agent: 'coder' } })
  assert.equal(queued.warnings, undefined, 'smart-one is online and supports it')
  assert.deepEqual((await hub.lease('fast-only', 5)).tasks, [], 'fast-only never gets it')
  const [leased] = (await hub.lease('smart-one', 5)).tasks
  assert.equal(leased.task_id, 'p1')
  assert.deepEqual(leased.effort, { mode: 'smart', agent: 'coder' })
  const lonely = await dispatchTask(hub, { task_id: 'p2', agent: 'pool:code', effort: { agent: 'nobody' } })
  assert.deepEqual(lonely.warnings, ['no-online-worker'])
})

test('retry to another worker re-checks the effort', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker')
  await provision(hub, 'other')
  await hub.heartbeat('worker', { status: 'idle', runtime: { modes: ['smart'] } })
  await hub.heartbeat('other', { status: 'idle', runtime: { modes: ['fast'] } })
  await dispatchTask(hub, { task_id: 'r1', effort: { mode: 'smart' } })
  await hub.cancel(CTL, 'r1', 'test')
  await expectHubError(() => hub.retry(CTL, 'r1', { agent: 'other' }), 409, 'unsupported-effort')
  const again = await hub.retry(CTL, 'r1', { agent: 'worker' })
  assert.equal(again.status, 'pending')
})
