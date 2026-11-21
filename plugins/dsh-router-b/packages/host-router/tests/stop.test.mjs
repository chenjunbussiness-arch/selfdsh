/**
 * Stopping work by hand: one worker, a whole request (manager and its
 * workers), and the notice a still-running manager gets.
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

const tempDirs = []
const scratch = (prefix = 'host-router-stop-') => {
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
  const interrupted = []
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
          interrupt(targetId) { interrupted.push(targetId) },
        }
      }
      return undefined
    },
  }
  return { ctx, tools, starts, sent, activations, agents, interrupted }
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


test('a human stop of one worker interrupts it, keeps it stopped, and tells the running manager', async () => {
  const { h, call, board } = await boot({ manager: true })
  const m = (await call('route_task', { text: 'feature', partition: 'front' })).task
  const mgr = fakeAgent('child-1')
  h.agents.set('child-1', mgr)
  const one = (await call('route_task', { text: 'step one', partition: 'front', parent_task: m }, mgr)).task
  const two = (await call('route_task', { text: 'step two', partition: 'front', parent_task: m }, mgr)).task
  assert.equal(h.starts.length, 3)

  const out = await call('task_control', { task_id: one, action: 'cancel', value: '方向错了', by: 'human' })
  assert.match(out.text, /cancelled \(interrupted child-2\)/)
  assert.deepEqual(h.interrupted, ['child-2'])
  const row = (await board()).get(one)
  assert.equal(row.state, 'cancelled')
  assert.match(row.error, /人工停止: 方向错了/)
  const notice = h.sent.find(message => message.targetId === 'child-1')
  assert.ok(notice, 'the manager is told')
  assert.match(notice.text, new RegExp(`${one}.*不要重新派发`, 's'))

  // The interrupted turn settling afterwards does not turn the row into a failure.
  h.activations[1].settle({ stopReason: 'aborted', output: [] })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal((await board()).get(one).state, 'cancelled')
  assert.equal((await board()).get(two).state === 'running' || (await board()).get(two).state === 'dispatched', true)

  // Stopping an already stopped row is a no-op.
  assert.match((await call('task_control', { task_id: one, action: 'cancel', by: 'human' })).text, /already ended/)
})

test('cancel_tree stops the manager first, then every open worker under it, and skips finished ones', async () => {
  const { h, call, board } = await boot({ manager: true })
  const m = (await call('route_task', { text: 'feature', partition: 'front' })).task
  const mgr = fakeAgent('child-1')
  h.agents.set('child-1', mgr)
  const one = (await call('route_task', { text: 'step one', partition: 'front', parent_task: m, stage: 1 }, mgr)).task
  const two = (await call('route_task', { text: 'step two', partition: 'front', parent_task: m, stage: 1 }, mgr)).task
  const three = (await call('route_task', { text: 'step three', partition: 'front', parent_task: m, stage: 2 }, mgr)).task
  h.activations[1].settle(done('one ok'))
  await waitFor(async () => (await board()).get(one).state === 'done', 'one done')

  const out = await call('task_control', { task_id: m, action: 'cancel_tree', by: 'human' })
  assert.match(out.text, /stopped 3 task\(s\)/)
  const after = await board()
  assert.equal(after.get(one).state, 'done', 'finished work is left alone')
  for (const id of [m, two, three]) assert.equal(after.get(id).state, 'cancelled', id)
  assert.match(after.get(m).error, /人工停止整个需求/)
  assert.deepEqual(h.interrupted, ['child-1', 'child-3'], 'manager first; the queued stage 2 row had no worker')
  assert.equal(h.starts.length, 3, 'nothing new starts after the stop')
  // The stopped manager is not woken to wait for children.
  assert.equal(h.sent.filter(message => message.targetId === 'child-1').length, 0)
})

test('a stopped row can be retried', async () => {
  const { h, call, board } = await boot()
  const a = (await call('route_task', { text: 'build api', partition: 'front' })).task
  await call('task_control', { task_id: a, action: 'cancel', by: 'human' })
  assert.equal((await board()).get(a).state, 'cancelled')
  await call('task_control', { task_id: a, action: 'retry' })
  assert.equal(h.starts.length, 2)
  assert.notEqual((await board()).get(a).state, 'cancelled')
})
