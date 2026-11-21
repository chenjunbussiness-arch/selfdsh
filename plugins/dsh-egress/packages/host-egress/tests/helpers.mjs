/**
 * Shared test fixtures: real local servers, no mocks of the network.
 *
 * - `startTarget`       an HTTPS server (test certificate) answering `target-ok`
 * - `startConnectProxy` an HTTP CONNECT proxy that counts tunnels and can require Basic auth
 * - `startSocks5`       a minimal SOCKS5 server (no-auth or user/pass) that counts connects
 * - `closedPort`        a port nothing listens on
 */
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createTcpServer, connect as tcpConnect } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const CERT = readFileSync(join(here, 'fixtures', 'test-cert.pem'), 'utf8')
export const KEY = readFileSync(join(here, 'fixtures', 'test-key.pem'), 'utf8')

/** Where a usable undici lives on a developer machine; the server resolves it from NODE_PATH instead. */
export function undiciPath() {
  const candidates = [
    process.env.EGRESS_TEST_UNDICI,
    'E:/PythonProject/deepseek-harness-latest/node_modules/.pnpm/node_modules/undici/index.js',
  ].filter(Boolean)
  const found = candidates.find(candidate => existsSync(candidate))
  if (found === undefined) throw new Error('no undici >= 7 found; set EGRESS_TEST_UNDICI to its index.js')
  return found
}

export function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-egress-'))
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) }
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = (server) => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.() })

export async function startTarget() {
  const hits = { count: 0 }
  const server = createHttpsServer({ cert: CERT, key: KEY }, (req, res) => {
    hits.count += 1
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('target-ok')
  })
  const port = await listen(server)
  return { port, hits, close: () => close(server) }
}

export async function startConnectProxy({ auth } = {}) {
  const state = { tunnels: [], rejected: 0, plain: 0 }
  const sockets = new Set()
  const server = createHttpServer((req, res) => {
    state.plain += 1
    res.writeHead(405).end()
  })
  server.on('connect', (req, clientSocket, head) => {
    if (auth !== undefined) {
      const expected = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
      if (req.headers['proxy-authorization'] !== expected) {
        state.rejected += 1
        clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n')
        return
      }
    }
    state.tunnels.push(req.url)
    const [host, port] = req.url.split(':')
    const upstream = tcpConnect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    sockets.add(clientSocket); sockets.add(upstream)
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  const port = await listen(server)
  return { port, state, close: async () => { for (const s of sockets) s.destroy(); await close(server) } }
}

/** Minimal SOCKS5 (RFC 1928/1929): CONNECT only, domain/IPv4 addresses. */
export async function startSocks5({ auth } = {}) {
  const state = { connects: [], authFailures: 0 }
  const sockets = new Set()
  const server = createTcpServer((client) => {
    sockets.add(client)
    client.on('error', () => client.destroy())
    let stage = 'greeting'
    let buffer = Buffer.alloc(0)
    client.on('data', (chunk) => {
      if (stage === 'piping') return
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (stage === 'greeting') {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return
          const methods = [...buffer.subarray(2, 2 + buffer[1])]
          buffer = buffer.subarray(2 + buffer[1])
          const want = auth === undefined ? 0x00 : 0x02
          if (!methods.includes(want)) { client.end(Buffer.from([5, 0xff])); return }
          client.write(Buffer.from([5, want]))
          stage = auth === undefined ? 'request' : 'auth'
        } else if (stage === 'auth') {
          if (buffer.length < 2) return
          const ulen = buffer[1]
          if (buffer.length < 3 + ulen) return
          const plen = buffer[2 + ulen]
          if (buffer.length < 3 + ulen + plen) return
          const user = buffer.subarray(2, 2 + ulen).toString()
          const pass = buffer.subarray(3 + ulen, 3 + ulen + plen).toString()
          buffer = buffer.subarray(3 + ulen + plen)
          if (user !== auth.username || pass !== auth.password) { state.authFailures += 1; client.end(Buffer.from([1, 1])); return }
          client.write(Buffer.from([1, 0]))
          stage = 'request'
        } else if (stage === 'request') {
          if (buffer.length < 5) return
          const atyp = buffer[3]
          let host; let offset
          if (atyp === 1) { if (buffer.length < 10) return; host = [...buffer.subarray(4, 8)].join('.'); offset = 8 }
          else if (atyp === 3) { const n = buffer[4]; if (buffer.length < 7 + n) return; host = buffer.subarray(5, 5 + n).toString(); offset = 5 + n }
          else { client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return }
          const port = buffer.readUInt16BE(offset)
          const rest = buffer.subarray(offset + 2)
          stage = 'piping'
          state.connects.push({ host, port, atyp })
          const upstream = tcpConnect(port, host === 'localhost' ? '127.0.0.1' : host, () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
            if (rest.length > 0) upstream.write(rest)
            client.removeAllListeners('data')
            upstream.pipe(client); client.pipe(upstream)
          })
          sockets.add(upstream)
          upstream.on('error', () => { try { client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])) } catch { /* gone */ } })
          return
        } else return
      }
    })
  })
  const port = await listen(server)
  return { port, state, close: async () => { for (const s of sockets) s.destroy(); await close(server) } }
}

/** A port with nothing listening: bind, read the number, release. */
export async function closedPort() {
  const server = createTcpServer()
  const port = await listen(server)
  await close(server)
  return port
}

/** Plain HTTP helper for the bridge tests. */
export function httpCall(port, { method = 'GET', path, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { json = undefined }
        resolve({ status: res.statusCode, text, json })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}
