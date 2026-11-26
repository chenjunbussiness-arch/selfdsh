/**
 * The hub as the one channel every DSH and worker writes to: DSH profiles,
 * tasks a DSH registers and runs itself, progress stages and the event
 * stream, full session logs (redacted), and expiry / archiving.
 */
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'
import { FALLBACK_AGENT, redact } from '../lib/hub.js'
import { CTL, CTL2, dispatchTask, expectHubError, fakeSignal, makeHub, provision, sleep } from './helpers.mjs'

const WS = 'site'
const HOUR = 3600_000

async function worker(hub, id, { profile, workspaces = [WS], ...extra } = {}) {
  const out = await provision(hub, id, { workspaces, ...(profile === undefined ? {} : { dsh_profile: profile }), ...extra })
  await hub.heartbeat(id, { status: 'idle', workspaces })
  return out
}

test('redact strips tokens, keys, passwords and internal addresses', () => {
  const text = [
    'token dsha_code-mydesk_abcdefghijklmnopqrstuvwxyz012345',
    'gh ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'key sk-ant-api03-abcdefghijklmnop',
    'password=hunter2hunter2',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'ssh to 10.1.2.3 and 192.168.0.12 and 172.20.1.1',
    'public 8.8.8.8 stays',
  ].join('\n')
  const out = redact(text)
  for (const secret of ['dsha_code-mydesk_abc', 'ghp_abc', 'sk-ant-api03', 'hunter2', 'abcdefghijklmnopqrstuvwxyz', '10.1.2.3', '192.168.0.12', '172.20.1.1']) {
    assert.ok(!out.includes(secret), `${secret} leaked: ${out}`)
  }
  assert.match(out, /8\.8\.8\.8 stays/)
  assert.match(out, /password=\[redacted\]/)
})

test('dsh_profile: enrolled, shown, routes tasks, and cannot be switched by a heartbeat', async (t) => {
  const { hub } = await makeHub(t)
  await worker(hub, 'desk-web', { profile: 'web', capabilities: ['code'] })
  await worker(hub, 'desk-ops', { profile: 'ops', capabilities: ['code'] })
  const agents = await hub.listAgents()
  assert.deepEqual(Object.fromEntries(agents.map(a => [a.agent_id, a.dsh_profile])), { 'desk-web': 'web', 'desk-ops': 'ops' })

  const task = await dispatchTask(hub, { agent: 'pool:code', dsh_profile: 'ops', workspace: WS })
  assert.equal(task.dsh_profile, 'ops')
  assert.deepEqual((await hub.poll('desk-web')).tasks, [], 'another profile does not get it')
  assert.deepEqual((await hub.poll('desk-ops')).tasks.map(x => x.task_id), [task.task_id])

  await expectHubError(() => dispatchTask(hub, { agent: 'desk-web', dsh_profile: 'ops' }), 409, 'unroutable')
  await expectHubError(() => dispatchTask(hub, { dsh_profile: 'bad name!' }), 400, 'bad-task')

  const hb = await hub.heartbeat('desk-web', { dsh_profile: 'ops' })
  assert.equal(hb.profile_mismatch, 'ops')
  assert.equal(hb.dsh_profile, 'web')
  assert.equal((await hub.me('desk-web')).dsh_profile, 'web')
})

test('a worker enrolled without a profile (older client) may name it once', async (t) => {
  const { hub } = await makeHub(t)
  await worker(hub, 'old')
  assert.equal((await hub.heartbeat('old', { dsh_profile: 'web' })).dsh_profile, 'web')
  assert.equal((await hub.heartbeat('old', { dsh_profile: 'ops' })).profile_mismatch, 'ops')
})

test('enrollment carries dsh_profile to the request list and the approved agent', async (t) => {
  const { hub } = await makeHub(t)
  const asked = await hub.requestEnrollment({ agent_id: 'desk', capabilities: ['code'], workspaces: [WS], dsh_profile: 'web' })
  assert.equal((await hub.listRequests())[0].dsh_profile, 'web')
  await hub.approveRequest(CTL, asked.request_id)
  assert.equal((await hub.listAgents())[0].dsh_profile, 'web')
  await expectHubError(() => hub.requestEnrollment({ agent_id: 'bad', dsh_profile: '../x' }), 400, 'bad-profile')
})

test('run_here: a DSH registers a task it runs itself; it is never offered to a worker', async (t) => {
  const { hub } = await makeHub(t)
  await worker(hub, 'worker')
  const task = await hub.dispatch(CTL, { title: 'Fix login', instruction: 'x', run_here: true, task_id: 'local_web_t1', executor: 'dsh-self/web/frontend', dsh_profile: 'web', workspace: WS })
  assert.equal(task.status, 'running')
  assert.equal(task.assigned_to, FALLBACK_AGENT)
  assert.deepEqual(task.origin, { kind: 'local', by: CTL, executor: 'dsh-self/web/frontend' })
  assert.equal(task.stage, 'received')
  assert.deepEqual((await hub.poll('worker')).tasks, [])
  assert.deepEqual((await hub.listFallback(CTL)), [], 'not a fallback candidate')

  const again = await hub.dispatch(CTL, { title: 'Fix login', instruction: 'x', run_here: true, task_id: 'local_web_t1' })
  assert.equal(again.already, true, 'registering twice is harmless')
  await expectHubError(() => hub.dispatch(CTL2, { title: 'x', instruction: 'x', run_here: true, task_id: 'local_web_t1' }), 409, 'task-exists')

  await hub.fallbackProgress(CTL, { task_id: 'local_web_t1', stage: 'started', message: 'working on the form' })
  await expectHubError(() => hub.fallbackProgress(CTL2, { task_id: 'local_web_t1', message: 'x' }), 403, 'not-creator')
  await hub.fallbackResult(CTL, { task_id: 'local_web_t1', status: 'completed', summary: 'done' })
  const done = await hub.getTask('local_web_t1')
  assert.equal(done.status, 'completed')
  assert.deepEqual(done.history.map(h => h.event), ['registered', 'progress', 'completed'])
  assert.deepEqual((await hub.listTasks({ origin: 'local' })).map(x => x.task_id), ['local_web_t1'])
})

test('a local task is not failed while its DSH is silent; it shows as quiet and goes on when the DSH is back', async (t) => {
  const { hub, clock } = await makeHub(t)
  await hub.dispatch(CTL, { title: 'Long', instruction: 'x', run_here: true, task_id: 'local_long' })
  clock.advance(3 * HOUR)
  await hub.sweep()
  const quiet = await hub.getTask('local_long')
  assert.equal(quiet.status, 'running')
  assert.equal(quiet.quiet, true)
  await hub.fallbackProgress(CTL, { task_id: 'local_long', stage: 'step', message: 'back' })
  assert.equal((await hub.getTask('local_long')).quiet, undefined)
  await hub.fallbackResult(CTL, { task_id: 'local_long', status: 'completed', summary: 'ok' })
  assert.equal((await hub.getTask('local_long')).status, 'completed')
})

test('run_here is for controllers only and takes no inputs', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'boss', { role: 'dispatcher' })
  await expectHubError(() => hub.agentDispatch('boss', { title: 'x', instruction: 'x', run_here: true }), 403, 'not-controller')
  await expectHubError(() => hub.dispatch(CTL, { title: 'x', instruction: 'x', run_here: true, inputs: [{ name: 'a.txt', text: 'a' }] }), 400, 'bad-task')
})

test('progress stages: stored, in history, in the event stream; a bare renew records nothing', async (t) => {
  const { hub } = await makeHub(t)
  await worker(hub, 'worker')
  const task = await dispatchTask(hub)
  await hub.poll('worker')
  const before = (await hub.feed()).latest
  await hub.progress('worker', { task_id: task.task_id, renew: true })
  assert.equal((await hub.feed()).latest, before, 'renew alone is silent')
  await hub.progress('worker', { task_id: task.task_id, stage: 'step', message: 'tests green, password=secretsecret', progress: 0.6 })
  await expectHubError(() => hub.progress('worker', { task_id: task.task_id, stage: 'nope' }), 400, 'bad-stage')
  const got = await hub.getTask(task.task_id)
  assert.equal(got.stage, 'step')
  assert.equal(got.progress, 0.6)
  assert.match(got.message, /password=\[redacted\]/)
  const feed = await hub.feed({ after: before })
  assert.deepEqual(feed.events.map(e => [e.kind, e.stage]), [['progress', 'step']])
  assert.equal(feed.events[0].task_id, task.task_id)
  assert.equal(feed.next, feed.latest)
})

test('a progress report that changes nothing is a keep-alive: lease renewed, no event', async (t) => {
  const { hub } = await makeHub(t)
  await worker(hub, 'worker')
  const task = await dispatchTask(hub)
  await hub.poll('worker')
  const before = (await hub.feed()).latest
  // An older client re-sends "working" every cycle to keep its lease.
  for (let i = 0; i < 5; i++) await hub.progress('worker', { task_id: task.task_id, progress: null, message: 'working' })
  await hub.progress('worker', { task_id: task.task_id, stage: 'step', message: 'tests 3/7' })
  await hub.progress('worker', { task_id: task.task_id, stage: 'step', message: 'tests 3/7' })
  await hub.progress('worker', { task_id: task.task_id, stage: 'step', message: 'tests 7/7' })
  await hub.progress('worker', { task_id: task.task_id, stage: 'needs_input', message: 'tests 7/7' })
  const feed = await hub.feed({ after: before })
  assert.deepEqual(feed.events.map(e => [e.stage ?? '', e.message]), [['', 'working'], ['step', 'tests 3/7'], ['step', 'tests 7/7'], ['needs_input', 'tests 7/7']])
  const got = await hub.getTask(task.task_id, { full: true })
  assert.equal(got.history.filter(e => e.event === 'progress').length, 4)
})

test('event stream: cursor, long poll woken by a new event, reset on a stale cursor', async (t) => {
  const { hub } = await makeHub(t)
  await worker(hub, 'worker')
  const first = await dispatchTask(hub)
  const all = await hub.feed()
  assert.deepEqual(all.events.map(e => [e.task_id, e.kind]), [[first.task_id, 'created']])
  assert.equal(all.reset, false)

  const waiting = hub.feed({ after: all.next, wait: 5 })
  await sleep(20)
  const second = await dispatchTask(hub)
  const woke = await waiting
  assert.deepEqual(woke.events.map(e => e.task_id), [second.task_id])

  const empty = await hub.feed({ after: woke.next, wait: 0 })
  assert.deepEqual(empty.events, [])
  assert.equal((await hub.feed({ after: 9999 })).reset, true)

  const signal = fakeSignal()
  const aborted = hub.feed({ after: woke.next, wait: 30, signal })
  await sleep(10)
  signal.abort()
  assert.deepEqual((await aborted).events, [])
})

test('session logs: worker and DSH upload pieces, redacted; any controller reads them', async (t) => {
  const { hub, dataDir } = await makeHub(t)
  await worker(hub, 'worker')
  const task = await dispatchTask(hub)
  await expectHubError(() => hub.agentSession('worker', { task_id: task.task_id, entries: [{ role: 'user', text: 'hi' }] }), 404, 'task-not-found')
  await hub.poll('worker')
  const up = await hub.agentSession('worker', { task_id: task.task_id, entries: [
    { role: 'user', text: 'Fix it' },
    { role: 'tool', name: 'bash', text: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" http://10.0.0.5/' },
  ] })
  assert.deepEqual(up, { ok: true, stored: 2, session_entries: 2 })
  await hub.agentSession('worker', { task_id: task.task_id, entries: [{ role: 'assistant', text: 'Done.' }] })
  await hub.submitResult('worker', { task_id: task.task_id, status: 'completed', summary: 'ok' })
  await hub.agentSession('worker', { task_id: task.task_id, entries: [{ role: 'note', text: 'late tail' }] })

  const read = await hub.readSession(task.task_id)
  assert.equal(read.total, 4)
  assert.deepEqual(read.entries.map(e => [e.index, e.role, e.by]), [[0, 'user', 'worker'], [1, 'tool', 'worker'], [2, 'assistant', 'worker'], [3, 'note', 'worker']])
  assert.equal(read.entries[1].name, 'bash')
  assert.ok(!read.entries[1].text.includes('abcdefghijklmnop') && !read.entries[1].text.includes('10.0.0.5'), read.entries[1].text)
  assert.deepEqual((await hub.readSession(task.task_id, { after: 3 })).entries.map(e => e.index), [3])
  assert.equal((await hub.getTask(task.task_id)).session_entries, 4)
  assert.ok((await readFile(join(dataDir, 'artifacts', task.task_id, 'session.jsonl'), 'utf8')).includes('"role":"user"'))

  await expectHubError(() => hub.agentSession('worker', { task_id: task.task_id, entries: [] }), 400, 'bad-session')
  await expectHubError(() => hub.agentSession('worker', { task_id: task.task_id, entries: [{ role: 'bot', text: 'x' }] }), 400, 'bad-session')

  await hub.dispatch(CTL, { title: 'Local', instruction: 'x', run_here: true, task_id: 'local_1', executor: 'dsh-self/web' })
  await hub.controllerSession(CTL, { task_id: 'local_1', entries: [{ role: 'assistant', text: 'local work' }] })
  await expectHubError(() => hub.controllerSession(CTL2, { task_id: 'local_1', entries: [{ role: 'note', text: 'x' }] }), 403, 'not-holder')
  assert.deepEqual((await hub.readSession('local_1')).entries.map(e => [e.text, e.by]), [['local work', 'dsh-self/web']])
})

test('expiry: done tasks leave the default list after 12 h, failed after 2 days or once acknowledged', async (t) => {
  const { hub, clock } = await makeHub(t)
  await worker(hub, 'worker', { max_concurrency: 4 })
  const ok = await dispatchTask(hub, { title: 'ok' })
  const bad = await dispatchTask(hub, { title: 'bad' })
  const seen = await dispatchTask(hub, { title: 'seen' })
  await hub.poll('worker', { max: 3 })
  await hub.submitResult('worker', { task_id: ok.task_id, status: 'completed', summary: 'ok' })
  await hub.submitResult('worker', { task_id: bad.task_id, status: 'failed', error: { code: 'X', message: 'no' } })
  await hub.submitResult('worker', { task_id: seen.task_id, status: 'failed', error: { code: 'X', message: 'no' } })
  await hub.acknowledge(CTL, seen.task_id)
  const listed = async () => (await hub.listTasks()).map(x => x.title).sort()
  assert.deepEqual(await listed(), ['bad', 'ok'])
  clock.advance(13 * HOUR)
  assert.deepEqual(await listed(), ['bad'])
  clock.advance(36 * HOUR)
  assert.deepEqual(await listed(), [])
  assert.deepEqual((await hub.listTasks({ history: 'only' })).map(x => x.title).sort(), ['bad', 'ok', 'seen'])
  const overview = await hub.overview()
  assert.equal(overview.history_count, 3)
  assert.deepEqual(overview.expiry, { doneHours: 12, failedHours: 48, dormantHours: 72, archiveHours: 168 })
  const pending = await dispatchTask(hub)
  await expectHubError(() => hub.acknowledge(CTL, pending.task_id), 409, 'task-active')
  // A finished task that handed back a question (partial) is put away the same way.
  const asked = await dispatchTask(hub, { title: 'asked' })
  await hub.poll('worker', { max: 2 })
  await hub.submitResult('worker', { task_id: asked.task_id, status: 'partial', summary: '', needs_input: 'v1 or v2?' })
  assert.ok((await listed()).includes('asked'))
  await hub.acknowledge(CTL, asked.task_id)
  assert.ok(!(await listed()).includes('asked'))
})

test('expiry: an agent silent for 3 days is dormant; revoked ones always are', async (t) => {
  const { hub, clock } = await makeHub(t)
  await worker(hub, 'worker')
  await worker(hub, 'gone')
  await hub.revokeAgent(CTL, 'gone')
  const dormant = async () => Object.fromEntries((await hub.listAgents()).map(a => [a.agent_id, a.dormant]))
  assert.deepEqual(await dormant(), { worker: false, gone: true })
  clock.advance(71 * HOUR)
  assert.equal((await dormant()).worker, false)
  clock.advance(2 * HOUR)
  assert.equal((await dormant()).worker, true)
  assert.equal((await hub.overview()).dormant_agents, 2)
  await hub.heartbeat('worker', {})
  assert.equal((await dormant()).worker, false)
})

test('archive: finished tasks older than 7 days leave state.json, compressed, with their files', async (t) => {
  const { hub, clock, dataDir } = await makeHub(t)
  await worker(hub, 'worker')
  const old = await dispatchTask(hub, { title: 'old' })
  await hub.poll('worker')
  await hub.agentSession('worker', { task_id: old.task_id, entries: [{ role: 'user', text: 'x' }] })
  await hub.submitResult('worker', { task_id: old.task_id, status: 'completed', summary: 'ok' })
  clock.advance(6 * 24 * HOUR)
  const young = await dispatchTask(hub, { title: 'young' })
  await hub.sweep()
  assert.ok((await hub.listTasks({ history: 'include' })).some(x => x.task_id === old.task_id), 'not yet')
  clock.advance(2 * 24 * HOUR)
  await hub.sweep()
  const left = (await hub.listTasks({ history: 'include' })).map(x => x.task_id)
  assert.deepEqual(left, [young.task_id])
  const files = await readdir(join(dataDir, 'archive'))
  const gz = files.find(f => f.endsWith('.jsonl.gz'))
  assert.ok(gz, files.join(','))
  const lines = gunzipSync(await readFile(join(dataDir, 'archive', gz))).toString('utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(lines.map(l => l.task_id), [old.task_id])
  assert.ok((await stat(join(dataDir, 'archive', 'tasks', old.task_id, 'session.jsonl'))).isFile())
  assert.ok(!(await readFile(join(dataDir, 'state.json'), 'utf8')).includes(old.task_id))
  await expectHubError(() => hub.getTask(old.task_id), 404, 'task-not-found')
})

test('archive keeps a finished task an open task still depends on', async (t) => {
  const { hub, clock } = await makeHub(t)
  await worker(hub, 'worker')
  const up = await dispatchTask(hub, { title: 'up' })
  await hub.poll('worker')
  await hub.submitResult('worker', { task_id: up.task_id, status: 'completed', summary: 'ok' })
  await dispatchTask(hub, { title: 'down', depends_on: [up.task_id], agent: 'pool:none', fallback: 'none' })
  clock.advance(8 * 24 * HOUR)
  await hub.sweep()
  assert.ok((await hub.listTasks({ history: 'include' })).some(x => x.task_id === up.task_id))
})
