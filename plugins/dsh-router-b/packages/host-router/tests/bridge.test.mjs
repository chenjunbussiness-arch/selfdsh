/**
 * Tests for the HTTP bridge: the state/tab mapping and the four route handlers.
 *
 * Two layers, because two different things can go wrong:
 *
 * 1. `boardDocument` is pure, so the host→panel mapping is asserted directly:
 *    every host state has a row, `reported` never collapses into `verified`, and
 *    the original state survives in `hostState`.
 * 2. The routes are driven against the *compiled plugin*, through the same fake
 *    Cordis context the router's own tests use, with a fake `webServer` that
 *    records what got registered. That covers the wiring the panel actually
 *    depends on: a demand published over HTTP becomes a board row, a verdict is
 *    only accepted on a `reported` row, and a disabled partition accepts nothing.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { after, test } from 'node:test'

import { apply } from '../lib/index.js'
import { TaskBoard } from '../lib/board.js'
import {
  BUCKET_OF_STATE, BOARD_PATH, EVENTS_PATH, PARTITION_PATH, PUBLISH_PATH, STATE_TO_UI, VERIFY_PATH,
  boardDocument, createRoutes,
} from '../lib/bridge.js'

const tempDirs = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-router-bridge-'))
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

const NOW = Date.parse('2026-11-18T12:00:00.000Z')
const STAMP = new Date(NOW).toISOString()

/** One host task view, as `buildSnapshot` would produce it. */
const taskView = (over) => ({
  id: 't1',
  partition: 'front',
  subject: 'fix the button',
  state: 'queued',
  level: 'worker',
  priority: 0,
  attempts: 0,
  reason: 'explicit',
  because: ['named "front"'],
  progress: 0,
  todos: { todos: null, done: 0, total: 0, ratio: '0/0' },
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
})

/** One host snapshot, as `buildSnapshot` would produce it. */
const snapshotOf = (tasks, counts = {}) => ({
  version: 1,
  generatedAt: STAMP,
  counts: { ...counts },
  partitions: [],
  tasks,
})

const partitionSource = (name) => ({ name, dir: `E:/work/${name}`, slots: 2, managerEnabled: false })

// --- mapping ---------------------------------------------------------------

test('every host state has a panel state and a tab, and reported stays separate', () => {
  const states = ['queued', 'dispatched', 'running', 'reported', 'verified', 'failed', 'blocked', 'cancelled']
  for (const state of states) {
    assert.ok(STATE_TO_UI[state] !== undefined, `${state} has a panel state`)
  }
  // The whole point of the board: a worker's claim is not acceptance.
  assert.equal(STATE_TO_UI.reported, 'reported')
  assert.equal(STATE_TO_UI.verified, 'verified')
  assert.notEqual(STATE_TO_UI.reported, STATE_TO_UI.verified)

  // A failed dispatch is "sent back", not "still queued" and not "done".
  assert.equal(STATE_TO_UI.failed, 'rejected')
  // A dispatched row already has a worker holding it, so the panel hears "running".
  assert.equal(STATE_TO_UI.dispatched, 'running')
  // Parked on a human decision: not running, not resolved.
  assert.equal(STATE_TO_UI.blocked, 'queued')
  assert.equal(BUCKET_OF_STATE.queued, 'up-next')
  assert.equal(BUCKET_OF_STATE.reported, 'active')
  assert.equal(BUCKET_OF_STATE.verified, 'resolved')
  assert.equal(BUCKET_OF_STATE.rejected, 'resolved')
})

test('boardDocument keeps the host state, the reason and the tab of every row', () => {
  const tasks = [
    taskView({ id: 't1', state: 'queued' }),
    taskView({ id: 't2', state: 'running', attempts: 1, sessionId: 'ses_2', worker: 'agent-2' }),
    taskView({
      id: 't3',
      state: 'reported',
      attempts: 1,
      sessionId: 'ses_3',
      worker: 'agent-3',
      todos: {
        todos: [
          { content: 'read it', status: 'completed' },
          { content: 'fix it', status: 'in_progress' },
        ],
        done: 1,
        total: 2,
        ratio: '1/2',
        current: 'fix it',
      },
    }),
    taskView({ id: 't4', state: 'verified', attempts: 1 }),
    taskView({ id: 't5', state: 'failed', attempts: 2, error: 'acceptance failed: go build' }),
    taskView({ id: 't6', state: 'blocked', resumeNote: 'needs a decision' }),
    taskView({ id: 't7', parentId: 't1', level: 'worker', state: 'running' }),
  ]
  const document = boardDocument({
    snapshot: snapshotOf(tasks, { queued: 1, running: 2, reported: 1, verified: 1, failed: 1, blocked: 1 }),
    partitions: [partitionSource('front')],
    isEnabled: () => true,
    credentials: [
      { ref: 'DEEPSEEK_API_KEY', label: 'DeepSeek', configured: true, source: 'file', writable: true },
      { ref: 'EXA_API_KEY', label: 'Exa', configured: false, source: 'unset', writable: true },
    ],
    now: NOW,
  })

  assert.equal(document.origin, 'host')
  assert.equal(document.version, 2)
  const byId = new Map(document.tasks.map(task => [task.id, task]))
  assert.equal(byId.get('t1').bucket, 'up-next')
  assert.equal(byId.get('t2').bucket, 'active')
  assert.equal(byId.get('t2').hostState, 'running')
  assert.equal(byId.get('t3').state, 'reported')
  assert.equal(byId.get('t3').bucket, 'active', 'awaiting verification is work in progress, not resolved')
  assert.equal(byId.get('t3').todoProgress.ratio, '1/2')
  assert.equal(byId.get('t3').todoProgress.current, 'fix it')
  assert.deepEqual(byId.get('t3').todos.map(item => item.content), ['read it', 'fix it'])
  assert.equal(byId.get('t3').reportedAt, STAMP, 'a reported row reports the moment it was folded')
  assert.equal(byId.get('t4').bucket, 'resolved')
  assert.equal(byId.get('t4').verifiedAt, STAMP)
  assert.equal(byId.get('t5').state, 'rejected')
  assert.equal(byId.get('t5').hostState, 'failed', 'the host state is preserved verbatim')
  assert.match(byId.get('t5').rejectionReason, /acceptance failed/)
  assert.equal(byId.get('t5').attempt, 2)
  assert.equal(byId.get('t6').state, 'queued')
  assert.equal(byId.get('t6').hostState, 'blocked')

  // Attempts are 1-based on this side of the bridge.
  assert.equal(byId.get('t1').attempt, 1)

  // Only rows whose worker is still on the roster carry a workerId.
  assert.equal(byId.get('t2').workerId, 'w:t2')
  assert.equal(byId.get('t3').workerId, 'w:t3')
  assert.equal(byId.get('t1').workerId, undefined)
  assert.equal(byId.get('t4').workerId, undefined, 'a resolved row keeps its session but no worker chip')

  const partition = document.partitions[0]
  assert.equal(partition.path, 'E:/work/front')
  assert.equal(partition.enabled, true)
  assert.equal(partition.workerCount, 2)
  assert.equal(partition.unreviewedCount, 1, 'the 待审查 badge counts reported rows')
  assert.equal(partition.taskCount, 7)
  assert.equal(partition.manager.name, 'router', 'a partition without a manager seat says so')
  assert.deepEqual(partition.workers.map(worker => worker.presence), ['busy', 'busy', 'released'],
    'two live rows hold the two slots, and the reported worker is released')
  assert.ok(partition.workers.every(worker => worker.presence !== 'offline'),
    'offline is never claimed without a reachability probe')

  // One demand row per root task, newest first; a manager's child row is not a demand.
  assert.deepEqual(document.demands.map(demand => demand.taskIds[0]), ['t6', 't5', 't4', 't3', 't2', 't1'])
  assert.equal(document.demands.find(demand => demand.taskIds[0] === 't1').routingReason, 'explicit: named "front"')
  assert.deepEqual(document.buckets, { active: 3, 'up-next': 2, scheduled: 0, resolved: 2 })
  assert.deepEqual(document.credentials.map(view => [view.ref, view.configured]), [['DEEPSEEK_API_KEY', true], ['EXA_API_KEY', false]])
  assert.deepEqual(document.credentials.map(view => view.label), ['DeepSeek', 'Exa'])
})

// --- fake HTTP exchange -----------------------------------------------------

/** A request carrying an optional JSON body. */
function fakeRequest({ method = 'GET', headers = {}, body, url = '/' } = {}) {
  const listeners = new Map()
  const request = {
    method,
    url,
    headers,
    on(event, listener) {
      listeners.set(event, [...listeners.get(event) ?? [], listener])
      return request
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener()
    },
    destroy() {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
  }
  return request
}

/** A response that records what the handler wrote. */
function fakeResponse() {
  const listeners = new Map()
  const response = {
    status: undefined,
    headers: undefined,
    body: '',
    frames: [],
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      response.status = status
      response.headers = headers
      response.headersSent = true
      return response
    },
    write(chunk) {
      response.frames.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) response.body += String(chunk)
      response.headersSent = true
      response.writableEnded = true
      return response
    },
    destroy() {
      response.destroyed = true
    },
    on(event, listener) {
      listeners.set(event, [...listeners.get(event) ?? [], listener])
      return response
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener()
    },
  }
  return response
}

/** The JSON a handler answered with. */
const jsonOf = (response) => {
  assert.notEqual(response.body, '', `expected a JSON body, got ${response.status}`)
  return JSON.parse(response.body)
}

/**
 * A fake Cordis context with a fake web server attached.
 *
 * The router's own test harness, extended with `inject`/`webServer`, a
 * credentials provider, and captured route registrations.
 */
function harness(options = {}) {
  const tools = new Map()
  const starts = []
  const activations = []
  const agents = new Map()
  const logs = new Map(options.logs ?? [])
  const boardDir = scratch()
  const routes = []
  const injected = []

  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    logger: { info() {}, warn() {} },
    on() { return () => {} },
    effect(run) { return run() },
    /** Mount callbacks immediately, the way a ready service would. */
    inject(deps, callback) {
      injected.push([...deps])
      callback({
        ...ctx,
        webServer: {
          register(route) {
            routes.push(route)
            return () => {
              const at = routes.indexOf(route)
              if (at >= 0) routes.splice(at, 1)
            }
          },
        },
      })
      return () => {}
    },
    get(name) {
      if (name === 'agents') return { get: id => agents.get(id) }
      if (name === 'credentials') return options.credentials
      if (name === 'sessionQuery') {
        return {
          async readSession(id) {
            const events = logs.get(id)
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
            const activation = {
              childId: `child-${String(activations.length + 1)}`,
              name: `agent-${String(activations.length + 1)}`,
              result,
              async dispose() {},
              settle,
            }
            activations.push(activation)
            return activation
          },
          async sendMessage() { return 'message-1' },
          interrupt() {},
        }
      }
      return undefined
    },
  }

  return {
    ctx, tools, starts, activations, agents, logs, boardDir, routes, injected,
    /** The registered route for one path. */
    route(path) {
      const found = routes.find(entry => entry.path === path)
      assert.ok(found !== undefined, `route ${path} is not registered (have ${routes.map(entry => entry.path).join(', ')})`)
      return found
    },
    /** Call one route handler with a fake exchange. */
    async call(path, request = {}) {
      const response = fakeResponse()
      await this.route(path).handler(fakeRequest(request), response)
      return response
    },
    /** A tool body by name, for driving the plugin the way the model would. */
    tool(name) {
      const definition = tools.get(name)
      assert.ok(definition !== undefined, `tool ${name} is not registered`)
      return (args, agent) => definition.execute(args, { agent, signal: new AbortController().signal })
    },
  }
}

const fakeAgent = (id) => ({ id, session: { id, header: { id, cwd: 'E:/elsewhere' } } })

const baseConfig = (overrides = {}) => ({
  boardDir: undefined,
  manager: false,
  partitions: [
    { name: 'front', root: 'E:/work/front', keywords: ['react'], workers: 2 },
    { name: 'state', root: 'E:/work/state', keywords: ['go'], workers: 2 },
  ],
  ...overrides,
})

const readTask = async (dir, id) => (await TaskBoard.open(dir)).get(id)

const jsonPost = (value) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
})

// --- routing table ----------------------------------------------------------

test('the bridge registers one exact route per endpoint', async () => {
  const h = harness()
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))
  assert.deepEqual(h.injected[0], ['webServer'])
  assert.deepEqual(h.routes.map(route => route.path), [BOARD_PATH, PUBLISH_PATH, VERIFY_PATH, PARTITION_PATH, EVENTS_PATH])
  assert.ok(h.routes.every(route => route.kind === 'exact'))
  assert.deepEqual(h.routes.map(route => route.path), [
    '/api/router/board', '/api/router/publish', '/api/router/verify', '/api/router/partition', '/api/router/events',
  ])
})

test('without an injectable web server the tools still mount', async () => {
  const h = harness()
  delete h.ctx.inject
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))
  assert.equal(h.routes.length, 0)
  assert.ok(h.tools.has('route_task'), 'the tool surface is unaffected')
})

// --- GET board --------------------------------------------------------------

test('GET board answers the panel document with partitions and credential presence', async () => {
  const h = harness({
    credentials: {
      async describe(ref) {
        return ref === 'DEEPSEEK_API_KEY' ? { configured: true } : { configured: false }
      },
    },
  })
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))

  const response = await h.call(BOARD_PATH)
  assert.equal(response.status, 200)
  assert.match(response.headers['content-type'], /application\/json/)
  const document = jsonOf(response)
  assert.equal(document.version, 2)
  assert.equal(document.origin, 'host')
  assert.deepEqual(document.partitions.map(part => part.id), ['front', 'state'])
  assert.deepEqual(document.credentials.map(view => [view.ref, view.configured]), [['DEEPSEEK_API_KEY', true], ['EXA_API_KEY', false]])
  assert.deepEqual(document.credentials.map(view => view.label), ['DeepSeek', 'Exa'])
  assert.deepEqual(document.tasks, [])
  assert.deepEqual(document.demands, [])

  // The board document is also persisted for anything reading the file directly.
  const written = JSON.parse(await (await import('node:fs/promises')).readFile(join(h.boardDir, 'snapshot.json'), 'utf8'))
  assert.equal(written.version, 1, 'the host snapshot keeps its own schema')
  assert.deepEqual(written.tasks, [])

  const wrongMethod = await h.call(BOARD_PATH, { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'GET')
})

test('a credential provider that cannot answer reads as unknown, not as missing', async () => {
  const h = harness({
    credentials: {
      async describe() { throw new Error('provider is not ready') },
    },
  })
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))
  const document = jsonOf(await h.call(BOARD_PATH))
  assert.deepEqual(
    document.credentials.map(view => ({ ref: view.ref, configured: view.configured, source: view.source })),
    [
      { ref: 'DEEPSEEK_API_KEY', configured: false, source: 'unknown' },
      { ref: 'EXA_API_KEY', configured: false, source: 'unknown' },
    ],
  )
})

// --- POST publish -----------------------------------------------------------

test('POST publish routes a demand onto the board and answers per-demand evidence', async () => {
  const h = harness()
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))

  const response = await h.call(PUBLISH_PATH, jsonPost({ demands: ['fix the react view', 'nothing useful at all'] }))
  assert.equal(response.status, 200)
  const result = jsonOf(response)
  assert.equal(result.accepted, 1)
  assert.equal(result.routed.length, 2)
  assert.equal(result.routed[0].partitionId, 'front')
  assert.match(result.routed[0].reason, /auto: /)
  assert.equal(result.routed[1].partitionId, undefined, 'an unrouted demand reports why instead of failing the call')
  assert.match(result.routed[1].reason, /no partition matched/)

  // The demand is a real board row. No agent is live in this test, so it waits —
  // which is what the panel shows as "Up next", not a failure.
  const tasks = (await TaskBoard.open(h.boardDir)).list()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].partition, 'front')
  assert.equal(tasks[0].state, 'queued')

  const document = jsonOf(await h.call(BOARD_PATH))
  assert.equal(document.tasks.length, 1)
  assert.equal(document.tasks[0].state, 'queued')
  assert.equal(document.tasks[0].bucket, 'up-next')
  assert.equal(document.demands[0].taskIds[0], tasks[0].id)
})

test('publish starts the row when a live agent is reachable', async () => {
  const h = harness()
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))
  // A router tool call is what records the human-facing agent.
  await h.tool('route_task')({ text: 'warm up', partition: 'front' }, root)
  assert.equal(h.starts.length, 1)

  const result = jsonOf(await h.call(PUBLISH_PATH, jsonPost({ demands: ['fix the state machine'] })))
  assert.equal(result.accepted, 1)
  assert.equal(h.starts.length, 2, 'the panel-published demand got a worker too')
  assert.equal(h.starts[1].cwd, resolvePath('E:/work/state'), 'routed by its own evidence, not the previous demand')
})

test('publish rejects malformed bodies without touching the board', async () => {
  const h = harness()
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))

  const wrongType = await h.call(PUBLISH_PATH, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ demands: ['x'] }),
  })
  assert.equal(wrongType.status, 415)

  const notArray = await h.call(PUBLISH_PATH, jsonPost({ demands: 'one string' }))
  assert.equal(notArray.status, 400)
  assert.equal(jsonOf(notArray).error.code, 'bad-request')

  const empty = await h.call(PUBLISH_PATH, jsonPost({ demands: ['   '] }))
  assert.equal(empty.status, 400)

  const wrongMethod = await h.call(PUBLISH_PATH, { method: 'GET' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')

  assert.equal((await TaskBoard.open(h.boardDir)).list().length, 0)
})

// --- POST verify ------------------------------------------------------------

test('a verdict is only accepted on a reported task, and reported never becomes verified by itself', async () => {
  const h = harness()
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir, autoVerify: false }))
  const created = await h.tool('route_task')({ text: 'do the thing', partition: 'front' }, root)

  // Still running: judging it is refused rather than guessed.
  const tooEarly = await h.call(VERIFY_PATH, jsonPost({ taskId: created.task, verdict: 'verified' }))
  assert.equal(tooEarly.status, 409)
  assert.match(jsonOf(tooEarly).error.message, /dispatched|running/)

  // The worker claims completion. That is a claim, not acceptance.
  h.activations[0].settle({ stopReason: 'completed', output: [{ type: 'text', text: 'finished!' }] })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && (await readTask(h.boardDir, created.task))?.state !== 'reported') {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal((await readTask(h.boardDir, created.task)).state, 'reported')

  let document = jsonOf(await h.call(BOARD_PATH))
  assert.equal(document.tasks[0].state, 'reported')
  assert.equal(document.partitions[0].unreviewedCount, 1)

  const accepted = await h.call(VERIFY_PATH, jsonPost({ taskId: created.task, verdict: 'verified', note: 'looks right' }))
  assert.equal(accepted.status, 200)
  assert.equal(jsonOf(accepted).task.state, 'verified')
  const verified = await readTask(h.boardDir, created.task)
  assert.equal(verified.state, 'verified')
  assert.match(verified.notes.join(' '), /verified from the router panel/)
  assert.match(verified.notes.join(' '), /looks right/)

  // History is not rewritten by a second verdict.
  const again = await h.call(VERIFY_PATH, jsonPost({ taskId: created.task, verdict: 'rejected' }))
  assert.equal(again.status, 409)

  document = jsonOf(await h.call(BOARD_PATH))
  assert.equal(document.tasks[0].bucket, 'resolved')
  assert.equal(document.tasks[0].hostState, 'verified')
  assert.equal(document.partitions[0].unreviewedCount, 0)
})

test('a rejection closes the row with the operator reason and is not silently re-queued', async () => {
  const h = harness()
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir, autoVerify: false }))
  const created = await h.tool('route_task')({ text: 'does half the job', partition: 'front' }, root)
  h.activations[0].settle({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && (await readTask(h.boardDir, created.task))?.state !== 'reported') {
    await new Promise(resolve => setTimeout(resolve, 20))
  }

  const response = await h.call(VERIFY_PATH, jsonPost({
    taskId: created.task, verdict: 'rejected', note: 'go vet still fails',
  }))
  assert.equal(response.status, 200)
  const row = await readTask(h.boardDir, created.task)
  assert.equal(row.state, 'failed')
  assert.match(row.error, /rejected by operator: go vet still fails/)
  assert.equal(h.starts.length, 1, 'rejecting does not spend another worker session')

  const document = jsonOf(await h.call(BOARD_PATH))
  assert.equal(document.tasks[0].state, 'rejected')
  assert.equal(document.tasks[0].bucket, 'resolved')
  assert.match(document.tasks[0].rejectionReason, /go vet still fails/)
})

test('an unknown task id is a 404, not an empty success', async () => {
  const h = harness()
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))
  const response = await h.call(VERIFY_PATH, jsonPost({ taskId: 't404', verdict: 'verified' }))
  assert.equal(response.status, 404)
  assert.equal(jsonOf(response).error.code, 'not-found')
})

// --- POST partition ---------------------------------------------------------

test('disabling a partition stops new work and re-enabling drains the queue', async () => {
  const h = harness()
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  await apply(h.ctx, baseConfig({
    boardDir: h.boardDir,
    partitions: [{ name: 'front', root: 'E:/work/front', keywords: ['react'], workers: 1 }],
  }))

  const disabled = await h.call(PARTITION_PATH, jsonPost({ id: 'front', enabled: false }))
  assert.equal(disabled.status, 200)
  assert.deepEqual(jsonOf(disabled).partition, { id: 'front', enabled: false })

  let document = jsonOf(await h.call(BOARD_PATH))
  assert.equal(document.partitions[0].enabled, false)

  // A demand for a disabled partition is reported unrouted and enqueues nothing.
  const publish = jsonOf(await h.call(PUBLISH_PATH, jsonPost({ demands: ['fix the react view'] })))
  assert.equal(publish.accepted, 0)
  assert.match(publish.routed[0].reason, /disabled/)

  // The model-facing tool refuses it too, rather than queueing work that cannot start.
  await assert.rejects(
    () => h.tool('route_task')({ text: 'fix the react view', partition: 'front' }, root),
    /disabled/,
  )

  const enabled = await h.call(PARTITION_PATH, jsonPost({ id: 'front', enabled: true }))
  assert.deepEqual(jsonOf(enabled).partition, { id: 'front', enabled: true })
  document = jsonOf(await h.call(BOARD_PATH))
  assert.equal(document.partitions[0].enabled, true)

  const after = jsonOf(await h.call(PUBLISH_PATH, jsonPost({ demands: ['fix the react view'] })))
  assert.equal(after.accepted, 1)
})

test('an unknown partition id is a 404 that lists the configured ones', async () => {
  const h = harness()
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))
  const response = await h.call(PARTITION_PATH, jsonPost({ id: 'nope', enabled: false }))
  assert.equal(response.status, 404)
  assert.match(jsonOf(response).error.message, /front, state/)
})

// --- GET events -------------------------------------------------------------

test('GET events opens an SSE stream and reports one change per board write', async () => {
  const h = harness()
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))

  // The board file exists after the first write.
  await h.call(PUBLISH_PATH, jsonPost({ demands: ['fix the react view'] }))
  const changeFile = join(h.boardDir, 'board.json')

  const request = fakeRequest({ method: 'GET' })
  const response = fakeResponse()
  await h.route(EVENTS_PATH).handler(request, response)

  assert.equal(response.status, 200)
  assert.match(response.headers['content-type'], /text\/event-stream/)
  assert.ok(response.frames.join('').includes('event: hello'), 'the client learns the stream is live')
  assert.ok(response.frames.join('').includes('retry: 3000'))

  // Nudge the board file's timestamp; the poller turns that into one event.
  utimesSync(changeFile, new Date(), new Date(Date.now() + 5000))
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !response.frames.join('').includes('event: changed')) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(response.frames.join('').includes('event: changed'), 'a board write reaches the client')

  // Disconnecting ends the stream and clears its timers.
  request.emit('close')
  assert.equal(response.writableEnded, true)

  const wrongMethod = await h.call(EVENTS_PATH, { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
})

// --- the route factory is pure ---------------------------------------------

test('createRoutes needs no harness to describe itself', () => {
  const noop = async () => ({})
  const routes = createRoutes({
    logger: { info() {}, warn() {} },
    partitions: [],
    isEnabled: () => true,
    snapshot: noop,
    publish: async () => ({ accepted: 0, routed: [] }),
    verify: async (id) => ({ id, state: 'verified' }),
    setPartitionState: async (id, enabled) => ({ id, enabled }),
    credentials: async () => [],
    changeFile: join(scratch(), 'board.json'),
  })
  assert.equal(routes.length, 6)
  assert.ok(routes.every(route => route.kind === 'exact' && typeof route.handler === 'function'))
})
