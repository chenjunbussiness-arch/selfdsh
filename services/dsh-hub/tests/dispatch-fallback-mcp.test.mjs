/**
 * dsh-agent/3.0 additions: dispatcher agents, the DSH fallback (dsh-self),
 * release_task and the MCP gateway for MCP-only clients (AWS Quick).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { FALLBACK_AGENT } from '../lib/hub.js'
import { createHandler } from '../lib/http.js'
import { McpGateway } from '../lib/mcp.js'
import { CTL, CTL2, dispatchTask, expectHubError, fakeReq, fakeRes, makeHub, provision } from './helpers.mjs'

const MIN = 60_000

test('a dispatcher agent dispatches with its own token and sees only its own tasks', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'planner', { role: 'dispatcher' })
  await provision(hub, 'worker')
  await provision(hub, 'plain')
  const task = await hub.agentDispatch('planner', { task_id: 'p1', title: 'Split', instruction: 'Do part 1.', agent: 'worker' })
  assert.equal(task.created_by, 'agent:planner')
  await dispatchTask(hub, { task_id: 'c1' })
  assert.deepEqual((await hub.agentTasks('planner')).map(x => x.task_id), ['p1'])
  await expectHubError(() => hub.agentCancel('planner', 'c1'), 403, 'not-creator')
  assert.equal((await hub.agentCancel('planner', 'p1', 'changed plan')).status, 'cancelled')
  await expectHubError(() => hub.agentDispatch('plain', { title: 'x', instruction: 'y', agent: 'worker' }), 403, 'not-dispatcher')
  await expectHubError(() => dispatchTask(hub, { agent: FALLBACK_AGENT }), 400, 'bad-task')
  await expectHubError(() => provision(hub, FALLBACK_AGENT), 400, 'bad-agent-id')
})

test('nobody takes a pool task for 10 minutes: DSH takes it over once, the result counts', async (t) => {
  const { hub, clock } = await makeHub(t)
  await dispatchTask(hub, { task_id: 'r1', agent: 'pool:report', inputs: [{ name: 'brief.md', text: 'hi' }] })
  assert.deepEqual(await hub.listFallback(CTL), [])
  await expectHubError(() => hub.takeFallback(CTL, { task_id: 'r1' }), 409, 'not-fallback')
  clock.advance(10 * MIN)
  assert.equal((await hub.overview()).fallback_due, 1)
  assert.deepEqual((await hub.listFallback(CTL)).map(x => x.task_id), ['r1'])
  const { task } = await hub.takeFallback(CTL, {})
  assert.equal(task.task_id, 'r1')
  assert.equal(task.assigned_to, FALLBACK_AGENT)
  assert.equal(task.instruction, 'Do the thing.')
  assert.equal(String(await hub.fallbackInput(CTL, { task_id: 'r1', name: 'brief.md' })), 'hi')
  await expectHubError(() => hub.fallbackResult(CTL2, { task_id: 'r1', status: 'completed', summary: 'x' }), 403, 'not-creator')
  await hub.fallbackProgress(CTL, { task_id: 'r1', progress: 0.5, message: 'writing' })
  const done = await hub.fallbackResult(CTL, { task_id: 'r1', status: 'completed', summary: 'report done', files: [{ name: 'r.md', base64: Buffer.from('# r').toString('base64') }] })
  assert.equal(done.task_status, 'completed')
  const final = await hub.getTask('r1')
  assert.equal(final.fallback_by, CTL)
  assert.equal(final.result.outputs[0].name, 'r.md')
})

test('a named scheduled puller gets two of its periods; fallback none and quick never fall back', async (t) => {
  const { hub, clock } = await makeHub(t)
  await provision(hub, 'quick-mydesk', { pull_every_seconds: 900, capabilities: ['quick', 'report'] })
  await dispatchTask(hub, { task_id: 'n1', agent: 'quick-mydesk' })
  await dispatchTask(hub, { task_id: 'n2', agent: 'quick-mydesk', fallback: 'none' })
  await dispatchTask(hub, { task_id: 'n3', agent: 'pool:quick' })
  await dispatchTask(hub, { task_id: 'n4', agent: 'pool:report', fallback_after_seconds: 60 })
  clock.advance(2 * MIN)
  assert.deepEqual((await hub.listFallback(CTL)).map(x => x.task_id), ['n4'])
  clock.advance(28 * MIN)
  assert.deepEqual((await hub.listFallback(CTL)).map(x => x.task_id).sort(), ['n1', 'n4'])
  await expectHubError(() => dispatchTask(hub, { agent: 'pool:report', fallback: 'maybe' }), 400, 'bad-task')
})

test('a fallback failure is final; an expired fallback lease fails the task; the old worker is told to stop', async (t) => {
  const { hub, clock } = await makeHub(t)
  await provision(hub, 'worker')
  await dispatchTask(hub, { task_id: 'f1', lease_seconds: 600 })
  await dispatchTask(hub, { task_id: 'f2', lease_seconds: 600 })
  await hub.poll('worker', { max: 2 })
  clock.advance(2 * MIN)
  await hub.sweep() // worker offline: both requeued
  clock.advance(10 * MIN)
  await hub.takeFallback(CTL, { task_id: 'f1' })
  await hub.takeFallback(CTL, { task_id: 'f2' })
  const hb = await hub.heartbeat('worker', { running: ['f1'] })
  assert.deepEqual(hb.abort, ['f1'])
  await expectHubError(() => hub.submitResult('worker', { task_id: 'f1', status: 'completed', summary: 'late' }), 404, 'task-not-found')
  const failed = await hub.fallbackResult(CTL, { task_id: 'f1', status: 'failed', summary: 'no', error: { code: 'X', retryable: true } })
  assert.equal(failed.task_status, 'failed', 'no retry after DSH tried')
  assert.deepEqual(await hub.listFallback(CTL), [])
  clock.advance(11 * MIN)
  await hub.sweep()
  assert.equal((await hub.getTask('f2')).result.error.code, 'FALLBACK_TIMEOUT')
})

test('a code task falls back only when DSH has its workspace', async (t) => {
  const { hub, clock } = await makeHub(t)
  await dispatchTask(hub, { task_id: 'k1', agent: 'pool:code', type: 'code', workspace: 'selfdsh' })
  clock.advance(11 * MIN)
  assert.deepEqual(await hub.listFallback(CTL, { workspaces: ['other'] }), [])
  await expectHubError(() => hub.takeFallback(CTL, { task_id: 'k1', workspaces: ['other'] }), 409, 'not-fallback')
  assert.equal((await hub.takeFallback(CTL, { workspaces: ['selfdsh'] })).task.task_id, 'k1')
})

test('release_task gives a task back; that worker is not offered it again', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'aa', { capabilities: ['report'] })
  await provision(hub, 'bb', { capabilities: ['report'] })
  await dispatchTask(hub, { task_id: 'x1', agent: 'pool:report' })
  assert.equal((await hub.poll('aa')).tasks[0].task_id, 'x1')
  assert.equal((await hub.release('aa', { task_id: 'x1', reason: 'no access' })).task_status, 'pending')
  assert.deepEqual((await hub.poll('aa')).tasks, [])
  assert.equal((await hub.poll('bb')).tasks[0].attempt, 1, 'the release did not count as an attempt')
})

// --- MCP over HTTP ---------------------------------------------------------------

async function call(handler, { method = 'POST', url, headers = {}, body }) {
  const res = fakeRes()
  await handler(fakeReq({ method, url, headers, body }), res)
  return res
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params })

test('MCP: client_credentials -> bearer; next_task, get_input, submit_result as the agent', async (t) => {
  const { hub } = await makeHub(t)
  const { token } = await provision(hub, 'quick-mydesk', { pull_every_seconds: 900 })
  const handler = createHandler({ hub })
  await dispatchTask(hub, { task_id: 'q1', agent: 'quick-mydesk', inputs: [{ name: 'q.txt', text: 'question' }] })

  const bad = await call(handler, { url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials&client_id=quick-mydesk&client_secret=dsha_nope' })
  assert.equal(bad.statusCode, 401)
  assert.equal(bad.json().error, 'invalid_client')
  const basic = Buffer.from(`quick-mydesk:${token}`).toString('base64')
  const tok = await call(handler, { url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` }, body: 'grant_type=client_credentials' })
  assert.equal(tok.statusCode, 200)
  const { access_token: bearer, expires_in: ttl } = tok.json()
  assert.equal(ttl, 900)
  assert.match(bearer, /^dshm_/)

  const auth = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }
  assert.equal((await call(handler, { url: '/mcp', headers: { 'content-type': 'application/json' }, body: rpc(1, 'ping') })).statusCode, 401)
  const init = (await call(handler, { url: '/mcp', headers: auth, body: rpc(1, 'initialize', { protocolVersion: '2025-03-26' }) })).json()
  assert.equal(init.result.protocolVersion, '2025-03-26')
  assert.equal((await call(handler, { url: '/mcp', headers: auth, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).statusCode, 202)
  const tools = (await call(handler, { url: '/mcp', headers: auth, body: rpc(2, 'tools/list') })).json().result.tools
  assert.deepEqual(tools.map(x => x.name), ['next_task', 'get_input', 'report_progress', 'submit_result', 'release_task'])

  const tool = async (n, name, args) => (await call(handler, { url: '/mcp', headers: auth, body: rpc(n, 'tools/call', { name, arguments: args }) })).json().result
  const next = await tool(3, 'next_task', {})
  assert.equal(next.structuredContent.task.task_id, 'q1')
  assert.equal((await tool(4, 'get_input', { task_id: 'q1', name: 'q.txt' })).structuredContent.text, 'question')
  const wrong = await tool(5, 'submit_result', { task_id: 'nope', status: 'completed', summary: 'x' })
  assert.equal(wrong.isError, true)
  const done = await tool(6, 'submit_result', { task_id: 'q1', status: 'completed', summary: 'answered', files: [{ name: 'a.md', text: '# answer' }] })
  assert.equal(done.structuredContent.task_status, 'completed')
  assert.equal(String(await hub.readOutput('q1', 'a.md')), '# answer')
  assert.deepEqual((await tool(7, 'next_task', {})).structuredContent, { task: null })

  await hub.revokeAgent(CTL, 'quick-mydesk')
  assert.equal((await call(handler, { url: '/mcp', headers: auth, body: rpc(8, 'tools/call', { name: 'next_task', arguments: {} }) })).statusCode, 401, 'revoke ends the bearer at once')
})

test('MCP: bearers expire; GET is not offered; disabled gateway answers 404', async (t) => {
  const { hub, clock } = await makeHub(t)
  const { token } = await provision(hub, 'quick-mydesk')
  const gateway = new McpGateway({ hub, clock })
  const handler = createHandler({ hub, mcp: gateway })
  const { access_token: bearer } = await gateway.issueToken({ grant_type: 'client_credentials', client_id: 'quick-mydesk', client_secret: token })
  const auth = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }
  assert.equal((await call(handler, { method: 'GET', url: '/mcp', headers: auth })).statusCode, 405)
  assert.equal((await call(handler, { url: '/mcp', headers: auth, body: rpc(1, 'ping') })).statusCode, 200)
  clock.advance(15 * MIN + 1)
  const expired = await call(handler, { url: '/mcp', headers: auth, body: rpc(2, 'ping') })
  assert.equal(expired.statusCode, 401)
  await expectHubError(() => gateway.issueToken({ grant_type: 'password', client_id: 'quick-mydesk', client_secret: token }), 400, 'unsupported_grant_type')
  const off = createHandler({ hub, mcp: false })
  assert.equal((await call(off, { url: '/mcp', headers: auth, body: rpc(3, 'ping') })).statusCode, 404)
})
