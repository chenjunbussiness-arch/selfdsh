/**
 * Partition memory, the manager's view of its sessions, and the manager model.
 *
 * POSIX temp paths only, so this file runs on any host.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { apply } from '../lib/index.js'
import { TaskBoard } from '../lib/board.js'
import { LOG_LIMIT, MemoryStore, memoryBrief, memoryFileStem, renderTranscript, sessionRoster } from '../lib/memory.js'
import { managerRouteOf, normaliseSettings, strongestRoute } from '../lib/tier.js'

const tempDirs = []
const scratch = (prefix = 'host-router-memory-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })

const fakeAgent = id => ({ id, session: { id, header: { id, cwd: '/w' } } })
const exec = agent => ({ agent, signal: new AbortController().signal })
const done = text => ({ stopReason: 'completed', output: [{ type: 'text', text }] })
const promptOf = spec => (Array.isArray(spec.prompt) ? spec.prompt.map(block => block.text ?? '').join('') : String(spec.prompt))

async function waitFor(check, label, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${label}`)
}

const MODELS = [
  { provider: 'kiro', providerName: 'kiro', model: 'kiro/claude-haiku-5.5', name: 'kiro/claude-haiku-5.5' },
  { provider: 'kiro', providerName: 'kiro', model: 'kiro/claude-opus-5.5', name: 'kiro/claude-opus-5.5', efforts: ['low', 'medium', 'high'] },
  { provider: 'kiro', providerName: 'kiro', model: 'kiro/claude-sonnet-5.5', name: 'kiro/claude-sonnet-5.5' },
  { provider: 'gemini', providerName: 'Gemini', model: 'gemini-3.1-flash-lite', name: 'gemini-3.1-flash-lite' },
]

function harness({ logs = {}, models = MODELS } = {}) {
  const tools = new Map()
  const starts = []
  const activations = []
  const agents = new Map()
  const ctx = {
    tools: { register(d) { tools.set(d.name, d); return () => tools.delete(d.name) } },
    logger: { info() {}, warn() {} },
    on() { return () => {} },
    effect(run) { return run() },
    get(name) {
      if (name === 'agents') return { get: id => agents.get(id), async create() { throw new Error('no create in test') } }
      if (name === 'sessionQuery') return { async readSession(id) { return { session: { id }, events: logs[id] ?? [] } }, async listSessions() { return [] } }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'kiro', model: 'kiro/claude-sonnet-5.5' }) }
      if (name === 'llm') {
        return {
          listProviders: () => [...new Set(models.map(item => item.provider))].map(id => ({ id, name: id })),
          async listModels(provider) { return models.filter(item => item.provider === provider).map(item => ({ id: item.model, name: item.name })) },
          async resolveModelInfo(provider, model) {
            const found = models.find(item => item.provider === provider && item.model === model)
            return found?.efforts === undefined ? {} : { reasoning: { efforts: found.efforts.map(id => ({ id })) } }
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
          async sendMessage() { return 'msg-1' },
          interrupt() {},
        }
      }
      return undefined
    },
  }
  return { ctx, tools, starts, activations, agents }
}

async function boot(options = {}) {
  const dir = scratch()
  const root = join(dir, 'front')
  mkdirSync(root)
  const h = harness(options)
  const user = fakeAgent('root')
  h.agents.set('root', user)
  await apply(h.ctx, {
    boardDir: join(dir, 'board'), manager: options.manager ?? true, resumeDelayMs: 60_000, progressNoticeDelayMs: 10,
    partitions: [{ name: 'front', root, workers: 0 }],
  })
  const call = (name, args, agent = user) => h.tools.get(name).execute(args, exec(agent))
  const board = async () => TaskBoard.open(join(dir, 'board'))
  return { dir, h, user, call, board }
}

const report = (summary, touched) => `ok\n--- report ---\nsummary: ${summary}\ntouched: ${touched}\nleft: none\n`

test('memory store: record replaces by task, notes add and remove, survives reopen', async () => {
  const dir = scratch()
  const store = await MemoryStore.open(dir, ['a'])
  await store.record('a', { at: '2026-11-01T00:00:00Z', taskId: 'T1', level: 'worker', subject: 'first try', state: 'failed' })
  await store.record('a', { at: '2026-11-01T01:00:00Z', taskId: 'T1', level: 'worker', subject: 'first try', state: 'done', summary: 'fixed it' })
  const note = await store.addNote('a', '接口统一走 /api/v2', 'manager', 'T0')
  await store.addNote('a', 'temporary', 'human')
  await assert.rejects(store.addNote('a', '   ', 'human'), /needs text/)
  await assert.rejects(store.addNote('a', 'x'.repeat(601), 'human'), /at most/)
  assert.equal(await store.removeNote('a', 'n-missing'), false)
  const reopened = await MemoryStore.open(dir)
  const doc = await reopened.read('a')
  assert.equal(doc.log.length, 1)
  assert.equal(doc.log[0].state, 'done')
  assert.equal(doc.notes.length, 2)
  assert.equal(await reopened.removeNote('a', note.id), true)
  assert.deepEqual((await reopened.read('a')).notes.map(item => item.text), ['temporary'])
  // A partition name is never a path.
  assert.equal(memoryFileStem('../x/y'), '__x_y')
})

test('memory store: the log is capped and seed only fills an empty log', async () => {
  const store = await MemoryStore.open(scratch())
  const entries = Array.from({ length: LOG_LIMIT + 5 }, (_, index) => ({
    at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), taskId: `T${String(index)}`, level: 'worker', subject: `t${String(index)}`, state: 'done',
  }))
  assert.equal(await store.seed('a', entries), LOG_LIMIT)
  const doc = await store.read('a')
  assert.equal(doc.log[0].taskId, 'T5')
  assert.equal(await store.seed('a', entries), 0)
})

test('brief lists notes, recent work newest first, and open sessions before finished ones', () => {
  const now = Date.parse('2026-11-21T12:00:00Z')
  const memory = {
    version: 1,
    notes: [{ id: 'n-1', at: '2026-11-20T00:00:00Z', text: '前端用 pnpm，不要用 npm', by: 'human' }],
    log: [
      { at: '2026-11-21T10:00:00Z', taskId: 'T1', level: 'worker', subject: 'old', state: 'done', summary: 'did old', touched: ['a.ts'], sessionId: 's1' },
      { at: '2026-11-21T11:00:00Z', taskId: 'T2', level: 'worker', subject: 'newer', state: 'failed', error: 'boom' },
    ],
  }
  const row = (id, state, updatedAt, extra = {}) => ({
    id, partition: 'front', subject: `subject ${id}`, body: '', state, cwd: '/w', priority: 0, level: 'worker',
    reason: '', because: [], attempts: 1, sessionId: `s-${id}`, createdAt: updatedAt, updatedAt, ...extra,
  })
  const tasks = [
    row('T1', 'done', '2026-11-21T10:00:00Z', { summary: 'did old' }),
    row('T3', 'running', '2026-11-21T09:00:00Z'),
    row('T4', 'suspended', '2026-11-21T08:00:00Z', { suspendReason: 'needs api' }),
    { ...row('M1', 'done', '2026-11-21T11:30:00Z'), level: 'manager' },
  ]
  const text = memoryBrief(memory, tasks, { now })
  assert.match(text, /\[n-1\] 前端用 pnpm/)
  assert.ok(text.indexOf('T2 [failed]') < text.indexOf('T1 [done]'), 'newest work first')
  assert.match(text, /did: did old \| touched: a\.ts/)
  const roster = sessionRoster(tasks, 12, now)
  assert.deepEqual(roster.map(line => line.split(' ')[1]), ['T3', 'T4', 'T1'], 'open sessions first, managers excluded')
  assert.match(roster[1], /suspended: needs api/)
})

test('transcript reader renders messages, tool calls, results, and turn ends; skips unknown events', () => {
  const events = [
    { type: 'turn/start', seq: 1, time: 1 },
    { type: 'user/message', seq: 2, time: 2, data: { message: { role: 'user', content: [{ type: 'text', text: 'please fix the header' }] } } },
    { type: 'tool/call', seq: 3, time: 3, data: { name: 'edit', arguments: { path: 'src/Header.tsx' } } },
    { type: 'tool/result', seq: 4, time: 4, data: { output: [{ type: 'text', text: 'edited 3 lines' }] } },
    { type: 'something/new', seq: 5, time: 5, data: { foo: 1 } },
    { type: 'assistant/message', seq: 6, time: 6, data: { message: { content: [{ type: 'text', text: 'Header fixed.' }] } } },
    { type: 'turn/end', seq: 7, time: 7, data: { reason: { kind: 'completed' } } },
  ]
  const lines = renderTranscript(events)
  assert.deepEqual(lines, [
    '[user] please fix the header',
    '[tool] edit {"path":"src/Header.tsx"}',
    '[result] edited 3 lines',
    '[assistant] Header fixed.',
    '[turn end: completed]',
  ])
  assert.deepEqual(renderTranscript(events, 2), ['[assistant] Header fixed.', '[turn end: completed]'])
})

test('strongest model: flagship wording wins, top effort is used, defaults keep ties', () => {
  assert.deepEqual(strongestRoute(MODELS, undefined), { provider: 'kiro', model: 'kiro/claude-opus-5.5', reasoningEffort: 'high' })
  const deepseek = [
    { provider: 'ds', providerName: 'ds', model: 'deepseek-chat', name: 'DeepSeek Chat' },
    { provider: 'ds', providerName: 'ds', model: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
  ]
  assert.equal(strongestRoute(deepseek, undefined).model, 'deepseek-reasoner')
  const plain = [
    { provider: 'p', providerName: 'p', model: 'alpha', name: 'alpha' },
    { provider: 'p', providerName: 'p', model: 'beta', name: 'beta' },
  ]
  assert.equal(strongestRoute(plain, { provider: 'p', model: 'beta' }).model, 'beta', 'a tie keeps the default')
  assert.equal(strongestRoute([], { provider: 'p', model: 'beta' }).model, 'beta')
})

test('manager model: saved route, then hard tier, then strongest; inherit opts out', () => {
  const fallback = { provider: 'kiro', model: 'kiro/claude-sonnet-5.5' }
  const base = normaliseSettings({})
  assert.deepEqual(managerRouteOf(base, MODELS, fallback), { route: { provider: 'kiro', model: 'kiro/claude-opus-5.5', reasoningEffort: 'high' }, source: 'strongest' })
  const hard = normaliseSettings({ tiers: { hard: { provider: 'kiro', model: 'kiro/claude-opus-5.5' } } })
  assert.equal(managerRouteOf(hard, MODELS, fallback).source, 'hard')
  assert.equal(managerRouteOf(hard, MODELS, fallback).route.reasoningEffort, 'high')
  const saved = normaliseSettings({ manager: { provider: 'kiro', model: 'kiro/claude-sonnet-5.5' } })
  assert.deepEqual(managerRouteOf(saved, MODELS, fallback), { route: { provider: 'kiro', model: 'kiro/claude-sonnet-5.5' }, source: 'saved' })
  assert.deepEqual(managerRouteOf(normaliseSettings({ manager: 'inherit' }), MODELS, fallback), { source: 'inherit' })
  assert.equal(normaliseSettings({ manager: 'nonsense' }).manager, undefined)
})

test('a request goes to the manager on the strongest model; finished work lands in memory for the next manager', async () => {
  const { h, call, board, dir } = await boot()
  const first = await call('route_task', { text: '给首页加一个公告栏', partition: 'front' })
  assert.equal(h.starts.length, 1)
  assert.deepEqual(h.starts[0].agentOptions, { provider: 'kiro', model: 'kiro/claude-opus-5.5', reasoningEffort: 'high' })
  assert.match(promptOf(h.starts[0]), /What this partition remembers/)
  assert.match(promptOf(h.starts[0]), /\(nothing recorded yet\)/)
  await waitFor(async () => (await board()).get(first.task).tierSource === 'manager', 'manager model recorded')
  assert.match((await board()).get(first.task).tierReason, /manager model: strongest/)

  // The manager starts one worker; the worker finishes with a report.
  const manager = fakeAgent('child-1')
  h.agents.set('child-1', manager)
  const worker = await call('route_task', { text: 'add the notice bar component', partition: 'front', parent_task: first.task }, manager)
  assert.equal(h.starts.length, 2)
  h.activations[1].settle(done(report('added NoticeBar to the home page', 'src/NoticeBar.tsx, src/Home.tsx')))
  await waitFor(async () => (await board()).get(worker.task).state === 'done', 'worker done')

  // The manager keeps a lasting fact, then finishes.
  const noted = await call('partition_memory', { action: 'note', text: '公告栏组件放在 src/NoticeBar.tsx' }, manager)
  assert.match(noted.text, /noted in front/)
  h.activations[0].settle(done('公告栏加好了'))
  await waitFor(async () => (await board()).get(first.task).state === 'done', 'manager done')
  await waitFor(() => {
    try {
      return JSON.parse(readFileSync(join(dir, 'board', 'memory', 'front.json'), 'utf8')).log.length === 2
    } catch { return false }
  }, 'both rows logged')

  // The next request's manager starts with that history and the session it can read.
  await call('route_task', { text: '公告栏加一个关闭按钮', partition: 'front' })
  const next = promptOf(h.starts[2])
  assert.match(next, /公告栏组件放在 src\/NoticeBar\.tsx/)
  assert.match(next, new RegExp(`${worker.task} \\[done\\].*\\n.*did: added NoticeBar to the home page \\| touched: src/NoticeBar\\.tsx, src/Home\\.tsx`))
  assert.match(next, new RegExp(`${worker.task} session child-2 \\[done\\]`))

  // Reading memory from a manager defaults to its own partition.
  const read = await call('partition_memory', { action: 'read', query: 'NoticeBar' }, fakeAgent('child-3'))
  assert.match(read.text, /front memory: 1 note\(s\), 2 logged task\(s\)/)
})

test('session_list and session_read show a partition\'s worker sessions and what one did', async () => {
  const logs = {
    'child-1': [
      { type: 'user/message', seq: 1, time: 1, data: { message: { role: 'user', content: [{ type: 'text', text: 'rename the button' }] } } },
      { type: 'tool/call', seq: 2, time: 2, data: { name: 'edit', arguments: { path: 'Button.tsx' } } },
      { type: 'assistant/message', seq: 3, time: 3, data: { message: { content: [{ type: 'text', text: 'Renamed.' }] } } },
    ],
  }
  const { h, call, board } = await boot({ logs, manager: false })
  const out = await call('route_task', { text: 'rename the button', partition: 'front' })
  h.activations[0].settle(done(report('renamed Button to ActionButton', 'Button.tsx')))
  await waitFor(async () => (await board()).get(out.task).state === 'done', 'done')
  const list = await call('session_list', { partition: 'front' })
  assert.match(list.text, new RegExp(`${out.task} session child-1 \\[done\\].*did: renamed Button to ActionButton`))
  const read = await call('session_read', { task_id: out.task })
  assert.match(read.text, /did: renamed Button to ActionButton/)
  assert.match(read.text, /\[user\] rename the button\n\[tool\] edit \{"path":"Button\.tsx"\}\n\[assistant\] Renamed\./)
  const bySession = await call('session_read', { session_id: 'child-1', last: 1 })
  assert.match(bySession.text, /--- last 1 transcript entries ---\n\[assistant\] Renamed\./)
  await assert.rejects(call('session_read', { session_id: 'not-routed' }), /does not belong to any routed task/)
  await assert.rejects(call('session_list', { partition: 'nope' }), /unknown partition/)
})

test('memory is seeded from tasks that finished before memory existed', async () => {
  const dir = scratch()
  const root = join(dir, 'front')
  mkdirSync(root)
  const seededBoard = await TaskBoard.open(join(dir, 'board'))
  const now = new Date().toISOString()
  await seededBoard.add({
    id: 'T-old', partition: 'front', subject: 'old work', body: 'x', state: 'done', cwd: root, priority: 0,
    level: 'worker', reason: 'test', because: [], attempts: 1, summary: 'did the old work', createdAt: now, updatedAt: now,
  })
  const h = harness()
  h.agents.set('root', fakeAgent('root'))
  await apply(h.ctx, { boardDir: join(dir, 'board'), manager: true, partitions: [{ name: 'front', root, workers: 0 }] })
  const read = await h.tools.get('partition_memory').execute({ action: 'read', partition: 'front' }, exec(fakeAgent('root')))
  assert.match(read.text, /T-old \[done\].*old work\n\s+did: did the old work/)
})
