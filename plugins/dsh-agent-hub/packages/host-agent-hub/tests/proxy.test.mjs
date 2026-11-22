/**
 * HTTP proxy (CONNECT tunnel) for the hub client: pure helpers, the tunnel
 * with fake node:http / node:tls modules, and the hub client wired to them.
 * Nothing here opens a socket.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { resolveConfig } from '../hub-client.js'
import {
  TunnelError, buildConnectRequest, buildTlsOptions, isIpLiteral, openTunnel, parseProxyUrl, proxySetting, resolveProxy, scrubProxy, shouldBypass,
} from '../proxy.js'
import { CONTROLLER, TOKEN, assertNoToken, expectHubError, fakeLogger, makeClient } from './helpers.mjs'

const HUB = new URL('https://hub.example:7891/v1/ctl/agents?id=dsh-test')
const SECRET_USER = 'clashuser'
const SECRET_PASS = 'p@ss:w0rd!'
const AUTH_PROXY = `http://${SECRET_USER}:${encodeURIComponent(SECRET_PASS)}@127.0.0.1:7890`
const basic = Buffer.from(`${SECRET_USER}:${SECRET_PASS}`).toString('base64')

/** Proxy credentials appear nowhere in these values. */
function assertNoProxySecret(...values) {
  for (const value of values) {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    for (const secret of [SECRET_USER, SECRET_PASS, encodeURIComponent(SECRET_PASS), basic]) assert.ok(!String(text).includes(secret), `proxy secret leaked: ${String(text).slice(0, 200)}`)
  }
}

/**
 * Fake node:http + node:tls. `proxy` scenario: ok | refuse:<status> | response:<status> | down | hang.
 * `tls` scenario: ok | cert | hang.
 */
function fakeNet({ proxy = 'ok', tls = 'ok' } = {}) {
  const connects = []
  const handshakes = []
  const sockets = []
  const httpRequest = (options) => {
    const req = new EventEmitter()
    req.destroyed = false
    req.destroy = () => { req.destroyed = true }
    req.end = () => {
      connects.push({ options, line: `${options.method} ${options.path} HTTP/1.1` })
      setTimeout(() => {
        const sock = new EventEmitter()
        sock.destroyed = false
        sock.destroy = () => { sock.destroyed = true }
        sock.unshift = () => {}
        sockets.push(sock)
        if (proxy === 'ok') req.emit('connect', { statusCode: 200, statusMessage: 'Connection established' }, sock, Buffer.alloc(0))
        else if (proxy.startsWith('refuse:')) req.emit('connect', { statusCode: Number(proxy.slice(7)), statusMessage: `Nope ${SECRET_PASS}` }, sock, Buffer.alloc(0))
        else if (proxy.startsWith('response:')) req.emit('response', { statusCode: Number(proxy.slice(9)), statusMessage: 'Proxy Authentication Required', resume() {}, socket: sock })
        else if (proxy === 'down') { const e = new Error(`connect ECONNREFUSED 127.0.0.1:7890 ${SECRET_USER}`); e.code = 'ECONNREFUSED'; req.emit('error', e) }
      }, 0)
    }
    return req
  }
  const tlsConnect = (options) => {
    handshakes.push(options)
    const secure = new EventEmitter()
    secure.destroy = () => { secure.destroyed = true }
    secure.isFakeTls = true
    setTimeout(() => {
      if (tls === 'ok') secure.emit('secureConnect')
      else if (tls === 'cert') { const e = new Error('self signed'); e.code = 'DEPTH_ZERO_SELF_SIGNED_CERT'; secure.emit('error', e) }
    }, 0)
    return secure
  }
  return { deps: { httpRequest, tlsConnect }, connects, handshakes, sockets }
}

// --- pure helpers -------------------------------------------------------------

test('parseProxyUrl: http only, default port 80, credentials -> Basic, display is masked', () => {
  const plain = parseProxyUrl('http://127.0.0.1:7890')
  assert.deepEqual([plain.ok, plain.host, plain.port, plain.authority, plain.display, plain.authorization], [true, '127.0.0.1', 7890, '127.0.0.1:7890', 'http://127.0.0.1:7890', undefined])
  assert.equal(parseProxyUrl('127.0.0.1:7890').display, 'http://127.0.0.1:7890', 'a bare host:port means http://')
  assert.equal(parseProxyUrl('http://proxy.lan').port, 80)
  assert.equal(parseProxyUrl('http://[::1]:7890/').authority, '[::1]:7890')
  const auth = parseProxyUrl(AUTH_PROXY)
  assert.equal(auth.authorization, `Basic ${basic}`)
  assert.equal(auth.display, 'http://***@127.0.0.1:7890')
  for (const bad of ['https://127.0.0.1:7890', 'socks5://127.0.0.1:7891', 'http://127.0.0.1:7890/path', 'http://h:1/?q=1', '', 'http://', 'http://h:99999']) {
    const r = parseProxyUrl(bad)
    assert.equal(r.ok, false, bad)
    assert.equal(typeof r.problem, 'string')
  }
  const bad = parseProxyUrl(`socks5://${SECRET_USER}:${SECRET_PASS}@h:1`)
  assertNoProxySecret(bad.problem)
  assert.equal(scrubProxy(`x ${SECRET_PASS} ${basic} y`, auth), 'x *** *** y')
})

test('buildConnectRequest: CONNECT host:port, Host header, Proxy-Authorization only with credentials', () => {
  const plain = buildConnectRequest(parseProxyUrl('http://127.0.0.1:7890'), 'hub.example', 7891)
  assert.equal(`${plain.method} ${plain.path} HTTP/1.1`, 'CONNECT hub.example:7891 HTTP/1.1')
  assert.deepEqual([plain.host, plain.port, plain.agent], ['127.0.0.1', 7890, false])
  assert.equal(plain.headers.host, 'hub.example:7891')
  assert.equal('proxy-authorization' in plain.headers, false)
  const auth = buildConnectRequest(parseProxyUrl(AUTH_PROXY), '203.0.113.7', 7891, { timeoutMs: 5000 })
  assert.equal(auth.headers['proxy-authorization'], `Basic ${basic}`)
  assert.equal(auth.timeout, 5000)
  assert.equal(buildConnectRequest(parseProxyUrl('http://p:1'), '[2001:db8::1]', 7891).path, '[2001:db8::1]:7891')
})

test('buildTlsOptions: SNI only for names, hostname always checked, ca passed through', () => {
  const sock = {}
  const named = buildTlsOptions(sock, 'hub.example', { ca: 'PEM' })
  assert.deepEqual([named.socket, named.host, named.servername, named.ca, named.minVersion], [sock, 'hub.example', 'hub.example', 'PEM', 'TLSv1.2'])
  const ip = buildTlsOptions(sock, '203.0.113.7')
  assert.equal('servername' in ip, false, 'no IP in SNI')
  assert.equal(ip.host, '203.0.113.7', 'certificate still checked against the IP')
  assert.equal('ca' in ip, false)
  assert.equal(isIpLiteral('[::1]'), true)
  assert.equal(isIpLiteral('hub.example'), false)
})

test('shouldBypass: *, exact host, suffixes (.x / *.x / x), optional port, case and brackets', () => {
  assert.equal(shouldBypass('*', 'hub.example', 7891), true)
  assert.equal(shouldBypass('localhost,127.0.0.1', '127.0.0.1', 7891), true)
  assert.equal(shouldBypass('.example.com', 'hub.example.com', 7891), true)
  assert.equal(shouldBypass('.example.com', 'example.com', 7891), true)
  assert.equal(shouldBypass('example.com', 'hub.EXAMPLE.com', 7891), true)
  assert.equal(shouldBypass('*.example.com', 'a.b.example.com', 7891), true)
  assert.equal(shouldBypass('example.com', 'badexample.com', 7891), false, 'suffix match is per label')
  assert.equal(shouldBypass('hub.example:7891', 'hub.example', 7891), true)
  assert.equal(shouldBypass('hub.example:443', 'hub.example', 7891), false)
  assert.equal(shouldBypass(' a.lan , [::1] ', '::1', 7891), true)
  assert.equal(shouldBypass('', 'hub.example', 7891), false)
  assert.equal(shouldBypass(undefined, 'hub.example', 7891), false)
  assert.equal(shouldBypass('other.example', 'hub.example', 7891), false)
})

test('proxySetting / resolveProxy: off, explicit URL, env (order, NO_PROXY), http hubs never proxied', () => {
  for (const v of [undefined, null, false, '', 'off', 'OFF', 'direct']) assert.equal(proxySetting(v).mode, 'direct', String(v))
  assert.equal(proxySetting('env').mode, 'env')
  assert.equal(proxySetting('http://127.0.0.1:7890').mode, 'url')
  assert.equal(proxySetting('socks5://x:1').mode, 'invalid')
  assert.equal(proxySetting(42).mode, 'invalid')
  const env = { HTTPS_PROXY: 'http://10.0.0.1:3128', https_proxy: 'http://10.0.0.2:3128', HTTP_PROXY: 'http://10.0.0.3:3128' }
  assert.equal(resolveProxy(proxySetting('env'), HUB, env).proxy.display, 'http://10.0.0.1:3128')
  assert.equal(resolveProxy(proxySetting('env'), HUB, { https_proxy: 'http://10.0.0.2:3128', HTTP_PROXY: 'http://10.0.0.3:3128' }).proxy.display, 'http://10.0.0.2:3128')
  assert.equal(resolveProxy(proxySetting('env'), HUB, { HTTP_PROXY: 'http://10.0.0.3:3128' }).source, 'HTTP_PROXY')
  assert.equal(resolveProxy(proxySetting('env'), HUB, {}).proxy, undefined)
  const bypass = resolveProxy(proxySetting('env'), HUB, { ...env, NO_PROXY: 'localhost,.example' })
  assert.equal(bypass.proxy, undefined)
  assert.match(bypass.source, /NO_PROXY matches hub\.example/)
  assert.equal(resolveProxy(proxySetting('env'), HUB, { ...env, no_proxy: '*' }).proxy, undefined)
  assert.equal(resolveProxy(proxySetting('http://127.0.0.1:7890'), HUB, { NO_PROXY: '*' }).proxy.display, 'http://127.0.0.1:7890', 'an explicit proxy ignores NO_PROXY')
  assert.equal(resolveProxy(proxySetting('http://127.0.0.1:7890'), new URL('http://127.0.0.1:7891/v1/health'), {}).proxy, undefined, 'loopback http hub: direct')
  const broken = resolveProxy(proxySetting('env'), HUB, { HTTPS_PROXY: `socks5://${SECRET_USER}:${SECRET_PASS}@h:1` })
  assert.match(broken.problem, /^HTTPS_PROXY: proxy must be an http:\/\/ URL/)
  assertNoProxySecret(broken.problem)
})

// --- the tunnel ----------------------------------------------------------------

test('openTunnel: CONNECT through the proxy, then TLS over the returned socket', async () => {
  const net = fakeNet()
  const proxy = parseProxyUrl(AUTH_PROXY)
  const secure = await openTunnel({ proxy, target: HUB, timeoutMs: 1000, ca: 'PEM', deps: net.deps })
  assert.equal(secure.isFakeTls, true)
  assert.equal(net.connects.length, 1)
  assert.equal(net.connects[0].line, 'CONNECT hub.example:7891 HTTP/1.1')
  assert.equal(net.connects[0].options.headers['proxy-authorization'], `Basic ${basic}`)
  assert.equal(net.connects[0].options.timeout, undefined, 'no idle timeout left on the tunnel socket')
  assert.equal(net.handshakes[0].socket, net.sockets[0])
  assert.deepEqual([net.handshakes[0].servername, net.handshakes[0].ca], ['hub.example', 'PEM'])
})

test('openTunnel failures name the stage and never carry proxy credentials', async () => {
  const proxy = parseProxyUrl(AUTH_PROXY)
  const cases = [
    [{ proxy: 'down' }, 'proxy-connect', /cannot reach proxy http:\/\/\*\*\*@127\.0\.0\.1:7890 \(ECONNREFUSED\) - is Clash \/ mihomo running/],
    [{ proxy: 'refuse:403' }, 'proxy-refused', /refused CONNECT hub\.example:7891: HTTP 403/],
    [{ proxy: 'refuse:502' }, 'proxy-refused', /HTTP 502/],
    [{ proxy: 'response:407' }, 'proxy-refused', /HTTP 407 .*proxy authentication required/],
    [{ tls: 'cert' }, 'tls', /TLS to hub\.example:7891 through proxy .* failed \(DEPTH_ZERO_SELF_SIGNED_CERT\); set caFile/],
    [{ proxy: 'hang' }, 'timeout', /timed out after 60 ms waiting for proxy/],
    [{ tls: 'hang' }, 'timeout', /timed out after 60 ms waiting for TLS handshake/],
  ]
  for (const [scenario, stage, re] of cases) {
    const net = fakeNet(scenario)
    const error = await openTunnel({ proxy, target: HUB, timeoutMs: 60, deps: net.deps }).then(() => undefined, e => e)
    assert.ok(error instanceof TunnelError, `${JSON.stringify(scenario)}: ${error}`)
    assert.equal(error.stage, stage, JSON.stringify(scenario))
    assert.match(error.message, re)
    assertNoProxySecret(error.message, error.stack)
    if (scenario.proxy?.startsWith('refuse')) assert.equal(net.sockets[0].destroyed, true, 'refused tunnel socket is closed')
  }
})

// --- hub client over the proxy ---------------------------------------------------

test('hub client: proxy config is validated without echoing credentials; http hubs warn that it is ignored', () => {
  const ok = resolveConfig({ hubUrl: 'https://hub.example:7891', controllerId: 'dsh-local', proxy: AUTH_PROXY })
  assert.deepEqual([ok.ok, ok.proxyMode, ok.proxy], [true, 'url', 'http://***@127.0.0.1:7890'])
  assertNoProxySecret(ok)
  assert.equal(resolveConfig({ hubUrl: 'https://hub.example:7891', controllerId: 'dsh-local' }).proxyMode, 'direct', 'default: no proxy')
  const bad = resolveConfig({ hubUrl: 'https://hub.example:7891', controllerId: 'dsh-local', proxy: `https://${SECRET_USER}:${SECRET_PASS}@p:1` })
  assert.equal(bad.ok, false)
  assert.match(bad.problems.join(), /config\.proxy: proxy must be an http:\/\/ URL/)
  assertNoProxySecret(bad.problems)
  const loop = resolveConfig({ hubUrl: 'http://127.0.0.1:7891', controllerId: 'dsh-cloud', proxy: 'http://127.0.0.1:7890' })
  assert.equal(loop.ok, true)
  assert.match(loop.warnings.join(), /proxy is ignored: an http:\/\/ hubUrl is a loopback hub/)
})

test('hub client: every call goes through CONNECT + TLS and the request rides on that socket', async () => {
  const net = fakeNet()
  const logger = fakeLogger()
  const { client, calls } = makeClient(() => ({ body: { agents: [] } }), { proxy: AUTH_PROXY, tunnel: net.deps, logger, caFile: '/ca.pem', readCa: async () => 'PEM' })
  assert.deepEqual(client.route(), { via: 'http://***@127.0.0.1:7890', source: 'config.proxy' })
  await client.listAgents()
  await client.health()
  assert.equal(net.connects.length, 2, 'one tunnel per request')
  assert.ok(net.connects.every(c => c.line === 'CONNECT hub.example:7891 HTTP/1.1'))
  assert.equal(net.handshakes[0].ca, 'PEM')
  assert.equal(typeof calls[0].options.createConnection, 'function')
  assert.equal(calls[0].options.createConnection().isFakeTls, true)
  assert.equal(calls[0].headers['X-DSH-Token'], TOKEN, 'the token rides inside the TLS tunnel, as a header')
  assert.ok(net.connects.every(c => !JSON.stringify(c.options).includes(TOKEN)), 'the proxy never sees the token')
  assert.ok(logger.lines.some(l => l.startsWith('debug agent-hub: GET /v1/ctl/agents -> 200') && l.includes('via http://***@127.0.0.1:7890')))
  assertNoProxySecret(logger.lines)
  assert.equal(CONTROLLER, 'dsh-test')
})

test('hub client: tunnel failures are 503 hub-unreachable naming the stage, without credentials or token', async () => {
  for (const [scenario, re] of [
    [{ proxy: 'down' }, /via proxy http:\/\/\*\*\*@127\.0\.0\.1:7890: cannot reach proxy .*ECONNREFUSED/],
    [{ proxy: 'refuse:403' }, /refused CONNECT hub\.example:7891: HTTP 403/],
    [{ tls: 'cert' }, /TLS to hub\.example:7891 through proxy .*caFile/],
    [{ proxy: 'hang' }, /timed out after 1000 ms/],
  ]) {
    const net = fakeNet(scenario)
    const { client, calls } = makeClient(() => ({ body: {} }), { proxy: AUTH_PROXY, tunnel: net.deps, timeoutMs: 1000 })
    const error = await expectHubError(() => client.listAgents(), 503, 'hub-unreachable')
    assert.match(error.message, re)
    assert.match(error.message, /^hub unreachable \(https:\/\/hub\.example:7891\) via proxy/)
    assert.equal(calls.length, 0, 'no request without a tunnel')
    assertNoProxySecret(error.message, error.stack)
    assertNoToken(error.message, error.stack)
  }
})

test('hub client proxy: env re-reads HTTPS_PROXY / NO_PROXY per call; NO_PROXY hit or no proxy = direct', async () => {
  const net = fakeNet()
  const env = { DSH_HUB_TOKEN: TOKEN, HTTPS_PROXY: 'http://127.0.0.1:7890' }
  const { client, calls } = makeClient(() => ({ body: { agents: [] } }), { proxy: 'env', tunnel: net.deps, env })
  await client.listAgents()
  assert.equal(net.connects.length, 1)
  env.NO_PROXY = 'hub.example'
  await client.listAgents()
  assert.equal(net.connects.length, 1, 'bypassed')
  assert.equal(calls[1].options.createConnection, undefined)
  delete env.NO_PROXY
  env.HTTPS_PROXY = 'socks5://127.0.0.1:7891'
  const error = await expectHubError(() => client.listAgents(), 503, 'hub-not-configured')
  assert.match(error.message, /HTTPS_PROXY: proxy must be an http:\/\//)
  const direct = makeClient(() => ({ body: { agents: [] } }), { tunnel: net.deps })
  await direct.client.listAgents()
  assert.equal(direct.calls[0].options.createConnection, undefined, 'no proxy configured: direct')
  assert.deepEqual(direct.client.route(), { via: 'direct', source: 'direct' })
})
