/**
 * The task lifecycle: one phase vocabulary, the question -> answer loop, delivery and
 * acknowledgement markers, the audit log (findable after archive), metrics and due times.
 */
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

import { metricsOf, percentile, phaseOf, timelineOf } from '../lib/lifecycle.js'
import { CTL, CTL2, dispatchTask, expectHubError, makeHub, provision } from './helpers.mjs'

const MIN = 60_000
const HOUR = 60 * MIN

test('phaseOf maps every status (and the stage) to one phase', () => {
  assert.equal(phaseOf({ status: 'pending' }), 'queued')
  assert.equal(phaseOf({ status: 'accepted' }), 'claimed')
  assert.equal(phaseOf({ status: 'running' }), 'running')
  assert.equal(phaseOf({ status: 'running', stage: 'blocked' }), 'blocked')
  assert.equal(phaseOf({ status: 'running', stage: 'needs_input' }), 'waiting_input')
  assert.equal(phaseOf({ status: 'running', question: { text: '?' } }), 'waiting_input')
  assert.equal(phaseOf({ status: 'waiting_input' }), 'waiting_input')
  assert.equal(phaseOf({ status: 'completed' }), 'completed')
  assert.equal(phaseOf({ status: 'dead' }), 'failed')
  assert.equal(phaseOf({ status: 'cancelled' }), 'cancelled')
})

test('percentile', () => {
  assert.equal(percentile([], 0.5), undefined)
  assert.equal(percentile([3, 1, 2], 0.5), 2)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9)
})

test('timelineOf: time per phase, markers do not split it, old entries without phase/by still work', () => {
  const at = m => new Date(Date.UTC(2026, 0, 1) + m * MIN).toISOString()
  const task = {
    task_id: 't', created_at: at(0), created_by: 'dsh-cloud', status: 'completed', result: { finished_at: at(60) },
    history: [
      { at: at(0), event: 'created' },
      { at: at(5), event: 'accepted', message: 'leased by quick (attempt 1)' },
      { at: at(6), event: 'progress', stage: 'step' },
      { at: at(20), event: 'progress', stage: 'needs_input' },
      { at: at(25), event: 'delivered', phase: 'waiting_input', by: 'dsh-cloud' },
      { at: at(40), event: 'answered', phase: 'running', by: 'dsh-cloud' },
      { at: at(60), event: 'completed' },
    ],
  }
  const view = timelineOf(task, Date.UTC(2026, 0, 2))
  assert.deepEqual(view.durations, { queue_ms: 5 * MIN, claim_ms: 1 * MIN, run_ms: 35 * MIN, waiting_ms: 20 * MIN, total_ms: 60 * MIN })
  assert.equal(view.events[1].by, 'quick')
  assert.equal(view.events[0].by, 'dsh-cloud')
  assert.equal(view.events[3].phase, 'waiting_input')
  assert.equal(view.events[5].gap_ms, 15 * MIN)
  assert.equal(view.phase, 'completed')
})

test('a question handed back waits on the human; the answer sends it back to the same worker with the answers', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'quick', { capabilities: ['code'], max_concurrency: 2 })
  await provision(hub, 'other', { capabilities: ['code'], max_concurrency: 2 })
  await hub.heartbeat('quick', {})
  await hub.heartbeat('other', {})
  const task = await dispatchTask(hub, { agent: 'pool:code', title: 'write it' })
  const { tasks: [leased] } = await hub.poll('quick')
  assert.equal(leased.task_id, task.task_id)
  assert.equal(leased.answers, undefined)
  const back = await hub.submitResult('quick', { task_id: task.task_id, status: 'partial', summary: 'half', needs_input: 'Postgres or SQLite?' })
  assert.equal(back.task_status, 'waiting_input')
  let view = await hub.getTask(task.task_id)
  assert.equal(view.phase, 'waiting_input')
  assert.equal(view.question.text, 'Postgres or SQLite?')
  assert.equal(view.assigned_to, undefined)
  // Nobody leases a task that waits on the human.
  assert.deepEqual((await hub.poll('other')).tasks, [])
  // Only the publisher answers.
  await expectHubError(() => hub.answer(CTL2, { task_id: task.task_id, answer: 'x' }), 403, 'not-creator')
  await expectHubError(() => hub.answer(CTL, { task_id: task.task_id, answer: '  ' }), 400, 'bad-answer')
  view = await hub.answer(CTL, { task_id: task.task_id, answer: 'SQLite' })
  assert.equal(view.status, 'pending')
  assert.equal(view.question, undefined)
  // The worker that asked gets it back first (sticky hold), attempt not counted.
  assert.deepEqual((await hub.poll('other')).tasks, [])
  const { tasks: [again] } = await hub.poll('quick')
  assert.equal(again.task_id, task.task_id)
  assert.equal(again.attempt, 1)
  assert.deepEqual(again.answers.map(a => [a.question, a.answer]), [['Postgres or SQLite?', 'SQLite']])
  await expectHubError(() => hub.answer(CTL, { task_id: task.task_id, answer: 'again' }), 409, 'no-question')
  await hub.submitResult('quick', { task_id: task.task_id, status: 'completed', summary: 'done' })
  const line = await hub.timeline(task.task_id)
  assert.deepEqual(line.events.map(e => e.event), ['created', 'accepted', 'waiting_input', 'answered', 'accepted', 'completed'])
  assert.deepEqual(line.events.map(e => e.by), [CTL, 'quick', 'quick', CTL, 'quick', 'quick'])
  assert.deepEqual(line.answers.map(a => a.answer), ['SQLite'])
  assert.equal(line.phase, 'completed')
})

test('a question asked while the worker keeps the task: answered via its next progress / heartbeat', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker')
  const task = await dispatchTask(hub)
  await hub.poll('worker')
  await hub.progress('worker', { task_id: task.task_id, stage: 'needs_input', message: 'Which branch?' })
  let view = await hub.getTask(task.task_id)
  assert.equal(view.phase, 'waiting_input')
  assert.equal(view.question.text, 'Which branch?')
  await hub.answer(CTL, { task_id: task.task_id, answer: 'main' })
  view = await hub.getTask(task.task_id)
  assert.equal(view.phase, 'running')
  const beat = await hub.heartbeat('worker', { running: [task.task_id] })
  assert.deepEqual(beat.answers?.map(a => [a.task_id, a.answer]), [[task.task_id, 'main']])
  // Handed over once.
  assert.equal((await hub.heartbeat('worker', { running: [task.task_id] })).answers, undefined)
  const reply = await hub.progress('worker', { task_id: task.task_id, renew: true })
  assert.equal(reply.answers, undefined)
})

test('answers reach the worker through progress too; a later step clears an open question', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker')
  const task = await dispatchTask(hub)
  await hub.poll('worker')
  await hub.progress('worker', { task_id: task.task_id, stage: 'needs_input', message: 'A or B?' })
  await hub.answer(CTL, { task_id: task.task_id, answer: 'B' })
  const reply = await hub.progress('worker', { task_id: task.task_id, renew: true })
  assert.deepEqual(reply.answers.map(a => a.answer), ['B'])
  await hub.progress('worker', { task_id: task.task_id, stage: 'needs_input', message: 'Ship it?' })
  await hub.progress('worker', { task_id: task.task_id, stage: 'step', message: 'found it myself' })
  assert.equal((await hub.getTask(task.task_id)).question, undefined)
})

test('putting away a question nobody will answer cancels it', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker')
  const task = await dispatchTask(hub)
  await hub.poll('worker')
  await hub.submitResult('worker', { task_id: task.task_id, status: 'partial', needs_input: '?' })
  const view = await hub.acknowledge(CTL, task.task_id)
  assert.equal(view.status, 'cancelled')
  assert.equal(view.acknowledged_by, CTL)
})

test('delivered and acknowledged are recorded once, with who, without moving the phase', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker')
  const task = await dispatchTask(hub)
  await hub.poll('worker')
  await hub.submitResult('worker', { task_id: task.task_id, status: 'completed', summary: 'ok' })
  assert.deepEqual((await hub.delivered(CTL, { task_ids: [task.task_id, 'nope'], profile: 'web' })).marked, [task.task_id])
  assert.deepEqual((await hub.delivered(CTL, { task_ids: [task.task_id] })).marked, [])
  await hub.acknowledge(CTL, task.task_id)
  const view = await hub.getTask(task.task_id)
  assert.equal(view.delivered_to, `${CTL}/web`)
  assert.equal(view.acknowledged_by, CTL)
  const line = await hub.timeline(task.task_id)
  assert.deepEqual(line.events.slice(-2).map(e => [e.event, e.phase, e.by]), [['delivered', 'completed', CTL], ['acknowledged', 'completed', CTL]])
  // Markers stay out of the feed (no chatter in the 作战室).
  const feed = await hub.feed({ after: 0 })
  assert.ok(!feed.events.some(e => e.kind === 'delivered' || e.kind === 'acknowledged'))
  await expectHubError(() => hub.delivered(CTL, { task_ids: [] }), 400)
})

test('audit log: every event in audit/<month>.jsonl, the timeline found after archive', async (t) => {
  const { hub, dataDir, clock } = await makeHub(t, { expiry: { archiveHours: 1 } })
  await provision(hub, 'worker')
  const task = await dispatchTask(hub)
  await hub.poll('worker')
  await hub.submitResult('worker', { task_id: task.task_id, status: 'completed', summary: 'ok' })
  const files = await readdir(join(dataDir, 'audit'))
  assert.deepEqual(files, ['2026-01.jsonl'])
  const lines = (await readFile(join(dataDir, 'audit', files[0]), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(lines.map(l => [l.task_id, l.event, l.by]), [[task.task_id, 'created', CTL], [task.task_id, 'accepted', 'worker'], [task.task_id, 'completed', 'worker']])
  clock.advance(2 * HOUR)
  await hub.sweep()
  assert.equal(await hub.read(state => state.tasks[task.task_id]), undefined, 'archived')
  const line = await hub.timeline(task.task_id)
  assert.equal(line.archived, true)
  assert.deepEqual(line.events.map(e => e.event), ['created', 'accepted', 'completed'])
  await expectHubError(() => hub.timeline('no-such-task'), 404)
})

test('a timeline whose history was cut at 200 entries is read whole from the audit log', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'worker')
  const task = await dispatchTask(hub)
  await hub.poll('worker')
  for (let i = 0; i < 230; i++) await hub.progress('worker', { task_id: task.task_id, stage: 'step', message: `step ${i}` })
  const line = await hub.timeline(task.task_id)
  assert.equal(line.events.length, 232)
  assert.equal(line.truncated, false)
  assert.equal(line.events[0].event, 'created')
})

test('the archive reader skips torn lines and finds the newest month first', async (t) => {
  const { hub, dataDir } = await makeHub(t)
  const dir = join(dataDir, 'archive')
  await mkdir(dir, { recursive: true })
  const rec = (month, title) => JSON.stringify({ task_id: 'old-1', title, status: 'completed', created_at: `2025-${month}-01T00:00:00.000Z`, created_by: CTL, history: [{ at: `2025-${month}-01T00:00:00.000Z`, event: 'created' }] })
  await writeFile(join(dir, '2025-01.jsonl.gz'), gzipSync(`${rec('01', 'jan')}\n{"task_id":"old-1", torn\n`))
  await writeFile(join(dir, '2025-02.jsonl.gz'), gzipSync(`${rec('02', 'feb')}\n`))
  const line = await hub.timeline('old-1')
  assert.equal(line.task.title, 'feb')
})

test('metrics: per worker counts, failure / ask rates, fallbacks, p50 / p90', async (t) => {
  const { hub, clock } = await makeHub(t)
  await provision(hub, 'quick', { max_concurrency: 8 })
  const ids = []
  for (let i = 0; i < 4; i++) ids.push((await dispatchTask(hub, { agent: 'quick', title: `t${i}` })).task_id)
  clock.advance(2 * MIN)
  await hub.poll('quick', { max: 4 })
  clock.advance(10 * MIN)
  await hub.submitResult('quick', { task_id: ids[0], status: 'completed', summary: 'ok' })
  await hub.submitResult('quick', { task_id: ids[1], status: 'failed', error: { code: 'X', message: 'no' } })
  await hub.submitResult('quick', { task_id: ids[2], status: 'partial', needs_input: '?' })
  const m = await hub.metrics({ hours: 24 })
  const row = m.workers.find(w => w.worker === 'quick')
  assert.equal(row.tasks, 4)
  assert.equal(row.completed, 1)
  assert.equal(row.failed, 1)
  assert.equal(row.open, 2)
  assert.equal(row.fail_rate, 0.5)
  assert.equal(row.asked_human, 1)
  assert.equal(row.ask_rate, 0.25)
  assert.equal(row.queue_ms_p50, 2 * MIN)
  assert.equal(row.run_ms_p50, 10 * MIN)
  assert.equal(m.total.tasks, 4)
  assert.equal(m.hours, 24)
  // Out of the window.
  clock.advance(48 * HOUR)
  assert.equal((await hub.metrics({ hours: 24 })).total.tasks, 0)
})

test('metricsOf groups local tasks by their DSH partition', () => {
  const at = new Date().toISOString()
  const out = metricsOf([
    { task_id: 'a', status: 'completed', created_at: at, origin: { kind: 'local', executor: 'dsh-self/web/coder' }, history: [] },
    { task_id: 'b', status: 'pending', created_at: at, history: [] },
  ])
  assert.deepEqual(out.workers.map(w => w.worker).sort(), ['dsh-self/web/coder', 'unassigned'])
})

test('due: overdue is reported once (notify) with the time it took; per capability, local and default minutes', async (t) => {
  const { hub, clock } = await makeHub(t, { due: { minutes: { default: 60, code: 30 } } })
  await provision(hub, 'worker', { capabilities: ['code', 'test'], max_concurrency: 4 })
  const code = await dispatchTask(hub, { capability: 'code' })
  const plain = await dispatchTask(hub)
  const own = await dispatchTask(hub, { due_minutes: 5 })
  assert.equal(code.due_at, new Date(Date.parse(code.created_at) + 30 * MIN).toISOString())
  assert.equal(plain.due_at, new Date(Date.parse(plain.created_at) + 60 * MIN).toISOString())
  await expectHubError(() => dispatchTask(hub, { due_minutes: 0 }), 400)
  await expectHubError(() => dispatchTask(hub, { on_overdue: 'panic' }), 400)
  await hub.poll('worker', { max: 3 })
  const ids = [code.task_id, plain.task_id, own.task_id]
  clock.advance(6 * MIN)
  await hub.heartbeat('worker', { running: ids })
  await hub.sweep()
  assert.equal((await hub.getTask(own.task_id)).overdue, true)
  assert.equal((await hub.getTask(code.task_id)).overdue, undefined)
  clock.advance(30 * MIN)
  await hub.heartbeat('worker', { running: ids })
  await hub.sweep()
  await hub.sweep()
  const view = await hub.getTask(code.task_id)
  assert.equal(view.overdue, true)
  assert.equal(view.status, 'accepted', 'notify leaves it with its worker')
  const feed = await hub.feed({ after: 0 })
  assert.equal(feed.events.filter(e => e.kind === 'overdue' && e.task_id === code.task_id).length, 1)
})

test('due: reassign takes an overdue task from its worker for another one', async (t) => {
  const { hub, clock } = await makeHub(t, { due: { minutes: { default: 10 }, onOverdue: 'reassign' } })
  await provision(hub, 'slow', { capabilities: ['code'] })
  await provision(hub, 'fast', { capabilities: ['code'] })
  await hub.heartbeat('slow', {})
  const task = await dispatchTask(hub, { agent: 'pool:code' })
  assert.equal((await hub.poll('slow')).tasks[0].task_id, task.task_id)
  clock.advance(11 * MIN)
  await hub.heartbeat('slow', { running: [task.task_id] })
  await hub.heartbeat('fast', {})
  await hub.sweep()
  let view = await hub.getTask(task.task_id)
  assert.equal(view.status, 'pending')
  assert.deepEqual((await hub.poll('slow')).tasks, [], 'not back to the worker it was taken from')
  assert.equal((await hub.poll('fast')).tasks[0].task_id, task.task_id)
  view = await hub.getTask(task.task_id)
  assert.equal(view.attempts, 1)
})
