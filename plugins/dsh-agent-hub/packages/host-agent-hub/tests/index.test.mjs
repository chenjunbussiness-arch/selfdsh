import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ADMIN_BASE, BRIDGE_BASE } from '../bridge.js'
import { apply, inject, name } from '../index.js'
import { TOKEN, assertNoToken, callRoute, fakeCtx, findRoute } from './helpers.mjs'

const OVERVIEW = `${ADMIN_BASE}/overview`
const ADMIN_PATHS = ['overview', 'agents', 'tasks', 'task', 'requests'].map(p => `${ADMIN_BASE}/${p}`)
/** Port 1 on loopback: connection refused at once (no hub is ever contacted by these tests). */
const NO_ENV_FILE = join(tmpdir(), 'dsh-agent-hub-test-no-such-dir', '.env')
const DEAD_HUB = { hubUrl: 'http://127.0.0.1:1', controllerId: 'dsh-test', timeoutMs: 3000, envFile: NO_ENV_FILE }

/** Set (or clear) DSH_HUB_TOKEN for one test. */
function withToken(t, value) {
  const env = globalThis.process.env
  const previous = env.DSH_HUB_TOKEN
  if (value === undefined) delete env.DSH_HUB_TOKEN
  else env.DSH_HUB_TOKEN = value
  t.after(() => {
    if (previous === undefined) delete env.DSH_HUB_TOKEN
    else env.DSH_HUB_TOKEN = previous
  })
}

/** The DSH_HUB_* connection variables of the real process env are hidden during a test. */
const HUB_ENV_KEYS = ['DSH_HUB_URL', 'DSH_HUB_CONTROLLER_ID', 'DSH_HUB_PROXY', 'DSH_HUB_CAFILE']
function hideHubEnv(t) {
  const env = globalThis.process.env
  const saved = HUB_ENV_KEYS.map(k => [k, env[k]])
  for (const k of HUB_ENV_KEYS) delete env[k]
  t.after(() => { for (const [k, v] of saved) { if (v === undefined) delete env[k]; else env[k] = v } })
}

function mount(t, options = {}, config = {}) {
  hideHubEnv(t)
  const fake = fakeCtx(options)
  t.after(() => fake.dispose())
  apply(fake.ctx, config)
  return fake
}

const warns = fake => fake.logger.lines.filter(l => l.startsWith('warn '))

test('plugin identity', () => {
  assert.equal(name, 'dsh-host-agent-hub')
  assert.deepEqual(inject, ['tools'])
})

test('apply registers 14 tools and the 5 login-guarded admin routes, nothing under /v1', (t) => {
  withToken(t, TOKEN)
  const fake = mount(t, { connection: { requestRejection: () => 401 } }, DEAD_HUB)
  assert.equal(fake.tools.size, 14)
  assert.deepEqual(fake.injected, [['webServer']])
  assert.deepEqual(fake.routes.map(r => r.path).sort(), [...ADMIN_PATHS].sort())
  assert.ok(!fake.routes.some(r => r.path.startsWith(`${BRIDGE_BASE}/v1`)), 'worker routes are gone')
  assert.deepEqual(warns(fake), [], 'a complete config gives no warning')
  assert.ok(fake.logger.lines.includes('info agent-hub: mounted /api/agent-hub/admin/* (login, read-only, forwarded to the hub)'))
  assert.ok(fake.logger.lines.includes('info agent-hub: 14 control tools registered (agent_*, task_*, fallback_*); controller of http://127.0.0.1:1 as dsh-test'))
  assert.ok(fake.logger.lines.includes('info agent-hub: controller token from environment variable DSH_HUB_TOKEN'))
  assertNoToken(fake.logger.lines)
})

test('admin routes are wrapped in requireLogin', async (t) => {
  withToken(t, TOKEN)
  const fake = mount(t, { connection: { requestRejection: () => 401 } }, DEAD_HUB)
  for (const route of fake.routes) assert.equal((await callRoute(route, { method: 'GET' })).statusCode, 401, route.path)
  const none = mount(t, {}, DEAD_HUB)
  assert.equal((await callRoute(findRoute(none.routes, OVERVIEW), { method: 'GET' })).statusCode, 503, 'no connection service')
})

test('logged in + hub down: panel answers 503 hub-unreachable, tools reject with [hub-unreachable]', async (t) => {
  withToken(t, TOKEN)
  const fake = mount(t, { connection: { requestRejection: () => undefined } }, DEAD_HUB)
  const res = await callRoute(findRoute(fake.routes, OVERVIEW), { method: 'GET' })
  assert.equal(res.statusCode, 503)
  assert.equal(res.json().error.code, 'hub-unreachable')
  await assert.rejects(fake.tools.get('agent_list').execute({}), (e) => {
    assert.equal(e.code, 'hub-unreachable')
    assert.match(e.message, /^\[hub-unreachable\] hub unreachable \(http:\/\/127\.0\.0\.1:1\)/)
    assertNoToken(e.message)
    return true
  })
  assertNoToken(res.text, fake.logger.lines)
})

test('missing token: loads with a warning; tools and panel answer hub-token-missing', async (t) => {
  withToken(t, undefined)
  const fake = mount(t, { connection: { requestRejection: () => undefined } }, DEAD_HUB)
  assert.equal(fake.tools.size, 14)
  assert.ok(warns(fake).some(l => l.includes('DSH_HUB_TOKEN is not set') && l.includes(NO_ENV_FILE) && l.includes('controller add dsh-test')))
  const res = await callRoute(findRoute(fake.routes, OVERVIEW), { method: 'GET' })
  assert.equal(res.statusCode, 503)
  assert.equal(res.json().error.code, 'hub-token-missing')
  await assert.rejects(fake.tools.get('task_list').execute({}), { code: 'hub-token-missing' })
})

test('missing config: loads with warnings; tools and panel answer hub-not-configured', async (t) => {
  withToken(t, TOKEN)
  const fake = mount(t, { connection: { requestRejection: () => undefined } }, { envFile: NO_ENV_FILE })
  assert.equal(fake.tools.size, 14)
  const w = warns(fake)
  assert.ok(w.some(l => l.includes('hubUrl is not set')))
  assert.ok(w.some(l => l.includes('controllerId is not set')))
  assert.ok(w.some(l => l.includes(`在 ${NO_ENV_FILE} 写上 DSH_HUB_URL=`) && l.includes('DSH_HUB_CONTROLLER_ID=')), w.join('\n'))
  assert.ok(w.some(l => l.includes('not configured')))
  assert.ok(fake.logger.lines.includes('info agent-hub: 14 control tools registered (agent_*, task_*, fallback_*); controller of an unconfigured hub'))
  const res = await callRoute(findRoute(fake.routes, `${ADMIN_BASE}/agents`), { method: 'GET' })
  assert.equal(res.statusCode, 503)
  assert.equal(res.json().error.code, 'hub-not-configured')
  await assert.rejects(fake.tools.get('task_dispatch').execute({ agent: 'x1', title: 't', instruction: 'i' }), { code: 'hub-not-configured' })
  assertNoToken(fake.logger.lines)
})

test('insecure remote http hubUrl is refused with a warning', (t) => {
  withToken(t, TOKEN)
  const fake = mount(t, {}, { hubUrl: 'http://203.0.113.5:7891', controllerId: 'dsh-test', envFile: NO_ENV_FILE })
  assert.ok(warns(fake).some(l => l.includes('must use https://')))
})

test('v1 config keys are ignored with one warning; a bad timeout warns and falls back', (t) => {
  withToken(t, TOKEN)
  const fake = mount(t, {}, { ...DEAD_HUB, timeoutMs: 10, dataDir: '/x', publicUrl: 'https://dsh', sweepIntervalMs: 1, maxRetries: 2 })
  const w = warns(fake)
  assert.ok(w.includes('warn agent-hub: config dataDir, publicUrl, sweepIntervalMs, maxRetries ignored (v1 settings; the standalone hub owns them now)'))
  assert.ok(w.some(l => l.includes('timeoutMs must be an integer')))
  assert.ok(!w.some(l => l.includes('not configured')), 'a bad timeout alone does not disable the client')
})

test('a webServer without register() mounts nothing and warns; tools still work', (t) => {
  withToken(t, TOKEN)
  const fake = mount(t, { webServer: {} }, DEAD_HUB)
  assert.equal(fake.routes.length, 0)
  assert.equal(fake.tools.size, 14)
  assert.ok(warns(fake).some(l => l.includes('webServer exposes no register()')))
})

test('no timers or background work: dispose unregisters tools and routes', (t) => {
  withToken(t, TOKEN)
  const fake = fakeCtx()
  apply(fake.ctx, DEAD_HUB)
  assert.equal(fake.routes.length, 5)
  assert.equal(fake.cleanups.length, 19, '14 tools + 5 routes, no sweeper')
  fake.dispose()
  assert.equal(fake.tools.size, 0)
  assert.equal(fake.routes.length, 0)
})

test('token from a real .env file (tokenEnv renamed): used for calls, only its source is logged', async (t) => {
  withToken(t, undefined)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-agent-hub-env-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, '.env')
  await writeFile(file, `# dsh-hub controller token\nexport HUB_TOKEN_TEST="${TOKEN}"\n`, { mode: 0o600 })
  await chmod(file, 0o600)
  const fake = mount(t, { connection: { requestRejection: () => undefined } }, { ...DEAD_HUB, envFile: file, tokenEnv: 'HUB_TOKEN_TEST' })
  assert.ok(fake.logger.lines.includes(`info agent-hub: controller token from ${file} (HUB_TOKEN_TEST)`))
  assert.ok(!warns(fake).some(l => l.includes('not set')), 'token found')
  const res = await callRoute(findRoute(fake.routes, OVERVIEW), { method: 'GET' })
  assert.equal(res.json().error.code, 'hub-unreachable', 'the token was found, the (dead) hub was contacted')
  assertNoToken(fake.logger.lines, res.text)
})

test('envFile = <DSH home>/.env with DSH_HUB_TOKEN: a real file there is not read, the startup log says how to migrate', async (t) => {
  withToken(t, undefined)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-agent-hub-home-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const env = globalThis.process.env
  const previousHome = env.DSH_HOME
  env.DSH_HOME = dir
  t.after(() => {
    if (previousHome === undefined) delete env.DSH_HOME
    else env.DSH_HOME = previousHome
  })
  const file = join(dir, '.env')
  await writeFile(file, `DSH_HUB_TOKEN=${TOKEN}\n`, { mode: 0o600 })
  const fake = mount(t, { connection: { requestRejection: () => undefined } }, { ...DEAD_HUB, envFile: file })
  const w = warns(fake)
  assert.ok(w.some(l => l.includes('DSH 不允许 <DSH home>/.env 里出现 DSH_ 开头的变量（会拒绝启动）') && l.includes('agent-hub/controller.env')), w.join('\n'))
  assert.ok(w.some(l => l.includes('DSH_HUB_TOKEN is not set') && l.includes('not read for DSH_* names')), 'token not taken from DSH\'s .env')
  assert.ok(!fake.logger.lines.some(l => l.startsWith('info agent-hub: controller token from')))
  const res = await callRoute(findRoute(fake.routes, OVERVIEW), { method: 'GET' })
  assert.equal(res.json().error.code, 'hub-token-missing')
  assertNoToken(fake.logger.lines, res.text)
})

test('controller.env alone (real file): all four settings and the token come from it; the startup log names every source, never the token', async (t) => {
  withToken(t, undefined)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-agent-hub-ctl-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ca = join(dir, 'hub-ca.pem')
  await writeFile(ca, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n')
  const file = join(dir, 'controller.env')
  await writeFile(file, `# test\nDSH_HUB_URL=127.0.0.1:1\nDSH_HUB_CONTROLLER_ID=dsh-test\nDSH_HUB_PROXY=off\nDSH_HUB_CAFILE=${ca}\nDSH_HUB_TOKEN=${TOKEN}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
  const fake = mount(t, { connection: { requestRejection: () => undefined } }, { envFile: file, timeoutMs: 3000 })
  assert.deepEqual(warns(fake), [], 'complete controller.env: no warning')
  const src = key => `${file} (${key})`
  assert.ok(fake.logger.lines.includes(`info agent-hub: config hubUrl=https://127.0.0.1:1 (${src('DSH_HUB_URL')}), controllerId=dsh-test (${src('DSH_HUB_CONTROLLER_ID')}), proxy=direct (${src('DSH_HUB_PROXY')}), caFile=${ca} (${src('DSH_HUB_CAFILE')})`), fake.logger.lines.join('\n'))
  assert.ok(fake.logger.lines.includes(`info agent-hub: controller token from ${file} (DSH_HUB_TOKEN)`))
  assert.ok(fake.logger.lines.includes('info agent-hub: 14 control tools registered (agent_*, task_*, fallback_*); controller of https://127.0.0.1:1 as dsh-test'))
  const res = await callRoute(findRoute(fake.routes, OVERVIEW), { method: 'GET' })
  assert.equal(res.json().error.code, 'hub-unreachable', 'configured from the file: the (dead) hub was contacted')
  assertNoToken(fake.logger.lines, res.text)
})

test('cordis config shadowing controller.env is reported at startup', async (t) => {
  withToken(t, TOKEN)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-agent-hub-ctl-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'controller.env')
  await writeFile(file, 'DSH_HUB_URL=https://203.0.113.10:7891\nDSH_HUB_CONTROLLER_ID=dsh-local\n', { mode: 0o600 })
  const fake = mount(t, {}, { ...DEAD_HUB, envFile: file })
  const w = warns(fake)
  assert.ok(w.includes(`warn agent-hub: ${file} 里的 DSH_HUB_URL 被 cordis.patch.yml 覆盖了（config.hubUrl 优先）；要让 controller.env 生效，删掉 cordis.patch.yml 里的 hubUrl`), w.join('\n'))
  assert.ok(w.some(l => l.includes(`${file} 里的 DSH_HUB_CONTROLLER_ID 被 cordis.patch.yml 覆盖了`)))
  assert.ok(fake.logger.lines.some(l => l.startsWith('info agent-hub: config hubUrl=http://127.0.0.1:1 (cordis.patch.yml), controllerId=dsh-test (cordis.patch.yml)')))
  assertNoToken(fake.logger.lines)
})

