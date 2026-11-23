import assert from 'node:assert/strict'
import test from 'node:test'
import { CONFIG_CODES, DEFAULT_TIMEOUT_MS, HubError, PROTOCOL, TOKEN_ENV, TOKEN_HEADER, CONFIG_ENV_KEYS, comparablePath, createHubClient, defaultEnvFile, isDshCredentialsFile, normalizeHubUrl, redact, resolveConfig } from '../hub-client.js'
import { CONTROLLER, HUB_URL, TOKEN, assertNoToken, expectHubError, fakeFs, fakeHub, fakeLogger, hermetic, makeClient } from './helpers.mjs'

const ok = body => ({ body })
/** `?a=1&b=2` of a recorded call as ordered pairs. */
const pairs = call => [...call.query.entries()].map(([k, v]) => [k, v])

test('constants of the v2 contract', () => {
  assert.equal(PROTOCOL, 'dsh-agent/2.0')
  assert.equal(TOKEN_ENV, 'DSH_HUB_TOKEN')
  assert.equal(TOKEN_HEADER, 'X-DSH-Token')
  assert.equal(DEFAULT_TIMEOUT_MS, 15000)
  for (const code of ['hub-not-configured', 'hub-token-missing', 'hub-token-mismatch', 'hub-ca-unreadable']) assert.ok(CONFIG_CODES.has(code), code)
})

// --- config --------------------------------------------------------------------

test('resolveConfig: valid https config, base path and trailing slash', () => {
  const c = resolveConfig({ hubUrl: 'https://hub.example:7891/', controllerId: 'dsh-cloud' }, hermetic())
  assert.equal(c.ok, true)
  assert.deepEqual(c.problems, [])
  assert.equal(c.hubUrl, 'https://hub.example:7891')
  assert.equal(c.basePath, '')
  assert.equal(c.secure, true)
  assert.equal(c.timeoutMs, DEFAULT_TIMEOUT_MS)
  assert.equal(c.caFile, undefined)
  const p = resolveConfig({ hubUrl: 'https://proxy.example/hub/', controllerId: 'dsh-cloud', caFile: ' /etc/dsh/hub-ca.pem ', timeoutMs: 5000 }, hermetic())
  assert.equal(p.ok, true)
  assert.equal(p.hubUrl, 'https://proxy.example/hub')
  assert.equal(p.basePath, '/hub')
  assert.equal(p.caFile, '/etc/dsh/hub-ca.pem')
  assert.equal(p.timeoutMs, 5000)
})

test('resolveConfig: plain http only for loopback', () => {
  for (const url of ['http://127.0.0.1:7891', 'http://localhost:7891', 'http://[::1]:7891']) {
    assert.equal(resolveConfig({ hubUrl: url, controllerId: 'dsh-local' }, hermetic()).ok, true, url)
  }
  const remote = resolveConfig({ hubUrl: 'http://203.0.113.5:7891', controllerId: 'dsh-local' }, hermetic())
  assert.equal(remote.ok, false)
  assert.match(remote.problems.join(), /must use https/)
})

test('resolveConfig: every problem is reported, nothing throws', () => {
  const cases = [
    [{}, /hubUrl is not set/],
    [{ hubUrl: 'not a url', controllerId: 'dsh-x' }, /not a valid URL/],
    [{ hubUrl: 'ftp://hub.example', controllerId: 'dsh-x' }, /must be http\(s\)/],
    [{ hubUrl: 'https://user:pw@hub.example', controllerId: 'dsh-x' }, /must not contain credentials/],
    [{ hubUrl: 'https://hub.example/?id=x', controllerId: 'dsh-x' }, /query or fragment/],
    [{ hubUrl: HUB_URL }, /controllerId is not set/],
    [{ hubUrl: HUB_URL, controllerId: 'DSH_Cloud' }, /controllerId must match/],
    [{ hubUrl: 'http://127.0.0.1:7891', controllerId: 'dsh-x', caFile: '/ca.pem' }, /caFile only applies/],
  ]
  for (const [config, re] of cases) {
    const c = resolveConfig(config, hermetic())
    assert.equal(c.ok, false, JSON.stringify(config))
    assert.match(c.problems.join(' | '), re)
  }
  // a bad timeout is a warning only: default is used, config stays usable
  for (const timeoutMs of [0, 999, 120001, 1.5, '5000']) {
    const c = resolveConfig({ hubUrl: HUB_URL, controllerId: 'dsh-x', timeoutMs }, hermetic())
    assert.equal(c.ok, true)
    assert.equal(c.timeoutMs, DEFAULT_TIMEOUT_MS)
    assert.deepEqual(c.problems, [])
    assert.match(c.warnings.join(), /timeoutMs must be an integer/)
  }
  // same for a bad tokenEnv
  for (const tokenEnv of ['', 'has space', '1ABC', 42]) {
    const c = resolveConfig({ hubUrl: HUB_URL, controllerId: 'dsh-x', tokenEnv }, hermetic())
    assert.equal(c.ok, true)
    assert.equal(c.tokenEnv, 'DSH_HUB_TOKEN')
    assert.match(c.warnings.join(), /tokenEnv must be a variable name/)
  }
})

test('resolveConfig: tokenEnv and envFile defaults (<DSH home>/agent-hub/controller.env)', () => {
  const join = (...p) => p.join('/').replace(/\\/g, '/')
  const norm = x => x.replace(/\\/g, '/')
  const d = resolveConfig({ hubUrl: HUB_URL, controllerId: 'dsh-x' }, { fs: fakeFs(), env: {}, homedir: () => '/home/u' })
  assert.equal(d.tokenEnv, 'DSH_HUB_TOKEN')
  assert.equal(norm(d.envFile), join('/home/u', '.dsh', 'agent-hub', 'controller.env'))
  assert.equal(d.envFileBlocked, false)
  assert.deepEqual(d.warnings, [], 'the default file is not DSH\'s .env: no warning')
  const h = resolveConfig({ hubUrl: HUB_URL, controllerId: 'dsh-x' }, { fs: fakeFs(), env: { DSH_HOME: '/srv/dsh' }, homedir: () => '/home/u' })
  assert.equal(norm(h.envFile), '/srv/dsh/agent-hub/controller.env')
  const c = resolveConfig({ hubUrl: HUB_URL, controllerId: 'dsh-x', tokenEnv: 'HUB_TOKEN_CLOUD', envFile: ' /etc/dsh/hub.env ' }, { env: { DSH_HOME: '/srv/dsh' } }, hermetic())
  assert.equal(c.tokenEnv, 'HUB_TOKEN_CLOUD')
  assert.equal(c.envFile, '/etc/dsh/hub.env')
  assert.deepEqual(c.warnings, [])
})

// --- URL, query id, header ----------------------------------------------------------

test('every controller call: method, /v1/ctl path, id first in the query, X-DSH-Token header', async () => {
  const { client, calls } = makeClient((call) => {
    if (call.path === '/v1/ctl/output') return { raw: 'bytes!' }
    if (call.path.endsWith('/tasks')) return ok({ tasks: [] })
    if (call.path.endsWith('/agents')) return ok({ agents: [] })
    if (call.path.endsWith('/requests')) return ok({ requests: [] })
    return ok({ ok: true })
  })
  const cases = [
    [() => client.dispatch({ agent: 'pool:code', title: 'T', instruction: 'I', type: 'code', workspace: 'deepseek-harness', node: 'mydesk', ref: 'main', depends_on: ['t0'] }),
      'POST', '/v1/ctl/dispatch', [], { agent: 'pool:code', title: 'T', instruction: 'I', type: 'code', workspace: 'deepseek-harness', node: 'mydesk', ref: 'main', depends_on: ['t0'] }],
    [() => client.listTasks({ status: 'running', agent: 'quick-mydesk', workspace: 'deepseek-harness', limit: 20 }),
      'GET', '/v1/ctl/tasks', [['status', 'running'], ['agent', 'quick-mydesk'], ['workspace', 'deepseek-harness'], ['limit', '20']]],
    [() => client.listTasks(), 'GET', '/v1/ctl/tasks', []],
    [() => client.listTasks({ status: '', agent: undefined }), 'GET', '/v1/ctl/tasks', []],
    [() => client.getTask('t1'), 'GET', '/v1/ctl/task', [['task_id', 't1']]],
    [() => client.readOutput('t1', 'a b&c.md'), 'GET', '/v1/ctl/output', [['task_id', 't1'], ['name', 'a b&c.md']]],
    [() => client.cancel('t1', 'not needed'), 'POST', '/v1/ctl/cancel', [], { task_id: 't1', reason: 'not needed' }],
    [() => client.retry('t1', 'pool:research'), 'POST', '/v1/ctl/retry', [], { task_id: 't1', agent: 'pool:research' }],
    [() => client.retry('t1'), 'POST', '/v1/ctl/retry', [], { task_id: 't1' }],
    [() => client.listAgents(), 'GET', '/v1/ctl/agents', []],
    [() => client.listRequests('all'), 'GET', '/v1/ctl/requests', [['status', 'all']]],
    [() => client.approve({ request_id: 'req_1', capabilities: ['code'], workspaces: ['deepseek-harness'], max_concurrency: 1 }),
      'POST', '/v1/ctl/approve', [], { request_id: 'req_1', capabilities: ['code'], workspaces: ['deepseek-harness'], max_concurrency: 1 }],
    [() => client.approve({ request_id: 'req_1' }), 'POST', '/v1/ctl/approve', [], { request_id: 'req_1' }],
    [() => client.reject('req_2', 'unknown'), 'POST', '/v1/ctl/reject', [], { request_id: 'req_2', reason: 'unknown' }],
    [() => client.revoke('quick-mydesk'), 'POST', '/v1/ctl/revoke', [], { agent_id: 'quick-mydesk' }],
    [() => client.provision({ agent_id: 'claude-cloud', node: 'cloud', workspaces: ['deepseek-harness'] }),
      'POST', '/v1/ctl/provision', [], { agent_id: 'claude-cloud', node: 'cloud', workspaces: ['deepseek-harness'] }],
    [() => client.overview(), 'GET', '/v1/ctl/overview', []],
  ]
  for (const [run, method, path, query, body] of cases) {
    const before = calls.length
    await run()
    assert.equal(calls.length, before + 1, path)
    const call = calls.at(-1)
    assert.equal(call.method, method, path)
    assert.equal(call.url.origin, HUB_URL, path)
    assert.equal(call.path, path)
    assert.deepEqual(pairs(call), [['id', CONTROLLER], ...query], `${path} query`)
    assert.equal(call.headers[TOKEN_HEADER], TOKEN, `${path} token header`)
    assert.ok(!call.url.href.includes(TOKEN), 'token is never in the URL')
    assert.ok(!call.url.href.includes('dshc_'), 'token is never in the URL')
    if (method === 'POST') {
      assert.equal(call.headers['content-type'], 'application/json')
      assert.equal(call.headers['content-length'], String(Buffer.byteLength(call.body)))
      assert.deepEqual(call.json, body, `${path} body`)
    } else {
      assert.equal(call.body, undefined, `${path} GET has no body`)
      assert.equal(call.headers['content-type'], undefined)
    }
  }
})

test('health: GET /v1/health with id, without a token (works even before a token is set)', async () => {
  const { client, calls } = makeClient({ 'GET /v1/health': ok({ ok: true, version: '2.0.0' }) }, { env: {} })
  assert.deepEqual(await client.health(), { ok: true, version: '2.0.0' })
  assert.equal(calls[0].headers[TOKEN_HEADER], undefined)
  assert.deepEqual(pairs(calls[0]), [['id', CONTROLLER]])
})

test('a hubUrl with a base path keeps it', async () => {
  const { client, calls } = makeClient(() => ok({ agents: [] }), { hubUrl: 'https://proxy.example/hub/' })
  await client.listAgents()
  assert.equal(calls[0].url.href, `https://proxy.example/hub/v1/ctl/agents?id=${CONTROLLER}`)
})

test('timeout and ca reach the transport options; no caFile means no ca', async () => {
  const { client, calls } = makeClient(() => ok({ agents: [] }), { timeoutMs: 4000 })
  await client.listAgents()
  assert.equal(calls[0].options.timeout, 4000)
  assert.equal('ca' in calls[0].options, false)
})

test('caFile is read once, passed as ca, and an unreadable file is a 503 hub-ca-unreadable (retried later)', async () => {
  const reads = []
  let fail = true
  const readCa = async (path) => {
    reads.push(path)
    if (fail) { const e = new Error(`ENOENT: no such file ${path}`); e.code = 'ENOENT'; throw e }
    return Buffer.from('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n')
  }
  const { client, calls } = makeClient(() => ok({ agents: [] }), { caFile: '/etc/dsh/hub-ca.pem', readCa })
  const error = await expectHubError(() => client.listAgents(), 503, 'hub-ca-unreadable')
  assert.match(error.message, /\/etc\/dsh\/hub-ca\.pem: ENOENT/)
  assert.equal(calls.length, 0, 'nothing is sent without the CA')
  fail = false
  await client.listAgents()
  await client.listAgents()
  assert.deepEqual(reads, ['/etc/dsh/hub-ca.pem', '/etc/dsh/hub-ca.pem'], 'read again after the failure, then cached')
  assert.match(String(calls[0].options.ca), /BEGIN CERTIFICATE/)
  assert.equal(calls[1].options.ca, calls[0].options.ca)
})

// --- response shapes -----------------------------------------------------------

test('list answers may be a bare array or { <key>: [...] }; task may be wrapped in { task }', async () => {
  const { client } = makeClient({
    'GET /v1/ctl/tasks': ok([{ task_id: 'a' }]),
    'GET /v1/ctl/agents': ok({ agents: [{ agent_id: 'quick-mydesk' }] }),
    'GET /v1/ctl/requests': ok({ requests: [] }),
    'GET /v1/ctl/task': ok({ task: { task_id: 't1', status: 'running' } }),
    'POST /v1/ctl/dispatch': ok({ task_id: 't2', status: 'pending' }),
  })
  assert.deepEqual(await client.listTasks(), [{ task_id: 'a' }])
  assert.deepEqual(await client.listAgents(), [{ agent_id: 'quick-mydesk' }])
  assert.deepEqual(await client.listRequests('pending'), [])
  assert.deepEqual(await client.getTask('t1'), { task_id: 't1', status: 'running' })
  assert.deepEqual(await client.dispatch({ agent: 'x', title: 't', instruction: 'i' }), { task_id: 't2', status: 'pending' })
})

test('output bytes come back as a Buffer', async () => {
  const { client } = makeClient({ 'GET /v1/ctl/output': { raw: Buffer.from([0, 1, 2, 255]) } })
  const bytes = await client.readOutput('t1', 'x.bin')
  assert.ok(Buffer.isBuffer(bytes))
  assert.deepEqual([...bytes], [0, 1, 2, 255])
})

test('garbage answers are 502 hub-bad-response', async () => {
  const { client } = makeClient({
    'GET /v1/ctl/tasks': ok({ nope: 1 }),
    'GET /v1/ctl/agents': { raw: '<html>proxy</html>' },
    'GET /v1/ctl/task': ok([1, 2]),
  })
  await expectHubError(() => client.listTasks(), 502, 'hub-bad-response')
  await expectHubError(() => client.listAgents(), 502, 'hub-bad-response')
  await expectHubError(() => client.getTask('t1'), 502, 'hub-bad-response')
})

// --- error mapping -------------------------------------------------------------

test('hub errors keep status and { error: { code, message } } and are marked fromHub', async () => {
  const { client } = makeClient({
    'GET /v1/ctl/task': { status: 404, body: { error: { code: 'task-not-found', message: 'task not found: t9' } } },
    'POST /v1/ctl/cancel': { status: 403, body: { error: { code: 'not-creator', message: 'only dsh-cloud may cancel t1' } } },
    'POST /v1/ctl/approve': { status: 400, body: { error: { code: 'widening', message: 'approve can only narrow' } } },
    'GET /v1/ctl/agents': { status: 401, body: { error: { code: 'unauthorized', message: 'bad token' } } },
    'GET /v1/ctl/overview': { status: 502, raw: 'Bad Gateway' },
    'GET /v1/ctl/requests': { status: 500, body: { error: { code: 'bad code with spaces', message: 42 } } },
  })
  const e404 = await expectHubError(() => client.getTask('t9'), 404, 'task-not-found')
  assert.equal(e404.message, 'task not found: t9')
  assert.equal(e404.fromHub, true)
  await expectHubError(() => client.cancel('t1'), 403, 'not-creator')
  await expectHubError(() => client.approve({ request_id: 'r', capabilities: ['x'] }), 400, 'widening')
  await expectHubError(() => client.listAgents(), 401, 'unauthorized')
  const e502 = await expectHubError(() => client.overview(), 502, 'http-502')
  assert.equal(e502.message, 'hub answered HTTP 502')
  const e500 = await expectHubError(() => client.listRequests('all'), 500, 'http-500')
  assert.equal(e500.message, 'hub answered HTTP 500')
})

test('network failures are 503 hub-unreachable with a useful reason', async () => {
  for (const [code, re] of [
    ['ECONNREFUSED', /ECONNREFUSED/],
    ['ENOTFOUND', /ENOTFOUND/],
    ['ECONNRESET', /ECONNRESET/],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', /TLS verification failed.*caFile/],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', /TLS verification failed/],
    ['ERR_TLS_CERT_ALTNAME_INVALID', /TLS verification failed/],
  ]) {
    const { client } = makeClient(() => ({ networkError: code }))
    const error = await expectHubError(() => client.listAgents(), 503, 'hub-unreachable')
    assert.match(error.message, re)
    assert.match(error.message, /hub\.example:7891/)
    assert.equal(error.fromHub, false)
  }
})

test('socket timeout, overall timeout and a throwing transport are hub-unreachable too', async () => {
  const idle = makeClient(() => ({ socketTimeout: true }))
  assert.match((await expectHubError(() => idle.client.listAgents(), 503, 'hub-unreachable')).message, /timed out/)

  const hang = makeClient(() => ({ hang: true }), { timeoutMs: 1000 })
  const started = Date.now()
  assert.match((await expectHubError(() => hang.client.listAgents(), 503, 'hub-unreachable')).message, /timed out/)
  assert.ok(Date.now() - started >= 900, 'waited for timeoutMs')

  const hub = fakeHub(() => ok({}))
  hub.throwSync = true
  const client = createHubClient({ hubUrl: HUB_URL, controllerId: CONTROLLER, env: { DSH_HUB_TOKEN: TOKEN }, request: hub.request, fs: fakeFs() })
  assert.match((await expectHubError(() => client.listAgents(), 503, 'hub-unreachable')).message, /request\(\) exploded/)
})

// --- token handling ------------------------------------------------------------

test('no token: 503 hub-token-missing and nothing is sent; the env is read on every call', async () => {
  const env = {}
  const { client, calls } = makeClient(() => ok({ agents: [] }), { env })
  assert.equal(client.hasToken(), false)
  const error = await expectHubError(() => client.listAgents(), 503, 'hub-token-missing')
  assert.match(error.message, /DSH_HUB_TOKEN is not set/)
  assert.match(error.message, /controller add dsh-test/)
  env.DSH_HUB_TOKEN = '   '
  await expectHubError(() => client.listAgents(), 503, 'hub-token-missing')
  assert.equal(calls.length, 0)
  env.DSH_HUB_TOKEN = TOKEN
  assert.equal(client.hasToken(), true)
  assert.deepEqual(await client.listAgents(), [])
  assert.equal(calls.length, 1)
})

test('a token of another controller (or a worker token) is refused locally: hub-token-mismatch', async () => {
  for (const wrong of ['dshc_dsh-other_abcdefghijklmnop', 'dsha_dsh-test_abcdefghijklmnop', 'plain-secret-value']) {
    const { client, calls } = makeClient(() => ok({}), { env: { DSH_HUB_TOKEN: wrong } })
    const error = await expectHubError(() => client.overview(), 503, 'hub-token-mismatch')
    assert.ok(!error.message.includes(wrong), 'the wrong token is not echoed')
    assert.match(error.message, /expected dshc_dsh-test_/)
    assert.equal(calls.length, 0)
  }
})

test('unconfigured client: every call is 503 hub-not-configured, nothing is sent', async () => {
  const hub = fakeHub(() => ok({}))
  const client = createHubClient({ env: { DSH_HUB_TOKEN: TOKEN }, request: hub.request, fs: fakeFs(), homedir: () => '/home/u' })
  assert.equal(client.config.ok, false)
  for (const run of [() => client.listAgents(), () => client.dispatch({}), () => client.health()]) {
    const error = await expectHubError(run, 503, 'hub-not-configured')
    assert.match(error.message, /hubUrl is not set/)
  }
  assert.equal(hub.calls.length, 0)
})

test('the token never reaches logs or error messages, even when the hub echoes it', async () => {
  const logger = fakeLogger()
  const { client, calls } = makeClient({
    'GET /v1/ctl/agents': ok({ agents: [] }),
    'GET /v1/ctl/task': { status: 401, body: { error: { code: 'unauthorized', message: `token ${TOKEN} is not valid for dsh-test` } } },
    'GET /v1/ctl/overview': () => ({ networkError: `E_${TOKEN}` }),
  }, { logger })
  await client.listAgents()
  const e1 = await expectHubError(() => client.getTask('t1'), 401, 'unauthorized')
  const e2 = await expectHubError(() => client.overview(), 503, 'hub-unreachable')
  assertNoToken(e1.message, e2.message, e1.stack, e2.stack, logger.lines)
  assert.match(e1.message, /token \*\*\* is not valid/)
  assert.ok(logger.lines.some(l => l.startsWith('debug agent-hub: GET /v1/ctl/agents -> 200')), 'calls are logged without secrets')
  assert.equal(calls.length, 3)
})

test('redact / scrub', () => {
  assert.equal(redact(`a ${TOKEN} b`, TOKEN), 'a *** b')
  assert.equal(redact('x dsha_quick_abcDEF123 y dshc_dsh-cloud_xyz'), 'x dsha_*** y dshc_***')
  assert.equal(redact(undefined), '')
  const { client } = makeClient(() => ok({}))
  assert.deepEqual(client.scrub({ a: [`k=${TOKEN}`], worker: 'dsha_quick_keepme' }), { a: ['k=***'], worker: 'dsha_quick_keepme' })
  const same = { x: 1 }
  assert.equal(client.scrub(same), same, 'untouched values are returned as is')
  assert.ok(new HubError(503, 'x', 'y') instanceof Error)
})

// --- token sources: environment first, then the .env file ----------------------------

const FILE_TOKEN = 'dshc_dsh-test_FromTheDotEnvFile0123456789'
const ENV_FILE = '/srv/dsh/agent-hub/controller.env'

test('token priority: process env wins, the .env file is the fallback, the file is never read when env has it', async () => {
  const fs = fakeFs({ [ENV_FILE]: `# hub\nDSH_HUB_TOKEN=${FILE_TOKEN}\n` })
  const env = { DSH_HUB_TOKEN: TOKEN, DSH_HOME: '/srv/dsh' }
  const { client, calls } = makeClient(() => ok({ agents: [] }), { env, fs })
  assert.equal(client.tokenSource(), 'env')
  await client.listAgents()
  assert.equal(calls.at(-1).headers['X-DSH-Token'], TOKEN, 'env hit: the file value is not used for the token')

  delete env.DSH_HUB_TOKEN
  assert.equal(client.tokenSource(), 'envFile')
  await client.listAgents()
  assert.equal(calls.at(-1).headers['X-DSH-Token'], FILE_TOKEN)

  env.DSH_HUB_TOKEN = '  '
  await client.listAgents()
  assert.equal(calls.at(-1).headers['X-DSH-Token'], FILE_TOKEN, 'an empty env value falls back to the file')
})

test('envFile default is <DSH_HOME>/agent-hub/controller.env, else ~/.dsh/agent-hub/controller.env; an explicit envFile overrides', async () => {
  const home = fakeFs({ '/home/test/.dsh/agent-hub/controller.env': `DSH_HUB_TOKEN=${FILE_TOKEN}`, '/home/test/.dsh/.env': 'DSH_HUB_TOKEN=dshc_dsh-test_NeverReadFromDshDotEnv000' })
  const a = makeClient(() => ok({ agents: [] }), { env: {}, fs: home })
  assert.equal(a.client.config.envFile.replace(/\\/g, '/'), '/home/test/.dsh/agent-hub/controller.env')
  await a.client.listAgents()
  assert.equal(a.calls[0].headers['X-DSH-Token'], FILE_TOKEN)
  assert.ok(!home.reads.includes('/home/test/.dsh/.env'), 'DSH\'s own .env is not read by default')

  const explicit = fakeFs({ '/etc/dsh/hub.env': `export DSH_HUB_TOKEN='${FILE_TOKEN}'` })
  const b = makeClient(() => ok({ agents: [] }), { env: { DSH_HOME: '/nowhere' }, fs: explicit, envFile: '/etc/dsh/hub.env' })
  await b.client.listAgents()
  assert.equal(b.calls[0].headers['X-DSH-Token'], FILE_TOKEN)
})

test('tokenEnv renames the variable in both the environment and the .env file', async () => {
  const fs = fakeFs({ [ENV_FILE]: `DSH_HUB_TOKEN=${TOKEN}\nHUB_TOKEN_CLOUD="${FILE_TOKEN}"` })
  const env = { DSH_HOME: '/srv/dsh', DSH_HUB_TOKEN: TOKEN }
  const { client, calls } = makeClient(() => ok({ agents: [] }), { env, fs, tokenEnv: 'HUB_TOKEN_CLOUD' })
  await client.listAgents()
  assert.equal(calls[0].headers['X-DSH-Token'], FILE_TOKEN, 'DSH_HUB_TOKEN is ignored once tokenEnv is renamed')
  env.HUB_TOKEN_CLOUD = TOKEN
  await client.listAgents()
  assert.equal(calls[1].headers['X-DSH-Token'], TOKEN)
  delete env.HUB_TOKEN_CLOUD
  delete fs.files[ENV_FILE]
  const error = await expectHubError(() => client.listAgents(), 503, 'hub-token-missing')
  assert.match(error.message, /HUB_TOKEN_CLOUD is not set \(neither in the environment nor in .*\.env\)/)
})

test('the .env file is re-read on every call (rotation without restart); a missing file is silent', async () => {
  const fs = fakeFs({})
  const logger = fakeLogger()
  const { client, calls } = makeClient(() => ok({ agents: [] }), { env: { DSH_HOME: '/srv/dsh' }, fs, logger })
  assert.equal(client.tokenSource(), undefined)
  await expectHubError(() => client.listAgents(), 503, 'hub-token-missing')
  assert.deepEqual(logger.lines, [], 'no warning for a missing .env')
  fs.files[ENV_FILE] = `DSH_HUB_TOKEN=${FILE_TOKEN}`
  await client.listAgents()
  const rotated = 'dshc_dsh-test_RotatedTokenValue9876543210'
  fs.files[ENV_FILE] = `DSH_HUB_TOKEN=${rotated}`
  await client.listAgents()
  assert.deepEqual(calls.map(c => c.headers['X-DSH-Token']), [FILE_TOKEN, rotated])
})

test('a group/other-readable .env warns once (POSIX), is still used, and no value reaches the log', async () => {
  const fs = fakeFs({ [ENV_FILE]: { text: `DSH_HUB_TOKEN=${FILE_TOKEN}`, mode: 0o100644 } })
  const logger = fakeLogger()
  const { client, calls } = makeClient((c) => ({ status: 401, body: { error: { code: 'unauthorized', message: `bad ${c.headers['X-DSH-Token']}` } } }), { env: { DSH_HOME: '/srv/dsh' }, fs, logger })
  const error = await expectHubError(() => client.listAgents(), 401, 'unauthorized')
  await expectHubError(() => client.listAgents(), 401)
  assert.equal(calls.length, 2, 'a loose file is still used')
  const warns = logger.lines.filter(l => l.startsWith('warn '))
  assert.equal(warns.length, 1, 'warned once')
  // Either separator: the message names the path as node:path built it on this platform.
  assert.match(warns[0], /readable by group or others \(mode 644\); run: chmod 600 [\/\\]srv[\/\\]dsh[\/\\]agent-hub[\/\\]controller\.env/)
  for (const line of [...logger.lines, error.message]) assert.ok(!line.includes(FILE_TOKEN) && !line.includes('FromTheDotEnv'), line)

  const win = makeClient(() => ok({ agents: [] }), { env: { DSH_HOME: '/srv/dsh' }, fs, logger: fakeLogger(), platform: 'win32' })
  await win.client.listAgents()
  assert.deepEqual(win.logger.lines.filter(l => l.startsWith('warn ')), [], 'no POSIX mode check on Windows')
})

// --- <DSH home>/.env is DSH's own credential file: no DSH_* variable may come from it ---

const DSH_DOT_ENV = '/srv/dsh/.env'
const DOT_ENV_TOKEN = 'dshc_dsh-test_FromDshOwnDotEnv0123456789'

test('defaultEnvFile / comparablePath / isDshCredentialsFile', () => {
  assert.equal(defaultEnvFile({ DSH_HOME: '/srv/dsh' }).replace(/\\/g, '/'), '/srv/dsh/agent-hub/controller.env')
  assert.equal(defaultEnvFile({}, () => '/home/u').replace(/\\/g, '/'), '/home/u/.dsh/agent-hub/controller.env')
  assert.equal(comparablePath('C:\\Users\\Me\\.DSH\\.\\x\\..\\.env\\'), 'c:/users/me/.dsh/.env')
  assert.equal(comparablePath('/srv//dsh/./.env'), '/srv/dsh/.env')
  const env = { DSH_HOME: '/srv/dsh' }
  for (const p of ['/srv/dsh/.env', '/srv/dsh//.env', '/srv/dsh/./.env', '/srv/dsh/agent-hub/../.env', '/SRV/DSH/.ENV', '\\srv\\dsh\\.env', ' /srv/dsh/.env/ ']) assert.equal(isDshCredentialsFile(p, env), true, p)
  for (const p of ['/srv/dsh/agent-hub/controller.env', '/srv/dsh/.env.bak', '/srv/.env', '/srv/dsh/worker/.env', '/srv/dsh2/.env']) assert.equal(isDshCredentialsFile(p, env), false, p)
})

test('envFile = <DSH home>/.env with tokenEnv DSH_HUB_TOKEN: the file is never read, a migration warning is given', async () => {
  const fs = fakeFs({ [DSH_DOT_ENV]: `DSH_HUB_TOKEN=${DOT_ENV_TOKEN}\n` })
  const logger = fakeLogger()
  const env = { DSH_HOME: '/srv/dsh' }
  const { client, calls } = makeClient(() => ok({ agents: [] }), { env, fs, logger, envFile: DSH_DOT_ENV })
  assert.equal(client.config.envFileBlocked, true)
  const warning = client.config.warnings.join('\n')
  assert.match(warning, /DSH 不允许 <DSH home>\/\.env 里出现 DSH_ 开头的变量（会拒绝启动）/)
  assert.match(warning, /把 DSH_HUB_TOKEN 移到 <DSH home>\/agent-hub\/controller\.env/)
  assert.match(warning, /或改用其他变量名/)
  assert.ok(!warning.includes(DOT_ENV_TOKEN))
  assert.equal(client.tokenSource(), undefined, 'value from DSH\'s .env is not adopted')
  const error = await expectHubError(() => client.listAgents(), 503, 'hub-token-missing')
  assert.match(error.message, /not read for DSH_\* names/)
  assert.match(error.message, /agent-hub[\/\\]controller\.env/)
  assert.deepEqual(fs.reads, [], 'readFileSync was never called on DSH\'s .env')
  assert.equal(calls.length, 0)
  for (const line of [...logger.lines, error.message]) assert.ok(!line.includes('FromDshOwnDotEnv'), line)

  // the process environment still works
  env.DSH_HUB_TOKEN = TOKEN
  await client.listAgents()
  assert.equal(calls.at(-1).headers['X-DSH-Token'], TOKEN)
  assert.deepEqual(fs.reads, [])
})

test('the guard also matches Windows paths (backslashes, other case) and ~/.dsh without DSH_HOME', async () => {
  const winHome = 'C:\\Users\\13558\\.dsh'
  for (const envFile of ['c:\\users\\13558\\.DSH\\.env', 'C:/Users/13558/.dsh/.env', 'C:\\Users\\13558\\.dsh\\agent-hub\\..\\.ENV']) {
    const fs = fakeFs({ [envFile]: `DSH_HUB_TOKEN=${DOT_ENV_TOKEN}` })
    const { client } = makeClient(() => ok({ agents: [] }), { env: { DSH_HOME: winHome }, fs, envFile, platform: 'win32' })
    assert.equal(client.config.envFileBlocked, true, envFile)
    assert.match(client.config.warnings.join(), /DSH 不允许/, envFile)
    await expectHubError(() => client.listAgents(), 503, 'hub-token-missing')
    assert.deepEqual(fs.reads, [], envFile)
  }
  // lower-case dsh_ prefix is reserved too (Windows variable names are case-insensitive)
  const lower = resolveConfig({ hubUrl: HUB_URL, controllerId: 'dsh-x', envFile: 'C:\\Users\\13558\\.dsh\\.env', tokenEnv: 'dsh_hub_token' }, { env: { DSH_HOME: winHome } }, hermetic())
  assert.equal(lower.envFileBlocked, true)
  // no DSH_HOME: ~/.dsh/.env is DSH's file
  const home = resolveConfig({ hubUrl: HUB_URL, controllerId: 'dsh-x', envFile: '/home/u/.dsh/.env' }, { fs: fakeFs(), env: {}, homedir: () => '/home/u' })
  assert.equal(home.envFileBlocked, true)
  // a different DSH home: /home/u/.dsh/.env is then just some file
  const other = resolveConfig({ hubUrl: HUB_URL, controllerId: 'dsh-x', envFile: '/home/u/.dsh/.env' }, { fs: fakeFs(), env: { DSH_HOME: '/srv/dsh' }, homedir: () => '/home/u' })
  assert.equal(other.envFileBlocked, false)
  assert.deepEqual(other.warnings, [])
})

test('tokenEnv AGENT_HUB_TOKEN may be read from <DSH home>/.env, with a weaker warning', async () => {
  const fs = fakeFs({ [DSH_DOT_ENV]: `AGENT_HUB_TOKEN=${FILE_TOKEN}\n` })
  const { client, calls } = makeClient(() => ok({ agents: [] }), { env: { DSH_HOME: '/srv/dsh' }, fs, envFile: DSH_DOT_ENV, tokenEnv: 'AGENT_HUB_TOKEN' })
  assert.equal(client.config.envFileBlocked, false)
  const warning = client.config.warnings.join('\n')
  assert.match(warning, /DSH 凭据层/)
  assert.match(warning, /agent-hub\/controller\.env/)
  assert.doesNotMatch(warning, /DSH 不允许/)
  assert.equal(client.tokenSource(), 'envFile')
  await client.listAgents()
  assert.equal(calls[0].headers['X-DSH-Token'], FILE_TOKEN)
  assert.ok(fs.reads.length >= 1 && fs.reads.every(p => p === DSH_DOT_ENV), 'read from <DSH home>/.env')
})

// --- connection settings: cordis config > process env > controller.env > default ---

const CTL_ENV = '/srv/dsh/agent-hub/controller.env'
const CA_PATH = '/srv/dsh/agent-hub/hub-ca.pem'
/** A complete MYDESK-style controller.env (bare IP, Clash proxy, CA, token). */
const ctlFile = (over = {}) => {
  const values = { DSH_HUB_URL: '8.134.170.38', DSH_HUB_CONTROLLER_ID: CONTROLLER, DSH_HUB_PROXY: 'http://127.0.0.1:7890', DSH_HUB_CAFILE: CA_PATH, DSH_HUB_TOKEN: TOKEN, ...over }
  return `# dsh-agent-hub controller (test)\n${Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n')}\n`
}
const fromFile = key => `${CTL_ENV} (${CONFIG_ENV_KEYS[key]})`

test('controller.env alone sets hubUrl, controllerId, proxy and caFile; each source is reported, the token is not', () => {
  assert.deepEqual(CONFIG_ENV_KEYS, { hubUrl: 'DSH_HUB_URL', controllerId: 'DSH_HUB_CONTROLLER_ID', proxy: 'DSH_HUB_PROXY', caFile: 'DSH_HUB_CAFILE' })
  const c = resolveConfig({ envFile: CTL_ENV }, hermetic({ fs: fakeFs({ [CTL_ENV]: ctlFile() }) }))
  assert.equal(c.ok, true, c.problems.join())
  assert.equal(c.hubUrl, 'https://8.134.170.38:7891', 'bare IP completed like the worker does')
  assert.equal(c.controllerId, CONTROLLER)
  assert.deepEqual([c.proxyMode, c.proxy], ['url', 'http://127.0.0.1:7890'])
  assert.equal(c.caFile, CA_PATH)
  for (const key of ['hubUrl', 'controllerId', 'proxy', 'caFile']) assert.equal(c.sources[key], fromFile(key), key)
  assert.deepEqual([c.warnings, c.notices, c.setupHint], [[], [], undefined])
  assertNoToken(c)
})

test('a client configured only by controller.env sends to the file\'s hub; editing the file applies on the next call (no restart)', async () => {
  const fs = fakeFs({ [CTL_ENV]: ctlFile({ DSH_HUB_PROXY: 'off' }) })
  const { client, calls, logger } = makeClient(() => ok({ agents: [] }), { hubUrl: undefined, controllerId: undefined, envFile: CTL_ENV, env: {}, fs, readCa: async () => 'PEM' })
  await client.listAgents()
  assert.equal(calls[0].url.href, `https://8.134.170.38:7891/v1/ctl/agents?id=${CONTROLLER}`)
  assert.equal(calls[0].headers[TOKEN_HEADER], TOKEN)
  assert.equal(calls[0].options.ca, 'PEM')
  fs.files[CTL_ENV] = ctlFile({ DSH_HUB_URL: 'https://hub.example:7891', DSH_HUB_PROXY: 'off', DSH_HUB_CAFILE: '' })
  await client.listAgents()
  assert.equal(calls[1].url.origin, 'https://hub.example:7891')
  assert.equal('ca' in calls[1].options, false, 'DSH_HUB_CAFILE= (empty) counts as not set')
  assert.equal(client.config.hubUrl, 'https://hub.example:7891')
  assert.deepEqual(client.route(), { via: 'direct', source: 'direct' })
  assertNoToken(logger.lines)
})

test('explicit cordis.patch.yml values win per setting and warn once that controller.env is shadowed', async () => {
  const fs = fakeFs({ [CTL_ENV]: ctlFile() })
  const logger = fakeLogger()
  const { client, calls } = makeClient(() => ok({ agents: [] }), { hubUrl: 'https://hub.example:7891', controllerId: undefined, proxy: 'off', envFile: CTL_ENV, env: {}, fs, logger, readCa: async () => 'PEM' })
  const c = client.config
  assert.deepEqual([c.hubUrl, c.sources.hubUrl], ['https://hub.example:7891', 'cordis.patch.yml'])
  assert.deepEqual([c.controllerId, c.sources.controllerId], [CONTROLLER, fromFile('controllerId')], 'not in cordis: still from the file')
  assert.deepEqual([c.proxyMode, c.sources.proxy], ['direct', 'cordis.patch.yml'])
  assert.deepEqual([c.caFile, c.sources.caFile], [CA_PATH, fromFile('caFile')])
  await client.listAgents()
  await client.listAgents()
  assert.ok(calls.every(call => call.url.origin === 'https://hub.example:7891'))
  const w = logger.lines.filter(l => l.startsWith('warn '))
  assert.equal(w.filter(l => l.includes(`${CTL_ENV} 里的 DSH_HUB_URL 被 cordis.patch.yml 覆盖了`)).length, 1, w.join('\n'))
  assert.equal(w.filter(l => l.includes(`${CTL_ENV} 里的 DSH_HUB_PROXY 被 cordis.patch.yml 覆盖了`)).length, 1)
  assert.ok(!w.some(l => l.includes('DSH_HUB_CONTROLLER_ID 被') || l.includes('DSH_HUB_CAFILE 被')), 'no reminder for settings cordis does not set')
  assertNoToken(logger.lines)
})

test('the process environment beats controller.env (and says so); the token still falls back to the file', async () => {
  const fs = fakeFs({ [CTL_ENV]: ctlFile() })
  const env = { DSH_HUB_URL: 'hub.example', DSH_HUB_PROXY: 'direct' }
  const { client, calls, logger } = makeClient(() => ok({ agents: [] }), { hubUrl: undefined, controllerId: undefined, envFile: CTL_ENV, env, fs, readCa: async () => 'PEM' })
  const c = client.config
  assert.deepEqual([c.hubUrl, c.sources.hubUrl], ['https://hub.example:7891', 'environment DSH_HUB_URL'])
  assert.deepEqual([c.proxyMode, c.sources.proxy], ['direct', 'environment DSH_HUB_PROXY'])
  assert.equal(c.sources.controllerId, fromFile('controllerId'))
  assert.equal(client.tokenSource(), 'envFile')
  await client.listAgents()
  assert.equal(calls[0].url.origin, 'https://hub.example:7891')
  assert.ok(logger.lines.some(l => l.includes(`${CTL_ENV} 里的 DSH_HUB_URL 被进程环境变量 DSH_HUB_URL 覆盖了`)))
  // cordis still beats both
  const both = resolveConfig({ hubUrl: 'https://cordis.example:7891', envFile: CTL_ENV }, hermetic({ env, fs }))
  assert.equal(both.hubUrl, 'https://cordis.example:7891')
  assert.ok(both.notices.some(n => n.includes('进程环境变量 DSH_HUB_URL 被 cordis.patch.yml 的 config.hubUrl 覆盖了')))
})

test('bare hub addresses are completed like the worker does: https:// and port 7891; a trailing /v1 is dropped', () => {
  const url = hubUrl => resolveConfig({ hubUrl, controllerId: 'dsh-x' }, hermetic())
  assert.equal(normalizeHubUrl('8.134.170.38'), 'https://8.134.170.38:7891/')
  for (const [input, expected] of [
    ['8.134.170.38', 'https://8.134.170.38:7891'],
    [' 8.134.170.38 ', 'https://8.134.170.38:7891'],
    ['8.134.170.38:9443', 'https://8.134.170.38:9443'],
    ['hub.example', 'https://hub.example:7891'],
    ['hub.example:443', 'https://hub.example'],
    ['[::1]', 'https://[::1]:7891'],
    ['https://hub.example', 'https://hub.example'],
    ['https://8.134.170.38:7891', 'https://8.134.170.38:7891'],
  ]) {
    const c = url(input)
    assert.equal(c.ok, true, `${input}: ${c.problems}`)
    assert.equal(c.hubUrl, expected, input)
  }
  const v1 = url('8.134.170.38:7891/v1')
  assert.equal(v1.hubUrl, 'https://8.134.170.38:7891')
  assert.match(v1.warnings.join(), /ends in \/v1 \(the worker form\)/)
  assert.equal(url('http://127.0.0.1:7891/v1/').hubUrl, 'http://127.0.0.1:7891')
  assert.match(url('user:pw@8.134.170.38').problems.join(), /must not contain credentials/)
  assert.match(url('not a url').problems.join(), /not a valid URL/)
})

test('DSH_HUB_PROXY words match the worker: off/direct/none/no = direct, env/system = environment proxy', () => {
  const proxy = value => resolveConfig({ hubUrl: HUB_URL, controllerId: 'dsh-x' }, hermetic({ env: { DSH_HUB_PROXY: value } }))
  for (const v of ['off', 'OFF', 'direct', 'none', 'no', 'false']) assert.equal(proxy(v).proxyMode, 'direct', v)
  for (const v of ['env', 'system']) assert.equal(proxy(v).proxyMode, 'env', v)
  assert.deepEqual([proxy('127.0.0.1:7890').proxyMode, proxy('127.0.0.1:7890').proxy], ['url', 'http://127.0.0.1:7890'])
  const bad = proxy('socks5://127.0.0.1:7891')
  assert.equal(bad.ok, false)
  assert.match(bad.problems.join(), /^DSH_HUB_PROXY \(environment\): proxy must be an http:\/\//)
  assert.equal(resolveConfig({ hubUrl: HUB_URL, controllerId: 'dsh-x' }, hermetic()).sources.proxy, 'default (direct)')
})

test('nothing configured: hub-not-configured names the controller.env path and the two keys; fixing the file works without restart', async () => {
  const fs = fakeFs({})
  const { client, calls } = makeClient(() => ok({ agents: [] }), { hubUrl: undefined, controllerId: undefined, envFile: CTL_ENV, env: { DSH_HUB_TOKEN: TOKEN }, fs })
  assert.equal(client.config.ok, false)
  assert.equal(client.config.sources.envFile, `${CTL_ENV} (not found)`)
  const error = await expectHubError(() => client.listAgents(), 503, 'hub-not-configured')
  assert.ok(error.message.includes(`在 ${CTL_ENV} 写上 DSH_HUB_URL=`), error.message)
  assert.ok(error.message.includes('DSH_HUB_CONTROLLER_ID='), error.message)
  assert.match(error.message, /hubUrl is not set/)
  assert.match(error.message, /controllerId is not set/)
  assertNoToken(error.message)
  assert.equal(calls.length, 0)
  fs.files[CTL_ENV] = 'DSH_HUB_URL=hub.example\nDSH_HUB_CONTROLLER_ID=dsh-test\n'
  await client.listAgents()
  assert.equal(calls[0].url.href, `https://hub.example:7891/v1/ctl/agents?id=${CONTROLLER}`)
})

test('DSH\'s own <DSH home>/.env never supplies DSH_HUB_* settings, even when it is read for a non-DSH token name', async () => {
  const fs = fakeFs({ [DSH_DOT_ENV]: `AGENT_HUB_TOKEN=${FILE_TOKEN}\nDSH_HUB_URL=hub.example\nDSH_HUB_CONTROLLER_ID=dsh-test\n` })
  const { client, calls } = makeClient(() => ok({ agents: [] }), { hubUrl: undefined, controllerId: undefined, env: { DSH_HOME: '/srv/dsh' }, fs, envFile: DSH_DOT_ENV, tokenEnv: 'AGENT_HUB_TOKEN' })
  assert.equal(client.config.ok, false)
  assert.equal(client.config.hubUrl, undefined)
  assert.equal(client.tokenSource(), 'envFile', 'the non-DSH token name is still read')
  const error = await expectHubError(() => client.listAgents(), 503, 'hub-not-configured')
  assert.match(error.message, /在 .*agent-hub[\\/]controller\.env 写上 DSH_HUB_URL=/, 'points at controller.env, not at DSH\'s .env')
  assert.ok(!error.message.includes(`在 ${DSH_DOT_ENV} `))
  assert.equal(calls.length, 0)
})

