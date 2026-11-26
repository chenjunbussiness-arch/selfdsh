/**
 * Logged-in routes for the 文件中转 page (wrapped by `requireLogin`):
 *
 *   POST /api/fileshare/hello    remember the address this browser uses (the public base for links)
 *   GET  /api/fileshare/links    links, the public base, allowed folders, defaults
 *   POST /api/fileshare/create   { kind: 'download', path, ttlMinutes?, maxDownloads?, note? }
 *                                { kind: 'upload', dir?, ttlMinutes?, maxFiles?, maxMb?, note? }
 *   POST /api/fileshare/revoke   { id }
 *
 * POSTs need the `x-dsh-fileshare: 1` header (a cross-site form cannot send it).
 *
 * @module dsh-host-fileshare/manage
 */

import { baseFromRequest } from './origin.js'
import { ROUTE_BASE, ShareError } from './service.js'

const MAX_BODY = 16 * 1024

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function sendError(res, status, message) {
  sendJson(res, status, { error: { message } })
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new ShareError('request body too large', 413)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch {
    throw new ShareError('body must be a JSON object')
  }
}

function route(path, method, logger, answer) {
  return {
    kind: 'exact',
    path,
    async handler(req, res) {
      if (req.method !== method) { res.setHeader('allow', method); sendError(res, 405, `use ${method}`); return }
      if (method === 'POST' && req.headers['x-dsh-fileshare'] !== '1') { sendError(res, 403, 'missing x-dsh-fileshare header'); return }
      try {
        const body = method === 'POST' ? await readJson(req) : undefined
        sendJson(res, 200, await answer(req, body))
      } catch (error) {
        if (error instanceof ShareError) { sendError(res, error.status, error.message); return }
        try { logger?.warn?.(`dsh-fileshare: ${path} failed: ${error instanceof Error ? error.message : String(error)}`) } catch { /* ignore */ }
        sendError(res, 500, error instanceof Error ? error.message : String(error))
      }
    },
  }
}

/**
 * @param {{ service: any, store: any, config: any, logger?: any, secure: () => boolean }} deps
 */
export function createManageRoutes({ service, store, config, logger, secure }) {
  async function overview() {
    const { base, source } = await service.publicBase()
    const { roots, dropped } = await service.roots(undefined)
    return {
      generatedAt: new Date().toISOString(),
      base: base ?? null,
      baseSource: source,
      roots,
      droppedRoots: dropped,
      defaults: {
        downloadTtlMinutes: config.downloadTtlMinutes,
        downloadMaxTtlMinutes: config.downloadMaxTtlMinutes,
        uploadTtlMinutes: config.uploadTtlMinutes,
        uploadMaxTtlMinutes: config.uploadMaxTtlMinutes,
        uploadMaxFiles: config.uploadMaxFiles,
        uploadMaxMb: Math.round(config.uploadMaxBytes / 1024 / 1024),
        inboxDir: config.inboxDir,
      },
      links: await service.list(),
    }
  }

  return [
    route(`${ROUTE_BASE}/hello`, 'POST', logger, async (req) => {
      const seen = baseFromRequest(req, secure())
      if (seen.ok && config.publicBaseUrl === '') await store.setOrigin(seen.base)
      const { base, source } = await service.publicBase()
      return { base: base ?? null, baseSource: source, seen: seen.ok ? seen.base : null, refused: seen.ok ? null : seen.reason }
    }),
    route(`${ROUTE_BASE}/links`, 'GET', logger, async () => overview()),
    route(`${ROUTE_BASE}/create`, 'POST', logger, async (_req, body) => {
      if (body.kind === 'download') {
        return service.createDownload({ path: body.path, ttlMinutes: body.ttlMinutes, maxDownloads: body.maxDownloads, note: body.note, by: 'page' })
      }
      if (body.kind === 'upload') {
        return service.createUpload({ dir: body.dir, ttlMinutes: body.ttlMinutes, maxFiles: body.maxFiles, maxMb: body.maxMb, note: body.note, by: 'page' })
      }
      throw new ShareError('kind must be download or upload')
    }),
    route(`${ROUTE_BASE}/revoke`, 'POST', logger, async (_req, body) => service.revoke(body.id)),
  ]
}

/**
 * Wrap a route so it answers only a logged-in browser (same check as the
 * other selfdsh bridges: a plugin route outranks the connection's own `/api`
 * prefix check, so it is put back here).
 */
export function requireLogin(route, connection) {
  return {
    ...route,
    handler: async (req, res) => {
      let check
      try { check = connection() } catch { check = undefined }
      const rejection = typeof check?.requestRejection === 'function' ? check.requestRejection(req) : 503
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(rejection === 401 ? 'unauthorized' : rejection === 403 ? 'forbidden' : 'login service unavailable')
        return
      }
      await route.handler(req, res)
    },
  }
}
