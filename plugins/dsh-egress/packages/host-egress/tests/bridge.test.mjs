/**
 * Bridge + probe + tool tests, driving the compiled plugin through a fake Cordis context.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createHttps } from 'node:https'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { apply } from '../lib/index.js'
import { EgressRuntime, PROBE_URL, loadUndici } from '../lib/dispatch.js'
import { EgressStore } from '../lib/store.js'
import { createRoutes } from '../lib/bridge.js'
import { CERT, KEY, httpCall, scratchDir, startConnectProxy, startSocks5, undiciPath } from './helpers.mjs'

const undici = loadUndici(undiciPath())
const scratches = []
after(() => { for (const s of scratches) s.remove() })

const PROVIDERS = new Map([['api.commandcode.ai', 'commandecode']])

/** Bridge served by a real node:http server over a runtime with a probe endpoint of our choosing. */
async function bridge({ probeUrl, directFetch } = {}) {
  const s = scratchDir(); scratches.push(s)
  const store = new EgressStore(join(s.dir, 'egress'))
  const runtime = new EgressRuntime({
    store, loadUndici: () => undici,
    directFetch: directFetch ?? (async () => new Response('203.0.113.9')),
    testing: { proxyLoopback: true, requestTls: { ca: CERT }, ...probeUrl === undefined ? {} : { probeUrl } },
    providers: PROVIDERS,
  })
  const routes = createRoutes({ logger: { info() {}, warn() {} }, runtime, hookActive: () => true, providers: PROVIDERS })
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    const route = routes.find(r => r.path === path)
    if (route === undefined) { res.writeHead(404).end(); return }
    void route.handler(req, res)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, store, runtime, dir: s.dir, close: async () => { runtime.dispose(); server.closeAllConnections?.(); await new Promise(r => server.close(r)) } }
}

const put = (b, path, body, headers) => httpCall(b.port, { method: 'PUT', path, body, headers })

test('GET state: lists direct + a default-bound row per configured provider; no exits yet', async () => {
  const b = await bridge()
  try {
    const { status, json } = await httpCall(b.port, { path: '/api/egress/state' })
    assert.equal(status, 200)
    assert.equal(json.apply.mode, 'instant')
    assert.equal(json.defaultExit, 'direct')
    assert.deepEqual(json.exits.map(e => e.id), ['direct'])
    assert.deepEqual(json.bindings.map(r => [r.host, r.provider, r.exit, r.source]), [['api.commandcode.ai', 'commandecode', 'direct', 'default']])
    assert.equal(json.probeEndpoint, 'https://ifconfig.me/ip')
  } finally { await b.close() }
})

test('PUT exit: create, never echoes the password; secret only in the 0600 file', async () => {
  const b = await bridge()
  try {
    const created = await put(b, '/api/egress/exit', { name: 'Tokyo', type: 'socks5h', host: 'Proxy.Example.com', port: 1080, username: 'alice', password: 'hunter2' })
    assert.equal(created.status, 200)
    const exit = created.json.exits.find(e => e.id === 'tokyo')
    assert.deepEqual({ type: exit.type, host: exit.host, port: exit.port, hasAuth: exit.hasAuth, url: exit.url }, { type: 'socks5', host: 'proxy.example.com', port: 1080, hasAuth: true, url: 'socks5://***:***@proxy.example.com:1080' })
    assert.ok(!created.text.includes('hunter2') && !created.text.includes('alice'), 'no credential in any response')
    const state = await httpCall(b.port, { path: '/api/egress/state' })
    assert.ok(!state.text.includes('hunter2') && !state.text.includes('alice'))
    const file = join(b.dir, 'egress', 'config.json')
    assert.ok(readFileSync(file, 'utf8').includes('hunter2'), 'the secret lives only in the 0600 file')
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600)
      assert.equal(statSync(join(b.dir, 'egress')).mode & 0o777, 0o700)
    }
    // edit without a password keeps the stored one
    const edited = await put(b, '/api/egress/exit', { id: 'tokyo', name: 'Tokyo 2', type: 'socks5', host: 'proxy.example.com', port: 1081 })
    assert.equal(edited.status, 200)
    assert.equal(b.store.snapshot().config.exits[0].auth.password, 'hunter2')
    const cleared = await put(b, '/api/egress/exit', { id: 'tokyo', name: 'Tokyo 2', type: 'socks5', host: 'proxy.example.com', port: 1081, clearAuth: true })
    assert.equal(cleared.json.exits.find(e => e.id === 'tokyo').hasAuth, false)
  } finally { await b.close() }
})

test('PUT exit: strict validation with stable codes; the number of exits is not capped at a small number', async () => {
  const b = await bridge()
  try {
    const base = { name: 'X', type: 'http', host: 'p.example.com', port: 3128 }
    const cases = [
      [{ ...base, host: 'p.example.com\nX-Evil: 1' }, 'bad-characters'],
      [{ ...base, host: 'p\0.com' }, 'bad-characters'],
      [{ ...base, host: 'http://p.com' }, 'bad-host'],
      [{ ...base, port: 0 }, 'bad-port'],
      [{ ...base, port: 70000 }, 'bad-port'],
      [{ ...base, type: 'ftp' }, 'bad-type'],
      [{ ...base, type: 'direct' }, 'bad-type'],
      [{ ...base, name: 'a\nb' }, 'bad-characters'],
      [{ ...base, username: 'u\r\nx', password: 'p' }, 'bad-characters'],
      [{ ...base, id: 'direct' }, 'bad-id'],
      [{ ...base, id: 'nope' }, 'not-found'],
    ]
    for (const [body, code] of cases) {
      const res = await put(b, '/api/egress/exit', body)
      assert.equal(res.status >= 400 && res.status < 500, true, JSON.stringify(body))
      assert.equal(res.json.error.code, code, JSON.stringify(body))
    }
    assert.equal((await put(b, '/api/egress/exit', 'not json')).status, 400)
    assert.equal((await httpCall(b.port, { method: 'PUT', path: '/api/egress/exit', body: JSON.stringify(base), headers: { 'content-type': 'text/plain' } })).status, 415)
    assert.equal((await put(b, '/api/egress/exit', base, { 'sec-fetch-site': 'cross-site' })).status, 403)
    assert.equal(b.store.snapshot().config.exits.length, 0, 'every rejected call left the store untouched')
    for (let i = 0; i < 25; i++) assert.equal((await put(b, '/api/egress/exit', { ...base, name: `Exit ${String(i)}`, port: 3000 + i })).status, 200)
    assert.equal(b.store.snapshot().config.exits.length, 25)
    assert.equal((await put(b, '/api/egress/exit', { ...base, name: 'exit 1' })).json.error.code, 'duplicate-name')
  } finally { await b.close() }
})

test('PUT binding + DELETE exit: in-use protection, default exit, unbinding', async () => {
  const b = await bridge()
  try {
    await put(b, '/api/egress/exit', { name: 'A', type: 'http', host: 'a.example.com', port: 8080 })
    const bound = await put(b, '/api/egress/binding', { host: 'API.CommandCode.ai', exit: 'a' })
    assert.equal(bound.status, 200)
    const row = bound.json.bindings.find(r => r.host === 'api.commandcode.ai')
    assert.deepEqual([row.exit, row.source], ['a', 'binding'])
    assert.equal((await put(b, '/api/egress/binding', { host: 'x.com', exit: 'missing' })).json.error.code, 'not-found')
    assert.equal((await put(b, '/api/egress/binding', { host: 'bad host', exit: 'a' })).json.error.code, 'bad-host')
    assert.equal((await put(b, '/api/egress/binding', { host: '*', exit: null })).status, 400)

    assert.equal((await httpCall(b.port, { method: 'DELETE', path: '/api/egress/exit?id=a' })).json.error.code, 'in-use')
    await put(b, '/api/egress/binding', { host: '*', exit: 'a' })
    assert.equal(b.store.snapshot().config.defaultExit, 'a')
    await put(b, '/api/egress/binding', { host: 'api.commandcode.ai', exit: null })
    assert.equal((await httpCall(b.port, { method: 'DELETE', path: '/api/egress/exit?id=a' })).json.error.code, 'in-use', 'still the default')
    await put(b, '/api/egress/binding', { host: '*', exit: 'direct' })
    const ok = await httpCall(b.port, { method: 'DELETE', path: '/api/egress/exit?id=a' })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.json.exits.map(e => e.id), ['direct'])
    assert.equal((await httpCall(b.port, { method: 'DELETE', path: '/api/egress/exit?id=a' })).status, 404)
    assert.equal((await httpCall(b.port, { method: 'DELETE', path: '/api/egress/exit?id=direct' })).json.error.code, 'bad-id')
    assert.equal((await httpCall(b.port, { method: 'POST', path: '/api/egress/state' })).status, 405)
  } finally { await b.close() }
})

test('probe: hits ONLY the fixed endpoint, through the chosen exit, and reports IP/latency', async () => {
  // A local HTTPS server stands in for the echo endpoint via the test seam; production uses PROBE_URL.
  const echoed = []
  const echo = createHttps({ cert: CERT, key: KEY }, (req, res) => { echoed.push(req.url); res.end('198.51.100.7\n') })
  await new Promise(r => echo.listen(0, '127.0.0.1', r))
  const proxy = await startConnectProxy()
  const b = await bridge({ probeUrl: `https://127.0.0.1:${echo.address().port}/ip` })
  try {
    await put(b, '/api/egress/exit', { name: 'P', type: 'http', host: '127.0.0.1', port: proxy.port })
    const res = await httpCall(b.port, { method: 'POST', path: '/api/egress/probe', body: { id: 'p' } })
    assert.equal(res.status, 200)
    assert.equal(res.json.result.ok, true)
    assert.equal(res.json.result.ip, '198.51.100.7')
    assert.equal(typeof res.json.result.ms, 'number')
    assert.deepEqual(proxy.state.tunnels, [`127.0.0.1:${echo.address().port}`], 'the probe really went through the proxy')
    assert.deepEqual(echoed, ['/ip'])
    assert.equal(res.json.state.exits.find(e => e.id === 'p').lastProbe.ip, '198.51.100.7', 'result is stored and shown in the list')

    // SSRF: extra fields are ignored, there is no way to name a URL.
    const sneaky = await httpCall(b.port, { method: 'POST', path: '/api/egress/probe', body: { id: 'p', url: 'http://169.254.169.254/latest/meta-data', host: '10.0.0.1' } })
    assert.equal(sneaky.status, 200)
    assert.deepEqual(echoed, ['/ip', '/ip'])
    assert.ok(proxy.state.tunnels.length >= 1 && proxy.state.tunnels.every(t => t === `127.0.0.1:${echo.address().port}`), 'only the fixed endpoint was ever tunnelled to (the second call may reuse the pooled tunnel)')
    assert.equal((await httpCall(b.port, { method: 'POST', path: '/api/egress/probe', body: { id: '../x' } })).json.error.code, 'bad-id')
    assert.equal((await httpCall(b.port, { method: 'POST', path: '/api/egress/probe', body: { id: 'nope' } })).status, 404)
    assert.equal(PROBE_URL, 'https://ifconfig.me/ip')
  } finally { await b.close(); await proxy.close(); echo.closeAllConnections?.(); await new Promise(r => echo.close(r)) }
})

test('probe: dead proxy -> ok:false with an error, no secret, no direct fallback', async () => {
  const hits = []
  const b = await bridge({ probeUrl: 'https://127.0.0.1:9/ip', directFetch: async (u) => { hits.push(String(u)); return new Response('1.2.3.4') } })
  try {
    await put(b, '/api/egress/exit', { name: 'Dead', type: 'http', host: '127.0.0.1', port: 9, username: 'u', password: 'pw-secret' })
    const res = await httpCall(b.port, { method: 'POST', path: '/api/egress/probe', body: { id: 'dead' } })
    assert.equal(res.json.result.ok, false)
    assert.ok(res.json.result.error.length > 0)
    assert.ok(!res.text.includes('pw-secret'))
    assert.equal(hits.length, 0)
    const direct = await httpCall(b.port, { method: 'POST', path: '/api/egress/probe', body: { id: 'direct' } })
    assert.equal(direct.json.result.ip, '1.2.3.4')
    assert.equal(hits.length, 1)
  } finally { await b.close() }
})

test('probe: socks5 exit works end to end', async () => {
  const echo = createHttps({ cert: CERT, key: KEY }, (req, res) => res.end('192.0.2.44'))
  await new Promise(r => echo.listen(0, '127.0.0.1', r))
  const socks = await startSocks5()
  const b = await bridge({ probeUrl: `https://127.0.0.1:${echo.address().port}/ip` })
  try {
    await put(b, '/api/egress/exit', { name: 'S', type: 'socks5', host: '127.0.0.1', port: socks.port })
    const res = await httpCall(b.port, { method: 'POST', path: '/api/egress/probe', body: { id: 's' } })
    assert.equal(res.json.result.ip, '192.0.2.44')
    assert.equal(socks.state.connects.length, 1)
  } finally { await b.close(); await socks.close(); echo.closeAllConnections?.(); await new Promise(r => echo.close(r)) }
})

test('ring log: keeps the newest 100, only host/exit/ok/error', async () => {
  const s = scratchDir(); scratches.push(s)
  const runtime = new EgressRuntime({ store: new EgressStore(s.dir), directFetch: async () => new Response('x'), loadUndici: () => undici })
  for (let i = 0; i < 130; i++) await runtime.fetch(`https://h${String(i % 7)}.example.test/v1/secret-path?key=SHOULD-NOT-APPEAR`, { headers: { authorization: 'Bearer SECRET' } })
  const recent = runtime.recent()
  assert.equal(recent.length, 100)
  assert.deepEqual(Object.keys(recent[0]).sort(), ['at', 'exit', 'exitName', 'host', 'ok'])
  const text = JSON.stringify(recent)
  assert.ok(!text.includes('SECRET') && !text.includes('secret-path') && !text.includes('SHOULD-NOT'))
  assert.equal(recent[0].host, 'h3.example.test') // request 129 -> 129 % 7
})

test('plugin: registers one read-only tool + the routes; tool output is redacted; the fetch hook blocks a bound dead exit', async () => {
  const s = scratchDir(); scratches.push(s)
  const saved = globalThis.fetch
  const tools = []; const routes = []
  const ctx = {
    tools: { register: (t) => { tools.push(t); return () => {} } },
    logger: { info() {}, warn() {} },
    effect: (run) => run(),
    inject: (_deps, cb) => cb({ ...ctx, webServer: { register: (r) => { routes.push(r); return () => {} } } }),
  }
  try {
    apply(ctx, { dataDir: join(s.dir, 'egress'), undiciPath: undiciPath(), providers: [{ name: 'commandecode', baseURL: 'https://api.commandcode.ai/provider/v1' }] })
    assert.deepEqual(tools.map(t => t.name), ['egress_status'])
    assert.deepEqual(tools[0].parameters.properties, {})
    assert.deepEqual(routes.map(r => r.path).sort(), ['/api/egress/binding', '/api/egress/exit', '/api/egress/probe', '/api/egress/state'])
    const store = new EgressStore(join(s.dir, 'egress'))
    await store.mutate((d) => { d.exits.push({ id: 'x', name: 'X', type: 'http', host: '127.0.0.1', port: 9, auth: { username: 'alice', password: 'hunter2' }, createdAt: '' }); d.bindings['api.commandcode.ai'] = 'x' })
    const out = await tools[0].execute({}, { signal: new AbortController().signal })
    assert.ok(!out.text.includes('hunter2') && !out.text.includes('alice'))
    assert.match(out.text, /api\.commandcode\.ai \[commandecode\] -> x/)
    assert.match(out.text, /http:\/\/\*\*\*:\*\*\*@127\.0\.0\.1:9/)
    assert.notEqual(globalThis.fetch, saved, 'fetch hook installed')
    await assert.rejects(globalThis.fetch('https://api.commandcode.ai/provider/v1/chat/completions', { method: 'POST', body: '{}' }), /Egress "X"/)
  } finally { globalThis.fetch = saved; delete globalThis[Symbol.for('dsh-egress.holder')] }
})
