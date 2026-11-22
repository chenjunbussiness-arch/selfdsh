/**
 * Shared helpers for the dsh-hub tests: temp dirs, a fake clock and logger,
 * a hub with two controllers, and fake HTTP req/res for the handler.
 *
 * Every test gets its own mkdtemp directory and an injected clock, so nothing
 * touches ~/.dsh and lease / TTL tests never sleep (long-poll tests use short
 * real waits).
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHub, HubError } from '../lib/hub.js'

/** Fixed start time for the fake clock: 2026-01-01T00:00:00.000Z. */
export const T0 = Date.parse('2026-01-01T00:00:00.000Z')
export const iso = ms => new Date(ms).toISOString()
export const b64 = text => Buffer.from(text, 'utf8').toString('base64')
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The two controllers every test hub has. CTL is the default creator. */
export const CTL = 'dsh-cloud'
export const CTL2 = 'dsh-local'

/** A fresh temp directory removed after the test. */
export async function tempDir(t, prefix = 'dsh-hub-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Manually driven clock: `clock()` is the hub's `Date.now`. */
export function fakeClock(start = T0) {
  let now = start
  const clock = () => now
  clock.advance = (ms) => { now += ms; return now }
  clock.set = (ms) => { now = ms; return now }
  return clock
}

/** Logger that records `level message` lines. */
export function fakeLogger() {
  const lines = []
  const record = level => (...args) => { lines.push(`${level} ${args.join(' ')}`) }
  return { lines, info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') }
}

/** A hub on a temp dir with a fake clock and logger, plus controllers CTL and CTL2. */
export async function makeHub(t, options = {}) {
  const dataDir = options.dataDir ?? await tempDir(t)
  const clock = options.clock ?? fakeClock()
  const logger = options.logger ?? fakeLogger()
  const hub = new AgentHub({ ...options, dataDir, clock, logger })
  const ctl = await hub.addController(CTL)
  const ctl2 = await hub.addController(CTL2)
  t.after(() => hub.close())
  return { hub, dataDir, clock, logger, ctlToken: ctl.token, ctl2Token: ctl2.token }
}

/** CTL provisions a worker; returns `{ token, agent }`. */
export function provision(hub, agentId, extra = {}, by = CTL) {
  return hub.provisionAgent(by, { agent_id: agentId, platform: 'custom', ...extra })
}

/** CTL dispatches a minimal valid task (default target: worker `worker`). */
export function dispatchTask(hub, extra = {}, by = CTL) {
  return hub.dispatch(by, { title: 'Task', instruction: 'Do the thing.', agent: 'worker', ...extra })
}

/**
 * Assert `run()` fails with a HubError of the given status (and code).
 * `run` is wrapped in an async function, so synchronous validation throws are
 * caught the same way.
 */
export async function expectHubError(run, status, code) {
  await assert.rejects(async () => run(), (error) => {
    assert.ok(error instanceof HubError, `expected HubError, got ${error?.stack ?? error}`)
    assert.equal(error.status, status, `status of ${error.code}: ${error.message}`)
    if (code !== undefined) assert.equal(error.code, code, error.message)
    return true
  })
}

/** Minimal AbortSignal stand-in (the hub only needs aborted + add/removeEventListener). */
export function fakeSignal() {
  const listeners = new Set()
  return {
    aborted: false,
    addEventListener(_type, fn) { listeners.add(fn) },
    removeEventListener(_type, fn) { listeners.delete(fn) },
    abort() { this.aborted = true; for (const fn of [...listeners]) fn() },
    get listenerCount() { return listeners.size },
  }
}

// --- fake HTTP --------------------------------------------------------------

const toBuffer = value => (Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'))

/**
 * Minimal IncomingMessage: method, url, lower-cased headers, socket, and an
 * async iterator over the body. `body` may be an object (JSON), a string, a
 * Buffer, or an array of chunks.
 */
export function fakeReq({ method = 'GET', url = '/', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  const chunks = body === undefined ? [] : Array.isArray(body) ? body.map(toBuffer) : [toBuffer(body)]
  return {
    method, url, headers: lower, socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}

/** Minimal ServerResponse (an EventEmitter) that records status, headers and body. */
export function fakeRes() {
  const chunks = []
  const res = new EventEmitter()
  Object.assign(res, {
    statusCode: undefined,
    headers: {},
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    writeHead(status, headers = {}) {
      this.statusCode = status
      this.headersSent = true
      for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = value
      return this
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(toBuffer(chunk))
      this.writableEnded = true
      this.writableFinished = true
      this.emit('finish')
      this.emit('close')
      return this
    },
    /** The client goes away before the response is finished. */
    destroy() { this.destroyed = true; this.emit('close'); return this },
  })
  Object.defineProperty(res, 'body', { get: () => Buffer.concat(chunks) })
  Object.defineProperty(res, 'text', { get: () => Buffer.concat(chunks).toString('utf8') })
  res.json = () => JSON.parse(res.text)
  return res
}

/** Run the handler on one fake request. `res` may be passed in to destroy it mid-flight. */
export async function callHttp(handler, init = {}, res = fakeRes()) {
  await handler(fakeReq(init), res)
  return res
}

/** JSON content-type header (plus extras). */
export const jsonHeaders = (extra = {}) => ({ 'content-type': 'application/json', ...extra })
