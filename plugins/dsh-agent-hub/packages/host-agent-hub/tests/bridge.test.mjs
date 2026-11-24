import assert from 'node:assert/strict'
import test from 'node:test'
import { ADMIN_BASE, BRIDGE_BASE, REQUEST_STATUSES, TASK_STATUSES, adminFailure, adminTaskRow, createRoutes, requireLogin } from '../bridge.js'
import { HubError } from '../hub-client.js'
import { CONTROLLER, TOKEN, assertNoToken, callRoute, fakeLogger, findRoute, jsonHeaders, makeClient } from './helpers.mjs'

const A = name => `${ADMIN_BASE}/${name}`
const PATHS = ['overview', 'agents', 'tasks', 'task', 'requests', 'session'].map(A)
const ALL_PATHS = [...PATHS, A('ack')]
const errorOf = res => res.json().error

// --- hub fixtures, with fields that must NOT pass the whitelist ---------------------

const HUB_AGENT = {
  agent_id: 'quick-mydesk', platform: 'aws-quick', mode: 'poll', node: 'mydesk', workspaces: ['deepseek-harness'],
  capabilities: ['research', 'code'], max_concurrency: 2, description: 'Quick on MYDESK dsha_quick-mydesk_LEAKED', revoked: false,
  online: true, last_seen: '2026-11-22T12:00:00.000Z', reported_status: 'busy', running_tasks: ['t1'], created_at: '2026-11-01T00:00:00.000Z',
  status: 'online', version: 'agent_client/2.1.0', left_at: undefined,
  tokenHash: 'ab'.repeat(32), token: 'dsha_quick-mydesk_SECRET', granted_workspaces: ['deepseek-harness'],
}
const AGENT_KEYS = ['agent_id', 'platform', 'mode', 'capabilities', 'max_concurrency', 'description', 'role', 'revoked', 'online', 'last_seen', 'reported_status', 'running_tasks', 'created_at', 'status', 'version', 'node', 'dormant']

const HUB_TASK = {
  task_id: 't1', agent: 'pool:code', assigned_to: 'quick-mydesk', type: 'code', title: 'Fix it', status: 'completed', priority: 'high',
  attempts: 1, progress: 1, message: `done with ${TOKEN}`, created_at: '2026-11-22T10:00:00.000Z', lease_until: undefined, depends_on: ['t0'],
  workspace: 'deepseek-harness', node: 'mydesk', ref: 'main', created_by: 'dsh-cloud',
  instruction: 'Apply the patch. dsha_quick-mydesk_abc', inputs: ['spec.md'], output: { format: 'patch', filename: 'changes.patch' },
  context: { repo: 'x', secret: 'value-that-must-not-leave' }, history: [{ at: '2026-11-22T10:00:00.000Z', event: 'created', message: '-> pool:code', extra: 1 }],
  result: {
    status: 'completed', summary: 'patched', needs_input: undefined, agent: 'quick-mydesk', finished_at: 'x',
    outputs: [{ name: 'changes.patch', bytes: 120, type: 'patch', description: 'diff', path: '/srv/artifacts/t1/outputs/changes.patch' }],
    error: { code: 'NONE', message: 'n/a', retryable: false, stack: 'at hub.js:1' },
  },
}
const ROW_KEYS = ['task_id', 'agent', 'assigned_to', 'type', 'title', 'status', 'priority', 'attempts', 'progress', 'message', 'created_at', 'lease_until', 'depends_on', 'result', 'acknowledged', 'in_history', 'quiet', 'session_entries']
const DETAIL_KEYS = [...ROW_KEYS, 'instruction', 'inputs', 'output', 'context_keys', 'history', 'output_files']

const HUB_REQUEST = {
  request_id: 'req_1', status: 'pending', agent_id: 'kiro-mydesk', platform: 'kiro', mode: 'push', node: 'mydesk', workspaces: ['deepseek-harness'],
  capabilities: ['code'], max_concurrency: 1, description: 'Kiro', from: '203.0.113.9', requested_at: '2026-11-22T09:00:00.000Z',
  decided_at: undefined, reason: undefined, secretHash: 'cd'.repeat(32), poll_secret: 'SECRET',
}
const REQUEST_KEYS = ['request_id', 'status', 'agent_id', 'platform', 'mode', 'capabilities', 'max_concurrency', 'description', 'role', 'from', 'requested_at', 'decided_at', 'reason']

const HUB_OVERVIEW = {
  protocol: 'dsh-agent/2.0', agents: [HUB_AGENT], task_counts: { pending: 2, completed: 5, bogus: 9, running: -1 }, pending_requests: 1,
  controllers: ['dsh-cloud', 'dsh-local'], hub_token_hashes: ['x'],
}

const ROUTES = {
  'GET /v1/ctl/overview': { body: HUB_OVERVIEW },
  'GET /v1/ctl/agents': { body: { agents: [HUB_AGENT, { ...HUB_AGENT, agent_id: 'claude-cloud', online: false, running_tasks: [] }] } },
  'GET /v1/ctl/tasks': { body: { tasks: [HUB_TASK] } },
  'GET /v1/ctl/task': (call) => (call.query.get('task_id') === 't1'
    ? { body: HUB_TASK }
    : { status: 404, body: { error: { code: 'task-not-found', message: `task not found: ${call.query.get('task_id')}` } } }),
  'GET /v1/ctl/requests': { body: { requests: [HUB_REQUEST] } },
}

function setup(handler = ROUTES, options = {}) {
  const base = makeClient(handler, options)
  const logger = fakeLogger()
  const { adminRoutes } = createRoutes({ client: base.client, logger })
  const route = path => findRoute(adminRoutes, path)
  const get = (path, query = '') => callRoute(route(path), { method: 'GET', url: `${path}${query}` })
  return { ...base, logger, adminRoutes, route, get }
}

const keys = obj => Object.keys(obj).sort()

test('route table: six read-only admin routes plus ack; no worker /v1 routes any more', () => {
  const { adminRoutes } = setup()
  assert.deepEqual(adminRoutes.map(r => r.path).sort(), [...ALL_PATHS].sort())
  for (const r of adminRoutes) {
    assert.equal(r.kind, 'exact', r.path)
    assert.equal(typeof r.handler, 'function')
    assert.ok(r.path.startsWith(`${BRIDGE_BASE}/admin/`))
    assert.ok(!r.path.includes('/v1'))
  }
  assert.equal(ADMIN_BASE, '/api/agent-hub/admin')
  assert.deepEqual(TASK_STATUSES, ['pending', 'accepted', 'running', 'completed', 'failed', 'cancelled', 'dead'])
  assert.deepEqual(REQUEST_STATUSES, ['pending', 'approved', 'rejected', 'expired', 'all'])
})

test('overview: forwarded to GET /v1/ctl/overview and re-projected (contract.ts Overview)', async () => {
  const { get, calls } = setup()
  const res = await get(A('overview'))
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['content-length'], res.body.length)
  const body = res.json()
  assert.deepEqual(keys(body), ['agents', 'dormant_agents', 'fallback_due', 'pending_requests', 'protocol', 'task_counts'])
  assert.equal(body.protocol, 'dsh-agent/2.0')
  assert.deepEqual(body.task_counts, { pending: 2, completed: 5 }, 'unknown statuses and bad numbers dropped')
  assert.equal(body.pending_requests, 1)
  assert.deepEqual(keys(body.agents[0]), [...AGENT_KEYS].sort())
  assert.equal(calls[0].path, '/v1/ctl/overview')
  assert.deepEqual([...calls[0].query.entries()].map(([k, v]) => [k, v]), [['id', CONTROLLER]])
  assert.equal(calls[0].headers['X-DSH-Token'], TOKEN)
  assertNoToken(res.text)
})

test('agents: { generated_at, online, agents } with the v1 whitelist, tokens masked', async () => {
  const { get } = setup()
  const body = (await get(A('agents'))).json()
  assert.deepEqual(keys(body), ['agents', 'generated_at', 'online'])
  assert.ok(!Number.isNaN(Date.parse(body.generated_at)))
  assert.equal(body.online, 1)
  assert.deepEqual(body.agents.map(a => a.agent_id), ['quick-mydesk', 'claude-cloud'])
  const a = body.agents[0]
  assert.deepEqual(keys(a), [...AGENT_KEYS].sort())
  assert.deepEqual(a, {
    agent_id: 'quick-mydesk', platform: 'aws-quick', mode: 'poll', capabilities: ['research', 'code'], max_concurrency: 2,
    description: 'Quick on MYDESK dsha_***', revoked: false, online: true, last_seen: '2026-11-22T12:00:00.000Z',
    reported_status: 'busy', running_tasks: ['t1'], created_at: '2026-11-01T00:00:00.000Z', status: 'online', version: 'agent_client/2.1.0',
    role: 'worker', node: 'mydesk', dormant: false,
  })
  const text = JSON.stringify(body)
  for (const secret of ['tokenHash', 'SECRET', 'abab', 'granted_workspaces']) assert.ok(!text.includes(secret), secret)
})

test('tasks: filter validated locally, forwarded as query, rows whitelisted', async () => {
  const { get, calls } = setup()
  const res = await get(A('tasks'), '?status=completed&agent=pool:code&limit=20')
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.deepEqual(body.filter, { status: 'completed', agent: 'pool:code', limit: 20, history: 'hide' })
  assert.deepEqual(Object.fromEntries(calls.at(-1).query.entries()), { id: CONTROLLER, status: 'completed', agent: 'pool:code', limit: '20' })
  const row = body.tasks[0]
  assert.deepEqual(keys(row), [...ROW_KEYS].filter(k => k !== 'lease_until').sort(), 'undefined lease_until is dropped by JSON')
  assert.equal(row.message, 'done with dshc_***')
  assert.deepEqual(row.result, { status: 'completed', summary: 'patched', error: { code: 'NONE', message: 'n/a', retryable: false }, output_count: 1 })
  assertNoToken(res.text)

  const all = (await get(A('tasks'))).json()
  assert.deepEqual(all.filter, { status: 'all', limit: 50, history: 'hide' })
  assert.deepEqual(Object.fromEntries(calls.at(-1).query.entries()), { id: CONTROLLER, limit: '50' })
  await get(A('tasks'), '?status=all')
  assert.deepEqual(Object.fromEntries(calls.at(-1).query.entries()), { id: CONTROLLER, limit: '50' })

  const before = calls.length
  for (const query of ['?status=done', '?agent=Bad_Id', '?agent=pool:', '?limit=0', '?limit=201', '?limit=1.5', '?limit=x']) {
    const bad = await get(A('tasks'), query)
    assert.equal(bad.statusCode, 400, query)
    assert.equal(errorOf(bad).code, 'bad-query')
  }
  assert.equal(calls.length, before, 'invalid queries never reach the hub')
})

test('task: detail whitelist (context keys only, no artifact paths), 400 without task_id, hub 404 passes through', async () => {
  const { get, calls } = setup()
  const res = await get(A('task'), '?task_id=t1')
  assert.equal(res.statusCode, 200)
  const { task, generated_at } = res.json()
  assert.ok(generated_at)
  assert.deepEqual(keys(task), [...DETAIL_KEYS].filter(k => k !== 'lease_until').sort())
  assert.equal(task.instruction, 'Apply the patch. dsha_***')
  assert.deepEqual(task.inputs, ['spec.md'])
  assert.deepEqual(task.output, { format: 'patch', filename: 'changes.patch' })
  assert.deepEqual(task.context_keys, ['repo', 'secret'])
  assert.deepEqual(task.history, [{ at: '2026-11-22T10:00:00.000Z', event: 'created', message: '-> pool:code' }])
  assert.deepEqual(task.result.outputs, [{ name: 'changes.patch', bytes: 120, type: 'patch', description: 'diff' }])
  assert.deepEqual(task.result.error, { code: 'NONE', message: 'n/a', retryable: false })
  assert.deepEqual(task.output_files, ['changes.patch'])
  for (const secret of ['value-that-must-not-leave', '/srv/artifacts', 'hub.js:1', 'created_by', 'finished_at']) assert.ok(!res.text.includes(secret), secret)
  assert.deepEqual(Object.fromEntries(calls.at(-1).query.entries()), { id: CONTROLLER, task_id: 't1' })

  for (const query of ['', '?task_id=', '?task_id=../x', `?task_id=${'a'.repeat(97)}`]) {
    const bad = await get(A('task'), query)
    assert.equal(bad.statusCode, 400, query)
    assert.deepEqual(errorOf(bad), { code: 'bad-query', message: 'task_id is required' })
  }
  const missing = await get(A('task'), '?task_id=nope')
  assert.equal(missing.statusCode, 404)
  assert.deepEqual(errorOf(missing), { code: 'task-not-found', message: 'task not found: nope' })
})

test('requests: default pending, status forwarded, whitelist drops secrets', async () => {
  const { get, calls } = setup()
  const body = (await get(A('requests'))).json()
  assert.deepEqual(body.filter, { status: 'pending' })
  assert.deepEqual(Object.fromEntries(calls.at(-1).query.entries()), { id: CONTROLLER, status: 'pending' })
  const r = body.requests[0]
  assert.deepEqual(keys(r), [...REQUEST_KEYS].filter(k => k !== 'decided_at' && k !== 'reason').sort())
  assert.equal(r.agent_id, 'kiro-mydesk')
  assert.equal(r.from, '203.0.113.9')
  assert.ok(!JSON.stringify(body).includes('SECRET') && !JSON.stringify(body).includes('secretHash'))
  for (const status of REQUEST_STATUSES) {
    const res = await get(A('requests'), `?status=${status}`)
    assert.equal(res.statusCode, 200, status)
    assert.equal(calls.at(-1).query.get('status'), status)
  }
  const bad = await get(A('requests'), '?status=open')
  assert.equal(bad.statusCode, 400)
  assert.equal(errorOf(bad).code, 'bad-query')
})

test('non-GET is 405 on every admin route, before calling the hub', async () => {
  const { route, calls } = setup()
  for (const path of PATHS) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await callRoute(route(path), { method, headers: jsonHeaders(), body: {} })
      assert.equal(res.statusCode, 405, `${method} ${path}`)
      assert.deepEqual(errorOf(res), { code: 'method-not-allowed', message: 'use GET' })
    }
  }
  assert.equal(calls.length, 0)
})

test('hub unreachable: 503 hub-unreachable on every admin route', async () => {
  for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'DEPTH_ZERO_SELF_SIGNED_CERT']) {
    const { get } = setup(() => ({ networkError: code }))
    for (const path of PATHS) {
      const res = await get(path, path.endsWith('/task') || path.endsWith('/session') ? '?task_id=t1' : '')
      assert.equal(res.statusCode, 503, `${code} ${path}`)
      assert.equal(errorOf(res).code, 'hub-unreachable')
      assert.match(errorOf(res).message, new RegExp(code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ? 'TLS' : code))
      assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
    }
  }
  const slow = setup(() => ({ socketTimeout: true }))
  const res = await slow.get(A('overview'))
  assert.equal(res.statusCode, 503)
  assert.equal(errorOf(res).code, 'hub-unreachable')
})

test('local config problems are 503 with their own code; nothing is sent', async () => {
  const noToken = setup(ROUTES, { env: {} })
  const res = await noToken.get(A('agents'))
  assert.equal(res.statusCode, 503)
  assert.equal(errorOf(res).code, 'hub-token-missing')
  assert.equal(noToken.calls.length, 0)
  const wrong = setup(ROUTES, { env: { DSH_HUB_TOKEN: 'dshc_someone-else_xxxxxxxxxxxx' } })
  const w = await wrong.get(A('agents'))
  assert.equal(w.statusCode, 503)
  assert.equal(errorOf(w).code, 'hub-token-mismatch')
  assert.ok(!w.text.includes('xxxxxxxxxxxx'))
  const unconfigured = setup(ROUTES, { hubUrl: undefined })
  const u = await unconfigured.get(A('overview'))
  assert.equal(u.statusCode, 503)
  assert.equal(errorOf(u).code, 'hub-not-configured')
})

test('hub refusing the controller token is 502 hub-unauthorized (never 401: the panel reads 401 as DSH login)', async () => {
  for (const status of [401, 403]) {
    const { get } = setup(() => ({ status, body: { error: { code: 'unauthorized', message: `token ${TOKEN} rejected` } } }))
    const res = await get(A('overview'))
    assert.equal(res.statusCode, 502)
    assert.equal(errorOf(res).code, 'hub-unauthorized')
    assertNoToken(res.text)
  }
  const broken = setup(() => ({ status: 500, body: { error: { code: 'internal', message: 'internal error' } } }))
  const b = await broken.get(A('agents'))
  assert.equal(b.statusCode, 502)
  assert.equal(errorOf(b).code, 'hub-error')
  const garbage = setup(() => ({ raw: '<html>' }))
  const g = await garbage.get(A('agents'))
  assert.equal(g.statusCode, 502)
  assert.equal(errorOf(g).code, 'hub-bad-response')
})

test('adminFailure mapping', () => {
  const m = (status, code, fromHub = false) => adminFailure(new HubError(status, code, 'x', { fromHub }))
  assert.deepEqual(m(503, 'hub-unreachable'), { status: 503, code: 'hub-unreachable' })
  for (const code of ['hub-not-configured', 'hub-token-missing', 'hub-token-mismatch', 'hub-ca-unreadable']) assert.deepEqual(m(503, code), { status: 503, code })
  assert.deepEqual(m(401, 'unauthorized', true), { status: 502, code: 'hub-unauthorized' })
  assert.deepEqual(m(403, 'not-creator', true), { status: 502, code: 'hub-unauthorized' })
  assert.deepEqual(m(500, 'internal', true), { status: 502, code: 'hub-error' })
  assert.deepEqual(m(503, 'busy', true), { status: 502, code: 'hub-error' })
  assert.deepEqual(m(404, 'task-not-found', true), { status: 404, code: 'task-not-found' })
  assert.deepEqual(m(400, 'bad-query'), { status: 400, code: 'bad-query' })
  assert.deepEqual(m(405, 'method-not-allowed'), { status: 405, code: 'method-not-allowed' })
  assert.deepEqual(m(502, 'hub-bad-response'), { status: 502, code: 'hub-bad-response' })
})

test('unexpected errors are 500 without details and logged as a warning (without the token)', async () => {
  const logger = fakeLogger()
  const client = {
    redact: text => String(text).split(TOKEN).join('***'),
    overview: async () => { throw new TypeError(`kaput ${TOKEN}`) },
    listAgents: async () => { throw new Error('disk on fire') },
  }
  const { adminRoutes } = createRoutes({ client, logger })
  const res = await callRoute(findRoute(adminRoutes, A('overview')), { method: 'GET' })
  assert.equal(res.statusCode, 500)
  assert.deepEqual(errorOf(res), { code: 'internal', message: 'internal error' })
  assert.ok(logger.lines.includes('warn agent-hub: overview failed: kaput ***'))
  const res2 = await callRoute(findRoute(adminRoutes, A('agents')), { method: 'GET' })
  assert.equal(res2.statusCode, 500)
  assert.ok(!res2.text.includes('disk on fire'))
  assert.ok(logger.lines.includes('warn agent-hub: admin-agents failed: disk on fire'))
  assertNoToken(logger.lines)
})

// --- requireLogin ---------------------------------------------------------------

test('requireLogin refuses before the admin handler runs', async () => {
  const { adminRoutes, calls } = setup()
  const cases = [
    [() => ({ requestRejection: () => 401 }), 401, 'unauthorized'],
    [() => ({ requestRejection: () => 403 }), 403, 'forbidden'],
    [() => ({ requestRejection: () => 503 }), 503, 'login service unavailable'],
    [() => undefined, 503, 'login service unavailable'],
    [() => ({}), 503, 'login service unavailable'],
  ]
  for (const route of adminRoutes) {
    for (const [connection, status, text] of cases) {
      let reached = false
      const spy = { ...route, handler: async (...args) => { reached = true; return route.handler(...args) } }
      const guarded = requireLogin(spy, connection)
      assert.equal(guarded.path, route.path)
      assert.equal(guarded.kind, route.kind)
      const res = await callRoute(guarded, { method: 'GET' })
      assert.equal(res.statusCode, status, `${route.path} -> ${status}`)
      assert.equal(res.text, text)
      assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8')
      assert.equal(res.headers['cache-control'], 'no-store')
      assert.equal(reached, false, `${route.path} handler must not run without login`)
    }
  }
  assert.equal(calls.length, 0, 'the hub is never asked for an unauthenticated panel request')
})

test('requireLogin passes the request to the login check and lets accepted requests through', async () => {
  const { route } = setup()
  const seen = []
  const connection = () => ({ requestRejection(req) { seen.push(`${req.method} ${req.url}`); return undefined } })
  const res = await callRoute(requireLogin(route(A('overview')), connection), { method: 'GET' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().protocol, 'dsh-agent/2.0')
  assert.deepEqual(seen, [`GET ${A('overview')}`])
})

test('presence fields: agent left_at and overview agent_counts pass the whitelist (bad values dropped)', async () => {
  const leftAgent = { ...HUB_AGENT, agent_id: 'kiro-mydesk', status: 'left', online: false, left_at: '2026-11-22T13:00:00.000Z', running_tasks: [] }
  const overview = {
    ...HUB_OVERVIEW,
    agents: [HUB_AGENT, leftAgent],
    agent_counts: { online: 1, left: 1, offline: 0, pending: -1, revoked: 1.5, bogus: 3 },
  }
  const { get } = setup({ ...ROUTES, 'GET /v1/ctl/overview': { body: overview } })
  const res = await get(A('overview'))
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.deepEqual(keys(body), ['agent_counts', 'agents', 'dormant_agents', 'fallback_due', 'pending_requests', 'protocol', 'task_counts'])
  assert.deepEqual(body.agent_counts, { online: 1, offline: 0, left: 1 }, 'negative, fractional and unknown counts dropped')
  assert.equal(body.agents[1].left_at, '2026-11-22T13:00:00.000Z')
  assert.equal(body.agents[1].status, 'left')
  assert.deepEqual(keys(body.agents[1]), [...AGENT_KEYS, 'left_at'].sort())
  assertNoToken(res.text)
})

test('task rows carry the sticky preference and who did a fallback, nothing else new', () => {
  const row = adminTaskRow({ task_id: 't1', agent: 'pool:browser', preferred_agent: 'aa', sticky_key: 'session-42', fallback_by: 'dsh-cloud', status: 'pending', secret: 'x' })
  assert.deepEqual([row.preferred_agent, row.sticky_key, row.fallback_by], ['aa', 'session-42', 'dsh-cloud'])
  assert.equal(row.secret, undefined)
})

// --- cloud channel: expiry view, origin, stage, session, ack -------------------------------

test('tasks: history / profile / origin filters validated and forwarded', async () => {
  const { get, calls } = setup()
  const res = await get(A('tasks'), '?history=only&profile=web&origin=local')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().filter, { status: 'all', limit: 50, history: 'only', profile: 'web', origin: 'local' })
  assert.deepEqual(Object.fromEntries(calls.at(-1).query.entries()), { id: CONTROLLER, limit: '50', history: 'only', dsh_profile: 'web', origin: 'local' })
  const before = calls.length
  for (const query of ['?history=yes', '?profile=../x', '?origin=cloud']) {
    const bad = await get(A('tasks'), query)
    assert.equal(bad.statusCode, 400, query)
  }
  assert.equal(calls.length, before)
})

test('task rows carry origin, stage and the expiry view; unknown stages and origin fields dropped', () => {
  const row = adminTaskRow({
    task_id: 'local_web_7', status: 'running', dsh_profile: 'web', stage: 'step', in_history: false, quiet: true, session_entries: 12,
    origin: { kind: 'local', by: 'dsh-local', executor: 'dsh-self/web/front', host: 'secret-host' }, updated_at: '2026-11-24T10:00:00.000Z',
  })
  assert.deepEqual(row.origin, { kind: 'local', by: 'dsh-local', executor: 'dsh-self/web/front' })
  assert.deepEqual([row.dsh_profile, row.stage, row.quiet, row.in_history, row.acknowledged, row.session_entries], ['web', 'step', true, false, false, 12])
  assert.equal(adminTaskRow({ task_id: 'x', stage: 'dancing', origin: { kind: 'nope' } }).stage, undefined)
  assert.equal(adminTaskRow({ task_id: 'x', origin: { kind: 'nope' } }).origin.kind, 'controller')
})

test('session: forwarded to /v1/ctl/session/read, entries whitelisted and masked', async () => {
  const { get, calls } = setup({
    ...ROUTES,
    'GET /v1/ctl/session/read': { body: { task_id: 't1', total: 3, next: 2, full: false, entries: [
      { index: 0, at: '2026-11-24T10:00:00.000Z', role: 'user', text: 'do it', by: 'dsh-self/web/front', path: '/srv/x' },
      { index: 1, at: '2026-11-24T10:00:01.000Z', role: 'tool', name: 'shell', text: `ran with ${TOKEN}` },
    ] } },
  })
  const res = await get(A('session'), '?task_id=t1&after=0&limit=2')
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.deepEqual([body.task_id, body.total, body.next, body.full], ['t1', 3, 2, false])
  assert.deepEqual(keys(body.entries[0]), ['at', 'by', 'index', 'role', 'text'])
  assert.equal(body.entries[1].text, 'ran with dshc_***')
  assert.deepEqual(Object.fromEntries(calls.at(-1).query.entries()), { id: CONTROLLER, task_id: 't1', after: '0', limit: '2' })
  for (const query of ['', '?task_id=t1&after=-1', '?task_id=t1&limit=501']) {
    assert.equal((await get(A('session'), query)).statusCode, 400, query)
  }
})

test('ack: POST with a JSON body only; forwarded to /v1/ctl/ack', async () => {
  const { route, calls } = setup({ ...ROUTES, 'POST /v1/ctl/ack': { body: { task: { ...HUB_TASK, status: 'failed', acknowledged: true, in_history: true } } } })
  const ack = route(A('ack'))
  assert.equal((await callRoute(ack, { method: 'GET' })).statusCode, 405)
  const form = await callRoute(ack, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'task_id=t1' })
  assert.equal(form.statusCode, 415, 'a cross-site form post is refused')
  assert.equal((await callRoute(ack, { method: 'POST', headers: jsonHeaders(), body: { task_id: '' } })).statusCode, 400)
  assert.equal(calls.length, 0)
  const res = await callRoute(ack, { method: 'POST', headers: jsonHeaders(), body: { task_id: 't1' } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual([res.json().task.acknowledged, res.json().task.in_history], [true, true])
  assert.equal(calls.at(-1).path, '/v1/ctl/ack')
  assertNoToken(res.text)
})
