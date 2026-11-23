/**
 * HTTP layer: pure helpers (addresses, CIDR, url / query parsing, listen host)
 * and the request handler driven with fake req/res. The last tests ("e2e:")
 * start a real node:http server on 127.0.0.1 and need a real Node runtime.
 */
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import test from 'node:test'
import {
  clientAddress, compileAllow, createHandler, createHubServer, expandIPv6, ipAllowed, matchRoute, normalizeIp,
  parseId, parsePollQuery, parseRequestUrl, parseTaskQuery, parseIPv4, queryOne, resolveListenHost, ROUTES,
} from '../lib/http.js'
import { HubError, VERSION } from '../lib/hub.js'
import { CTL, CTL2, b64, callHttp, dispatchTask, fakeLogger, fakeReq, fakeRes, jsonHeaders, makeHub, provision, sleep } from './helpers.mjs'

const WS = 'deepseek-harness'
const errorOf = res => res.json().error
const q = text => new URLSearchParams(text)
const throwsHub = (fn, status, code) => assert.throws(fn, e => e instanceof HubError && e.status === status && (code === undefined || e.code === code))

// --- pure: addresses -------------------------------------------------------------

test('parseIPv4 / expandIPv6 / normalizeIp', () => {
  assert.equal(parseIPv4('10.1.2.3'), (10 * 2 ** 24 + 1 * 2 ** 16 + 2 * 256 + 3))
  for (const bad of ['10.1.2', '10.1.2.3.4', '256.0.0.1', '01.2.3.4', '1.2.3.-1', '', 'a.b.c.d', undefined]) assert.equal(parseIPv4(bad), undefined, String(bad))
  assert.deepEqual(expandIPv6('::1'), ['0', '0', '0', '0', '0', '0', '0', '1'])
  assert.deepEqual(expandIPv6('2001:DB8::0001'), ['2001', 'db8', '0', '0', '0', '0', '0', '1'])
  for (const bad of ['1::2::3', '12345::', 'g::1', ':::', '1:2:3:4:5:6:7:8:9', '']) assert.equal(expandIPv6(bad), undefined, bad)
  assert.equal(normalizeIp('::ffff:203.0.113.9'), '203.0.113.9', 'IPv4-mapped (Node dual-stack sockets)')
  assert.equal(normalizeIp('::FFFF:cb00:7109'), '203.0.113.9', 'hex form of the mapped address')
  assert.equal(normalizeIp('0:0:0:0:0:0:0:1'), normalizeIp('::1'))
  assert.equal(normalizeIp('[2001:db8::1]'), '2001:db8:0:0:0:0:0:1')
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80:0:0:0:0:0:0:1')
  assert.equal(normalizeIp(' 127.0.0.1 '), '127.0.0.1')
  assert.equal(normalizeIp('example.com'), undefined)
  assert.equal(normalizeIp(undefined), undefined)
})

test('compileAllow / ipAllowed: IPv4 CIDR, IPv6 exact, ::ffff: compatibility', () => {
  const allow = compileAllow(['203.0.113.7/32', '10.0.0.0/8', '192.168.1.77/24', '2001:db8::1', '::1/128', '::ffff:198.51.100.4'])
  const yes = ['203.0.113.7', '::ffff:203.0.113.7', '10.255.0.1', '10.0.0.0', '192.168.1.1', '192.168.1.255', '2001:DB8:0:0::1', '::1', '0:0:0:0:0:0:0:1', '198.51.100.4', '::ffff:10.2.3.4']
  const no = ['203.0.113.8', '11.0.0.1', '192.168.2.1', '2001:db8::2', '::2', '127.0.0.1', '', undefined, 'garbage', '::ffff:11.0.0.1']
  for (const ip of yes) assert.equal(ipAllowed(allow, ip), true, ip)
  for (const ip of no) assert.equal(ipAllowed(allow, ip), false, String(ip))
  assert.equal(ipAllowed(compileAllow(['0.0.0.0/0']), '8.8.8.8'), true)
  assert.equal(ipAllowed(compileAllow(['0.0.0.0/0']), '2001:db8::1'), false, 'an IPv4 rule never matches IPv6')
  assert.equal(ipAllowed(compileAllow(['::ffff:10.0.0.0/104']), '10.9.9.9'), true, 'mapped CIDR is written against 128 bits')
  assert.equal(ipAllowed(compileAllow([]), 'anything'), true, 'empty list = no restriction')
  assert.equal(ipAllowed(compileAllow(undefined), '1.2.3.4'), true)
  for (const bad of [['1.2.3.4/33'], ['1.2.3.4/-1'], ['1.2.3.4/08'], ['256.1.1.1'], ['abc'], ['2001:db8::/64'], ['1.2.3.4/24/1'], [''], [5], 'x', ['::ffff:1.2.3.4/24']]) {
    assert.throws(() => compileAllow(bad), Error, JSON.stringify(bad))
  }
})

test('clientAddress: socket only, unless trustProxy (then the rightmost X-Forwarded-For hop)', () => {
  const req = (remoteAddress, xff) => fakeReq({ remoteAddress, headers: xff === undefined ? {} : { 'X-Forwarded-For': xff } })
  assert.equal(clientAddress(req('::ffff:10.0.0.2', '203.0.113.9')), '10.0.0.2', 'XFF ignored by default')
  assert.equal(clientAddress(req('127.0.0.1', '6.6.6.6, 203.0.113.9'), { trustProxy: true }), '203.0.113.9', 'spoofed left hops are ignored')
  assert.equal(clientAddress(req('127.0.0.1', '203.0.113.9'), { trustProxy: true }), '203.0.113.9')
  assert.equal(clientAddress(req('127.0.0.1'), { trustProxy: true }), '127.0.0.1', 'no header: socket')
  assert.equal(clientAddress(req('127.0.0.1', '1.2.3.4, junk'), { trustProxy: true }), undefined, 'unparsable hop: unknown (denied by an allow list)')
})

// --- pure: url, query, routes ---------------------------------------------------------

test('parseRequestUrl, queryOne and parseId', () => {
  assert.deepEqual(parseRequestUrl('/v1/poll/?id=quick-mydesk&wait=25').path, '/v1/poll')
  assert.equal(parseRequestUrl('/v1/poll?id=quick-mydesk').query.get('id'), 'quick-mydesk')
  assert.equal(parseRequestUrl(undefined).path, '/')
  assert.equal(parseId(q('id=quick-mydesk')), 'quick-mydesk')
  for (const bad of ['', 'id=', 'id=Quick', 'id=a', 'id=quick_mydesk', 'id=a&id=b', 'id=%5F%5Fproto%5F%5F']) throwsHub(() => parseId(q(bad)), 400, 'bad-query')
  assert.equal(queryOne(q('x=1'), 'x'), '1')
  assert.equal(queryOne(q(''), 'x'), undefined)
  throwsHub(() => queryOne(q('x=1&x=2'), 'x'), 400, 'bad-query')
})

test('matchRoute: every contract endpoint exists with its method; unknown 404, wrong method 405', () => {
  const expected = {
    '/v1/health': 'GET', '/v1/enroll': 'POST', '/v1/enroll/status': 'POST', '/v1/heartbeat': 'POST', '/v1/poll': 'GET',
    '/v1/event': 'POST', '/v1/result': 'POST', '/v1/artifact': 'GET', '/v1/me': 'GET', '/v1/leave': 'POST',
    '/v1/ctl/dispatch': 'POST', '/v1/ctl/tasks': 'GET', '/v1/ctl/task': 'GET', '/v1/ctl/output': 'GET', '/v1/ctl/cancel': 'POST',
    '/v1/ctl/retry': 'POST', '/v1/ctl/agents': 'GET', '/v1/ctl/requests': 'GET', '/v1/ctl/approve': 'POST', '/v1/ctl/reject': 'POST',
    '/v1/ctl/revoke': 'POST', '/v1/ctl/provision': 'POST', '/v1/ctl/overview': 'GET',
    '/v1/release': 'POST', '/v1/dispatch': 'POST', '/v1/dispatched': 'GET', '/v1/cancel': 'POST',
    '/v1/ctl/fallback': 'GET', '/v1/ctl/fallback/take': 'POST', '/v1/ctl/fallback/event': 'POST', '/v1/ctl/fallback/result': 'POST', '/v1/ctl/fallback/input': 'GET',
  }
  assert.deepEqual(Object.keys(ROUTES).sort(), Object.keys(expected).sort())
  for (const [path, method] of Object.entries(expected)) {
    assert.equal(matchRoute(method, path), ROUTES[path])
    throwsHub(() => matchRoute(method === 'GET' ? 'POST' : 'GET', path), 405, 'method-not-allowed')
    const auth = ROUTES[path].auth
    if (path.startsWith('/v1/ctl/')) assert.equal(auth, 'controller', path)
    else if (path.startsWith('/v1/enroll')) assert.equal(auth, 'enroll', path)
    else if (path === '/v1/health') assert.equal(auth, 'none')
    else assert.equal(auth, 'worker', path)
  }
  for (const path of ['/', '/v1', '/v1/ctl', '/v2/poll', '/v1/__proto__', '/v1/constructor', '/api/agent-hub/v1/poll']) throwsHub(() => matchRoute('GET', path), 404, 'not-found')
})

test('parseTaskQuery and parsePollQuery', () => {
  assert.deepEqual(parseTaskQuery(q('')), { limit: 50 })
  assert.deepEqual(parseTaskQuery(q(`status=failed&agent=pool:code&workspace=${WS}&limit=7`)), { status: 'failed', agent: 'pool:code', workspace: WS, limit: 7 })
  assert.deepEqual(parseTaskQuery(q('status=all')), { limit: 50 })
  for (const bad of ['status=done', 'agent=Bad', 'workspace=a/b', 'limit=0', 'limit=201', 'limit=x', 'status=failed&status=dead']) throwsHub(() => parseTaskQuery(q(bad)), 400, 'bad-query')
  assert.deepEqual(parsePollQuery(q('')), { max: 1, wait: 0 })
  assert.deepEqual(parsePollQuery(q('max=3&wait=25')), { max: 3, wait: 25 })
  assert.deepEqual(parsePollQuery(q('wait=600')), { max: 1, wait: 55 }, 'wait is capped at 55')
  assert.deepEqual(parsePollQuery(q('wait=0.5')), { max: 1, wait: 0.5 })
  for (const bad of ['max=0', 'max=33', 'max=1.5', 'max=x', 'wait=-1', 'wait=abc', 'wait=Infinity']) throwsHub(() => parsePollQuery(q(bad)), 400, 'bad-query')
})

test('resolveListenHost: without TLS only 127.0.0.1; with TLS 0.0.0.0 by default', () => {
  assert.equal(resolveListenHost({}), '127.0.0.1')
  assert.equal(resolveListenHost({ host: '127.0.0.1' }), '127.0.0.1')
  for (const host of ['0.0.0.0', '::', '10.0.0.5', 'localhost', '::1', 'example.com']) throwsHub(() => resolveListenHost({ host }), 500, 'insecure-listen')
  const tls = { cert: '/c.pem', key: '/k.pem' }
  assert.equal(resolveListenHost({ tls }), '0.0.0.0')
  assert.equal(resolveListenHost({ tls, host: '10.0.0.5' }), '10.0.0.5')
  throwsHub(() => createHubServer({ hub: {}, config: { host: '0.0.0.0' } }), 500, 'insecure-listen')
})

// --- handler ---------------------------------------------------------------------------

async function setup(t, options = {}) {
  const base = await makeHub(t)
  const handler = createHandler({ hub: base.hub, logger: base.logger, ...options })
  const { token } = await provision(base.hub, 'worker', { max_concurrency: 2, node: 'mydesk', workspaces: [WS] })
  const call = (init, res) => callHttp(handler, init, res)
  const asWorker = (extra = {}) => jsonHeaders({ 'X-DSH-Token': token, ...extra })
  const asCtl = (extra = {}) => jsonHeaders({ 'X-DSH-Token': base.ctlToken, ...extra })
  const asCtl2 = (extra = {}) => jsonHeaders({ 'X-DSH-Token': base.ctl2Token, ...extra })
  return { ...base, handler, call, token, asWorker, asCtl, asCtl2 }
}

test('GET /v1/health needs no token and returns only {ok, version, client_ip}', async (t) => {
  const { call } = await setup(t)
  const res = await call({ method: 'GET', url: '/v1/health' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, version: VERSION, client_ip: '127.0.0.1' })
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
})

test('the token must belong to the query id (401), and its role must fit the route (403)', async (t) => {
  const { call, asWorker, asCtl } = await setup(t)
  // controller token, someone else's id
  let res = await call({ url: `/v1/ctl/tasks?id=${CTL2}`, headers: asCtl() })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(errorOf(res), { code: 'unauthorized', message: 'token does not belong to id' })
  // worker token, someone else's id
  res = await call({ method: 'POST', url: '/v1/heartbeat?id=other', headers: asWorker(), body: {} })
  assert.equal(res.statusCode, 401)
  // worker token on a controller route
  for (const [method, path] of [['GET', 'tasks'], ['POST', 'dispatch'], ['POST', 'approve'], ['GET', 'overview'], ['POST', 'provision']]) {
    res = await call({ method, url: `/v1/ctl/${path}?id=worker`, headers: asWorker(), body: method === 'POST' ? {} : undefined })
    assert.equal(res.statusCode, 403, path)
    assert.equal(errorOf(res).code, 'forbidden')
  }
  // controller token on a worker route
  res = await call({ url: `/v1/poll?id=${CTL}`, headers: asCtl() })
  assert.equal(res.statusCode, 403)
  res = await call({ method: 'POST', url: `/v1/result?id=${CTL}`, headers: asCtl(), body: {} })
  assert.equal(res.statusCode, 403)
  // missing / wrong / misplaced token
  for (const headers of [jsonHeaders(), jsonHeaders({ 'X-DSH-Token': 'dshc_dsh-cloud_wrong' }), jsonHeaders({ 'X-DSH-Agent-Token': 'x' }), jsonHeaders({ Authorization: 'Bearer x' })]) {
    res = await call({ url: `/v1/ctl/tasks?id=${CTL}`, headers })
    assert.equal(res.statusCode, 401)
  }
})

test('id is required, given once; a token in the query is refused', async (t) => {
  const { call, asCtl, ctlToken } = await setup(t)
  for (const url of ['/v1/ctl/tasks', '/v1/ctl/tasks?id=', '/v1/ctl/tasks?id=A', `/v1/ctl/tasks?id=${CTL}&id=${CTL2}`]) {
    const res = await call({ url, headers: asCtl() })
    assert.equal(res.statusCode, 400, url)
    assert.equal(errorOf(res).code, 'bad-query')
  }
  const res = await call({ url: `/v1/ctl/tasks?id=${CTL}&token=${ctlToken}`, headers: asCtl() })
  assert.equal(res.statusCode, 400)
  assert.equal(errorOf(res).code, 'token-in-query')
})

test('IP allow list applies to every route, health included; ::ffff: sockets match IPv4 rules', async (t) => {
  const { call, asCtl, logger } = await setup(t, { allow: ['203.0.113.0/24', '2001:db8::1'] })
  let res = await call({ url: '/v1/health', remoteAddress: '198.51.100.1' })
  assert.equal(res.statusCode, 403)
  assert.deepEqual(errorOf(res), { code: 'ip-not-allowed', message: 'client address is not allowed', client_ip: '198.51.100.1' })
  assert.ok(logger.lines.some(l => l.includes('ip-not-allowed') && l.includes('198.51.100.1')))
  res = await call({ url: `/v1/ctl/tasks?id=${CTL}`, headers: asCtl(), remoteAddress: '127.0.0.1' })
  assert.equal(res.statusCode, 403, 'loopback is not implicitly allowed')
  assert.equal((await call({ url: '/v1/health', remoteAddress: '::ffff:203.0.113.50' })).statusCode, 200)
  assert.equal((await call({ url: '/v1/health', remoteAddress: '2001:db8:0::1' })).statusCode, 200)
  assert.equal((await call({ url: '/v1/health', remoteAddress: '2001:db8::2' })).statusCode, 403)
  // X-Forwarded-For is ignored without trustProxy
  res = await call({ url: '/v1/health', remoteAddress: '198.51.100.1', headers: { 'X-Forwarded-For': '203.0.113.5' } })
  assert.equal(res.statusCode, 403)
})

test('trustProxy: the rightmost X-Forwarded-For hop is checked and recorded as the enrollment source', async (t) => {
  const { call, hub } = await setup(t, { allow: ['203.0.113.0/24'], trustProxy: true })
  let res = await call({ url: '/v1/health', remoteAddress: '127.0.0.1', headers: { 'X-Forwarded-For': '6.6.6.6, 203.0.113.5' } })
  assert.equal(res.statusCode, 200)
  res = await call({ url: '/v1/health', remoteAddress: '127.0.0.1', headers: { 'X-Forwarded-For': '203.0.113.5, 6.6.6.6' } })
  assert.equal(res.statusCode, 403, 'a spoofed left hop does not help')
  res = await call({ method: 'POST', url: '/v1/enroll?id=quick', remoteAddress: '127.0.0.1', headers: jsonHeaders({ 'X-Forwarded-For': '203.0.113.9' }), body: { platform: 'aws-quick' } })
  assert.equal(res.statusCode, 200)
  assert.equal((await hub.listRequests())[0].from, '203.0.113.9')
})

test('enroll: identity comes from the query id; source from the socket; body agent_id / from are ignored', async (t) => {
  const { call, hub } = await setup(t)
  const res = await call({
    method: 'POST', url: '/v1/enroll?id=quick-mydesk', remoteAddress: '::ffff:198.51.100.4',
    headers: jsonHeaders({ 'X-Forwarded-For': '203.0.113.9' }),
    body: { agent_id: 'evil', from: 'spoofed', platform: 'aws-quick', node: 'mydesk', workspaces: [WS], capabilities: ['research'], max_concurrency: 2 },
  })
  assert.equal(res.statusCode, 200)
  const out = res.json()
  assert.equal(out.status, 'pending')
  const [r] = await hub.listRequests()
  assert.deepEqual([r.agent_id, r.from, r.node, r.workspaces], ['quick-mydesk', '198.51.100.4', 'mydesk', [WS]])
  // status: wrong id looks like an unknown request; right id gets the token once after approval
  const status = id => call({ method: 'POST', url: `/v1/enroll/status?id=${id}`, headers: jsonHeaders(), body: { request_id: out.request_id, poll_secret: out.poll_secret } })
  assert.equal((await status('quick-mydesk')).json().status, 'pending')
  await hub.approveRequest(CTL, out.request_id)
  assert.equal((await status('someone')).statusCode, 404)
  assert.match((await status('quick-mydesk')).json().token, /^dsha_quick-mydesk_/)
  assert.equal((await status('quick-mydesk')).json().token_issued, true)
})

test('bodies: 415 without JSON, 413 over 16 KiB for enroll / heartbeat, maxResultBytes for result and dispatch', async (t) => {
  const { call, asWorker, asCtl } = await setup(t, { maxResultBytes: 64 * 1024 })
  const pad = n => [Buffer.from('{'), Buffer.alloc(n, 0x20)]
  const cases = [
    ['/v1/enroll?id=quick', jsonHeaders(), 16 * 1024],
    ['/v1/enroll/status?id=quick', jsonHeaders(), 16 * 1024],
    ['/v1/heartbeat?id=worker', asWorker(), 16 * 1024],
    ['/v1/event?id=worker', asWorker(), 64 * 1024],
    ['/v1/result?id=worker', asWorker(), 64 * 1024],
    [`/v1/ctl/dispatch?id=${CTL}`, asCtl(), 64 * 1024],
  ]
  for (const [url, headers, limit] of cases) {
    const res = await call({ method: 'POST', url, headers, body: pad(limit) })
    assert.equal(res.statusCode, 413, url)
    assert.deepEqual(errorOf(res), { code: 'body-too-large', message: `request body exceeds ${limit} bytes` })
    assert.equal(res.headers.connection, 'close', 'unread body: the connection is not reused')
    const declared = await call({ method: 'POST', url, headers: { ...headers, 'content-length': String(limit + 1) }, body: '{}' })
    assert.equal(declared.statusCode, 413, 'a declared content-length over the limit is refused before reading')
  }
  const body = { platform: 'x', description: '' }
  body.description = 'x'.repeat(16 * 1024 - JSON.stringify(body).length)
  assert.equal((await call({ method: 'POST', url: '/v1/enroll?id=quick', headers: jsonHeaders(), body })).statusCode, 200, 'exactly at the limit is fine')
  for (const ct of [undefined, 'text/plain', 'application/jsonx']) {
    const res = await call({ method: 'POST', url: '/v1/heartbeat?id=worker', headers: { 'X-DSH-Token': asWorker()['X-DSH-Token'], ...(ct ? { 'content-type': ct } : {}) }, body: '{}' })
    assert.equal(res.statusCode, 415, String(ct))
  }
  for (const raw of ['{oops', '[1,2]', '"x"', 'null', '7']) {
    const res = await call({ method: 'POST', url: '/v1/heartbeat?id=worker', headers: asWorker(), body: raw })
    assert.equal(res.statusCode, 400, raw)
    assert.equal(errorOf(res).code, 'bad-request')
  }
  assert.equal((await call({ method: 'POST', url: '/v1/heartbeat?id=worker', headers: asWorker({ 'content-type': 'Application/JSON; charset=utf-8' }) })).statusCode, 200, 'empty body is {}')
})

test('unauthenticated callers cannot make the hub read a large body (auth before body)', async (t) => {
  const { handler } = await setup(t)
  let iterated = false
  const req = fakeReq({ method: 'POST', url: '/v1/result?id=worker', headers: jsonHeaders({ 'X-DSH-Token': 'dsha_worker_nope' }) })
  req[Symbol.asyncIterator] = async function* () { iterated = true; yield Buffer.alloc(10) }
  const res = fakeRes()
  await handler(req, res)
  assert.equal(res.statusCode, 401)
  assert.equal(iterated, false)
})

test('worker flow over HTTP: heartbeat, GET poll, event, artifact, result; controller reads task and output', async (t) => {
  const { call, asWorker, asCtl } = await setup(t)
  const disp = await call({
    method: 'POST', url: `/v1/ctl/dispatch?id=${CTL}`, headers: asCtl(),
    body: { task_id: 't1', agent: 'worker', type: 'code', workspace: WS, ref: 'main', title: 'Fix', instruction: 'Fix it', inputs: [{ name: 'in.txt', text: 'input!' }] },
  })
  assert.equal(disp.statusCode, 200)
  assert.equal(disp.json().created_by, CTL)
  // not reported yet -> nothing to lease
  assert.deepEqual((await call({ url: '/v1/poll?id=worker', headers: asWorker() })).json(), { tasks: [] })
  const hb = await call({ method: 'POST', url: '/v1/heartbeat?id=worker', headers: asWorker(), body: { status: 'idle', workspaces: [WS, 'not-granted'] } })
  assert.deepEqual([hb.json().workspaces, hb.json().ignored_workspaces], [[WS], ['not-granted']])
  const polled = (await call({ url: '/v1/poll?id=worker&max=2', headers: asWorker() })).json()
  assert.deepEqual(polled.tasks.map(x => [x.task_id, x.workspace, x.ref]), [['t1', WS, 'main']])
  assert.equal((await call({ method: 'POST', url: '/v1/event?id=worker', headers: asWorker(), body: { task_id: 't1', progress: 0.5, message: 'half' } })).json().ok, true)
  const art = await call({ url: '/v1/artifact?id=worker&task_id=t1&name=in.txt', headers: asWorker() })
  assert.equal(art.statusCode, 200)
  assert.equal(art.headers['content-type'], 'application/octet-stream')
  assert.equal(art.headers['content-length'], 6)
  assert.equal(art.text, 'input!')
  for (const query of ['task_id=t1&name=..%2Fstate.json', 'task_id=t1&name=', 'task_id=t1']) {
    assert.equal((await call({ url: `/v1/artifact?id=worker&${query}`, headers: asWorker() })).statusCode, 400, query)
  }
  const result = await call({ method: 'POST', url: '/v1/result?id=worker', headers: asWorker(), body: { task_id: 't1', status: 'completed', summary: 'done', files: [{ name: 'changes.patch', base64: b64('diff --git') }] } })
  assert.deepEqual(result.json(), { ok: true, task_status: 'completed' })
  const task = (await call({ url: `/v1/ctl/task?id=${CTL}&task_id=t1`, headers: asCtl() })).json().task
  assert.equal(task.status, 'completed')
  assert.equal(task.workspace, WS)
  assert.deepEqual(task.result.outputs.map(o => o.name), ['changes.patch'])
  assert.ok(task.history.length >= 4)
  const out = await call({ url: `/v1/ctl/output?id=${CTL}&task_id=t1&name=changes.patch`, headers: asCtl() })
  assert.equal(out.statusCode, 200)
  assert.equal(out.text, 'diff --git')
  assert.match(out.headers['content-disposition'], /filename\*=UTF-8''changes\.patch/)
  const list = (await call({ url: `/v1/ctl/tasks?id=${CTL}&workspace=${WS}&status=completed`, headers: asCtl() })).json()
  assert.deepEqual(list.filter, { status: 'completed', workspace: WS, limit: 50 })
  assert.deepEqual(list.tasks.map(x => x.task_id), ['t1'])
})

test('controller isolation over HTTP: another controller can read but not cancel or retry (403)', async (t) => {
  const { call, asCtl, asCtl2, hub } = await setup(t)
  await dispatchTask(hub, { task_id: 'mine' })
  let res = await call({ method: 'POST', url: `/v1/ctl/cancel?id=${CTL2}`, headers: asCtl2(), body: { task_id: 'mine' } })
  assert.equal(res.statusCode, 403)
  assert.equal(errorOf(res).code, 'not-creator')
  assert.equal((await call({ url: `/v1/ctl/task?id=${CTL2}&task_id=mine`, headers: asCtl2() })).statusCode, 200)
  res = await call({ method: 'POST', url: `/v1/ctl/cancel?id=${CTL}`, headers: asCtl(), body: { task_id: 'mine', reason: 'not needed' } })
  assert.equal(res.json().status, 'cancelled')
  res = await call({ method: 'POST', url: `/v1/ctl/retry?id=${CTL2}`, headers: asCtl2(), body: { task_id: 'mine' } })
  assert.equal(res.statusCode, 403)
  res = await call({ method: 'POST', url: `/v1/ctl/retry?id=${CTL}`, headers: asCtl(), body: { task_id: 'mine' } })
  assert.equal(res.json().status, 'pending')
  res = await call({ method: 'POST', url: `/v1/ctl/cancel?id=${CTL}`, headers: asCtl(), body: {} })
  assert.equal(res.statusCode, 400)
})

test('controller admin routes: provision, requests, approve (narrow only), reject, agents, revoke, overview', async (t) => {
  const { call, asCtl, hub } = await setup(t)
  const prov = await call({ method: 'POST', url: `/v1/ctl/provision?id=${CTL}`, headers: asCtl(), body: { agent_id: 'claude-cloud', node: 'cloud', workspaces: [WS], capabilities: ['code'] } })
  assert.equal(prov.statusCode, 200)
  assert.match(prov.json().token, /^dsha_claude-cloud_/)
  assert.equal(prov.json().note, 'Store this token now; it is not shown again.')
  const asked = await hub.requestEnrollment({ agent_id: 'kiro-mydesk', capabilities: ['code'], workspaces: [WS] })
  const reqs = (await call({ url: `/v1/ctl/requests?id=${CTL}`, headers: asCtl() })).json()
  assert.deepEqual(reqs.requests.map(r => r.agent_id), ['kiro-mydesk'])
  assert.equal((await call({ url: `/v1/ctl/requests?id=${CTL}&status=bogus`, headers: asCtl() })).statusCode, 400)
  const widened = await call({ method: 'POST', url: `/v1/ctl/approve?id=${CTL}`, headers: asCtl(), body: { request_id: asked.request_id, workspaces: [WS, 'more'] } })
  assert.equal(widened.statusCode, 400)
  assert.equal(errorOf(widened).code, 'grant-widened')
  const ok = await call({ method: 'POST', url: `/v1/ctl/approve?id=${CTL}`, headers: asCtl(), body: { request_id: asked.request_id, capabilities: [] } })
  assert.equal(ok.json().status, 'approved')
  const spam = await hub.requestEnrollment({ agent_id: 'spam' })
  assert.deepEqual((await call({ method: 'POST', url: `/v1/ctl/reject?id=${CTL}`, headers: asCtl(), body: { request_id: spam.request_id, reason: 'no' } })).json(), { request_id: spam.request_id, status: 'rejected' })
  const agents = (await call({ url: `/v1/ctl/agents?id=${CTL}`, headers: asCtl() })).json()
  assert.deepEqual(agents.agents.map(a => a.agent_id).sort(), ['claude-cloud', 'kiro-mydesk', 'worker'])
  assert.ok(!JSON.stringify(agents).includes('tokenHash') && !JSON.stringify(agents).includes('dsha_'))
  assert.equal((await call({ method: 'POST', url: `/v1/ctl/revoke?id=${CTL}`, headers: asCtl(), body: { agent_id: 'claude-cloud' } })).json().revoked, true)
  const ov = (await call({ url: `/v1/ctl/overview?id=${CTL}`, headers: asCtl() })).json()
  assert.equal(ov.protocol, 'dsh-agent/2.0')
  assert.equal(ov.pending_requests, 0)
})

test('long poll over HTTP: GET /v1/poll?wait= is answered as soon as a task is dispatched', async (t) => {
  const { call, asWorker, asCtl, hub } = await setup(t)
  await hub.heartbeat('worker', { workspaces: [WS] })
  const started = Date.now()
  const pending = call({ url: '/v1/poll?id=worker&wait=10', headers: asWorker() })
  await sleep(30)
  await call({ method: 'POST', url: `/v1/ctl/dispatch?id=${CTL}`, headers: asCtl(), body: { task_id: 'lp', agent: 'worker', type: 'code', workspace: WS, title: 't', instruction: 'i' } })
  const res = await pending
  assert.deepEqual(res.json().tasks.map(x => x.task_id), ['lp'])
  assert.ok(Date.now() - started < 3000)
})

test('long poll over HTTP: a client that disconnects while waiting leases nothing', async (t) => {
  const { call, asWorker, hub } = await setup(t)
  const res = fakeRes()
  const pending = call({ url: '/v1/poll?id=worker&wait=10', headers: asWorker() }, res)
  await sleep(30)
  res.destroy() // client gone
  await pending
  assert.equal(res.statusCode, undefined, 'nothing was written to the dead connection')
  await dispatchTask(hub, { task_id: 't1' })
  assert.equal((await hub.getTask('t1')).status, 'pending')
  assert.equal(hub.waiters.size, 0)
})

test('long poll over HTTP: tasks leased for a connection that closed meanwhile are handed back', async (t) => {
  const { asWorker, hub, logger } = await setup(t)
  await dispatchTask(hub, { task_id: 't1' })
  // A hub whose poll resolves only after the client went away.
  const res = fakeRes()
  const slowHub = {
    authenticateToken: token => hub.authenticateToken(token),
    poll: async (...args) => { const out = await hub.poll(...args); res.destroy(); return out },
    unlease: (...args) => hub.unlease(...args),
  }
  const handler = createHandler({ hub: slowHub, logger })
  await handler(fakeReq({ url: '/v1/poll?id=worker', headers: asWorker() }), res)
  assert.equal(res.statusCode, undefined)
  const task = await hub.getTask('t1')
  assert.equal(task.status, 'pending')
  assert.equal(task.attempts, 0)
  assert.equal(task.history.at(-1).event, 'released')
})

test('errors: unknown path 404, wrong method 405 (before auth), unexpected errors 500 without details', async (t) => {
  const { call } = await setup(t)
  let res = await call({ url: '/v1/nope?id=worker' })
  assert.deepEqual([res.statusCode, errorOf(res).code], [404, 'not-found'])
  res = await call({ method: 'DELETE', url: '/v1/poll?id=worker' })
  assert.deepEqual([res.statusCode, errorOf(res)], [405, { code: 'method-not-allowed', message: 'use GET' }])
  res = await call({ method: 'POST', url: '/v1/poll?id=worker', headers: jsonHeaders(), body: {} })
  assert.equal(res.statusCode, 405)
  const logger = fakeLogger()
  const broken = {
    authenticateToken: async () => ({ role: 'worker', id: 'worker' }),
    heartbeat: async () => { throw new Error('disk on fire at /root/.dsh/agent-hub/state.json') },
  }
  const handler = createHandler({ hub: broken, logger })
  res = await callHttp(handler, { method: 'POST', url: '/v1/heartbeat?id=worker', headers: jsonHeaders({ 'X-DSH-Token': 'dsha_worker_x' }), body: {} })
  assert.equal(res.statusCode, 500)
  assert.deepEqual(errorOf(res), { code: 'internal', message: 'internal error' })
  assert.ok(!res.text.includes('disk') && !res.text.includes('/root'))
  assert.ok(logger.lines.some(l => l.startsWith('warn ') && l.includes('disk on fire')))
})

// --- e2e (real node:http; skipped by the sandbox runner) --------------------------------

function rawRequest(port, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

test('e2e: real server on 127.0.0.1 - health, auth, 413 on a streamed oversized body, long poll', async (t) => {
  const { hub, ctlToken } = await makeHub(t)
  const { token } = await provision(hub, 'worker')
  const { server, host } = createHubServer({ hub, config: { maxResultBytes: 64 * 1024 } })
  assert.equal(host, '127.0.0.1')
  await new Promise(resolve => server.listen(0, host, resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) }))
  const { port } = server.address()
  const health = await rawRequest(port, { path: '/v1/health' })
  assert.deepEqual([health.status, JSON.parse(health.text)], [200, { ok: true, version: VERSION, client_ip: '127.0.0.1' }])
  const mismatch = await rawRequest(port, { path: `/v1/ctl/tasks?id=${CTL2}`, headers: { 'x-dsh-token': ctlToken } })
  assert.equal(mismatch.status, 401)
  const big = await rawRequest(port, { method: 'POST', path: '/v1/result?id=worker', headers: { 'content-type': 'application/json', 'x-dsh-token': token }, body: `{"x":"${'a'.repeat(200 * 1024)}"}` })
  assert.equal(big.status, 413)
  const poll = rawRequest(port, { path: '/v1/poll?id=worker&wait=10', headers: { 'x-dsh-token': token } })
  await sleep(100)
  await dispatchTask(hub, { task_id: 'e2e' })
  const polled = await poll
  assert.deepEqual(JSON.parse(polled.text).tasks.map(x => x.task_id), ['e2e'])
})
