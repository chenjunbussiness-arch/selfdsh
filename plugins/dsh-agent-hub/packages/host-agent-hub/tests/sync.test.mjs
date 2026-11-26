/**
 * sync.js: local router tasks mirrored to the hub (stage, session, result), offline
 * catch-up, and hub events turned into 作战室 lines.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { HubError } from '../hub-client.js'
import { createSync, hubTaskId, isOffline, lineOf, noticeOf, sessionEntriesOf, stageOf } from '../sync.js'
import { fakeLogger } from './helpers.mjs'

const offline = () => new HubError(503, 'hub-unreachable', 'hub unreachable')

function fakeClient() {
  const calls = []
  const c = {
    calls,
    down: false,
    refuse: new Set(),
    feed: { events: [], next: 0, latest: 0, reset: false },
    config: { controllerId: 'dsh-home' },
    guard(id) {
      if (c.down) throw offline()
      if (c.refuse.has(id)) throw new HubError(409, 'task-not-active', 'no', { fromHub: true })
    },
    async registerLocal(task) { c.guard(task.task_id); calls.push(['register', task.task_id, task.executor, task.dsh_profile, task.parent_task_id]); return { task_id: task.task_id } },
    async fallbackEvent(body) { c.guard(body.task_id); calls.push(body.renew ? ['renew', body.task_id] : ['event', body.task_id, body.stage, body.message]); return { ok: true } },
    async fallbackResult(body) { c.guard(body.task_id); calls.push(['result', body.task_id, body.status, body.summary, body.error?.code]); return { ok: true } },
    async cancel(id) { c.guard(id); calls.push(['cancel', id]); return {} },
    async appendSession(id, entries) { c.guard(id); calls.push(['session', id, entries.map(e => `${e.role}:${e.text}`)]); return { ok: true } },
    list: [],
    async listTasks() { if (c.down) throw offline(); calls.push(['list']); return c.list },
    async events({ after, wait }) {
      if (c.down) throw offline()
      calls.push(['events', after, wait])
      return c.feed
    },
    of(kind) { return calls.filter(x => x[0] === kind) },
  }
  return c
}

function row(id, state, extra = {}) {
  return { id, partition: 'web', subject: `做 ${id}`, state, level: 'worker', progress: 0.3, todos: { ratio: '0/0' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra }
}

async function setup(t, { rows = [], events = {}, notice = true, options = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const client = fakeClient()
  const board = { tasks: rows }
  const notices = []
  let clock = Date.parse('2026-11-24T10:00:00Z')
  const router = { snapshot: async () => board, ...(notice ? { notice: line => notices.push(line) } : {}) }
  const logger = fakeLogger()
  const make = () => createSync({
    client, logger, profile: 'web', stateFile: join(dir, 'sync-web.json'),
    router: () => router, sessions: () => ({ readSession: async id => ({ session: { id }, events: events[id] ?? [] }) }),
    now: () => clock, options,
  })
  return { client, board, notices, logger, dir, sync: make(), make, tick: ms => { clock += ms } }
}

test('hubTaskId is stable and always a valid hub id', () => {
  assert.equal(hubTaskId('web', 't-12'), 'local_web_t-12')
  assert.equal(hubTaskId('web', 'a/b c'), 'local_web_a-b-c')
  const long = hubTaskId('web', 'x'.repeat(200))
  assert.ok(long.length <= 96 && /^[A-Za-z0-9_.-]+$/.test(long))
  assert.equal(long, hubTaskId('web', 'x'.repeat(200)))
})

test('stage and line of router rows', () => {
  assert.equal(stageOf(row('a', 'queued')), 'received')
  assert.equal(stageOf(row('a', 'running')), 'step')
  assert.equal(stageOf(row('a', 'blocked')), 'blocked')
  assert.equal(stageOf(row('a', 'done')), undefined)
  assert.equal(lineOf(row('a', 'running', { todos: { ratio: '2/5', current: '写测试' } })), '2/5 写测试')
  assert.equal(lineOf(row('a', 'running', { activity: { lastTool: 'bash' } })), '正在用 bash')
  assert.equal(lineOf(row('a', 'blocked', { resumeNote: '需要密钥' })), '等你处理：需要密钥')
})

test('a DSH session log becomes hub session entries', () => {
  const entries = sessionEntriesOf([
    { type: 'user/message', seq: 1, time: 1, data: { message: { role: 'user', content: [{ type: 'text', text: '修登录' }] } } },
    { type: 'assistant/attempt', seq: 2, time: 2, data: {} },
    { type: 'assistant/message', seq: 3, time: 3, data: { message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } } },
    { type: 'tool/call', seq: 4, time: 4, data: { name: 'bash', arguments: { cmd: 'ls' } } },
    { type: 'tool/result', seq: 5, time: 5, data: { output: [{ type: 'text', text: 'a.txt' }] } },
    { type: 'turn/end', seq: 6, time: 6, data: { reason: { kind: 'stop' } } },
    { type: 'todo/write', seq: 7, time: 7, data: { todos: [] } },
  ])
  assert.deepEqual(entries.map(e => [e.role, e.name, e.text]), [
    ['user', undefined, '修登录'], ['assistant', undefined, '好'], ['tool', 'bash', '调用 {"cmd":"ls"}'],
    ['tool', 'result', 'a.txt'], ['note', undefined, '回合结束：stop'],
  ])
})

test('sessionEntriesOf reads DSH 0.2.2 tool results (data.message) and skips compaction re-surfacing', () => {
  const entries = sessionEntriesOf([
    { type: 'tool/result', seq: 1, time: 1, surfaceOp: 'append', data: { message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'Error: invalid arguments' }], isError: true } } },
    { type: 'tool/result', seq: 2, time: 2, surfaceOp: 'replace', data: { message: { toolCallId: 'c0', toolName: 'bash', content: [{ type: 'text', text: 'old' }] } } },
  ])
  assert.deepEqual(entries.map(e => [e.role, e.name, e.text, e.error]), [['tool', 'bash', 'Error: invalid arguments', true]])
})

test('isOffline: network and 5xx wait; a hub refusal does not', () => {
  assert.equal(isOffline(offline()), true)
  assert.equal(isOffline(new HubError(409, 'x', 'y', { fromHub: true })), false)
  assert.equal(isOffline(new HubError(502, 'x', 'y', { fromHub: true })), true)
})

test('mirror: register once, a line per change, steps throttled, session and result at the end', async (t) => {
  const s = await setup(t, { rows: [row('t1', 'queued')], events: { s1: [{ type: 'user/message', seq: 1, time: 1, data: { message: { role: 'user', content: '修登录' } } }] } })
  await s.sync.mirrorOnce()
  assert.deepEqual(s.client.of('register'), [['register', 'local_web_t1', 'dsh-self/web/web', 'web', undefined]])
  assert.deepEqual(s.client.of('event'), [['event', 'local_web_t1', 'received', '排队中']])

  s.board.tasks = [row('t1', 'running', { sessionId: 's1', todos: { ratio: '1/3', current: '改表单' } })]
  await s.sync.mirrorOnce()
  assert.deepEqual(s.client.of('event').at(-1), ['event', 'local_web_t1', 'step', '1/3 改表单'])
  assert.deepEqual(s.client.of('session'), [['session', 'local_web_t1', ['user:修登录']]])

  s.board.tasks = [row('t1', 'running', { sessionId: 's1', todos: { ratio: '2/3', current: '跑测试' } })]
  s.tick(5_000)
  await s.sync.mirrorOnce()
  assert.deepEqual(s.client.calls.at(-1), ['renew', 'local_web_t1'], 'a step 5 s later only renews')
  s.tick(30_000)
  await s.sync.mirrorOnce()
  assert.deepEqual(s.client.of('event').at(-1), ['event', 'local_web_t1', 'step', '2/3 跑测试'])

  s.board.tasks = [row('t1', 'done', { sessionId: 's1', result: '登录修好了' })]
  await s.sync.mirrorOnce()
  assert.deepEqual(s.client.of('result'), [['result', 'local_web_t1', 'completed', '登录修好了', undefined]])
  assert.equal(s.client.of('register').length, 1)
  const before = s.client.calls.length
  await s.sync.mirrorOnce()
  assert.equal(s.client.calls.length, before, 'a finished task is left alone')
})

test('mirror: failed and cancelled rows end the same way on the hub; parents link', async (t) => {
  const s = await setup(t, { rows: [row('p', 'running', { level: 'manager' }), row('c1', 'failed', { parentId: 'p', error: '测试没过' }), row('c2', 'cancelled', { parentId: 'p' })] })
  await s.sync.mirrorOnce()
  assert.deepEqual(s.client.of('register').map(c => [c[1], c[4]]), [['local_web_p', undefined], ['local_web_c1', 'local_web_p'], ['local_web_c2', 'local_web_p']])
  assert.deepEqual(s.client.of('result'), [['result', 'local_web_c1', 'failed', '测试没过', 'LOCAL_FAILED']])
  assert.deepEqual(s.client.of('cancel'), [['cancel', 'local_web_c2']])
})

test('mirror: old finished rows are not backfilled; recent ones are', async (t) => {
  const old = new Date(Date.parse('2026-11-23T00:00:00Z')).toISOString()
  const s = await setup(t, { rows: [row('old', 'done', { updatedAt: old }), row('new', 'done', { updatedAt: '2026-11-24T09:00:00Z' })] })
  await s.sync.mirrorOnce()
  assert.deepEqual(s.client.of('register').map(c => c[1]), ['local_web_new'])
})

test('offline: nothing is lost; the latest state, the session and the result go out once the hub is back, also after a restart', async (t) => {
  const s = await setup(t, { rows: [row('t1', 'running', { sessionId: 's1' })], events: { s1: [] } })
  await s.sync.mirrorOnce()
  s.client.down = true
  s.board.tasks = [row('t1', 'blocked', { sessionId: 's1', resumeNote: '要 VPN' })]
  await s.sync.mirrorOnce()
  assert.ok(s.logger.lines.some(l => l.startsWith('warn agent-hub sync: hub not reachable')))
  // the task finishes while offline, and DSH restarts (a new sync reads the state file)
  s.board.tasks = [row('t1', 'done', { sessionId: 's1', result: '好了' })]
  const restarted = s.make()
  await assert.doesNotReject(restarted.mirrorOnce())
  assert.equal(s.client.of('result').length, 0)
  s.client.down = false
  await restarted.mirrorOnce()
  assert.equal(s.client.of('register').length, 1, 'not registered again after the restart')
  assert.deepEqual(s.client.of('result'), [['result', 'local_web_t1', 'completed', '好了', undefined]])
  assert.ok(s.logger.lines.some(l => l.startsWith('info agent-hub sync: hub reachable again')))
  const saved = JSON.parse(await readFile(join(s.dir, 'sync-web.json'), 'utf8'))
  assert.equal(saved.tasks.t1.finished, true)
})

test('offline session entries go out after reconnect, none twice', async (t) => {
  const events = { s1: [{ type: 'user/message', seq: 1, time: 1, data: { message: { role: 'user', content: 'a' } } }] }
  const s = await setup(t, { rows: [row('t1', 'running', { sessionId: 's1' })], events })
  await s.sync.mirrorOnce()
  s.client.down = true
  events.s1.push({ type: 'assistant/message', seq: 2, time: 2, data: { message: { role: 'assistant', content: 'b' } } })
  s.tick(31_000)
  await s.sync.mirrorOnce()
  s.client.down = false
  s.board.tasks = [row('t1', 'done', { sessionId: 's1', result: 'ok' })]
  await s.sync.mirrorOnce()
  assert.deepEqual(s.client.of('session').map(c => c[2]), [['user:a'], ['assistant:b']])
})

test('a row the hub refuses is dropped from the mirror; the others go on', async (t) => {
  const s = await setup(t, { rows: [row('bad', 'running'), row('good', 'running')] })
  s.client.refuse.add('local_web_bad')
  await s.sync.mirrorOnce()
  await s.sync.mirrorOnce()
  assert.deepEqual(s.client.of('register').map(c => c[1]), ['local_web_good'])
  assert.ok(s.logger.lines.some(l => l.includes('bad not mirrored')))
})

test('stream: starts at the head, then other DSHs\' and workers\' events become 作战室 lines; our own mirror does not', async (t) => {
  const s = await setup(t)
  s.client.feed = { events: [], next: 7, latest: 7, reset: false }
  await s.sync.streamOnce(0)
  assert.equal(s.sync.state.cursor, 7, 'no replay of old history')
  s.client.feed = {
    next: 12, latest: 12, reset: false, events: [
      { seq: 8, kind: 'registered', task_id: 'local_ops_a', title: '备份', origin: { kind: 'local', by: 'dsh-office' } },
      { seq: 9, kind: 'progress', stage: 'step', task_id: 'local_web_t1', title: '自己的', origin: { kind: 'local', by: 'dsh-home' } },
      { seq: 10, kind: 'leased', task_id: 'task_1', title: '查日志', agent: 'code-desk', origin: { kind: 'controller', by: 'dsh-home' } },
      { seq: 11, kind: 'progress', stage: 'step', message: '跑测试', task_id: 'task_1', title: '查日志', agent: 'code-desk' },
      { seq: 12, kind: 'completed', message: '找到了', task_id: 'task_1', title: '查日志', agent: 'code-desk' },
    ],
  }
  await s.sync.streamOnce(0)
  // One line per task per read: its latest state.
  assert.deepEqual(s.notices, [
    'dsh-office 在本地开始 「备份」',
    '「查日志」（code-desk） 完成：找到了',
  ])
  assert.deepEqual(s.client.of('events').at(-1), ['events', 7, 0])
  assert.equal(s.sync.state.cursor, 12)
})

test('stream: the hub feed shape (origin as a kind string, created_by, dsh_profile) is filtered right', async (t) => {
  const s = await setup(t)
  s.sync.state.cursor = 0
  s.client.feed = {
    next: 4, latest: 4, reset: false, events: [
      { seq: 1, kind: 'registered', task_id: 'local_web_t1', title: '自己的', origin: 'local', created_by: 'dsh-home', dsh_profile: 'web' },
      { seq: 2, kind: 'completed', task_id: 'local_web_t1', title: '自己的', message: '好了', origin: 'local', created_by: 'dsh-home', dsh_profile: 'web' },
      { seq: 3, kind: 'registered', task_id: 'local_ops_t1', title: '备份', origin: 'local', created_by: 'dsh-home', dsh_profile: 'ops' },
      { seq: 4, kind: 'completed', task_id: 'task_9', title: '写周报', agent: 'quick-mydesk', origin: 'controller', created_by: 'dsh-home',
        message: '周报写好了。\n--- report ---\nsummary: x\ntouched: none\nleft: none' },
    ],
  }
  await s.sync.streamOnce(0)
  assert.deepEqual(s.notices, ['dsh-home（ops） 在本地开始 「备份」', '「写周报」（quick-mydesk） 完成：周报写好了。'])
})

test('stream: the same news for a task is told once, also after a restart; an old client\'s "working" is not news', async (t) => {
  const s = await setup(t)
  s.sync.state.cursor = 0
  const step = (seq, m) => ({ seq, kind: 'progress', stage: 'step', message: m, task_id: 'task_7', title: 'P7 收口', agent: 'quick-ws' })
  const keepAlive = seq => ({ seq, kind: 'progress', message: 'working', task_id: 'task_8', title: '另一件', agent: 'quick-ws' })
  s.client.feed = { events: [step(1, '测试已 7/7 通过'), keepAlive(2)], next: 2, latest: 2, reset: false }
  await s.sync.streamOnce(0)
  for (let i = 0; i < 50; i++) {
    s.tick(31_000)
    s.client.feed = { events: [step(3 + 2 * i, '测试已 7/7 通过'), keepAlive(4 + 2 * i)], next: 4 + 2 * i, latest: 4 + 2 * i, reset: false }
    await s.sync.streamOnce(0)
  }
  assert.deepEqual(s.notices, ['「P7 收口」（quick-ws） 进度：测试已 7/7 通过'])
  // A new DSH process with the same state file still remembers what it said.
  const again = s.make()
  s.tick(31_000)
  s.client.feed = { events: [step(200, '测试已 7/7 通过')], next: 200, latest: 200, reset: false }
  await again.streamOnce(0)
  assert.equal(s.notices.length, 1)
  s.client.feed = { events: [{ ...step(201, ''), kind: 'completed', message: '好了' }], next: 201, latest: 201, reset: false }
  await again.streamOnce(0)
  assert.deepEqual(s.notices.slice(1), ['「P7 收口」（quick-ws） 完成：好了'])
})

test('stream: step lines of one task at most every 30 s; a reset jumps to the head', async (t) => {
  const s = await setup(t)
  s.sync.state.cursor = 1
  const step = (seq, m) => ({ seq, kind: 'progress', stage: 'step', message: m, task_id: 'task_1', title: 'x' })
  s.client.feed = { events: [step(2, 'a'), step(3, 'b')], next: 3, latest: 3, reset: false }
  await s.sync.streamOnce(0)
  assert.deepEqual(s.notices, ['「x」 进度：a'])
  s.client.feed = { events: [], next: 3, latest: 900, reset: true }
  await s.sync.streamOnce(0)
  assert.equal(s.sync.state.cursor, 900)
})

test('stream without a router notice hook only logs', async (t) => {
  const s = await setup(t, { notice: false })
  s.sync.state.cursor = 0
  s.client.feed = { events: [{ seq: 1, kind: 'failed', message: 'boom', task_id: 't', title: 'y' }], next: 1, latest: 1, reset: false }
  await s.sync.streamOnce(0)
  assert.ok(s.logger.lines.includes('info agent-hub: 「y」 失败：boom'))
})

test('noticeOf skips plain step events without a message', () => {
  assert.equal(noticeOf({ kind: 'progress', stage: 'step', task_id: 't' }), undefined)
  assert.equal(noticeOf({ kind: 'progress', stage: 'blocked', message: '要密钥', title: 'z' }), '「z」 卡住了：要密钥')
})

test('noticeOf: a task handed back with a question reads as a question, not a failure', () => {
  assert.equal(noticeOf({ kind: 'failed', stage: 'needs_input', title: 'z', agent: 'quick', message: '用 v1 还是 v2？' }), '「z」（quick） 需要回答：用 v1 还是 v2？')
  assert.equal(noticeOf({ kind: 'failed', title: 'z', message: '编译失败' }), '「z」 失败：编译失败')
})

test('stall: a cloud task with no news for stallMinutes gets one 没有动静 line per silence', async (t) => {
  const s = await setup(t, { options: { stallMinutes: 20 } })
  const at = new Date(Date.parse('2026-11-24T10:00:00Z') - 5 * 60_000).toISOString()
  s.client.list = [
    { task_id: 'c1', title: '改接口', agent: 'quick', status: 'running', updated_at: at, origin: { kind: 'controller' } },
    { task_id: 'c2', title: '问过了', agent: 'quick', status: 'running', stage: 'needs_input', updated_at: at, origin: { kind: 'controller' } },
    { task_id: 'l1', title: '本机的', status: 'running', updated_at: at, origin: { kind: 'local' } },
    { task_id: 'd1', title: '早做完', status: 'completed', updated_at: at, origin: { kind: 'controller' } },
  ]
  assert.deepEqual((await s.sync.stallOnce()).lines, [], 'five minutes is not a stall')
  s.tick(16 * 60_000)
  assert.deepEqual((await s.sync.stallOnce()).lines, ['「改接口」（quick） 没有动静：已经 21 分钟没有新进展'])
  assert.deepEqual(s.notices, ['「改接口」（quick） 没有动静：已经 21 分钟没有新进展'])
  s.tick(10 * 60_000)
  assert.deepEqual((await s.sync.stallOnce()).lines, [], 'said once per silence, also after a restart')
  assert.deepEqual((await s.make().stallOnce()).lines, [])
  // A session upload is news: the clock restarts from it.
  s.client.list = [{ ...s.client.list[0], session_updated_at: new Date(Date.parse('2026-11-24T10:00:00Z') + 25 * 60_000).toISOString() }]
  assert.deepEqual((await s.sync.stallOnce()).lines, [])
  s.tick(21 * 60_000)
  assert.equal((await s.sync.stallOnce()).lines.length, 1, 'quiet again: one more line')
  // Gone from the active list: forgotten.
  s.client.list = []
  await s.sync.stallOnce()
  assert.deepEqual(s.sync.state.stalled, {})
})

test('stall check is off with stallMinutes 0', async (t) => {
  const s = await setup(t, { options: { stallMinutes: 0 } })
  assert.deepEqual((await s.sync.stallOnce()).lines, [])
  assert.equal(s.client.of('list').length, 0)
})

test('mirror: a row the board lost while open is closed on the hub after 10 minutes, never on an empty board', async (t) => {
  const s = await setup(t, { rows: [row('a', 'running'), row('b', 'running')] })
  await s.sync.mirrorOnce()
  s.board.tasks = [row('b', 'running')]
  await s.sync.mirrorOnce()
  assert.deepEqual(s.client.of('cancel'), [], 'just gone: wait')
  s.tick(11 * 60_000)
  await s.sync.mirrorOnce()
  assert.deepEqual(s.client.of('cancel'), [['cancel', 'local_web_a']])
  assert.equal(s.sync.state.tasks.a, undefined, 'then forgotten')
  // An empty board says nothing: b stays.
  s.board.tasks = []
  s.tick(60 * 60_000)
  await s.sync.mirrorOnce()
  await s.sync.mirrorOnce()
  assert.deepEqual(s.client.of('cancel'), [['cancel', 'local_web_a']])
})
