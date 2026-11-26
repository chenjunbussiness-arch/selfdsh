/**
 * The two public routes. They need no DSH login: the random token in the
 * path is the credential, so each request is checked against the link record
 * (kind, expiry, revocation, use limits) and the file system (the path must
 * still resolve to the same real path inside the same root).
 *
 *   GET|HEAD  /api/fileshare/d/<token>/<name>   download (Range supported; ?view=1 shows safe types inline)
 *   GET       /api/fileshare/u/<token>/          upload page (light / dark)
 *   GET       /api/fileshare/u/<token>/?status=1 upload link state as JSON
 *   PUT|POST  /api/fileshare/u/<token>/<name>    receive one file (raw body; `curl -T file <link>` works)
 *
 * Responses never name the server's directories, only the target folder's own
 * name. Served files always go out with `Content-Security-Policy: sandbox`,
 * `nosniff` and, unless a safe type is asked for inline, as an attachment, so
 * an uploaded HTML or SVG file cannot run script in the DSH origin.
 *
 * @module dsh-host-fileshare/public
 */

import { createHash, randomBytes } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { isInside, numbered, safeFileName } from './paths.js'
import { DOWNLOAD_BASE, UPLOAD_BASE, formatBytes } from './service.js'
import { linkState } from './store.js'
import { uploadPage, notePage } from './upload-page.js'

const MIME = {
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json', '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.tgz': 'application/gzip',
  '.tar': 'application/x-tar', '.7z': 'application/x-7z-compressed', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
/** Types shown inline with ?view=1; everything else is always an attachment. */
const INLINE_OK = new Set(['text/plain; charset=utf-8', 'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav'])

const SECURITY_HEADERS = {
  'cache-control': 'no-store, no-transform',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow',
}

function contentDisposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function wantsHtml(req) {
  return /text\/html/.test(String(req.headers.accept ?? ''))
}

function sendText(req, res, status, title, text, extra = {}) {
  if (res.headersSent) { res.destroy(); return }
  if (wantsHtml(req) && req.method !== 'PUT' && req.method !== 'POST') {
    const html = notePage(title, text)
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html.body), 'content-security-policy': html.csp, ...extra })
    res.end(req.method === 'HEAD' ? undefined : html.body)
    return
  }
  const body = `${text}\n`
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body), ...extra })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** `/api/fileshare/x/<token>/<rest>` → { token, rest, slash } */
function splitPath(req, base) {
  const url = new URL(req.url ?? '/', 'http://x')
  const tail = url.pathname.slice(base.length)
  const match = /^\/([^/]*)(\/(.*))?$/.exec(tail)
  if (match === null) return { url, token: '', rest: '', slash: false }
  let rest = match[3] ?? ''
  try { rest = decodeURIComponent(rest) } catch { rest = '' }
  return { url, token: match[1], rest, slash: match[2] !== undefined }
}

const DEAD = {
  expired: ['链接已过期', '这个链接已经过了有效期。需要的话请重新生成一个。'],
  revoked: ['链接已撤销', '这个链接已经被撤销。'],
  'used-up': ['链接已用完', '这个链接的次数或容量已经用完。'],
}

function parseRange(header, size) {
  if (typeof header !== 'string' || !header.startsWith('bytes=') || header.includes(',')) return undefined
  const [startText, endText] = header.slice(6).split('-')
  let start
  let end
  if (startText === '') {
    const suffix = Number(endText)
    if (!Number.isInteger(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(startText)
    end = endText === '' ? size - 1 : Number(endText)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return null
    end = Math.min(end, size - 1)
  }
  if (start >= size) return null
  return { start, end }
}

/**
 * Build the two public routes.
 * @param {{ store: import('./store.js').LinkStore, logger?: any }} deps
 */
export function createPublicRoutes({ store, logger }) {
  const warn = (message) => { try { logger?.warn?.(message) } catch { /* ignore */ } }

  async function download(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { sendText(req, res, 405, '不支持', 'method not allowed', { allow: 'GET, HEAD' }); return }
    const { url, token } = splitPath(req, DOWNLOAD_BASE)
    const link = await store.find(token)
    if (link === undefined || link.kind !== 'download') { sendText(req, res, 404, '链接无效', '没有这个链接。'); return }
    const state = linkState(link)
    if (state !== 'active') { sendText(req, res, 410, ...DEAD[state]); return }

    let real
    let handle
    try {
      real = await realpath(link.path)
      if (real !== link.path || !isInside(link.root, real)) throw new Error('moved')
      handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch {
      sendText(req, res, 410, '文件已不在', '文件已经被移走、改名或删除。')
      return
    }
    let closed = false
    const close = () => { if (!closed) { closed = true; handle.close().catch(() => undefined) } }
    try {
      const info = await handle.stat()
      if (!info.isFile()) { close(); sendText(req, res, 410, '文件已不在', '目标不再是普通文件。'); return }
      const size = info.size
      const range = parseRange(req.headers.range, size)
      if (range === null) { close(); sendText(req, res, 416, '范围无效', 'range not satisfiable', { 'content-range': `bytes */${size}` }); return }
      const start = range?.start ?? 0
      const end = range?.end ?? size - 1

      // Count a download when a GET starts at byte 0; resumed ranges ride on the same count.
      if (req.method === 'GET' && start === 0) {
        const counted = await store.mutate(link.id, (current) => {
          if (linkState(current) !== 'active') return 'dead'
          current.downloads += 1
          current.lastAccessAt = new Date().toISOString()
          return 'ok'
        })
        if (counted !== 'ok') { close(); sendText(req, res, 410, ...DEAD['used-up']); return }
      }

      const type = MIME[extname(link.name).toLowerCase()] ?? 'application/octet-stream'
      const inline = url.searchParams.get('view') === '1' && INLINE_OK.has(type)
      const headers = {
        ...SECURITY_HEADERS,
        'content-type': type,
        'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', link.name),
        'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
        'accept-ranges': 'bytes',
        'last-modified': info.mtime.toUTCString(),
        'content-length': size === 0 ? 0 : end - start + 1,
      }
      if (range !== undefined) headers['content-range'] = `bytes ${start}-${end}/${size}`
      res.writeHead(range !== undefined ? 206 : 200, headers)
      if (req.method === 'HEAD' || size === 0) { close(); res.end(); return }
      const stream = createReadStream('', { fd: handle.fd, start, end, autoClose: false })
      let sent = 0
      stream.on('data', (chunk) => { sent += chunk.length })
      try {
        await pipeline(stream, res)
      } catch {
        // client went away: nothing to report
      } finally {
        close()
        if (sent > 0) store.mutate(link.id, (current) => { current.bytesSent = (current.bytesSent ?? 0) + sent; return 'ok' }).catch(() => undefined)
      }
    } catch (error) {
      close()
      warn(`dsh-fileshare: download ${link.id} failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) sendText(req, res, 500, '出错了', '读取文件失败。')
      else res.destroy()
    }
  }

  function uploadStatus(link) {
    const state = linkState(link)
    return {
      state,
      folder: link.name,
      expiresAt: link.expiresAt,
      maxFiles: link.maxFiles,
      filesLeft: Math.max(0, link.maxFiles - link.files.length),
      maxBytes: link.maxBytes,
      bytesLeft: Math.max(0, link.maxBytes - link.receivedBytes),
      files: link.files.map(file => ({ name: file.name, size: file.size })),
    }
  }

  async function receive(req, res, link, rawName) {
    const name = safeFileName(rawName)
    if (name === undefined) { sendJson(res, 400, { ok: false, error: '文件名不可用' }); return }
    const declared = req.headers['content-length'] === undefined ? undefined : Number(req.headers['content-length'])
    const bytesLeft = link.maxBytes - link.receivedBytes
    if (declared !== undefined && Number.isFinite(declared) && declared > bytesLeft) {
      sendJson(res, 413, { ok: false, error: `超出这个链接剩余的容量（还剩 ${formatBytes(Math.max(0, bytesLeft))}）` })
      req.resume()
      return
    }

    let dir
    try {
      await mkdir(link.path, { recursive: true })
      dir = await realpath(link.path)
      if (dir !== link.path || !isInside(link.root, dir)) throw new Error('moved')
    } catch {
      sendJson(res, 410, { ok: false, error: '目标文件夹已不可用' })
      req.resume()
      return
    }

    const temp = join(dir, `.fileshare-${randomBytes(6).toString('hex')}.part`)
    const hash = createHash('sha256')
    let size = 0
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length
        if (size > bytesLeft) { callback(Object.assign(new Error('too large'), { code: 'TOO_LARGE' })); return }
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(req, meter, createWriteStream(temp, { flags: 'wx', mode: 0o640 }))
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      if (error?.code === 'TOO_LARGE') sendJson(res, 413, { ok: false, error: `超出这个链接剩余的容量（还剩 ${formatBytes(Math.max(0, bytesLeft))}）` })
      else if (!res.headersSent && !res.destroyed) sendJson(res, 400, { ok: false, error: '上传中断' })
      return
    }

    // Commit under the store queue: limits are re-checked against concurrent uploads.
    let final
    const sha256 = hash.digest('hex')
    const verdict = await store.mutate(link.id, async (current) => {
      if (linkState(current) !== 'active') return { error: '链接已失效', status: 410 }
      if (current.files.length >= current.maxFiles) return { error: '文件数已达上限', status: 409 }
      if (current.receivedBytes + size > current.maxBytes) return { error: '超出这个链接的容量', status: 413 }
      for (let n = 0; n < 1000; n++) {
        const candidate = join(dir, numbered(name, n))
        try {
          const reserve = await open(candidate, 'wx')
          await reserve.close()
          final = candidate
          break
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error
        }
      }
      if (final === undefined) return { error: '同名文件太多', status: 409 }
      await rename(temp, final)
      current.files.push({ name: basename(final), size, sha256, at: new Date().toISOString() })
      current.receivedBytes += size
      return { ok: true, link: current }
    }).catch((error) => ({ error: `保存失败：${error instanceof Error ? error.message : String(error)}`, status: 500 }))
    if (verdict?.ok !== true) {
      await rm(temp, { force: true }).catch(() => undefined)
      sendJson(res, verdict?.status ?? 410, { ok: false, error: verdict?.error ?? '链接已失效' })
      return
    }
    const status = uploadStatus(verdict.link)
    sendJson(res, 201, { ok: true, name: basename(final), size, sha256, filesLeft: status.filesLeft, bytesLeft: status.bytesLeft })
  }

  async function upload(req, res) {
    const { url, token, rest, slash } = splitPath(req, UPLOAD_BASE)
    const link = await store.find(token)
    if (link === undefined || link.kind !== 'upload') { req.resume(); sendText(req, res, 404, '链接无效', '没有这个链接。'); return }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!slash) {
        res.writeHead(301, { ...SECURITY_HEADERS, location: `${token}/` })
        res.end()
        return
      }
      if (url.searchParams.get('status') === '1') { sendJson(res, 200, uploadStatus(link)); return }
      if (rest !== '') { sendText(req, res, 404, '链接无效', '上传链接不能下载文件。'); return }
      const status = uploadStatus(link)
      const page = uploadPage(status)
      res.writeHead(status.state === 'active' ? 200 : 410, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(page.body), 'content-security-policy': page.csp })
      res.end(req.method === 'HEAD' ? undefined : page.body)
      return
    }
    if (req.method !== 'PUT' && req.method !== 'POST') { req.resume(); sendText(req, res, 405, '不支持', 'method not allowed', { allow: 'GET, HEAD, PUT, POST' }); return }
    const state = linkState(link)
    if (state !== 'active') { req.resume(); sendJson(res, 410, { ok: false, error: DEAD[state][0] }); return }
    const rawName = rest !== '' ? rest : url.searchParams.get('name') ?? ''
    if (rawName === '') { req.resume(); sendJson(res, 400, { ok: false, error: '缺少文件名：PUT 到 <链接>/<文件名>，或 curl -T 文件 <链接>' }); return }
    await receive(req, res, link, rawName)
  }

  return [
    { kind: 'prefix', path: DOWNLOAD_BASE, handler: download },
    { kind: 'prefix', path: UPLOAD_BASE, handler: upload },
  ]
}

/** Exported for tests. */
export { parseRange, splitPath }
