/**
 * Shared helpers for the dsh-host-agent-hub tests (controller client of dsh-hub v2).
 *
 *   - fakeHub(): a fake `node:https` `request(url, options, onResponse)` that records
 *     every call (method, URL, headers, body) and answers from a handler, or fails
 *     like the network would (refused, TLS, socket timeout, hang);
 *   - makeClient(): a hub client wired to that fake, with a test token in a fake env;
 *   - fake logger, fake HTTP req/res for the admin routes, fake plugin ctx for index.js.
 *
 * Nothing here opens a socket or touches ~/.dsh.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { HubError, createHubClient } from '../hub-client.js'

export const HUB_URL = 'https://hub.example:7891'
export const CONTROLLER = 'dsh-test'
/** Test controller token. Every test that can leak checks this string is absent. */
export const TOKEN = 'dshc_dsh-test_S3cretTestTokenValue0123456789abcdef'
export const b64 = text => Buffer.from(text, 'utf8').toString('base64')

/** Logger that records `level message` lines. */
export function fakeLogger() {
  const lines = []
  const record = level => (...args) => { lines.push(`${level} ${args.join(' ')}`) }
  return { lines, info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') }
}

/**
 * Fake transport. `handler(call)` gets `{ method, url, path, query, headers, options, body, json }`
 * and returns a response spec:
 *   { status?: 200, body?: <JSON value>, raw?: string | Buffer, headers? }
 *   { networkError: 'ECONNREFUSED' }   emit 'error' with that code
 *   { socketTimeout: true }            emit 'timeout' (socket idle timeout)
 *   { hang: true }                     never answer (overall timer must fire)
 * `handler` may also be a map `{ 'GET /v1/ctl/tasks': spec | (call => spec) }`; unknown routes are 404.
 * Set `hub.throwSync = true` to make request() itself throw.
 */
export function fakeHub(handler = () => ({ body: {} })) {
  const calls = []
  const route = typeof handler === 'function'
    ? handler
    : (call) => {
        const entry = handler[`${call.method} ${call.path}`]
        if (entry === undefined) return { status: 404, body: { error: { code: 'not-found', message: `no route ${call.method} ${call.path}` } } }
        return typeof entry === 'function' ? entry(call) : entry
      }
  const hub = { calls, throwSync: false, request }
  function request(url, options, onResponse) {
    if (hub.throwSync) throw new Error('request() exploded')
    const req = new EventEmitter()
    const chunks = []
    req.destroyed = false
    req.write = (chunk) => { chunks.push(Buffer.from(chunk)) }
    req.destroy = () => { req.destroyed = true }
    req.end = () => {
      const body = chunks.length === 0 ? undefined : Buffer.concat(chunks).toString('utf8')
      const call = { method: options.method, url, path: url.pathname, query: url.searchParams, headers: options.headers, options, body, json: body === undefined ? undefined : JSON.parse(body) }
      calls.push(call)
      Promise.resolve().then(async () => {
        const spec = (await route(call)) ?? {}
        if (spec.hang) return
        if (spec.networkError) {
          const error = new Error(`connect ${spec.networkError} ${url.host}`)
          error.code = spec.networkError
          req.emit('error', error)
          return
        }
        if (spec.socketTimeout) { req.emit('timeout'); return }
        const payload = spec.raw !== undefined ? Buffer.from(spec.raw) : Buffer.from(JSON.stringify(spec.body ?? {}), 'utf8')
        const res = {
          statusCode: spec.status ?? 200,
          headers: { 'content-type': spec.raw !== undefined ? 'application/octet-stream' : 'application/json', ...spec.headers },
          destroy() {},
          async *[Symbol.asyncIterator]() { yield payload },
        }
        onResponse(res)
      })
    }
    return req
  }
  return hub
}

/**
 * In-memory `fs` for the .env lookup: `{ [path]: text | { text, mode, dir, error } }`.
 * Missing paths throw ENOENT, so no real file (~/.dsh/agent-hub/controller.env,
 * let alone DSH's own ~/.dsh/.env) is ever read by the tests.
 * The map stays live: tests may add, change or delete files between calls.
 */
export function fakeFs(files = {}) {
  const reads = []
  const entry = (path) => {
    if (!Object.hasOwn(files, path)) { const e = new Error(`ENOENT: ${path}`); e.code = 'ENOENT'; throw e }
    const value = files[path]
    return typeof value === 'string' ? { text: value, mode: 0o100600 } : value
  }
  return {
    files, reads,
    statSync(path) {
      const e = entry(path)
      if (e.error) { const err = new Error(`${e.error}: ${path}`); err.code = e.error; throw err }
      return { mode: e.mode ?? (e.dir ? 0o40755 : 0o100600), isFile: () => !e.dir }
    },
    readFileSync(path) { reads.push(path); return entry(path).text },
  }
}

/** A client against a fake hub. `env` defaults to a valid token, `fs` to an empty fake. */
export function makeClient(handler, options = {}) {
  const hub = fakeHub(handler)
  const logger = options.logger ?? fakeLogger()
  const env = options.env ?? { DSH_HUB_TOKEN: TOKEN }
  const fs = options.fs ?? fakeFs()
  const client = createHubClient({ hubUrl: HUB_URL, controllerId: CONTROLLER, request: hub.request, platform: 'linux', homedir: () => '/home/test', ...options, env, logger, fs })
  return { client, hub, calls: hub.calls, logger, env, fs }
}

/** Assert `run()` rejects with a HubError of the given status (and code). */
export async function expectHubError(run, status, code) {
  let caught
  await assert.rejects(async () => run(), (error) => {
    assert.ok(error instanceof HubError, `expected HubError, got ${error?.stack ?? error}`)
    assert.equal(error.status, status, `status of ${error.code}: ${error.message}`)
    if (code !== undefined) assert.equal(error.code, code, error.message)
    caught = error
    return true
  })
  return caught
}

/** Assert the test token appears nowhere in these values (strings, objects, log lines). */
export function assertNoToken(...values) {
  for (const value of values) {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    assert.ok(!String(text).includes(TOKEN), `token leaked into: ${String(text).slice(0, 200)}`)
    assert.ok(!String(text).includes(TOKEN.slice(14)), 'token secret part leaked')
  }
}

// --- fake HTTP --------------------------------------------------------------

const toBuffer = value => (Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'))

/**
 * Minimal IncomingMessage: method, url, lower-cased headers, socket, and an
 * async iterator over the body.
 */
export function fakeReq({ method = 'GET', url = '/', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  const chunks = body === undefined ? [] : Array.isArray(body) ? body.map(toBuffer) : [toBuffer(body)]
  return {
    method, url, headers: lower, socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}

/** Minimal ServerResponse that records status, headers and body. */
export function fakeRes() {
  const chunks = []
  return {
    statusCode: undefined,
    headers: {},
    ended: false,
    writeHead(status, headers = {}) {
      this.statusCode = status
      for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = value
      return this
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(toBuffer(chunk))
      this.ended = true
      return this
    },
    get body() { return Buffer.concat(chunks) },
    get text() { return this.body.toString('utf8') },
    json() { return JSON.parse(this.text) },
  }
}

/** Run one route handler against a fake request (url defaults to the route path). */
export async function callRoute(route, init = {}) {
  const res = fakeRes()
  await route.handler(fakeReq({ url: route.path, ...init }), res)
  assert.ok(res.ended, `${route.path} did not end the response`)
  return res
}

/** Find a route by path (never by index: other changes may add routes). */
export function findRoute(routes, path) {
  const route = routes.find(r => r.path === path)
  assert.ok(route, `route not mounted: ${path}`)
  return route
}

/** JSON content-type header (plus extras). */
export const jsonHeaders = (extra = {}) => ({ 'content-type': 'application/json', ...extra })

// --- fake plugin ctx --------------------------------------------------------

/**
 * Fake Harness ctx for `apply()`: tools.register, logger, effect (cleanups are
 * collected), inject(['webServer']) with webServer.register, and get('connection').
 */
export function fakeCtx({ connection, webServer } = {}) {
  const tools = new Map()
  const routes = []
  const cleanups = []
  const injected = []
  const logger = fakeLogger()
  const effect = (run) => {
    const dispose = run()
    if (typeof dispose === 'function') cleanups.push(dispose)
    return dispose
  }
  const server = webServer ?? {
    register(route) {
      routes.push(route)
      return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1) }
    },
  }
  const ctx = {
    logger,
    effect,
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    inject(deps, fn) { injected.push(deps); fn({ webServer: server, effect }) },
    get(name) { return name === 'connection' ? connection : undefined },
  }
  return {
    ctx, tools, routes, logger, cleanups, injected,
    dispose() { for (const cleanup of cleanups.splice(0).reverse()) cleanup() },
  }
}
