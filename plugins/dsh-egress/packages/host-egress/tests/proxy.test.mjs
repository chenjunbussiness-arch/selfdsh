/**
 * Real local proxy behaviour: a CONNECT proxy, a SOCKS5 server and an HTTPS
 * target on loopback. Nothing is mocked on the network side.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { after, test } from 'node:test'
import { createServer as createHttps } from 'node:https'

import { EgressRuntime, EgressError, installHook, loadUndici } from '../lib/dispatch.js'
import { EgressStore } from '../lib/store.js'
import { CERT, KEY, closedPort, scratchDir, startConnectProxy, startSocks5, startTarget, undiciPath } from './helpers.mjs'

const scratches = []
const newStore = () => { const s = scratchDir(); scratches.push(s); return new EgressStore(s.dir) }
after(() => { for (const s of scratches) s.remove() })

const undici = loadUndici(undiciPath())

/** A runtime whose `direct` fetch is a spy that must never be called when a proxy is chosen. */
function makeRuntime(store) {
  const calls = []
  const directFetch = async (input) => { calls.push(String(input)); return new Response('DIRECT', { status: 200 }) }
  const runtime = new EgressRuntime({
    store, directFetch, loadUndici: () => undici,
    testing: { proxyLoopback: true, requestTls: { ca: CERT } },
  })
  return { runtime, calls }
}

const addExit = (store, exit) => store.mutate((d) => { d.exits.push({ createdAt: new Date().toISOString(), ...exit }) })
const bindHost = (store, host, id) => store.mutate((d) => { d.bindings[host] = id })

test('http proxy: request really goes through the CONNECT proxy', async () => {
  const [target, proxy] = [await startTarget(), await startConnectProxy()]
  try {
    const store = newStore()
    await addExit(store, { id: 'hp', name: 'HP', type: 'http', host: '127.0.0.1', port: proxy.port })
    await bindHost(store, '127.0.0.1', 'hp')
    const { runtime, calls } = makeRuntime(store)
    const response = await runtime.fetch(`https://127.0.0.1:${target.port}/x`)
    assert.equal(await response.text(), 'target-ok')
    assert.deepEqual(proxy.state.tunnels, [`127.0.0.1:${target.port}`])
    assert.equal(calls.length, 0, 'direct fetch must not be used')
    assert.equal(runtime.recent()[0].exit, 'hp')
    assert.equal(runtime.recent()[0].ok, true)
    runtime.dispose()
  } finally { await proxy.close(); await target.close() }
})

test('http proxy with auth: credentials are sent; wrong ones fail closed without leaking', async () => {
  const auth = { username: 'alice', password: 'hunter2' }
  const [target, proxy] = [await startTarget(), await startConnectProxy({ auth })]
  try {
    const store = newStore()
    await addExit(store, { id: 'ok', name: 'OK', type: 'http', host: '127.0.0.1', port: proxy.port, auth })
    await addExit(store, { id: 'wrong', name: 'Wrong', type: 'http', host: '127.0.0.1', port: proxy.port, auth: { username: 'alice', password: 'nope-nope' } })
    await bindHost(store, '127.0.0.1', 'ok')
    const { runtime, calls } = makeRuntime(store)
    assert.equal(await (await runtime.fetch(`https://127.0.0.1:${target.port}/`)).text(), 'target-ok')
    await bindHost(store, '127.0.0.1', 'wrong')
    await assert.rejects(runtime.fetch(`https://127.0.0.1:${target.port}/`), (error) => {
      assert.ok(error instanceof EgressError)
      assert.ok(!error.message.includes('nope-nope') && !error.message.includes('hunter2'), 'no secret in the error')
      assert.match(error.message, /Wrong/)
      return true
    })
    assert.equal(proxy.state.rejected >= 1, true)
    assert.equal(calls.length, 0)
    runtime.dispose()
  } finally { await proxy.close(); await target.close() }
})

test('FAIL-CLOSED: proxy goes away -> request errors, target never reached, no direct fallback', async () => {
  const [target, proxy] = [await startTarget(), await startConnectProxy()]
  const store = newStore()
  await addExit(store, { id: 'hp', name: 'HP', type: 'http', host: '127.0.0.1', port: proxy.port })
  await bindHost(store, '127.0.0.1', 'hp')
  const { runtime, calls } = makeRuntime(store)
  try {
    assert.equal(await (await runtime.fetch(`https://127.0.0.1:${target.port}/`)).text(), 'target-ok')
    assert.equal(target.hits.count, 1)
    await proxy.close()
    runtime.dispose() // drop pooled sockets so the next request must reconnect to the dead proxy
    await assert.rejects(runtime.fetch(`https://127.0.0.1:${target.port}/`), (error) => {
      assert.ok(error instanceof EgressError, String(error))
      assert.match(error.message, /could not carry the connection/)
      assert.match(error.message, /not retried directly/)
      // The message must be the root of the chain: DSH shows the deepest cause, so a raw network error
      // attached as `cause` would hide "not retried directly" from the user.
      assert.equal(error.cause, undefined)
      return true
    })
    assert.equal(target.hits.count, 1, 'the target must not have been contacted directly')
    assert.equal(calls.length, 0)
    assert.equal(runtime.recent()[0].ok, false)
  } finally { await target.close() }
})

test('FAIL-CLOSED: never-open proxy port', async () => {
  const target = await startTarget()
  try {
    const store = newStore()
    await addExit(store, { id: 'dead', name: 'Dead', type: 'http', host: '127.0.0.1', port: await closedPort() })
    await bindHost(store, '127.0.0.1', 'dead')
    const { runtime, calls } = makeRuntime(store)
    await assert.rejects(runtime.fetch(`https://127.0.0.1:${target.port}/`), EgressError)
    assert.equal(target.hits.count, 0)
    assert.equal(calls.length, 0)
    runtime.dispose()
  } finally { await target.close() }
})

test('FAIL-CLOSED: binding to a missing exit, corrupt config, and undici missing all block', async () => {
  const target = await startTarget()
  try {
    const store = newStore()
    mkdirSync(store.dir, { recursive: true })
    writeFileSync(store.file, JSON.stringify({ version: 1, exits: [], bindings: { '127.0.0.1': 'ghost' }, defaultExit: 'direct', probes: {} }))
    const { runtime, calls } = makeRuntime(store)
    await assert.rejects(runtime.fetch(`https://127.0.0.1:${target.port}/`), /does not exist/)

    await new Promise(r => setTimeout(r, 20))
    writeFileSync(store.file, '{ not json -- corrupt')
    await assert.rejects(runtime.fetch(`https://127.0.0.1:${target.port}/`), /unreadable/)

    await new Promise(r => setTimeout(r, 20))
    writeFileSync(store.file, JSON.stringify({ version: 1, exits: [{ id: 'hp', name: 'HP', type: 'http', host: '127.0.0.1', port: 9 }], bindings: { '127.0.0.1': 'hp' }, defaultExit: 'direct', probes: {} }))
    const noUndici = new EgressRuntime({
      store, directFetch: async (i) => { calls.push(String(i)); return new Response('DIRECT') },
      loadUndici: () => { throw new Error('Cannot find module undici') },
      testing: { proxyLoopback: true },
    })
    await assert.rejects(noUndici.fetch(`https://127.0.0.1:${target.port}/`), /undici is not available/)
    assert.equal(target.hits.count, 0)
    assert.equal(calls.length, 0, 'none of the failure modes may reach the direct fetch')
  } finally { await target.close() }
})

test('socks5 (no auth): the host name is handed to the proxy (socks5h)', async () => {
  const [target, socks] = [await startTarget(), await startSocks5()]
  try {
    const store = newStore()
    await addExit(store, { id: 's5', name: 'S5', type: 'socks5', host: '127.0.0.1', port: socks.port })
    await bindHost(store, 'localhost', 's5')
    const { runtime, calls } = makeRuntime(store)
    const response = await runtime.fetch(`https://localhost:${target.port}/`)
    assert.equal(await response.text(), 'target-ok')
    assert.equal(socks.state.connects.length, 1)
    assert.equal(socks.state.connects[0].host, 'localhost', 'the proxy, not this process, resolves the name')
    assert.equal(socks.state.connects[0].port, target.port)
    assert.equal(calls.length, 0)
    runtime.dispose()
  } finally { await socks.close(); await target.close() }
})

test('socks5 with user/password, and fail-closed when the socks server stops', async () => {
  const auth = { username: 'bob', password: 's3cret-pw' }
  const [target, socks] = [await startTarget(), await startSocks5({ auth })]
  const store = newStore()
  await addExit(store, { id: 's5', name: 'S5', type: 'socks5', host: '127.0.0.1', port: socks.port, auth })
  await addExit(store, { id: 's5bad', name: 'S5bad', type: 'socks5', host: '127.0.0.1', port: socks.port, auth: { username: 'bob', password: 'wrong-pw' } })
  await bindHost(store, '127.0.0.1', 's5')
  const { runtime, calls } = makeRuntime(store)
  try {
    assert.equal(await (await runtime.fetch(`https://127.0.0.1:${target.port}/`)).text(), 'target-ok')
    await bindHost(store, '127.0.0.1', 's5bad')
    await assert.rejects(runtime.fetch(`https://127.0.0.1:${target.port}/`), (e) => e instanceof EgressError && !e.message.includes('wrong-pw'))
    await bindHost(store, '127.0.0.1', 's5')
    await socks.close()
    runtime.dispose()
    const hitsBefore = target.hits.count
    await assert.rejects(runtime.fetch(`https://127.0.0.1:${target.port}/`), EgressError)
    assert.equal(target.hits.count, hitsBefore)
    assert.equal(calls.length, 0)
  } finally { await target.close() }
})

test('per-host routing and instant switching: two hosts, two exits, binding changed between requests', async () => {
  const [target, p1, p2] = [await startTarget(), await startConnectProxy(), await startConnectProxy()]
  try {
    const store = newStore()
    await addExit(store, { id: 'one', name: 'One', type: 'http', host: '127.0.0.1', port: p1.port })
    await addExit(store, { id: 'two', name: 'Two', type: 'http', host: '127.0.0.1', port: p2.port })
    await bindHost(store, '127.0.0.1', 'one')
    await bindHost(store, 'localhost', 'two')
    const { runtime } = makeRuntime(store)
    await (await runtime.fetch(`https://127.0.0.1:${target.port}/`)).text()
    await (await runtime.fetch(`https://localhost:${target.port}/`)).text()
    assert.equal(p1.state.tunnels.length, 1)
    assert.equal(p2.state.tunnels.length, 1)
    await bindHost(store, '127.0.0.1', 'two') // switch without restarting anything
    await (await runtime.fetch(`https://127.0.0.1:${target.port}/`)).text()
    assert.equal(p1.state.tunnels.length, 1)
    assert.equal(p2.state.tunnels.length, 2)
    runtime.dispose()
  } finally { await p1.close(); await p2.close(); await target.close() }
})

test('direct exit and loopback pass straight through; default exit applies to unbound hosts', async () => {
  const store = newStore()
  const calls = []
  const runtime = new EgressRuntime({ store, directFetch: async (i) => { calls.push(String(i)); return new Response('DIRECT') }, loadUndici: () => undici })
  await store.mutate((d) => { d.exits.push({ id: 'dead', name: 'Dead', type: 'http', host: '127.0.0.1', port: 9, createdAt: '' }); d.defaultExit = 'dead' })
  // loopback is never proxied, even with a failing default exit
  assert.equal(await (await runtime.fetch('http://127.0.0.1:1/x')).text(), 'DIRECT')
  assert.equal(await (await runtime.fetch('http://localhost:1/x')).text(), 'DIRECT')
  // a non-loopback host follows the (dead) default -> blocked or failed, never direct
  await assert.rejects(runtime.fetch('https://api.example.test/v1'), EgressError)
  assert.equal(calls.length, 2)
  // explicit direct binding is the user's choice
  await store.mutate((d) => { d.bindings['api.example.test'] = 'direct' })
  assert.equal(await (await runtime.fetch('https://api.example.test/v1')).text(), 'DIRECT')
  // non-http URLs are not ours
  assert.equal(await (await runtime.fetch('data:text/plain,hi')).text(), 'DIRECT')
  runtime.dispose()
})

test('aborting a request passes the AbortError through untouched', async () => {
  const [target, proxy] = [await startTarget(), await startConnectProxy()]
  try {
    const store = newStore()
    await addExit(store, { id: 'hp', name: 'HP', type: 'http', host: '127.0.0.1', port: proxy.port })
    await bindHost(store, '127.0.0.1', 'hp')
    const { runtime } = makeRuntime(store)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(runtime.fetch(`https://127.0.0.1:${target.port}/`, { signal: controller.signal }), (e) => !(e instanceof EgressError))
    runtime.dispose()
  } finally { await proxy.close(); await target.close() }
})

test('POST body and headers survive the proxy path, including a Request object', async () => {
  const seen = {}
  const server = createHttps({ cert: CERT, key: KEY }, (req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => { seen.body = Buffer.concat(chunks).toString(); seen.auth = req.headers.authorization; seen.method = req.method; res.end('echo') })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const proxy = await startConnectProxy()
  try {
    const store = newStore()
    await addExit(store, { id: 'hp', name: 'HP', type: 'http', host: '127.0.0.1', port: proxy.port })
    await bindHost(store, '127.0.0.1', 'hp')
    const { runtime } = makeRuntime(store)
    const url = `https://127.0.0.1:${server.address().port}/v1/chat`
    await (await runtime.fetch(url, { method: 'POST', headers: { authorization: 'Bearer k', 'content-type': 'application/json' }, body: '{"a":1}' })).text()
    assert.deepEqual(seen, { body: '{"a":1}', auth: 'Bearer k', method: 'POST' })
    await (await runtime.fetch(new Request(url, { method: 'POST', headers: { authorization: 'Bearer r' }, body: 'req-body' }))).text()
    assert.deepEqual(seen, { body: 'req-body', auth: 'Bearer r', method: 'POST' })
    runtime.dispose()
  } finally { await proxy.close(); server.closeAllConnections?.(); await new Promise(r => server.close(r)) }
})

test('installHook replaces globalThis.fetch once, survives reload without chaining, and keeps the original', async () => {
  const saved = globalThis.fetch
  const marker = async () => new Response('orig')
  globalThis.fetch = marker
  try {
    const store = newStore()
    const first = installHook(original => new EgressRuntime({ store, directFetch: original, loadUndici: () => undici }))
    const hooked = globalThis.fetch
    assert.notEqual(hooked, marker)
    assert.equal(first.isActive(), true)
    const second = installHook(original => new EgressRuntime({ store, directFetch: original, loadUndici: () => undici }))
    assert.equal(globalThis.fetch, hooked, 'reload keeps the same function')
    assert.equal(await (await globalThis.fetch('http://127.0.0.1:1/')).text(), 'orig', 'direct goes to the ORIGINAL fetch, not to itself')
    assert.equal(second.isActive(), true)
    globalThis.fetch = async () => new Response('someone else')
    assert.equal(second.isActive(), false, 'hook reports when it was overwritten')
  } finally { globalThis.fetch = saved; delete globalThis[Symbol.for('dsh-egress.holder')] }
})
