/**
 * Task order (stage / depends_on), suspension with a prerequisite, a manager
 * kept waiting for held-back tasks, and the workspace file listing.
 *
 * POSIX temp paths only, so this file runs on any host.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { apply } from '../lib/index.js'
import { TaskBoard } from '../lib/board.js'
import { gateOf, groupProgress, progressLine } from '../lib/order.js'
import { FileListError, listPartitionDir, partitionProblems, safeRelative } from '../lib/files.js'

const tempDirs = []
const scratch = (prefix = 'host-router-order-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })

const fakeAgent = id => ({ id, session: { id, header: { id, cwd: '/w' } } })

function harness() {
  const tools = new Map()
  const starts = []
  const sent = []
  const activations = []
  const agents = new Map()
  const ctx = {
    tools: { register(d) { tools.set(d.name, d); return () => tools.delete(d.name) } },
    logger: { info() {}, warn() {} },
    on() { return () => {} },
    effect(run) { return run() },
    get(name) {
      if (name === 'agents') return { get: id => agents.get(id), async create() { throw new Error('no create in test') } }
      if (name === 'sessionQuery') return { async readSession(id) { return { session: { id }, events: [] } }, async listSessions() { return [] } }
      if (name === 'subagents') {
        return {
          async startActivation(spec) {
            starts.push(spec)
            let settle
            const result = new Promise((resolve) => { settle = resolve })
            const activation = { childId: `child-${String(activations.length + 1)}`, name: `agent-${String(activations.length + 1)}`, result, async dispose() {}, settle }
            activations.push(activation)
            return activation
          },
          async sendMessage(sender, targetId, content) { sent.push({ sender: sender.id, targetId, text: content[0]?.text }); return `msg-${String(sent.length)}` },
          interrupt() {},
        }
      }
      return undefined
    },
  }
  return { ctx, tools, starts, sent, activations, agents }
}

async function waitFor(check, label, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${label}`)
}

const promptOf = spec => (Array.isArray(spec.prompt) ? spec.prompt.map(block => block.text ?? '').join('') : String(spec.prompt))
const done = text => ({ stopReason: 'completed', output: [{ type: 'text', text }] })
const exec = agent => ({ agent, signal: new AbortController().signal })

async function boot({ manager = false } = {}) {
  const dir = scratch()
  const root = join(dir, 'front')
  mkdirSync(root)
  const h = harness()
  const user = fakeAgent('root')
  h.agents.set('root', user)
  await apply(h.ctx, {
    boardDir: join(dir, 'board'), manager, resumeDelayMs: 60_000, progressNoticeDelayMs: 10,
    partitions: [{ name: 'front', root, workers: 0 }],
  })
  const call = (name, args, agent = user) => h.tools.get(name).execute(args, exec(agent))
  const board = async () => TaskBoard.open(join(dir, 'board'))
  return { dir, h, user, call, board }
}

test('stage 2 waits until every stage 1 sibling is done, then starts on its own', async () => {
  const { h, call, board } = await boot()
  const ids = []
  for (const [index, stage] of [1, 1, 1, 2, 2, 2].entries()) {
    const out = await call('route_task', { text: `piece ${String(index + 1)}`, partition: 'front', parent_task: 'mgr', stage })
    ids.push(out.task)
    if (stage === 2) assert.match(out.text, /Waiting for/)
  }
  assert.equal(h.starts.length, 3)
  assert.deepEqual(h.starts.map(spec => promptOf(spec).match(/piece \d/)[0]), ['piece 1', 'piece 2', 'piece 3'])
  assert.equal((await board()).get(ids[3]).state, 'queued')

  h.activations[0].settle(done('one'))
  h.activations[1].settle(done('two'))
  await waitFor(async () => (await board()).get(ids[1]).state === 'done', 'two settled')
  assert.equal(h.starts.length, 3, 'stage 2 must not start while a stage 1 task is open')

  h.activations[2].settle(done('three'))
  await waitFor(() => h.starts.length === 6, 'stage 2 started')
  assert.deepEqual(h.starts.slice(3).map(spec => promptOf(spec).match(/piece \d/)[0]), ['piece 4', 'piece 5', 'piece 6'])
})

test('depends_on: a failed prerequisite parks the task; retrying it lets the task continue', async () => {
  const { h, call, board } = await boot()
  const a = (await call('route_task', { text: 'build api', partition: 'front' })).task
  const b = (await call('route_task', { text: 'build page', partition: 'front', depends_on: [a] })).task
  await assert.rejects(call('route_task', { text: 'x', partition: 'front', depends_on: ['nope'] }), /unknown task id/)
  assert.equal(h.starts.length, 1)

  h.activations[0].settle({ stopReason: 'error', output: [] })
  await waitFor(async () => (await board()).get(b).state === 'blocked', 'b parked')
  assert.match((await board()).get(b).resumeNote, /失败/)

  await call('task_control', { task_id: a, action: 'retry' })
  await waitFor(async () => (await board()).get(b).state === 'queued', 'b back in queue')
  assert.equal(h.starts.length, 2)
  h.activations[1].settle(done('api ok'))
  await waitFor(() => h.starts.length === 3, 'b started')
  assert.match(promptOf(h.starts[2]), /build page/)
})

test('a worker suspends itself on a prerequisite and is continued in its own session with the result', async () => {
  const { dir, h, call, board } = await boot()
  const w = (await call('route_task', { text: 'write the page', partition: 'front' })).task
  const worker = fakeAgent('child-1')
  const out = await call('task_suspend', { task_id: w, reason: 'needs the api first', prerequisite: 'add GET /api/items' }, worker)
  assert.match(out.text, /End your turn now/)
  const rows = (await board()).list()
  const pre = rows.find(row => row.id !== w)
  assert.equal((await board()).get(w).state, 'suspended')
  assert.deepEqual((await board()).get(w).waitingOn, [pre.id])
  assert.equal(pre.priority, 1)
  assert.equal(h.starts.length, 2, 'the prerequisite starts right away')

  // The suspended worker ends its turn: that must not close the row.
  h.activations[0].settle(done('suspending'))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal((await board()).get(w).state, 'suspended')

  h.activations[1].settle(done('--- report ---\nsummary: added GET /api/items\ntouched: api.ts\nleft: none'))
  await waitFor(async () => (await board()).get(w).state === 'running', 'worker continued')
  const wake = h.sent.find(message => message.targetId === 'child-1')
  assert.ok(wake, 'continued in the original session')
  assert.match(wake.text, /挂起的任务现在可以继续/)
  assert.match(wake.text, /added GET \/api\/items/)
  await waitFor(() => {
    try {
      const snapshot = JSON.parse(readFileSync(join(dir, 'board', 'snapshot.json'), 'utf8'))
      return (snapshot.notices ?? []).some(entry => /继续执行/.test(entry.text))
    } catch { return false }
  }, 'progress notice recorded')
})

test('a delivered task can be suspended on an existing task and is told it delivered before', async () => {
  const { h, call, board } = await boot()
  const a = (await call('route_task', { text: 'first', partition: 'front' })).task
  h.activations[0].settle(done('first done'))
  await waitFor(async () => (await board()).get(a).state === 'done', 'a done')
  const b = (await call('route_task', { text: 'second', partition: 'front' })).task
  await call('task_suspend', { task_id: a, reason: 'missed the migration', wait_for: [b] })
  assert.equal((await board()).get(a).state, 'suspended')
  h.activations[1].settle(done('second done'))
  await waitFor(() => h.sent.some(message => message.targetId === 'child-1'), 'a woken')
  assert.match(h.sent.find(message => message.targetId === 'child-1').text, /之前已经交付过/)
})

test('a manager that ends while a stage is still waiting is woken to keep waiting', async () => {
  const { h, call, board } = await boot({ manager: true })
  const m = (await call('route_task', { text: 'feature', partition: 'front' })).task
  const mgr = fakeAgent('child-1')
  h.agents.set('child-1', mgr)
  await call('route_task', { text: 'step one', partition: 'front', parent_task: m, stage: 1 }, mgr)
  const second = (await call('route_task', { text: 'step two', partition: 'front', parent_task: m, stage: 2 }, mgr)).task
  assert.equal(h.starts.length, 2)
  h.agents.delete('child-1') // its turn ends
  h.activations[0].settle(done('dispatched both'))
  await waitFor(() => h.sent.some(message => message.targetId === 'child-1'), 'manager woken')
  assert.match(h.sent.find(message => message.targetId === 'child-1').text, /task_wait/)
  assert.equal((await board()).get(m).state, 'running')
  assert.equal((await board()).get(m).rewakes, 1)

  // task_wait returns when a watched task changes.
  const waiting = call('task_wait', { parent_task: m, timeout_seconds: 5 })
  h.activations[1].settle(done('one ok'))
  const result = await waiting
  assert.equal(result.settled, false)
  assert.match(result.text, new RegExp(second))
})

test('order helpers: gate and per-request progress', () => {
  const at = '2026-01-01T00:00:00Z'
  const row = (id, over = {}) => ({ id, partition: 'p', subject: id, body: id, state: 'queued', cwd: '/', priority: 0, level: 'worker', reason: 'explicit', because: [], attempts: 0, createdAt: at, updatedAt: at, ...over })
  const rows = [
    row('m', { level: 'manager', state: 'running' }),
    row('a', { parentId: 'm', stage: 1, state: 'done' }),
    row('b', { parentId: 'm', stage: 1, state: 'running' }),
    row('c', { parentId: 'm', stage: 2 }),
    row('d', { parentId: 'm', dependsOn: ['x'] }),
    row('x', { state: 'cancelled' }),
  ]
  assert.deepEqual(gateOf(rows[3], rows), { kind: 'wait', on: ['b'] })
  assert.equal(gateOf(rows[4], rows).kind, 'dead')
  const group = groupProgress(rows).find(entry => entry.rootId === 'm')
  assert.equal(group.total, 4)
  assert.equal(group.finished, 1)
  assert.equal(group.waiting, 2)
  assert.match(progressLine(group), /1\/4 完成/)
})

test('workspace listing stays inside the partition and marks out-of-scope entries', async () => {
  const root = scratch('host-router-files-')
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'vendor'))
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'src', 'a.ts'), 'x')
  writeFileSync(join(root, 'notes.log'), 'x')
  const partition = { name: 'p', root, dir: root, slots: 1, managerEnabled: false, exclude: ['vendor/**', '**/*.log'] }
  const top = await listPartitionDir(partition, '')
  assert.deepEqual(top.entries.map(entry => entry.name), ['src', 'vendor', 'notes.log'])
  assert.equal(top.entries.find(entry => entry.name === 'vendor').inScope, false)
  assert.equal(top.entries.find(entry => entry.name === 'src').inScope, true)
  assert.equal(top.entries.find(entry => entry.name === 'notes.log').inScope, false)
  assert.deepEqual((await listPartitionDir(partition, 'src')).entries.map(entry => entry.path), ['src/a.ts'])
  assert.throws(() => safeRelative('../etc'), FileListError)
  assert.throws(() => safeRelative('/etc'), FileListError)
  assert.throws(() => safeRelative('node_modules'), FileListError)
  const problems = await partitionProblems([
    partition,
    { name: 'q', root: join(root, 'src'), dir: join(root, 'src'), slots: 1, managerEnabled: false },
    { name: 'gone', root: join(root, 'missing'), dir: join(root, 'missing'), slots: 1, managerEnabled: false },
  ])
  assert.ok(problems.some(problem => problem.partition === 'gone' && problem.level === 'error'))
  assert.ok(problems.some(problem => problem.partition === 'p' && /嵌套/.test(problem.message)))
})
