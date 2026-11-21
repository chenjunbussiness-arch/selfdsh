/**
 * Tests for the VPN host half. No network, no routes, no root: the openfortivpn
 * binary is a fake script (`fixtures/fake-openfortivpn.mjs`) and `ip` is a fake
 * `exec`.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createRoutes } from '../lib/bridge.js'
import { cookieFromHead, parseLine, planCookie, planPassword } from '../lib/forti.js'
import { checkTargets, defaultRouteKey, parseRouteTable, protectedAddresses, v4Targets } from '../lib/guard.js'
import { VpnManager } from '../lib/manager.js'
import { redact, secretsOfUrl } from '../lib/redact.js'
import { ProfileStore } from '../lib/store.js'
import { ValidationError, parseTarget, parseTargets, validateProfileInput } from '../lib/validate.js'
import { apply, describeStatus } from '../lib/index.js'

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-openfortivpn.mjs')
const dirs = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-vpn-'))
  dirs.push(dir)
  return dir
}
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

const logger = { info() {}, warn() {} }
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await wait(20)
  }
  throw new Error('condition not met in time')
}

const ROUTES = [
  'default via 192.0.2.30 dev eth0 proto dhcp src 192.0.2.35 metric 100',
  '198.18.16.0/20 dev eth0 proto kernel scope link src 192.0.2.35 metric 100',
  '192.0.2.30 dev eth0 proto dhcp scope link src 192.0.2.35 metric 100',
].join('\n')

/** A fake `ip`/system layer. `defaultRoute` can be changed mid-test. */
function fakeSystem() {
  const state = { defaultRoute: ROUTES, added: [], tcpOk: true, failRouteAdd: false }
  const exec = async (argv) => {
    if (argv[0] === 'ip' && argv[1] === '-4' && argv[2] === 'route' && argv[3] === 'show' && argv[4] === 'default') {
      return { code: 0, stdout: state.defaultRoute.split('\n').filter(line => line.startsWith('default')).join('\n'), stderr: '' }
    }
    if (argv[0] === 'ip' && argv[3] === 'show') return { code: 0, stdout: state.defaultRoute, stderr: '' }
    if (argv[0] === 'ip' && argv[3] === 'add') {
      if (state.failRouteAdd) return { code: 2, stderr: 'RTNETLINK answers: File exists', stdout: '' }
      state.added.push(argv.join(' '))
      return { code: 0, stdout: '', stderr: '' }
    }
    // `openfortivpn --version` / `--help` go through the fake script.
    return runNode(argv)
  }
  return { state, exec, tcp: async () => state.tcpOk }
}

import { spawnSync } from 'node:child_process'
function runNode(argv) {
  const [command, ...args] = argv
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function harness(options = {}) {
  const dir = scratch()
  const store = new ProfileStore(dir)
  await store.ensure()
  const sys = fakeSystem()
  const manager = new VpnManager({
    store,
    dir,
    exe: [process.execPath, FAKE],
    logger,
    allowCustom: options.allowCustom ?? false,
    watchdogMs: options.watchdogMs ?? 300,
    watchdogIntervalMs: 30,
    guardIntervalMs: 30,
    connectTimeoutMs: options.connectTimeoutMs ?? 5000,
    killGraceMs: 500,
    localProbePort: 42443,
    publicProbe: '223.5.5.5:53',
    exec: sys.exec,
    tcp: sys.tcp,
    lookupAll: async host => (host === 'git.corp.example' ? ['10.20.30.40'] : (() => { throw new Error('nx') })()),
    cookie: options.cookie ?? (async () => 'COOKIEVALUE123456'),
    env: options.env ?? {},
  })
  return { dir, store, sys, manager }
}

const passwordBody = (over = {}) => ({
  name: 'corp', type: 'password', host: 'vpn.corp.example', port: 443, username: 'alice', secret: 'S3cret-pass!',
  targets: ['10.20.0.0/16', 'git.corp.example'], ...over,
})

async function addProfile(h, over) {
  return h.store.upsert(validateProfileInput(passwordBody(over), { allowCustom: true }))
}

// --- validation -------------------------------------------------------------

test('targets: default-route lookalikes are refused', () => {
  for (const bad of ['0.0.0.0/0', '0.0.0.0', '::/0', '::', 'default', '0.0.0.0/1', '128.0.0.0/1', '10.0.0.0/7', '8.0.0.0/4', '2000::/3', 'localhost', '0.1.2.3/24']) {
    assert.throws(() => parseTarget(bad), ValidationError, bad)
  }
})

test('targets: good shapes are canonicalised', () => {
  assert.deepEqual(parseTarget('10.20.30.40/16'), { kind: 'v4', value: '10.20.0.0/16' })
  assert.deepEqual(parseTarget('10.1.2.3'), { kind: 'v4', value: '10.1.2.3/32' })
  assert.deepEqual(parseTarget('Git.Corp.Example'), { kind: 'host', value: 'git.corp.example' })
  assert.deepEqual(parseTarget('fd12::/16'), { kind: 'v6', value: 'fd12::/16' })
  assert.deepEqual(parseTargets('10.0.0.0/8, 10.0.0.0/8\n192.168.1.0/24'), ['10.0.0.0/8', '192.168.1.0/24'])
})

test('targets: empty list, injection and line breaks are refused', () => {
  assert.throws(() => parseTargets([]), /at least one target/)
  assert.throws(() => parseTargets(''), /at least one target/)
  for (const bad of ['-A', '--set-routes=1', '10.0.0.0/8\n0.0.0.0/0', '10.0.0.1\u0000', 'a b', 'x;rm -rf /', '10.0.0.0/33', 'a..b', '999.1.1.1']) {
    assert.throws(() => parseTargets([bad]), ValidationError, JSON.stringify(bad))
  }
})

test('profile input: host, port, username, realm and digest are checked', () => {
  const ok = (over) => validateProfileInput(passwordBody(over), { allowCustom: false })
  assert.equal(ok({}).fields.host, 'vpn.corp.example')
  assert.throws(() => ok({ host: '-oProxyCommand=x' }), ValidationError)
  assert.throws(() => ok({ host: 'a b' }), ValidationError)
  assert.throws(() => ok({ host: 'vpn\n.example' }), ValidationError)
  assert.throws(() => ok({ port: 0 }), ValidationError)
  assert.throws(() => ok({ port: 70000 }), ValidationError)
  assert.throws(() => ok({ port: 'abc' }), ValidationError)
  assert.throws(() => ok({ username: '-u' }), ValidationError)
  assert.throws(() => ok({ username: 'a\nb' }), ValidationError)
  assert.throws(() => ok({ realm: 'x y' }), ValidationError)
  assert.throws(() => ok({ trustedCert: 'zz' }), ValidationError)
  assert.throws(() => ok({ secret: 'pass\nword' }), ValidationError)
  assert.throws(() => ok({ secret: 'pass\u0000' }), ValidationError)
  assert.throws(() => ok({ secret: ' leading' }), ValidationError)
  assert.equal(ok({ trustedCert: 'AB:'.repeat(31) + 'AB' }).fields.trustedCert, 'ab'.repeat(32))
  assert.throws(() => ok({ type: 'custom', command: ['/bin/true'] }), /disabled/)
})

test('token-url: only plain https URLs, host and port are derived', () => {
  const body = { name: 't', type: 'token-url', secret: 'https://gw.corp.example:10443/remote/login?token=abc123', targets: ['10.0.0.0/8'] }
  const parsed = validateProfileInput(body, { allowCustom: false })
  assert.equal(parsed.fields.host, 'gw.corp.example')
  assert.equal(parsed.fields.port, 10443)
  assert.equal(parsed.secret, body.secret)
  for (const bad of ['http://gw.example/?token=x', 'https://u:p@gw.example/?token=x', 'ftp://gw.example', 'not a url', 'https://gw.example/\nx', 'https://-bad/']) {
    assert.throws(() => validateProfileInput({ ...body, secret: bad }, { allowCustom: false }), ValidationError, bad)
  }
})

// --- redaction --------------------------------------------------------------

test('redact: known secrets, urls and key=value shapes become ***', () => {
  const url = 'https://gw.corp.example/remote/login?token=tok_ABC123&x=1'
  const secrets = secretsOfUrl(url)
  assert.ok(secrets.includes('tok_ABC123'))
  const line = `GET ${url} cookie: SVPNCOOKIE=abcdef123; password = hunter22 ; Authorization: Bearer xyz`
  const out = redact(line, [...secrets, 'hunter22'])
  for (const leak of ['tok_ABC123', 'abcdef123', 'hunter22', 'xyz', url]) assert.ok(!out.includes(leak), `${leak} leaked: ${out}`)
  assert.match(out, /\*\*\*/)
  assert.equal(redact('ordinary line: tunnel up', ['x']), 'ordinary line: tunnel up')
  assert.ok(!redact('encoded %7Esecret%21', ['~secret!']).includes('secret%21'))
  assert.ok(!redact('?token=zzz&a=b', []).includes('zzz'))
})

// --- storage ----------------------------------------------------------------

test('store: read endpoints never carry a secret; files are private', async () => {
  const h = await harness()
  const saved = await addProfile(h)
  assert.equal(saved.secretConfigured, true)
  const listed = JSON.stringify(await h.store.list())
  assert.ok(!listed.includes('S3cret-pass!'))
  assert.ok(!('secret' in JSON.parse(listed)[0]))
  assert.ok(!readFileSync(join(h.dir, 'profiles.json'), 'utf8').includes('S3cret-pass!'))
  assert.equal(readFileSync(join(h.dir, 'secrets', saved.id), 'utf8'), 'S3cret-pass!')
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(h.dir, 'secrets', saved.id)).mode & 0o777, 0o600)
    assert.equal(statSync(h.dir).mode & 0o777, 0o700)
  }
  // Update without a secret keeps the stored one; with one replaces it.
  const { secret: _drop, ...noSecret } = passwordBody({ id: saved.id, name: 'corp2' })
  await h.store.upsert(validateProfileInput(noSecret, { allowCustom: false }))
  assert.equal(await h.store.readSecret(saved.id), 'S3cret-pass!')
  await h.store.upsert(validateProfileInput(passwordBody({ id: saved.id, secret: 'newpass9' }), { allowCustom: false }))
  assert.equal(await h.store.readSecret(saved.id), 'newpass9')
  await assert.rejects(() => h.store.upsert(validateProfileInput(passwordBody(), { allowCustom: false })), /already exists/)
  await h.store.remove(saved.id)
  assert.equal(await h.store.readSecret(saved.id), undefined)
})

test('store: a profile without a secret cannot be created', async () => {
  const h = await harness()
  const { secret: _drop, ...noSecret } = passwordBody()
  await assert.rejects(() => h.store.upsert(validateProfileInput(noSecret, { allowCustom: false })), /password is required/)
})

// --- guard ------------------------------------------------------------------

test('guard: targets that would capture the gateway, this server or the probe are refused', () => {
  const table = parseRouteTable(ROUTES)
  assert.equal(defaultRouteKey(ROUTES), 'via 192.0.2.30 dev eth0')
  const extra = [{ label: 'the watchdog probe address', address: '223.5.5.5' }]
  const protect = protectedAddresses(table, extra)
  assert.equal(checkTargets(table, v4Targets(['10.20.0.0/16']), protect), undefined)
  assert.match(checkTargets(table, v4Targets(['192.0.2.30/32']), protect), /default gateway/)
  assert.match(checkTargets(table, v4Targets(['192.0.2.35/32']), protect), /own address/)
  assert.match(checkTargets(table, v4Targets(['223.5.5.0/24']), protect), /probe/)
  assert.match(checkTargets(table, v4Targets(['127.0.0.0/8']), protect), /loopback/)
  // The connected /20 is more specific than a /16 target, so a wider route cannot take it over.
  assert.equal(checkTargets(table, v4Targets(['198.18.0.0/16']), protect), undefined)
  assert.match(checkTargets(table, v4Targets(['198.18.18.0/24']), protect), /default gateway|own address/)
})

// --- openfortivpn plans & log parsing --------------------------------------

test('forti: plans never put a secret in argv and never allow route changes', () => {
  const profile = { host: 'vpn.corp.example', port: 443, username: 'alice', realm: 'r1', trustedCert: 'ab'.repeat(32), setDns: false }
  const pw = planPassword(profile, 'S3cret-pass!')
  assert.ok(!pw.args.join(' ').includes('S3cret'))
  assert.ok(pw.args.includes('--no-routes'))
  assert.ok(pw.args.includes('--set-dns=0'))
  assert.ok(pw.args.includes('--pppd-use-peerdns=0'))
  assert.ok(!pw.args.some(arg => arg.startsWith('--half-internet-routes') || arg.startsWith('--set-routes=1')))
  assert.match(pw.config, /^password = S3cret-pass!$/m)
  const ck = planCookie(profile, 'COOKIE123')
  assert.ok(!ck.args.join(' ').includes('COOKIE123'))
  assert.ok(ck.args.includes('--cookie-on-stdin') && ck.args.includes('--no-routes'))
  assert.equal(ck.stdin, 'COOKIE123\n')
  assert.ok(planPassword({ ...profile, setDns: true }, 'x').args.includes('--set-dns=1'))
})

test('forti: log lines are understood', () => {
  assert.equal(parseLine('INFO:   Interface ppp0 is UP.').iface, 'ppp0')
  assert.equal(parseLine('INFO:   Got addresses: [10.8.0.6], ns [10.8.0.1]').ip, '10.8.0.6')
  assert.equal(parseLine('INFO:   Tunnel is up and running.').ready, true)
  assert.match(parseLine('ERROR:  Could not authenticate to gateway.').error, /authentication failed/)
  assert.match(parseLine(`ERROR:      --trusted-cert ${'ab'.repeat(32)}`).error, /(ab){32}/)
  assert.match(parseLine('ERROR:  Gateway certificate validation failed, and the certificate digest is not in the local whitelist. If you trust it, rerun with: ' + 'cd'.repeat(32)).error, /(cd){32}/)
})

test('forti: cookie extraction from a response head; redirects are errors', () => {
  assert.deepEqual(cookieFromHead('HTTP/1.1 200 OK\r\nSet-Cookie: SVPNCOOKIE=abc%3D123; path=/; secure'), { cookie: 'abc%3D123' })
  assert.match(cookieFromHead('HTTP/1.1 302 Found\r\nLocation: https://elsewhere.example/').error, /redirect/)
  assert.match(cookieFromHead('HTTP/1.1 200 OK\r\nSet-Cookie: other=1').error, /without an SVPNCOOKIE/)
  assert.match(cookieFromHead('HTTP/1.1 200 OK\r\nSet-Cookie: SVPNCOOKIE=0; path=/').error, /without an SVPNCOOKIE/)
})

// --- process management & state machine ------------------------------------

test('manager: connect → connected → disconnect; only the targets are routed', async () => {
  const h = await harness()
  const profile = await addProfile(h)
  assert.equal(h.manager.state, 'disconnected')
  const first = await h.manager.connect(profile.id)
  assert.equal(first.status, 'connecting')
  await until(() => h.manager.state === 'connected')
  const status = await h.manager.statusDocument()
  assert.equal(status.iface, 'ppp0')
  assert.equal(status.ip, '10.8.0.6')
  assert.deepEqual(status.routes, ['10.20.0.0/16', '10.20.30.40/32'])
  assert.deepEqual(h.sys.state.added, ['ip -4 route add 10.20.0.0/16 dev ppp0', 'ip -4 route add 10.20.30.40/32 dev ppp0'])
  assert.ok(!h.sys.state.added.some(cmd => /default|0\.0\.0\.0/.test(cmd)))
  await until(() => h.manager.statusDocument().then(s => s.watchdog.state === 'passed'))
  assert.ok(existsSync(join(h.dir, 'run.json')))
  const config = readdirSync(h.dir).filter(name => name.startsWith('run-'))
  assert.equal(config.length, 1)
  await assert.rejects(() => h.manager.connect(profile.id), /already connected/)
  const after = await h.manager.disconnect()
  assert.equal(after.status, 'disconnected')
  await until(() => !existsSync(join(h.dir, 'run.json')) && readdirSync(h.dir).every(name => !name.startsWith('run-')))
  assert.deepEqual((await h.manager.statusDocument()).routes, [])
})

test('manager: logs are capped at 200 and the password never appears', async () => {
  const h = await harness({ env: { FAKE_SECRET_ECHO: '1' } })
  const profile = await addProfile(h)
  await h.manager.connect(profile.id)
  await until(() => h.manager.state === 'connected')
  const text = JSON.stringify(h.manager.logLines())
  assert.ok(text.includes('credential'), 'the echo line should be present')
  assert.ok(!text.includes('S3cret-pass!'), text)
  assert.ok(text.includes('***'))
  for (let i = 0; i < 300; i++) h.manager.log('info', `line ${String(i)}`)
  assert.equal(h.manager.logLines().length, 200)
  assert.equal(h.manager.logLines(5).length, 5)
  await h.manager.disconnect()
})

test('manager: authentication failure → failed with a readable reason', async () => {
  const h = await harness({ env: { FAKE_MODE: 'authfail' } })
  const profile = await addProfile(h)
  await h.manager.connect(profile.id)
  await until(() => h.manager.state === 'failed')
  const status = await h.manager.statusDocument()
  assert.match(status.error, /authentication failed/)
  assert.deepEqual(h.sys.state.added, [])
  await h.manager.disconnect()
  assert.equal(h.manager.state, 'disconnected')
})

test('manager: an untrusted certificate reports the digest to trust', async () => {
  const h = await harness({ env: { FAKE_MODE: 'cert' } })
  const profile = await addProfile(h)
  await h.manager.connect(profile.id)
  await until(() => h.manager.state === 'failed')
  assert.match((await h.manager.statusDocument()).error, /certificate/)
})

test('manager: the process dying after connecting becomes failed and removes routes from the state', async () => {
  const h = await harness({ env: { FAKE_MODE: 'crash' } })
  const profile = await addProfile(h)
  await h.manager.connect(profile.id)
  await until(() => h.manager.state === 'failed')
  assert.deepEqual((await h.manager.statusDocument()).routes, [])
})

test('manager: a connection that never comes up times out', async () => {
  const h = await harness({ env: { FAKE_MODE: 'hang' }, connectTimeoutMs: 400 })
  const profile = await addProfile(h)
  await h.manager.connect(profile.id)
  await until(() => h.manager.state === 'failed', 3000)
  assert.match((await h.manager.statusDocument()).error, /timed out/)
  await h.manager.disconnect()
})

test('manager: route-add failure fails the attempt', async () => {
  const h = await harness()
  h.sys.state.failRouteAdd = true
  const profile = await addProfile(h)
  await h.manager.connect(profile.id)
  await until(() => h.manager.state === 'failed')
  assert.match((await h.manager.statusDocument()).error, /could not add route/)
})

test('watchdog: a changed default route trips it and tears the tunnel down', async () => {
  const h = await harness({ watchdogMs: 5000 })
  const profile = await addProfile(h)
  await h.manager.connect(profile.id)
  await until(() => h.manager.state === 'connected')
  h.sys.state.defaultRoute = 'default dev ppp0 scope link'
  await until(() => h.manager.state === 'failed')
  const status = await h.manager.statusDocument()
  assert.equal(status.watchdog.state, 'tripped')
  assert.match(status.watchdog.reason, /default route changed/)
  assert.match(status.error, /watchdog/)
})

test('watchdog: losing the local DSH port or the public probe trips it', async () => {
  const h = await harness({ watchdogMs: 5000 })
  const profile = await addProfile(h)
  await h.manager.connect(profile.id)
  await until(() => h.manager.state === 'connected')
  h.sys.state.tcpOk = false
  await until(() => h.manager.state === 'failed')
  assert.match((await h.manager.statusDocument()).watchdog.reason, /cannot reach/)
})

test('manager: refuses a profile whose targets would capture the gateway', async () => {
  const h = await harness()
  const profile = await addProfile(h, { targets: ['192.0.2.30/32'] })
  await h.manager.connect(profile.id)
  assert.equal(h.manager.state, 'failed')
  assert.match((await h.manager.statusDocument()).error, /would capture the default gateway/)
  assert.deepEqual(h.sys.state.added, [])
})

test('manager: a target host that does not resolve is an explicit error', async () => {
  const h = await harness()
  const profile = await addProfile(h, { targets: ['nx.corp.example'] })
  await h.manager.connect(profile.id)
  assert.equal(h.manager.state, 'failed')
  assert.match((await h.manager.statusDocument()).error, /cannot resolve target host/)
})

test('token-url: the cookie goes through stdin, never argv or logs', async () => {
  const h = await harness({ env: { FAKE_SECRET_ECHO: '1' } })
  const profile = await h.store.upsert(validateProfileInput({
    name: 'tok', type: 'token-url', secret: 'https://gw.corp.example:10443/remote/login?token=tok_ABC123', targets: ['10.20.0.0/16'],
  }, { allowCustom: false }))
  await h.manager.connect(profile.id)
  await until(() => h.manager.state === 'connected')
  const text = JSON.stringify(h.manager.logLines())
  assert.ok(text.includes('--cookie-on-stdin'), 'argv line is logged')
  for (const leak of ['COOKIEVALUE123456', 'tok_ABC123']) assert.ok(!text.includes(leak), `${leak} leaked`)
  await h.manager.disconnect()
})

test('token-url: a failing cookie exchange fails cleanly and names no token', async () => {
  const h = await harness({ cookie: async () => { throw new Error('the gateway answered HTTP 200 without an SVPNCOOKIE') } })
  const profile = await h.store.upsert(validateProfileInput({
    name: 'tok', type: 'token-url', secret: 'https://gw.corp.example/login?token=tok_ABC123', targets: ['10.20.0.0/16'],
  }, { allowCustom: false }))
  await h.manager.connect(profile.id)
  assert.equal(h.manager.state, 'failed')
  const status = await h.manager.statusDocument()
  assert.ok(!JSON.stringify(status).includes('tok_ABC123'))
})

test('custom command: {url} is substituted into argv, and the type is off by default', async () => {
  const h = await harness({ allowCustom: true, env: { FAKE_MODE: 'ok' } })
  const profile = await h.store.upsert(validateProfileInput({
    name: 'c', type: 'custom', command: [process.execPath, FAKE, '{url}'], secret: 'https://gw.corp.example/login?token=tok_CUSTOM', targets: ['10.20.0.0/16'],
  }, { allowCustom: true }))
  await h.manager.connect(profile.id)
  // The custom command here is "node fake {url}": the fake script sees the URL as an argument and logs argv;
  // that line must be redacted.
  await until(() => h.manager.state === 'connected')
  assert.ok(!JSON.stringify(h.manager.logLines()).includes('tok_CUSTOM'))
  await h.manager.disconnect()
  assert.throws(() => validateProfileInput({ name: 'c', type: 'custom', command: ['/bin/true'], targets: ['10.0.0.0/8'] }, { allowCustom: false }), /disabled/)
  assert.throws(() => validateProfileInput({ name: 'c', type: 'custom', command: ['relative'], targets: ['10.0.0.0/8'] }, { allowCustom: true }), ValidationError)
})

test('recover: a leftover child is stopped only when its command line matches', async () => {
  const h = await harness()
  const { writeFileSync } = await import('node:fs')
  const killed = []
  const realKill = process.kill
  process.kill = (pid, signal) => { if (pid === 424242) { killed.push(signal); return true } return realKill(pid, signal) }
  try {
    let alive = true
    const mgr = new VpnManager({
      ...h.manager.o,
      isAlive: () => alive,
      readCmdline: async () => '/usr/bin/openfortivpn -c /root/.dsh/vpn/run-1.conf',
    })
    writeFileSync(join(h.dir, 'run.json'), JSON.stringify({ pid: 424242, marker: 'openfortivpn' }))
    setTimeout(() => { alive = false }, 50)
    assert.match(await mgr.recover(), /stopped leftover openfortivpn/)
    assert.deepEqual(killed, ['SIGTERM'])
    assert.ok(!existsSync(join(h.dir, 'run.json')))
    // A pid reused by something else is left alone.
    writeFileSync(join(h.dir, 'run.json'), JSON.stringify({ pid: 424242, marker: 'openfortivpn' }))
    alive = true
    const other = new VpnManager({ ...h.manager.o, isAlive: () => true, readCmdline: async () => 'nginx: worker' })
    assert.match(await other.recover(), /left alone/)
    assert.deepEqual(killed, ['SIGTERM'])
    // Nothing leftover.
    assert.equal(await mgr.recover(), 'no leftover tunnel')
  } finally {
    process.kill = realKill
  }
})

test('install detection: a missing binary is reported with an install command', async () => {
  const h = await harness()
  const missing = new VpnManager({ ...h.manager.o, exe: [join(h.dir, 'no-such-binary')], exec: async () => ({ code: 127, stdout: '', stderr: 'not found' }) })
  const info = await missing.install(true)
  assert.equal(info.installed, false)
  assert.match(info.hint, /apt-get install -y openfortivpn/)
  const profile = await addProfile(h)
  const m2 = new VpnManager({ ...h.manager.o, exe: [join(h.dir, 'no-such-binary')], exec: h.manager.o.exec === undefined ? undefined : async (argv) => (argv[0] === 'ip' ? h.sys.exec(argv) : { code: 127, stdout: '', stderr: '' }) })
  await m2.connect(profile.id)
  assert.equal(m2.state, 'failed')
  assert.match((await m2.statusDocument()).error, /openfortivpn is not installed/)
})

// --- HTTP bridge -----------------------------------------------------------

/** Drive one route with a fake exchange. */
async function call(routes, method, path, body, headers = {}) {
  const route = routes.find(entry => entry.path === path.split('?')[0])
  assert.ok(route, `no route ${path}`)
  const { Readable } = await import('node:stream')
  const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Object.assign(Readable.from(raw), { method, url: path, headers: { host: 'x.test', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } })
  const out = { status: 0, headers: {}, text: '' }
  const res = {
    headersSent: false,
    writeHead(status, headers) { out.status = status; out.headers = headers; this.headersSent = true },
    end(text) { out.text = text ?? '' },
    destroy() {},
  }
  await route.handler(req, res)
  return { ...out, json: out.text === '' ? undefined : JSON.parse(out.text) }
}

test('bridge: full round trip, and no response ever contains a secret', async () => {
  const h = await harness()
  const routes = createRoutes({ logger, manager: h.manager, store: h.store, allowCustom: false })
  assert.deepEqual(routes.map(route => route.path), ['/api/vpn/status', '/api/vpn/profiles', '/api/vpn/profile', '/api/vpn/connect', '/api/vpn/disconnect', '/api/vpn/logs'])
  const put = await call(routes, 'PUT', '/api/vpn/profile', passwordBody())
  assert.equal(put.status, 200)
  const id = put.json.profile.id
  assert.equal(put.json.profile.secretConfigured, true)
  const everything = []
  everything.push((await call(routes, 'GET', '/api/vpn/profiles')).text)
  everything.push((await call(routes, 'GET', '/api/vpn/status')).text)
  const conn = await call(routes, 'POST', '/api/vpn/connect', { id })
  assert.equal(conn.status, 202)
  await until(() => h.manager.state === 'connected')
  everything.push((await call(routes, 'GET', '/api/vpn/status')).text)
  everything.push((await call(routes, 'GET', '/api/vpn/logs?limit=50')).text)
  assert.equal((await call(routes, 'POST', '/api/vpn/connect', { id })).status, 409)
  assert.equal((await call(routes, 'DELETE', `/api/vpn/profile?id=${id}`)).status, 409)
  const down = await call(routes, 'POST', '/api/vpn/disconnect', {})
  assert.equal(down.json.status, 'disconnected')
  for (const text of everything) assert.ok(!text.includes('S3cret-pass!'), text)
  assert.equal((await call(routes, 'DELETE', `/api/vpn/profile?id=${id}`)).status, 200)
  assert.deepEqual((await call(routes, 'GET', '/api/vpn/profiles')).json.profiles, [])
})

test('bridge: bad input is a 400 with the field; wrong method 405; wrong type 415; foreign origin 403', async () => {
  const h = await harness()
  const routes = createRoutes({ logger, manager: h.manager, store: h.store, allowCustom: false })
  const bad = await call(routes, 'PUT', '/api/vpn/profile', passwordBody({ targets: ['0.0.0.0/0'] }))
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.field, 'targets')
  assert.equal((await call(routes, 'PUT', '/api/vpn/profile', passwordBody({ targets: [] }))).status, 400)
  assert.equal((await call(routes, 'PUT', '/api/vpn/profile', passwordBody({ host: 'a\nb' }))).status, 400)
  assert.equal((await call(routes, 'POST', '/api/vpn/status')).status, 405)
  assert.equal((await call(routes, 'GET', '/api/vpn/connect')).status, 405)
  assert.equal((await call(routes, 'PUT', '/api/vpn/profile', passwordBody(), { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await call(routes, 'PUT', '/api/vpn/profile', passwordBody(), { origin: 'https://evil.example' })).status, 403)
  assert.equal((await call(routes, 'PUT', '/api/vpn/profile', passwordBody(), { origin: 'https://x.test' })).status, 200)
  assert.equal((await call(routes, 'POST', '/api/vpn/connect', { id: '../etc/passwd' })).status, 400)
  assert.equal((await call(routes, 'POST', '/api/vpn/connect', { id: 'p-deadbeef' })).status, 409)
  assert.equal((await call(routes, 'PUT', '/api/vpn/profile', '{not json')).status, 400)
  assert.equal((await call(routes, 'PUT', '/api/vpn/profile', { ...passwordBody({ name: 'zz' }), type: 'custom', command: ['/bin/x'] })).status, 400)
})

// --- plugin wiring ----------------------------------------------------------

test('plugin: registers only a read-only vpn_status tool and mounts the bridge', async () => {
  const dir = scratch()
  const tools = []
  const routes = []
  const disposers = []
  const ctx = {
    tools: { register: (def) => { tools.push(def); return () => {} } },
    logger,
    effect: (run) => { const d = run(); disposers.push(d) },
    inject: (_deps, cb) => cb({ webServer: { register: (route) => { routes.push(route.path); return () => {} } }, effect: (run) => { run() } }),
  }
  await apply(ctx, { dir, openfortivpn: [process.execPath, FAKE], recoverOnStart: false })
  assert.deepEqual(tools.map(tool => tool.name), ['vpn_status'])
  assert.deepEqual(tools[0].parameters.properties, {})
  assert.equal(routes.length, 6)
  const out = await tools[0].execute({}, { signal: new AbortController().signal })
  assert.match(out.text, /status: disconnected/)
  assert.match(out.text, /Only a person can connect/)
  assert.ok(!/password|token|cookie/i.test(out.text.replace(/Only a person[^\n]*/, '').replace(/never shows[^\n]*/, '')))
  if (process.platform !== 'win32') assert.equal(statSync(dir).mode & 0o777, 0o700)
  for (const d of disposers) if (typeof d === 'function') d()
})

test('describeStatus: no secret fields exist to leak', () => {
  const text = describeStatus({
    status: 'connected', profileName: 'corp', iface: 'ppp0', ip: '10.8.0.6', uptimeSeconds: 12, routes: ['10.0.0.0/8'],
    error: undefined, watchdog: { state: 'passed', secondsLeft: undefined, reason: undefined },
    install: { installed: true, version: '1.20.0', cookieSupport: true, pppd: true, hint: '' },
  })
  assert.match(text, /routed through the tunnel: 10.0.0.0\/8/)
})
