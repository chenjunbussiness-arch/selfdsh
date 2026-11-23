/**
 * hub.json resolution (defaults, env overrides, validation, listen safety),
 * TLS private key permission check, and the controller CLI.
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { runCli } from '../lib/cli.js'
import { checkTlsKey, ConfigError, DEFAULT_PORT, dshHome, keyModeWarning, loadConfig, resolveConfig, stateDir } from '../lib/config.js'
import { AgentHub } from '../lib/hub.js'
import { fakeClock, tempDir } from './helpers.mjs'

const TLS = { cert: '/etc/dsh-hub/tls/fullchain.pem', key: '/etc/dsh-hub/tls/privkey.pem' }

test('defaults: port 7891, 127.0.0.1 without TLS, no allow list, v1 timings', () => {
  const { config, warnings } = resolveConfig({})
  assert.deepEqual(config, {
    port: DEFAULT_PORT, host: '127.0.0.1', tls: undefined, allow: [], trustProxy: false,
    maxRetries: 2, offlineAfterMs: 90_000, sweepIntervalMs: 15_000, maxResultBytes: 20 * 1024 * 1024,
    fallback: { enabled: true, noFallbackCapabilities: ['quick'] }, mcp: { enabled: true },
  })
  assert.equal(DEFAULT_PORT, 7891)
  assert.notEqual(DEFAULT_PORT, 7890, '7890 is the Clash/mihomo proxy port on MYDESK')
  assert.deepEqual(warnings, [])
})

test('DSH_HUB_PORT overrides hub.json port and is validated', () => {
  assert.equal(resolveConfig({ port: 9000 }, { env: { DSH_HUB_PORT: '7999' } }).config.port, 7999)
  assert.equal(resolveConfig({ port: 9000 }, { env: { DSH_HUB_PORT: '' } }).config.port, 9000)
  for (const bad of ['0', '65536', 'abc', '7891.5', '-1', ' 80']) assert.throws(() => resolveConfig({}, { env: { DSH_HUB_PORT: bad } }), ConfigError, bad)
  for (const port of [0, 70000, '7891', 1.5]) assert.throws(() => resolveConfig({ port }), ConfigError, String(port))
})

test('no TLS: any host other than 127.0.0.1 is refused (the service will not start)', () => {
  for (const host of ['0.0.0.0', '::', '10.0.0.5', 'localhost', '::1']) {
    assert.throws(() => resolveConfig({ host }), (e) => e instanceof ConfigError && /without TLS/.test(e.message), host)
  }
  assert.equal(resolveConfig({ host: '127.0.0.1' }).config.host, '127.0.0.1')
})

test('TLS: both paths required, relative paths resolved against the state dir, default host 0.0.0.0', () => {
  const { config, warnings } = resolveConfig({ tls: TLS, allow: ['203.0.113.7/32'] }, { dir: '/root/.dsh/agent-hub' })
  assert.deepEqual(config.tls, TLS)
  assert.equal(config.host, '0.0.0.0')
  assert.deepEqual(warnings, [])
  const rel = resolveConfig({ tls: { cert: 'tls/cert.pem', key: 'tls/key.pem' }, host: '10.0.0.5' }, { dir: '/root/.dsh/agent-hub' }).config
  assert.equal(rel.tls.key.replace(/\\/g, '/').endsWith('/root/.dsh/agent-hub/tls/key.pem'), true)
  assert.equal(rel.host, '10.0.0.5')
  for (const tls of [{ cert: 'a' }, { key: 'b' }, { cert: '', key: 'b' }, 'cert.pem', { cert: 1, key: 2 }]) assert.throws(() => resolveConfig({ tls }), ConfigError, JSON.stringify(tls))
  assert.ok(resolveConfig({ tls: TLS }).warnings.some(w => w.includes('no "allow" list')), 'TLS without allow list warns')
})

test('validation of allow, trustProxy, numbers; unknown keys only warn', () => {
  assert.deepEqual(resolveConfig({ allow: ['10.0.0.0/8', '::1'] }).config.allow, ['10.0.0.0/8', '::1'])
  for (const allow of [['10.0.0.0/33'], ['2001:db8::/64'], 'any', [1]]) assert.throws(() => resolveConfig({ allow }), ConfigError, JSON.stringify(allow))
  assert.throws(() => resolveConfig({ trustProxy: 'yes' }), ConfigError)
  assert.equal(resolveConfig({ trustProxy: true }).config.trustProxy, true)
  for (const [key, bad] of [['maxRetries', -1], ['maxRetries', 21], ['offlineAfterMs', 10], ['sweepIntervalMs', 0], ['maxResultBytes', 100], ['maxResultBytes', '20MB']]) {
    assert.throws(() => resolveConfig({ [key]: bad }), ConfigError, `${key}=${bad}`)
  }
  const { config, warnings } = resolveConfig({ maxRetries: 0, offlineAfterMs: 60_000, sweepIntervalMs: 5000, maxResultBytes: 1024 * 1024, dataDir: '/elsewhere', token: 'x' })
  assert.deepEqual([config.maxRetries, config.offlineAfterMs, config.sweepIntervalMs, config.maxResultBytes], [0, 60_000, 5000, 1024 * 1024])
  assert.deepEqual(warnings, ['hub.json: unknown key "dataDir" ignored', 'hub.json: unknown key "token" ignored'])
  for (const raw of [null, [], 'x']) assert.throws(() => resolveConfig(raw), ConfigError)
})

test('DSH home and the fixed state dir', () => {
  assert.equal(dshHome({ DSH_HOME: '/srv/dsh' }, '/root').replace(/\\/g, '/'), '/srv/dsh')
  assert.equal(dshHome({}, '/root').replace(/\\/g, '/'), '/root/.dsh')
  assert.equal(stateDir({}, '/root').replace(/\\/g, '/'), '/root/.dsh/agent-hub')
  assert.equal(stateDir({ DSH_HOME: '/srv/dsh' }).replace(/\\/g, '/'), '/srv/dsh/agent-hub')
})

test('loadConfig reads <DSH_HOME>/agent-hub/hub.json; missing file = defaults; bad JSON is a ConfigError', async (t) => {
  const home = await tempDir(t)
  const env = { DSH_HOME: home }
  const first = await loadConfig({ env })
  assert.equal(first.config.port, 7891)
  assert.equal(first.dir, join(home, 'agent-hub'))
  await mkdir(join(home, 'agent-hub'), { recursive: true })
  await writeFile(join(home, 'agent-hub', 'hub.json'), JSON.stringify({ port: 9101, allow: ['127.0.0.1'] }))
  const second = await loadConfig({ env: { ...env, DSH_HUB_PORT: '9102' } })
  assert.deepEqual([second.config.port, second.config.allow], [9102, ['127.0.0.1']])
  assert.equal(second.path, join(home, 'agent-hub', 'hub.json'))
  await writeFile(join(home, 'agent-hub', 'hub.json'), '{ nope')
  await assert.rejects(loadConfig({ env }), e => e instanceof ConfigError && /not valid JSON/.test(e.message))
})

test('TLS private key permissions: warn on POSIX when group/others can read; never on Windows', async () => {
  assert.equal(keyModeWarning(0o100600, 'linux', '/k.pem'), undefined)
  assert.equal(keyModeWarning(0o100400, 'linux', '/k.pem'), undefined)
  assert.match(keyModeWarning(0o100640, 'linux', '/k.pem'), /mode 640.*chmod 600 \/k\.pem/)
  assert.match(keyModeWarning(0o100644, 'darwin', '/k.pem'), /group\/others/)
  assert.match(keyModeWarning(0o100604, 'linux', '/k.pem'), /mode 604/)
  assert.equal(keyModeWarning(0o100666, 'win32', 'C:/k.pem'), undefined)
  const statOf = mode => async () => ({ mode, isFile: () => true })
  assert.equal(await checkTlsKey('/k.pem', { platform: 'linux', statFn: statOf(0o100600) }), undefined)
  assert.match(await checkTlsKey('/k.pem', { platform: 'linux', statFn: statOf(0o100644) }), /chmod 600/)
  await assert.rejects(checkTlsKey('/missing.pem', { platform: 'linux', statFn: async () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e } }), e => e instanceof ConfigError && /ENOENT/.test(e.message))
  await assert.rejects(checkTlsKey('/dir', { platform: 'linux', statFn: async () => ({ mode: 0o40700, isFile: () => false }) }), ConfigError)
})

// --- CLI ---------------------------------------------------------------------------------

async function cli(t, home, argv) {
  const out = []
  const err = []
  const code = await runCli(argv, { env: { DSH_HOME: home }, out: s => out.push(s), err: s => err.push(s), clock: fakeClock() })
  return { code, out, err }
}

test('CLI: controller add prints the token once; list never shows it; revoke; state dir is <DSH_HOME>/agent-hub', async (t) => {
  const home = await tempDir(t)
  const added = await cli(t, home, ['controller', 'add', 'dsh-cloud'])
  assert.equal(added.code, 0)
  const token = added.out.find(l => l.startsWith('dshc_'))
  assert.match(token, /^dshc_dsh-cloud_[A-Za-z0-9_-]{32}$/)
  const dir = join(home, 'agent-hub')
  assert.equal(await new AgentHub({ dataDir: dir }).authenticateController(token), 'dsh-cloud')
  assert.ok(!(await readFile(join(dir, 'controllers.json'), 'utf8')).includes(token))

  const dup = await cli(t, home, ['controller', 'add', 'dsh-cloud'])
  assert.equal(dup.code, 1)
  assert.match(dup.err.join('\n'), /already exists/)
  const bad = await cli(t, home, ['controller', 'add', 'Bad_Id'])
  assert.equal(bad.code, 1)

  await cli(t, home, ['controller', 'add', 'dsh-local'])
  const list = await cli(t, home, ['controller', 'list'])
  assert.equal(list.code, 0)
  assert.equal(list.out.length, 2)
  assert.ok(list.out[0].startsWith('dsh-cloud\tactive'))
  assert.ok(!list.out.join('\n').includes('dshc_'), 'list never prints tokens')

  const revoked = await cli(t, home, ['controller', 'revoke', 'dsh-cloud'])
  assert.equal(revoked.code, 0)
  assert.ok((await cli(t, home, ['controller', 'list'])).out[0].includes('revoked'))
  assert.equal((await cli(t, home, ['controller', 'revoke', 'ghost'])).code, 1)
})

test('CLI: usage errors exit 2; help exits 0', async (t) => {
  const home = await tempDir(t)
  for (const argv of [['controller'], ['controller', 'add'], ['controller', 'list', 'x'], ['controller', 'remove', 'x'], ['agent', 'add', 'x'], ['controller', 'add', 'a', 'b']]) {
    const r = await cli(t, home, argv)
    assert.equal(r.code, 2, argv.join(' '))
    assert.match(r.err.join('\n'), /usage:/)
  }
  assert.equal((await cli(t, home, ['--help'])).code, 0)
  assert.equal((await cli(t, home, ['controller', 'list'])).out[0].startsWith('no controllers'), true)
})
