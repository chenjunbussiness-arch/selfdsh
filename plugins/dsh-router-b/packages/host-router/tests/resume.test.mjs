/**
 * Restart survival: a row the previous process left in flight is resumed in its
 * own session from its log, not recorded as failed and redone from scratch.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { apply } from '../lib/index.js'
import { TaskBoard } from '../lib/board.js'

const tempDirs = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-router-resume-'))
  tempDirs.push(dir)
  return dir
}
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })

const fakeAgent = id => ({ id, session: { id, header: { id, cwd: '/w' } } })

function harness({ logs = [] } = {}) {
  const tools = new Map()
  const starts = []
  const sent = []
  const activations = []
  const agents = new Map()
  const logMap = new Map(logs)
  const info = []
  const ctx = {
    tools: { register(d) { tools.set(d.name, d); return () => tools.delete(d.name) } },
    logger: { info(...a) { info.push(a.join(' ')) }, warn(...a) { info.push(`WARN ${a.join(' ')}`) } },
    on() { return () => {} },
    effect(run) { return run() },
    get(name) {
      if (name === 'agents') return { get: id => agents.get(id), async create() { throw new Error('no create in test') } }
      if (name === 'sessionQuery') {
        return {
          async readSession(id) {
            const events = logMap.get(id)
            if (events === undefined) throw new Error(`no log for ${id}`)
            return { session: { id }, events }
          },
        }
      }
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
  return { ctx, tools, starts, sent, activations, agents, info }
}

const partitions = [{ name: 'front', root: '/w/front', workers: 0 }]
const now = () => new Date().toISOString()
const row = over => ({
  partition: 'front', subject: over.id, body: `do ${over.id}`, cwd: '/w/front', priority: 0,
  reason: 'explicit', because: [], attempts: 1, runToken: 'run-dead', createdAt: now(), updatedAt: now(), ...over,
})

async function waitFor(check, label, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${label}`)
}

/** Seed a board left behind by a dead process, plus the persisted anchor id. */
async function seed(dir, rows) {
  const board = await TaskBoard.open(dir) // tokenless: no reconcile
  for (const r of rows) await board.add(r)
  writeFileSync(join(dir, 'anchor.json'), JSON.stringify({ sessionId: 'anchor' }))
}

const running = [{ type: 'turn/start', data: {} }]
const completed = [
  { type: 'turn/start', data: {} },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'all done' }] } } },
  { type: 'turn/end', data: { reason: { kind: 'completed' } } },
]

test('reconcile files in-flight rows as interrupted (with a session) or queued (without)', async () => {
  const dir = scratch()
  await seed(dir, [
    row({ id: 't-mgr', level: 'manager', state: 'running', sessionId: 'm1' }),
    row({ id: 't-new', level: 'worker', state: 'dispatched' }),
  ])
  const board = await TaskBoard.open(dir, 'run-alive')
  assert.equal(board.get('t-mgr').state, 'interrupted')
  assert.match(board.get('t-mgr').error, /resumed from its log/)
  assert.equal(board.get('t-new').state, 'queued')
})

test('boot resumes interrupted rows in their own sessions, managers first, and drives the queue', async () => {
  const dir = scratch()
  await seed(dir, [
    row({ id: 't-wrk', level: 'worker', state: 'running', sessionId: 'w1', parentId: 't-mgr', createdAt: '2026-01-01T00:00:01Z' }),
    row({ id: 't-mgr', level: 'manager', state: 'running', sessionId: 'm1', createdAt: '2026-01-01T00:00:02Z' }),
    row({ id: 't-done', level: 'worker', state: 'running', sessionId: 'd1' }),
    row({ id: 't-new', level: 'worker', state: 'dispatched' }),
  ])
  const h = harness({ logs: [['m1', running], ['w1', running], ['d1', completed]] })
  h.agents.set('anchor', fakeAgent('anchor'))
  await apply(h.ctx, { boardDir: dir, manager: false, resumeDelayMs: 10, partitions })

  await waitFor(async () => h.sent.length === 2 && h.starts.length === 1
    && (await TaskBoard.open(dir)).get('t-new').state === 'dispatched', 'two resumes and one fresh start')
  // Same sessions, not new ones; the manager before its worker.
  assert.deepEqual(h.sent.map(m => m.targetId), ['m1', 'w1'])
  assert.ok(h.sent.every(m => m.sender === 'anchor'))
  assert.match(h.sent[0].text, /从中断的那一步继续/)
  const board = await TaskBoard.open(dir)
  assert.equal(board.get('t-mgr').state, 'running')
  assert.equal(board.get('t-mgr').resumes, 1)
  assert.equal(board.get('t-wrk').state, 'running')
  // Finished just before the stop: closed from its log, no second turn.
  assert.equal(board.get('t-done').state, 'done')
  assert.equal(board.get('t-done').result, 'all done')
  // Never had a session: started normally.
  assert.equal(board.get('t-new').state, 'dispatched')
})

test('a row interrupted too many times is left for a human instead of looping', async () => {
  const dir = scratch()
  await seed(dir, [row({ id: 't-loop', level: 'worker', state: 'running', sessionId: 'l1', resumes: 3 })])
  const h = harness({ logs: [['l1', running]] })
  h.agents.set('anchor', fakeAgent('anchor'))
  await apply(h.ctx, { boardDir: dir, manager: false, resumeDelayMs: 10, partitions })
  await waitFor(async () => (await TaskBoard.open(dir)).get('t-loop').state === 'failed', 'resume limit')
  assert.equal(h.sent.length, 0)
  assert.match((await TaskBoard.open(dir)).get('t-loop').error, /interrupted 3 times/)
})

test('task_control resume continues an aborted row in its own session', async () => {
  const dir = scratch()
  await seed(dir, [row({ id: 't-old', level: 'manager', state: 'failed', sessionId: 'o1', error: 'worker ended with stopReason "aborted"' })])
  const h = harness({ logs: [['o1', running]] })
  h.agents.set('anchor', fakeAgent('anchor'))
  await apply(h.ctx, { boardDir: dir, manager: false, resumeDelayMs: 10, partitions })
  const call = h.tools.get('task_control').execute
  const out = await call({ task_id: 't-old', action: 'resume' }, { agent: fakeAgent('anchor'), signal: new AbortController().signal })
  assert.match(out.text, /resumed session o1/)
  assert.deepEqual(h.sent.map(m => m.targetId), ['o1'])
  assert.equal((await TaskBoard.open(dir)).get('t-old').state, 'running')
})

// Last: SIGTERM flips a process-wide flag that later tests would inherit.
test('a child stopped during shutdown becomes interrupted, not failed', async () => {
  const dir = scratch()
  const h = harness()
  const root = fakeAgent('root')
  h.agents.set('root', root)
  await apply(h.ctx, { boardDir: dir, manager: false, resumeDelayMs: 60_000, partitions })
  await h.tools.get('route_task').execute({ text: 'slow job', partition: 'front' }, { agent: root, signal: new AbortController().signal })
  const id = (await TaskBoard.open(dir)).list()[0].id
  process.emit('SIGTERM')
  h.activations[0].settle({ stopReason: 'aborted', output: [] })
  await waitFor(async () => (await TaskBoard.open(dir)).get(id).state !== 'dispatched', 'settlement')
  const task = (await TaskBoard.open(dir)).get(id)
  assert.equal(task.state, 'interrupted')
  assert.equal(task.sessionId, 'child-1')
})
