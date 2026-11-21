/**
 * Behaviour tests for the compiled plugin, run against a fake Cordis context.
 *
 * The point is to exercise the real control flow — routing, capacity, the pump,
 * dispatch arguments, settlement, acceptance, and the snapshot folder — without
 * an LLM in the loop. The fake `subagents` seam records the exact spec the
 * plugin passes, so the `cwd` claim ("the worker is rooted in the partition")
 * is asserted rather than assumed.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { after, test } from 'node:test'

import { apply } from '../lib/index.js'
import { TaskBoard } from '../lib/board.js'
import { resolveRoute, normalisePartitions, containsFile, globToRegExp } from '../lib/config.js'
import { parseWorkerReport, REPORT_MARKER } from '../lib/report.js'
import { foldTodos, foldWorkerLog } from '../lib/snapshot.js'

const tempDirs = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-router-'))
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** A fake live agent, plus the registry that answers liveness for it. */
function fakeAgent(id) {
  return { id, session: { id, header: { id, cwd: 'E:/elsewhere' } } }
}

/**
 * Build a fake ctx: tool registry, agent liveness, subagent seam, scripted
 * session-query logs, and the two board directory overrides.
 */
function harness(options = {}) {
  const tools = new Map()
  const starts = []
  const sent = []
  const interrupted = []
  const activations = []
  const agents = new Map()
  const logs = new Map(options.logs ?? [])
  const boardDir = scratch()
  const info = []

  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    logger: { info(...args) { info.push(args.join(' ')) }, warn(...args) { console.error('#warn', ...args) } },
    on() { return () => {} },
    effect(run) { return run() },
    get(name) {
      if (name === 'agents') return { get: id => agents.get(id) }
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
          async sendMessage(sender, targetId, content) {
            sent.push({ sender, targetId, content })
            return 'message-1'
          },
          interrupt(targetId) {
            interrupted.push(targetId)
          },
        }
      }
      return undefined
    },
  }

  return {
    ctx,
    tools,
    starts,
    sent,
    interrupted,
    activations,
    agents,
    logs,
    info,
    boardDir,
    /** A tool body by name, with the calling agent and an abort signal. */
    call(name) {
      const definition = tools.get(name)
      assert.ok(definition !== undefined, `tool ${name} is not registered`)
      return (args, agent) => definition.execute(args, { agent, signal: new AbortController().signal })
    },
  }
}

/** Poll until `check` returns true, or fail after the deadline. */
async function waitFor(check, label, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${label}`)
}

/**
 * Read one task through a fresh board instance.
 *
 * The plugin owns the writer; a test that kept one board instance open would
 * assert against its own stale snapshot instead of what was persisted.
 */
const readTask = async (dir, id) => (await TaskBoard.open(dir)).get(id)

const baseConfig = (overrides = {}) => ({
  boardDir: undefined,
  manager: false,
  partitions: [
    {
      name: 'front',
      root: 'E:/work/front',
      include: ['src/**'],
      keywords: ['react'],
      workers: 2,
    },
    {
      name: 'state',
      root: 'E:/work/state',
      include: ['**/*.go'],
      keywords: ['go', 'kratos'],
      workers: 2,
    },
  ],
  ...overrides,
})

// --- pure routing ----------------------------------------------------------

test('globs select members and nested partitions resolve to the tighter root', () => {
  assert.equal(globToRegExp('src/**').test('src/a/b.ts'), true)
  assert.equal(globToRegExp('**/*.go').test('cmd/main.go'), true)
  assert.equal(globToRegExp('**/*.go').test('main.ts'), false)

  const partitions = normalisePartitions([
    { name: 'repo', root: 'E:/work' },
    { name: 'inner', root: 'E:/work/inner', include: ['**/*.ts'] },
  ], { workers: 2, manager: true })
  assert.equal(containsFile(partitions[0], 'E:/work/inner/a.ts'), true)
  const decision = resolveRoute(partitions, { files: ['E:/work/inner/a.ts'] })
  assert.equal(decision.partition.name, 'inner')
})

test('routing: explicit name wins, ambiguous text refuses to guess', () => {
  const partitions = normalisePartitions(baseConfig().partitions, { workers: 2, manager: true })
  assert.equal(resolveRoute(partitions, { partition: 'state' }).reason, 'explicit')
  assert.equal(resolveRoute(partitions, { text: 'fix the react view' }).partition.name, 'front')
  assert.equal(resolveRoute(partitions, { files: ['E:/work/state/a.go'] }).partition.name, 'state')
  assert.throws(
    () => resolveRoute(partitions, { text: 'react and go both' }),
    /matches .* equally/,
  )
  assert.throws(() => resolveRoute(partitions, { text: 'nothing useful' }), /no partition matched/)
  assert.equal(resolveRoute(partitions, { text: 'nothing useful' }, 'state').reason, 'default')
})

// --- board durability ------------------------------------------------------

test('a row left in flight by a dead process is reconciled to reported', async () => {
  const dir = scratch()
  const board = await TaskBoard.open(dir, 'run-A')
  await board.add({
    id: 't1',
    partition: 'front',
    subject: 'orphan',
    body: 'x',
    state: 'running',
    cwd: 'E:/work/front',
    priority: 0,
    level: 'worker',
    reason: 'explicit',
    because: [],
    attempts: 1,
    runToken: 'run-A',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  // Same process token: this row is still ours, so it must survive a reopen.
  const same = await TaskBoard.open(dir, 'run-A')
  assert.equal(same.get('t1').state, 'running')

  // A new process token means the dispatcher is gone; the row must not look live.
  const restarted = await TaskBoard.open(dir, 'run-B')
  const task = restarted.get('t1')
  assert.equal(task.state, 'reported')
  assert.match(task.error, /restarted/)
})

// --- dispatch, settlement, acceptance --------------------------------------

test('route_task roots the worker in the partition and reports cwd in the spec', async () => {
  const h = harness()
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))

  const result = await h.call('route_task')({ text: 'fix the button', partition: 'front' }, root)
  assert.equal(result.partition, 'front')
  assert.equal(result.state, 'dispatched')
  assert.equal(h.starts.length, 1)

  const spec = h.starts[0]
  assert.equal(spec.cwd, resolvePath('E:/work/front'), 'the child is rooted in the partition directory')
  assert.equal(spec.delivery, 'parent', 'the closing report goes to the creating agent')
  assert.equal(spec.provider, 'spawn')
  assert.match(spec.prompt[0].text, /You are a worker for the "front" partition/)
  assert.match(spec.prompt[0].text, /fix the button/)
})

test('a completed worker stops at reported; acceptance decides verified', async () => {
  const h = harness()
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  // Acceptance commands run in the partition directory, so these roots must exist.
  const frontDir = scratch()
  const stateDir = scratch()
  await apply(h.ctx, baseConfig({
    boardDir: h.boardDir,
    partitions: [
      { name: 'front', root: frontDir, workers: 2, verify: ['node -e "process.exit(0)"'] },
      { name: 'state', root: stateDir, workers: 2, verify: ['node -e "process.exit(3)"'] },
    ],
  }))

  const passing = await h.call('route_task')({ text: 'ok', partition: 'front' }, root)
  const failing = await h.call('route_task')({ text: 'bad', partition: 'state' }, root)
  assert.equal(h.starts.length, 2)

  h.activations[0].settle({ stopReason: 'completed', output: [{ type: 'text', text: 'done: edited a.ts' }] })
  h.activations[1].settle({ stopReason: 'completed', output: [{ type: 'text', text: 'looks fine to me' }] })

  const board = await TaskBoard.open(h.boardDir)
  await waitFor(async () => (await readTask(h.boardDir, passing.task))?.state === 'verified', 'first task verified')
  await waitFor(async () => (await readTask(h.boardDir, failing.task))?.state === 'failed', 'second task failed')
  const verified = await readTask(h.boardDir, passing.task)
  const failed = await readTask(h.boardDir, failing.task)
  assert.equal(verified.state, 'verified')
  assert.match(verified.result, /edited a\.ts/)
  assert.equal(failed.state, 'failed', 'a worker claim must not survive a failing acceptance command')
  assert.match(failed.error, /acceptance failed/)
})

test('without acceptance commands a worker claim is only reported', async () => {
  const h = harness()
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir, autoVerify: false }))
  const created = await h.call('route_task')({ text: 'do the thing', partition: 'front' }, root)
  h.activations[0].settle({ stopReason: 'completed', output: [{ type: 'text', text: 'finished!' }] })
  await waitFor(async () => (await readTask(h.boardDir, created.task))?.state === 'reported', 'reported')
  assert.equal((await readTask(h.boardDir, created.task)).state, 'reported')
})

// --- capacity and the pump -------------------------------------------------

test('a partition at capacity queues the next task and the pump starts it later', async () => {
  const h = harness()
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  await apply(h.ctx, baseConfig({
    boardDir: h.boardDir,
    partitions: [{ name: 'front', root: 'E:/work/front', workers: 1 }],
  }))

  const first = await h.call('route_task')({ text: 'first', partition: 'front' }, root)
  const second = await h.call('route_task')({ text: 'second', partition: 'front' }, root)
  assert.equal(first.state, 'dispatched')
  assert.equal(second.state, 'queued', 'the second task waits for a slot')
  assert.equal(h.starts.length, 1)

  h.activations[0].settle({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] })
  await waitFor(async () => (await readTask(h.boardDir, first.task))?.state === 'reported', 'first reported')

  // Reading the board is what re-drives the queue.
  await h.call('task_board')({ partition: 'front' }, root)
  await waitFor(() => h.starts.length === 2, 'second dispatch')
  assert.equal(h.starts[1].cwd, resolvePath('E:/work/front'))
})

// --- two-level routing -----------------------------------------------------

test('a managed partition hands the task to a manager, who then starts workers', async () => {
  const h = harness()
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  await apply(h.ctx, baseConfig({
    boardDir: h.boardDir,
    manager: true,
    partitions: [{ name: 'state', root: 'E:/work/state', workers: 2, manager: true }],
  }))

  const managed = await h.call('route_task')({ text: 'align the mcp tools', partition: 'state' }, root)
  assert.equal(managed.state, 'dispatched')
  assert.match(h.starts[0].prompt[0].text, /You are the manager of the "state" partition/)

  // The manager is its own child; the router records it as a manager-level row.
  const managerRow = await readTask(h.boardDir, managed.task)
  assert.equal(managerRow.level, 'manager')

  // A worker call carries parent_task, which is the level-2 signal.
  const worker = await h.call('route_task')({
    text: 'align registry.json',
    partition: 'state',
    parent_task: managed.task,
  }, root)
  assert.equal(h.starts.length, 2)
  assert.match(h.starts[1].prompt[0].text, /You are a worker for the "state" partition/)
  assert.equal((await readTask(h.boardDir, worker.task)).parentId, managed.task)
})

// --- progress / todo folding ----------------------------------------------

test('the snapshot folds worker todos and promotes dispatched to running from the log', async () => {
  const h = harness()
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))
  const created = await h.call('route_task')({ text: 'tidy the reducer', partition: 'front' }, root)

  const sessionId = (await TaskBoard.open(h.boardDir)).get(created.task).sessionId
  // The worker starts, writes a list, and completes one item.
  h.logs.set(sessionId, [
    { type: 'turn/start', seq: 0, time: 1 },
    {
      type: 'todo/write',
      seq: 1,
      time: 2,
      data: {
        todos: [
          { content: 'read the reducer', status: 'completed' },
          { content: 'split the action', status: 'in_progress' },
        ],
      },
    },
  ])

  const snapshot = await h.call('task_progress')({}, root)
  assert.match(snapshot.text, /1\/2 todos/)
  assert.match(snapshot.text, /now: split the action/)

  assert.equal((await readTask(h.boardDir, created.task)).state, 'running', 'the log proves the child started')
  const published = JSON.parse(readFileSync(join(h.boardDir, 'snapshot.json'), 'utf8'))
  assert.equal(published.tasks[0].sessionId, sessionId)
  assert.equal(published.tasks[0].todos.ratio, '1/2')
  assert.ok(published.tasks[0].progress > 0.4)
})

test('todo projection resets on turn/start like the tool does', () => {
  const folded = foldTodos([
    { type: 'turn/start', seq: 0, time: 1 },
    { type: 'todo/write', seq: 1, time: 2, data: { todos: [{ content: 'a', status: 'completed' }] } },
    { type: 'turn/start', seq: 2, time: 3 },
  ])
  assert.equal(folded.todos, null)
  assert.equal(folded.ratio, '0/0')

  const facts = foldWorkerLog([
    { type: 'turn/start', seq: 0, time: 1 },
    { type: 'assistant/message', seq: 1, time: 2, data: { message: { content: [{ type: 'text', text: 'half way' }] } } },
    { type: 'turn/end', seq: 2, time: 3, data: { reason: { kind: 'completed' } } },
  ])
  assert.equal(facts.started, true)
  assert.equal(facts.endedWith, 'completed')
  assert.equal(facts.lastAssistant, 'half way')
})

// --- control ---------------------------------------------------------------

test('cancel interrupts the worker and closes the row', async () => {
  const h = harness()
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))
  const created = await h.call('route_task')({ text: 'long job', partition: 'front' }, root)
  const result = await h.call('task_control')({ task_id: created.task, action: 'cancel', value: 'superseded' }, root)
  assert.match(result.text, /cancelled/)
  assert.equal(h.interrupted.length, 1)
  assert.equal((await readTask(h.boardDir, created.task)).state, 'cancelled')
})

test('task_resume continues the recorded worker session instead of starting a new one', async () => {
  const h = harness()
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))
  const created = await h.call('route_task')({ text: 'step one', partition: 'front' }, root)
  h.activations[0].settle({ stopReason: 'completed', output: [{ type: 'text', text: 'step one done' }] })
  await waitFor(async () => (await readTask(h.boardDir, created.task))?.state === 'reported', 'reported')

  const result = await h.call('task_resume')({ task_id: created.task, text: 'now step two' }, root)
  assert.match(result.text, /continued/)
  assert.equal(h.starts.length, 1, 'no second child was started')
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].targetId, (await readTask(h.boardDir, created.task)).sessionId)
})

// --- context ceiling -------------------------------------------------------

/** One durable usage report, in the shape the token-meter fold reads. */
const usageEvent = (seq, inputTokens, cacheReadTokens = 0) => ({
  type: 'assistant/message',
  seq,
  time: seq,
  data: {
    message: { content: [{ type: 'text', text: 'working' }] },
    usage: { inputTokens, cacheReadTokens },
  },
})

test('route_task refuses to delegate once the caller itself passed the ceiling', async () => {
  const h = harness({ logs: [['root', [usageEvent(0, 300_000, 40_000)]]] })
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))

  await assert.rejects(
    () => h.call('route_task')({ text: 'split the reducer', partition: 'front' }, root),
    /attach ceiling/,
  )
  assert.equal(h.starts.length, 0, 'nothing was dispatched')
})

test('task_resume refuses to attach to a worker past the ceiling', async () => {
  // child-1 is the first activation, so its log can be seeded before it starts.
  const h = harness({ logs: [['child-1', [usageEvent(0, 250_000, 20_000)]]] })
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))
  const created = await h.call('route_task')({ text: 'step one', partition: 'front' }, root)

  await assert.rejects(
    () => h.call('task_resume')({ task_id: created.task, text: 'now step two' }, root),
    /attach ceiling/,
  )
  assert.equal(h.sent.length, 0, 'no message was delivered to the worker')
})

test('a ceiling of 0 disables the guard', async () => {
  const h = harness({ logs: [['root', [usageEvent(0, 900_000)]]] })
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir, contextLimitTokens: 0 }))

  const created = await h.call('route_task')({ text: 'split the reducer', partition: 'front' }, root)
  assert.equal(created.state, 'dispatched')
})

// --- the report contract ---------------------------------------------------

test('the report block parses into summary, touched and left', () => {
  const parsed = parseWorkerReport([
    'Did the work.',
    '',
    REPORT_MARKER,
    'Summary: split the reducer into two actions',
    'touched: src/store/reducer.ts; src/store/actions.ts',
    'left: the selector still reads the old shape',
  ].join('\n'))
  assert.equal(parsed.summary, 'split the reducer into two actions')
  assert.deepEqual(parsed.touched, ['src/store/reducer.ts', 'src/store/actions.ts'])
  assert.equal(parsed.left, 'the selector still reads the old shape')
})

test('the last marker wins, "none" clears a field, and no marker means unknown', () => {
  const twice = parseWorkerReport([
    'I could end with:',
    REPORT_MARKER,
    'summary: quoted example, not a report',
    'Then the real one:',
    REPORT_MARKER,
    'summary: actually did this',
    'touched: none',
    'left: none',
  ].join('\n'))
  assert.equal(twice.summary, 'actually did this')
  assert.deepEqual(twice.touched, [])
  assert.equal(twice.left, undefined)

  assert.equal(parseWorkerReport('I changed the reducer and it works.'), undefined)
  assert.equal(parseWorkerReport(`${REPORT_MARKER}\nnothing readable here`), undefined)
})

test('a worker report lands on the board and in the board view', async () => {
  const h = harness()
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))
  const created = await h.call('route_task')({ text: 'change the reducer', partition: 'front' }, root)

  h.activations[0].settle({
    stopReason: 'completed',
    output: [{
      type: 'text',
      text: [
        'Refactored it.',
        '',
        REPORT_MARKER,
        'summary: split the reducer into two actions',
        'touched: src/store/reducer.ts, src/store/actions.ts',
        'left: none',
      ].join('\n'),
    }],
  })
  await waitFor(async () => (await readTask(h.boardDir, created.task))?.state === 'reported', 'reported')

  const row = await readTask(h.boardDir, created.task)
  assert.equal(row.summary, 'split the reducer into two actions')
  assert.deepEqual(row.touched, ['src/store/reducer.ts', 'src/store/actions.ts'])
  assert.equal(row.left, undefined, '"none" means nothing is open')

  const view = await h.call('task_board')({ partition: 'front' }, root)
  assert.match(view.text, /did: split the reducer into two actions/)
  assert.match(view.text, /touched: src\/store\/reducer\.ts, src\/store\/actions\.ts/)
})

test('the worker brief bounds what gets delivered back to the dispatcher', async () => {
  const h = harness()
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))
  await h.call('route_task')({ text: 'change the reducer', partition: 'front' }, root)

  const brief = h.starts[0].prompt[0].text
  // The delivered text is the worker's last message, so the brief must say that
  // out loud: `delivery: 'parent'` hands it straight into the dispatcher's context.
  assert.match(brief, /final message is the only thing the dispatcher receives/)
  assert.match(brief, /--- report ---/)
  assert.match(brief, /nothing after it/)
})

test('a partition declares its network and git rules into the worker brief', async () => {
  const h = harness()
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  await apply(h.ctx, baseConfig({
    boardDir: h.boardDir,
    partitions: [{
      name: 'state',
      root: 'E:/work/state',
      workers: 1,
      network: 'intranet',
      git: { branch: 'router/work' },
    }],
  }))
  await h.call('route_task')({ text: 'align the mcp tools', partition: 'state' }, root)

  const brief = h.starts[0].prompt[0].text
  assert.match(brief, /reached over the intranet VPN/)
  assert.match(brief, /branch "router\/work"/)
  assert.match(brief, /never reset, never clean/)
})

test('an unknown network value fails at config time, not at dispatch', () => {
  assert.throws(
    () => normalisePartitions(
      [{ name: 'x', root: 'E:/work/x', network: 'wan' }],
      { workers: 1, manager: false },
    ),
    /expected intranet, internet, or offline/,
  )
})

test('the manager brief caps its own reply too', async () => {
  const h = harness()
  const root = fakeAgent('root')
  h.agents.set(root.id, root)
  await apply(h.ctx, baseConfig({
    boardDir: h.boardDir,
    manager: true,
    partitions: [{ name: 'state', root: 'E:/work/state', workers: 2, manager: true }],
  }))
  await h.call('route_task')({ text: 'align the mcp tools', partition: 'state' }, root)

  const brief = h.starts[0].prompt[0].text
  assert.match(brief, /at most three lines/)
  assert.match(brief, /delivered into the requester's context verbatim/)
})

// --- upgrade surface -------------------------------------------------------

test('activation reports which host seams it found', async () => {
  const h = harness()
  await apply(h.ctx, baseConfig({ boardDir: h.boardDir }))

  const line = h.info.find(text => text.startsWith('host-router seams:'))
  assert.ok(line !== undefined, 'the seam report is logged once at activation')
  // Present in the fake host, so the plugin can rely on them.
  assert.match(line, /tools=ok/)
  assert.match(line, /subagents=ok/)
  assert.match(line, /agents=ok/)
  assert.match(line, /sessionQuery=ok/)
  // Absent in the fake host: the report must say so rather than stay silent,
  // because after a version bump this line is how a vanished seam is noticed.
  assert.match(line, /credentials=absent/)
  assert.match(line, /sandboxPolicy=absent/)

  // The same report is written to disk: the process log does not carry it on
  // every host, and an operator upgrading the app reads the file, not a console.
  const written = JSON.parse(readFileSync(join(h.boardDir, 'seams.json'), 'utf8'))
  assert.equal(written.ok, true, 'both required seams are present')
  assert.equal(written.seams.tools, true)
  assert.equal(written.seams.subagents, true)
  assert.equal(written.seams.credentials, false)
})
