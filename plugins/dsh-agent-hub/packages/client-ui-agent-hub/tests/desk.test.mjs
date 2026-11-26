import assert from 'node:assert/strict'
import test from 'node:test'
import { LANES, agentGroups, clearActionOf, fallbackReason, fallbackTasks, laneOf, lanesOf, registeredBy, selfParts, selfWorkers, stageOf, timeline } from '../src/client/desk.ts'

const task = (over = {}) => ({ task_id: 't', agent: 'pool:code', type: 'code', title: 'x', status: 'running', priority: 'normal', attempts: 1, created_at: '2026-11-24T10:00:00.000Z', depends_on: [], ...over })
const agent = (over = {}) => ({ agent_id: 'a', capabilities: [], revoked: false, online: true, running_tasks: [], ...over })

test('lanes: status and stage decide; a question waits on you even before it ends', () => {
  assert.equal(laneOf(task({ status: 'pending' })), 'queued')
  assert.equal(laneOf(task({ status: 'accepted' })), 'claimed')
  assert.equal(laneOf(task({ status: 'running', stage: 'step' })), 'running')
  assert.equal(laneOf(task({ status: 'running', stage: 'needs_input' })), 'waiting')
  assert.equal(laneOf(task({ status: 'completed', result: { status: 'partial', needs_input: 'keep the old API?', output_count: 0 } })), 'waiting')
  assert.equal(laneOf(task({ status: 'completed', result: { status: 'completed', output_count: 0 } })), 'ended')
  for (const status of ['failed', 'cancelled', 'dead']) assert.equal(laneOf(task({ status })), 'ended')
  assert.deepEqual(LANES, ['queued', 'claimed', 'running', 'waiting', 'ended'])
})

test('lanesOf: newest activity first, the queue oldest first', () => {
  const lanes = lanesOf([
    task({ task_id: 'q1', status: 'pending', created_at: '2026-11-24T09:00:00.000Z' }),
    task({ task_id: 'q2', status: 'pending', created_at: '2026-11-24T11:00:00.000Z' }),
    task({ task_id: 'r1', updated_at: '2026-11-24T10:05:00.000Z' }),
    task({ task_id: 'r2', updated_at: '2026-11-24T10:09:00.000Z' }),
  ])
  assert.deepEqual(lanes.queued.map(t => t.task_id), ['q1', 'q2'])
  assert.deepEqual(lanes.running.map(t => t.task_id), ['r2', 'r1'])
  assert.deepEqual(lanes.ended, [])
})

test('agents grouped by profile, then machine, then unlabelled; dormant and revoked apart', () => {
  const { groups, dormant } = agentGroups([
    agent({ agent_id: 'b', dsh_profile: 'web' }), agent({ agent_id: 'c', node: 'mydesk' }), agent({ agent_id: 'd' }),
    agent({ agent_id: 'e', dsh_profile: 'api' }), agent({ agent_id: 'f', dsh_profile: 'web', dormant: true }), agent({ agent_id: 'g', revoked: true }),
  ])
  assert.deepEqual(groups.map(g => [g.kind, g.key, g.agents.map(a => a.agent_id)]), [
    ['profile', 'api', ['e']], ['profile', 'web', ['b']], ['node', 'mydesk', ['c']], ['none', '', ['d']],
  ])
  assert.deepEqual(dormant.map(a => a.agent_id), ['f', 'g'])
})

test('DSH partition workers come from the unfinished local tasks they hold', () => {
  assert.deepEqual(selfParts('dsh-self/web/front'), { profile: 'web', partition: 'front' })
  assert.deepEqual(selfParts('quick-mydesk'), {})
  const workers = selfWorkers([
    task({ task_id: 'l1', origin: { kind: 'local', executor: 'dsh-self/web/front' }, dsh_profile: 'web' }),
    task({ task_id: 'l2', origin: { kind: 'local', executor: 'dsh-self/web/front' }, quiet: true }),
    task({ task_id: 'l3', origin: { kind: 'local', executor: 'dsh-self/web/state' }, status: 'completed' }),
    task({ task_id: 'c1', origin: { kind: 'controller' } }),
  ])
  assert.deepEqual([...workers.keys()], ['web'])
  const [front] = workers.get('web')
  assert.deepEqual([front.id, front.partition, front.tasks.map(t => t.task_id), front.quiet], ['dsh-self/web/front', 'front', ['l1', 'l2'], 1])
})

test('fallback: only tasks DSH took over, with the reason read from history', () => {
  const rows = fallbackTasks([task({ task_id: 'f1', fallback_by: 'dsh-cloud' }), task({ task_id: 'l1', fallback_by: 'dsh-local', origin: { kind: 'local' } }), task({ task_id: 'n' })])
  assert.deepEqual(rows.map(t => t.task_id), ['f1'])
  assert.equal(fallbackReason([{ event: 'fallback', message: 'no worker for it is online; DSH (x) does it itself' }]), 'nobody-online')
  assert.equal(fallbackReason([{ event: 'fallback', message: 'nobody took it in time; DSH (x) does it itself' }]), 'waited-out')
  assert.equal(fallbackReason([{ event: 'created' }]), undefined)
})

test('timeline: newest first, empty keep-alives and repeated steps dropped', () => {
  const events = timeline([
    { at: '1', event: 'created' },
    { at: '2', event: 'progress' },
    { at: '3', event: 'progress', stage: 'step', message: 'tests' },
    { at: '4', event: 'progress', stage: 'step', message: 'tests' },
    { at: '5', event: 'progress', stage: 'needs_input', message: 'keep it?' },
  ])
  assert.deepEqual(events.map(e => e.at), ['5', '3', '1'])
  assert.equal(stageOf(task({ status: 'completed', stage: 'uploading' })), undefined)
  assert.equal(stageOf(task({ stage: 'blocked' })), 'blocked')
})

test('registeredBy: reads the hub line for a task DSH runs itself', () => {
  assert.deepEqual(registeredBy({ event: 'registered', message: 'dsh-cloud runs it itself (dsh-self/web/demo)' }), { by: 'dsh-cloud', executor: 'dsh-self/web/demo' })
  assert.deepEqual(registeredBy({ event: 'registered', message: 'dsh-cloud runs it itself' }), { by: 'dsh-cloud' })
  assert.equal(registeredBy({ event: 'created', message: 'dsh-cloud runs it itself' }), undefined)
  assert.equal(registeredBy({ event: 'registered', message: 'something else' }), undefined)
})

test('等你回复: a handed-back question waits until someone deals with it, and every row there can be cleared', () => {
  // A worker that hands the task back with a question ends as failed on the hub.
  const asked = task({ status: 'failed', result: { status: 'failed', needs_input: '越界：请改派给 worker', output_count: 0 } })
  assert.equal(laneOf(asked), 'waiting')
  assert.equal(clearActionOf(asked), 'ack')
  // Put away (or past its expiry): it leaves the lane at once.
  assert.equal(laneOf({ ...asked, acknowledged: true }), 'ended')
  assert.equal(laneOf({ ...asked, in_history: true }), 'ended')
  // Still open and asking: the way out is to cancel it.
  const open = task({ status: 'running', stage: 'needs_input' })
  assert.equal(laneOf(open), 'waiting')
  assert.equal(clearActionOf(open), 'cancel')
  // A plain failure is not a question.
  assert.equal(laneOf(task({ status: 'failed', result: { status: 'failed', output_count: 0 } })), 'ended')
})
