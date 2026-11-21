/**
 * Stable entry gate for dsh web.
 *
 * `dsh web` mints a fresh launch token and a fresh cookie-signing secret on
 * every boot (dsh-client-connection/src/browser-auth.ts:64,185,240), and exposes
 * no configuration to pin either. That makes any bookmarked `?token=` URL expire
 * on every restart.
 *
 * This gate sits between nginx and dsh web. It reads the launch token the
 * process prints to its log and hands it to a browser that has not authenticated
 * yet, so the URL a person bookmarks never changes. Everything else is proxied
 * verbatim: streaming, websockets, uploads and the plugin bundles all pass
 * through untouched.
 */
import { createReadStream, statSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'

const PORT = Number(process.env.GATE_PORT ?? 42444)
const UPSTREAM_HOST = process.env.GATE_UPSTREAM_HOST ?? '127.0.0.1'
const UPSTREAM_PORT = Number(process.env.GATE_UPSTREAM_PORT ?? 42443)
const LOG_PATH = process.env.GATE_TOKEN_LOG ?? '/var/log/dsh-web.log'
const TOKEN_PATTERN = /[?&]token=([A-Za-z0-9_-]+)/g

/** Cached launch token plus the log fingerprint it was read from. */
let cachedToken = undefined
let cachedKey = ''

/**
 * Last launch token printed by the upstream process.
 *
 * Keyed on size+mtime so a restart is picked up on the next request without
 * re-reading a log that only ever grows.
 * @returns the live token, or undefined before the process has printed one.
 */
function currentToken() {
  let stat
  try {
    stat = statSync(LOG_PATH)
  } catch {
    return undefined
  }
  const key = `${stat.size}:${stat.mtimeMs}`
  if (key === cachedKey && cachedToken !== undefined) return cachedToken
  cachedKey = key
  cachedToken = undefined

  // Only the tail matters: the token line is printed once per boot and the log
  // is appended to forever.
  const readFrom = Math.max(0, stat.size - 64 * 1024)
  const chunks = []
  const stream = createReadStream(LOG_PATH, { start: readFrom, encoding: 'utf8' })
  return new Promise(resolve => {
    stream.on('data', chunk => chunks.push(chunk))
    stream.on('error', () => resolve(undefined))
    stream.on('end', () => {
      const text = chunks.join('')
      let last
      let match
      TOKEN_PATTERN.lastIndex = 0
      while ((match = TOKEN_PATTERN.exec(text)) !== null) last = match[1]
      cachedToken = last
      resolve(last)
    })
  })
}

/** Whether the browser already holds a cookie — a stale one recovers via the 401 path. */
function hasCookies(req) {
  return typeof req.headers.cookie === 'string' && req.headers.cookie.length > 0
}

/**
 * Ask the browser for the token URL instead of the bare root.
 * @param res - response to redirect.
 * @param token - current launch token.
 */
function redirectToToken(res, token) {
  res.writeHead(302, {
    Location: `/?token=${token}`,
    'Cache-Control': 'no-store',
  })
  res.end()
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://placeholder')
  const token = await currentToken()

  // A browser arriving at the bare root without a cookie cannot get past the
  // launch-token exchange, so hand it the current one. Assets and API calls are
  // proxied: redirecting those would corrupt a page mid-load.
  const isDocument = req.method === 'GET' && url.pathname === '/'
  const carriesToken = url.searchParams.has('token')
  if (isDocument && !carriesToken && !hasCookies(req) && token !== undefined) {
    redirectToToken(res, token)
    return
  }

  const headers = { ...req.headers, host: req.headers.host ?? `${UPSTREAM_HOST}:${UPSTREAM_PORT}` }
  const upstream = httpRequest(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers },
    upstreamRes => {
      // An expired cookie after a restart lands here: the document request is
      // refused, so send the browser through the exchange again.
      if (isDocument && upstreamRes.statusCode === 401 && token !== undefined) {
        upstreamRes.resume()
        redirectToToken(res, token)
        return
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  upstream.on('error', error => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`dsh-web-gate: upstream error: ${error.message}\n`)
    } else {
      res.end()
    }
  })
  req.pipe(upstream)
})

/**
 * Proxy a WebSocket upgrade.
 *
 * An upgrade is not an HTTP exchange: `http.request` hands the upgraded socket
 * to an `upgrade` listener instead of a response, and the browser validates the
 * `Sec-WebSocket-Accept` header against the key it sent. So the upstream's 101
 * is relayed byte for byte and then the two sockets are piped together — a gate
 * that only pipes `req`/`res` leaves the client reconnecting forever, which
 * looks exactly like "the server has no data".
 */
server.on('upgrade', (req, socket, head) => {
  const headers = { ...req.headers, host: req.headers.host ?? `${UPSTREAM_HOST}:${UPSTREAM_PORT}` }
  const upstream = httpRequest({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    method: req.method,
    path: req.url,
    headers,
  })

  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    socket.write(`HTTP/1.1 ${String(upstreamRes.statusCode ?? 101)} ${upstreamRes.statusMessage ?? 'Switching Protocols'}\r\n`)
    const raw = upstreamRes.rawHeaders
    for (let index = 0; index < raw.length; index += 2) {
      socket.write(`${String(raw[index])}: ${String(raw[index + 1])}\r\n`)
    }
    socket.write('\r\n')
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    if (head.length > 0) upstreamSocket.write(head)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    const close = () => {
      socket.destroy()
      upstreamSocket.destroy()
    }
    socket.on('error', close)
    upstreamSocket.on('error', close)
    socket.on('close', close)
    upstreamSocket.on('close', close)
  })

  // The upstream answered with plain HTTP instead of upgrading: relay its status
  // so the client sees the refusal rather than a silent hang.
  upstream.on('response', (upstreamRes) => {
    socket.write(`HTTP/1.1 ${String(upstreamRes.statusCode ?? 502)} ${upstreamRes.statusMessage ?? 'Bad Gateway'}\r\n\r\n`)
    socket.destroy()
    upstreamRes.resume()
  })
  upstream.on('error', () => socket.destroy())
  upstream.end()
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`dsh-web-gate: 127.0.0.1:${PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}\n`)
})
