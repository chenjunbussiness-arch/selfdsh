/**
 * Scheduled pullers (pull_every_seconds), taking a requeued task back
 * (reclaim / late result) and worker roles in the standalone hub.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CTL, dispatchTask, expectHubError, makeHub, provision } from './helpers.mjs'

const MIN = 60_000

test('a scheduled puller stays online between visits; its task is not requeued', async (t) => {
  const { hub, clock } = await makeHub(t)
  await provision(hub, 'quick', { pull_every_seconds: 900 })
  await hub.heartbeat('quick', { status: 'idle' })
  await dispatchTask(hub, { task_id: 't1', agent: 'quick' })
  assert.equal((await hub.poll('quick')).tasks.length, 1)
  clock.advance(10 * MIN)
  assert.equal(await hub.sweep(), 0)
  const [agent] = await hub.listAgents()
  assert.equal(agent.online, true)
  assert.equal(agent.pull_every_seconds, 900)
  assert.equal(agent.offline_after_ms, 90_000 + 900_000)
  clock.advance(990_000 - 10 * MIN + 1)
  assert.equal((await hub.listAgents())[0].online, false)
})

test('heartbeat sets and clears its own schedule; bad values are refused', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'wk')
  const hb = await hub.heartbeat('wk', { pull_every_seconds: 300 })
  assert.equal(hb.pull_every_seconds, 300)
  assert.equal(hb.offline_after_ms, 390_000)
  assert.equal((await hub.heartbeat('wk', { pull_every_seconds: null })).pull_every_seconds, undefined)
  await expectHubError(() => hub.heartbeat('wk', { pull_every_seconds: 5 }), 400, 'bad-schedule')
  await expectHubError(() => provision(hub, 'xx', { pull_every_seconds: 86_401 }), 400, 'bad-schedule')
})

test('a worker back after being marked offline takes its task back instead of being told to abort', async (t) => {
  const { hub, clock } = await makeHub(t)
  await provision(hub, 'wk')
  await dispatchTask(hub, { task_id: 't1', agent: 'wk' })
  await hub.poll('wk')
  clock.advance(2 * MIN)
  assert.equal(await hub.sweep(), 1)
  assert.equal((await hub.getTask('t1')).status, 'pending')
  const hb = await hub.heartbeat('wk', { running: ['t1'] })
  assert.deepEqual(hb.abort, [])
  assert.deepEqual(hb.reclaimed, ['t1'])
  const task = await hub.getTask('t1')
  assert.equal(task.status, 'running')
  assert.equal(task.attempts, 1, 'taking it back is not a new attempt')
  assert.equal((await hub.submitResult('wk', { task_id: 't1', status: 'completed', summary: 'ok' })).task_status, 'completed')
})

test('a late result after a requeue is accepted while nobody else has the task', async (t) => {
  const { hub, clock } = await makeHub(t)
  await provision(hub, 'wk')
  await dispatchTask(hub, { task_id: 't1', agent: 'wk' })
  await hub.poll('wk')
  clock.advance(2 * MIN)
  await hub.sweep()
  assert.equal((await hub.submitResult('wk', { task_id: 't1', status: 'completed', summary: 'late' })).task_status, 'completed')
})

test('once another worker has the task, the old holder is told to abort and its result refused', async (t) => {
  const { hub, clock } = await makeHub(t)
  await provision(hub, 'wa', { capabilities: ['report'] })
  await provision(hub, 'wb', { capabilities: ['report'] })
  await dispatchTask(hub, { task_id: 't1', agent: 'pool:report' })
  const first = (await hub.poll('wa')).tasks.length === 1 ? 'wa' : 'wb'
  const other = first === 'wa' ? 'wb' : 'wa'
  clock.advance(2 * MIN)
  await hub.heartbeat(other, {})
  await hub.sweep()
  assert.equal((await hub.poll(other)).tasks.length, 1)
  assert.deepEqual((await hub.heartbeat(first, { running: ['t1'] })).abort, ['t1'])
  await expectHubError(() => hub.submitResult(first, { task_id: 't1', status: 'completed' }), 404, 'task-not-found')
})

test('roles: dispatchers and observers never get tasks; testers only test tasks', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'boss', { role: 'dispatcher', capabilities: ['report'] })
  await provision(hub, 'eye', { role: 'observer' })
  await provision(hub, 'qa', { role: 'tester', capabilities: ['code'] })
  await provision(hub, 'dev', { capabilities: ['code'] })
  await expectHubError(() => dispatchTask(hub, { agent: 'boss' }), 400, 'role-not-dispatchable')
  await expectHubError(() => dispatchTask(hub, { agent: 'eye' }), 400, 'role-not-dispatchable')
  await expectHubError(() => dispatchTask(hub, { agent: 'qa', type: 'research', title: 'Weekly report' }), 400, 'role-not-testable')
  await expectHubError(() => dispatchTask(hub, { agent: 'pool:report' }), 400, 'role-not-dispatchable')
  await dispatchTask(hub, { task_id: 'smoke', agent: 'pool:code', type: 'review', title: 'smoke test' })
  await dispatchTask(hub, { task_id: 'build', agent: 'pool:code', type: 'research', title: 'Build notes' })
  await hub.heartbeat('qa', {})
  const got = await hub.poll('qa', { max: 5 })
  assert.deepEqual(got.tasks.map(x => x.task_id), ['smoke'])
  const [boss] = (await hub.listAgents()).filter(a => a.agent_id === 'boss')
  assert.equal(boss.role, 'dispatcher')
})

test('approval may narrow the role and set the schedule, never widen the role', async (t) => {
  const { hub } = await makeHub(t)
  const req = await hub.requestEnrollment({ agent_id: 'quick', role: 'tester', pull_every_seconds: 900 })
  assert.equal((await hub.listRequests())[0].role, 'tester')
  await expectHubError(() => hub.approveRequest(CTL, req.request_id, { role: 'worker' }), 400, 'role-widened')
  const ok = await hub.approveRequest(CTL, req.request_id, { role: 'observer', pull_every_seconds: 1800 })
  assert.equal(ok.agent.role, 'observer')
  assert.equal(ok.agent.pull_every_seconds, 1800)
})

test('a coder only edits: a task that runs tests, commands or git is refused or left to a worker', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'quick', { role: 'coder', capabilities: ['code'] })
  await provision(hub, 'dsh', { capabilities: ['code', 'test'] })
  // Sent straight to the coder: refused, with the split spelled out.
  const err = await hub.dispatch(CTL, { agent: 'quick', title: '修首页布局', instruction: '改 index.css，改完跑一下测试再 git push' }).catch(e => e)
  assert.equal(err.code, 'role-not-coding')
  assert.match(err.message, /不能跑测试、git/)
  assert.match(err.message, /另派给 worker/)
  await expectHubError(() => dispatchTask(hub, { agent: 'quick', title: '修首页布局', instruction: '改 index.css', needs: ['code', 'git'] }), 400, 'role-not-coding')
  // `needs` cannot hide an ask in the text.
  await expectHubError(() => dispatchTask(hub, { agent: 'quick', title: '修首页', instruction: '改完运行 npm test', needs: ['code'] }), 400, 'role-not-coding')
  await expectHubError(() => dispatchTask(hub, { agent: 'quick', title: 'x', instruction: 'y', needs: ['code', 'fly'] }), 400, 'bad-needs')
  // Editing only (also "write tests" and "don't run the tests") goes to the coder.
  await dispatchTask(hub, { task_id: 'edit', agent: 'quick', title: '修首页布局', instruction: '改 index.css，写单元测试覆盖 parse()，不要跑测试', needs: ['code'] })
  // In a pool, the coder leaves the test + git task to the worker.
  await dispatchTask(hub, { task_id: 'ship', agent: 'pool:code', title: '跑测试并提交', instruction: '跑 npm test，通过后 git push' })
  await hub.heartbeat('quick', {})
  await hub.heartbeat('dsh', {})
  const coder = await hub.poll('quick', { max: 5 })
  assert.deepEqual(coder.tasks.map(x => x.task_id), ['edit'])
  assert.equal(coder.tasks[0].duties.role, 'coder')
  assert.deepEqual(coder.tasks[0].needs, ['code'])
  assert.match(coder.tasks[0].boundary, /coder.*不能跑测试/)
  const worker = await hub.poll('dsh', { max: 5 })
  assert.deepEqual(worker.tasks.map(x => x.task_id), ['ship'])
  assert.equal(worker.tasks[0].duties.role, 'worker')
  // agent_list shows what each may and may not do.
  const agents = Object.fromEntries((await hub.listAgents()).map(a => [a.agent_id, a]))
  assert.deepEqual(agents.quick.duties.cannot, ['跑测试', '执行命令或脚本', 'git（提交、推送、开 PR）'])
  assert.deepEqual(agents.dsh.duties.cannot, [])
})

test('a worker may narrow its own role by heartbeat, never widen it', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'quick', { capabilities: ['code'] })
  await hub.heartbeat('quick', { role: 'coder' })
  assert.equal((await hub.listAgents())[0].role, 'coder')
  await hub.heartbeat('quick', { role: 'worker' })
  assert.equal((await hub.listAgents())[0].role, 'coder')
  await expectHubError(() => hub.heartbeat('quick', { role: 'boss' }), 400, 'bad-role')
  // Approval: worker -> coder narrows; tester -> coder is another kind of work, refused.
  const req = await hub.requestEnrollment({ agent_id: 'qa', role: 'tester' })
  await expectHubError(() => hub.approveRequest(CTL, req.request_id, { role: 'coder' }), 400, 'role-widened')
})
