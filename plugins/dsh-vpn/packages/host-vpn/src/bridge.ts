/**
 * The HTTP bridge between the VPN manager and the Web page.
 *
 *   GET    /api/vpn/status                 state, install info, watchdog
 *   GET    /api/vpn/profiles               profiles without any secret
 *   PUT    /api/vpn/profile                create (no id) or update (id) one profile
 *   DELETE /api/vpn/profile?id=<id>        delete a profile and its secret
 *   POST   /api/vpn/connect   {id}         start connecting (only a person does this)
 *   POST   /api/vpn/disconnect             stop the tunnel
 *   GET    /api/vpn/logs?limit=<n>         newest redacted log lines
 *
 * Trust model: the routes are served by the Harness web server behind nginx
 * Basic auth. On top of that, every write requires `application/json` (a browser
 * must preflight a cross-origin request) and, when the browser sends an `Origin`
 * header, that origin's host must be the host the request was addressed to.
 *
 * No response carries a secret: profiles expose `secretConfigured` only, and
 * log lines are redacted when they are written.
 *
 * @module host-vpn/bridge
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { ConflictError } from './manager.ts'
import type { VpnManager } from './manager.ts'
import { NotFoundError } from './store.ts'
import type { ProfileStore } from './store.ts'
import type { LoggerService, WebRouteLike } from './types.ts'
import { PROFILE_ID, ValidationError, validateProfileInput } from './validate.ts'

/** Path prefix every route lives under. */
export const BRIDGE_BASE = '/api/vpn'
export const STATUS_PATH = `${BRIDGE_BASE}/status`
export const PROFILES_PATH = `${BRIDGE_BASE}/profiles`
export const PROFILE_PATH = `${BRIDGE_BASE}/profile`
export const CONNECT_PATH = `${BRIDGE_BASE}/connect`
export const DISCONNECT_PATH = `${BRIDGE_BASE}/disconnect`
export const LOGS_PATH = `${BRIDGE_BASE}/logs`

/** Request body ceiling. */
const MAX_BODY_BYTES = 32 * 1024

/** A failed call: HTTP status plus a stable code. */
export class BridgeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly field?: string) {
    super(message)
    this.name = 'BridgeError'
  }
}

/** What the routes act on. */
export interface BridgeDeps {
  readonly logger: LoggerService
  readonly manager: VpnManager
  readonly store: ProfileStore
  readonly allowCustom: boolean
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.writeHead(405, { allow, 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: { code: 'method-not-allowed', message: `use ${allow}` } }))
}

/** Reject a write whose Origin names another host. */
function checkOrigin(req: IncomingMessage): void {
  const origin = req.headers['origin']
  if (typeof origin !== 'string' || origin === '' || origin === 'null') {
    if (origin === 'null') throw new BridgeError(403, 'forbidden-origin', 'opaque origin')
    return
  }
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    throw new BridgeError(403, 'forbidden-origin', 'unparseable origin')
  }
  const target = req.headers['x-forwarded-host'] ?? req.headers['host']
  const wanted = (Array.isArray(target) ? target[0] : target)?.split(',')[0]?.trim()
  if (wanted === undefined || wanted.toLowerCase() !== host.toLowerCase()) {
    throw new BridgeError(403, 'forbidden-origin', 'the request origin does not match this host')
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const essence = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
  if (essence !== 'application/json') throw new BridgeError(415, 'unsupported-media-type', 'content-type must be application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new BridgeError(413, 'body-too-large', `request body exceeds ${String(MAX_BODY_BYTES)} bytes`)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') throw new BridgeError(400, 'bad-request', 'request body is empty')
  try {
    return JSON.parse(text)
  } catch {
    throw new BridgeError(400, 'bad-request', 'request body is not JSON')
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://localhost').searchParams
}

function guard(
  deps: BridgeDeps,
  label: string,
  run: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      await run(req, res)
    } catch (error) {
      let failure: BridgeError
      if (error instanceof BridgeError) failure = error
      else if (error instanceof ValidationError) failure = new BridgeError(400, 'invalid', error.message, error.field)
      else if (error instanceof NotFoundError) failure = new BridgeError(404, 'not-found', error.message)
      else if (error instanceof ConflictError) failure = new BridgeError(409, 'conflict', error.message)
      else {
        failure = new BridgeError(500, 'internal', 'internal error')
        // The message could quote a path or a command; the log is redacted at source, this one is not.
        deps.logger.warn(`host-vpn: ${label} failed: ${error instanceof Error ? error.name : 'error'}`)
      }
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendJson(res, failure.status, { error: { code: failure.code, message: failure.message, ...failure.field === undefined ? {} : { field: failure.field } } })
    }
  }
}

/** Build the routes. Pure construction; registration belongs to the plugin. */
export function createRoutes(deps: BridgeDeps): readonly WebRouteLike[] {
  const { manager, store } = deps
  return [
    {
      kind: 'exact', path: STATUS_PATH,
      handler: guard(deps, STATUS_PATH, async (req, res) => {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
        sendJson(res, 200, { ...await manager.statusDocument(), allowCustom: deps.allowCustom })
      }),
    },
    {
      kind: 'exact', path: PROFILES_PATH,
      handler: guard(deps, PROFILES_PATH, async (req, res) => {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
        sendJson(res, 200, { profiles: await store.list() })
      }),
    },
    {
      kind: 'exact', path: PROFILE_PATH,
      handler: guard(deps, PROFILE_PATH, async (req, res) => {
        if (req.method === 'PUT') {
          checkOrigin(req)
          const input = validateProfileInput(await readJson(req), { allowCustom: deps.allowCustom })
          if (input.id !== undefined && manager.state !== 'disconnected' && manager.state !== 'failed') {
            const current = (await manager.statusDocument()).profileId
            if (current === input.id) throw new ConflictError('disconnect before editing the profile that is in use')
          }
          sendJson(res, 200, { profile: await store.upsert(input) })
          return
        }
        if (req.method === 'DELETE') {
          checkOrigin(req)
          const id = queryOf(req).get('id') ?? ''
          if (!PROFILE_ID.test(id)) throw new BridgeError(400, 'invalid', 'id is not a valid profile id', 'id')
          if ((await manager.statusDocument()).profileId === id && (manager.state === 'connecting' || manager.state === 'connected')) {
            throw new ConflictError('disconnect before deleting the profile that is in use')
          }
          await store.remove(id)
          sendJson(res, 200, { ok: true })
          return
        }
        methodNotAllowed(res, 'PUT, DELETE')
      }),
    },
    {
      kind: 'exact', path: CONNECT_PATH,
      handler: guard(deps, CONNECT_PATH, async (req, res) => {
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
        checkOrigin(req)
        const body = await readJson(req)
        const id = typeof body === 'object' && body !== null ? (body as { id?: unknown }).id : undefined
        if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new BridgeError(400, 'invalid', 'id must be a profile id', 'id')
        sendJson(res, 202, await manager.connect(id))
      }),
    },
    {
      kind: 'exact', path: DISCONNECT_PATH,
      handler: guard(deps, DISCONNECT_PATH, async (req, res) => {
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
        checkOrigin(req)
        // Disconnecting needs no body, but a JSON content type is still required
        // so a cross-site form post cannot trigger it.
        const essence = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
        if (essence !== 'application/json') throw new BridgeError(415, 'unsupported-media-type', 'content-type must be application/json')
        req.resume()
        sendJson(res, 200, await manager.disconnect())
      }),
    },
    {
      kind: 'exact', path: LOGS_PATH,
      handler: guard(deps, LOGS_PATH, async (req, res) => {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
        const raw = Number(queryOf(req).get('limit') ?? '200')
        sendJson(res, 200, { lines: manager.logLines(Number.isFinite(raw) ? raw : 200) })
      }),
    },
  ]
}
