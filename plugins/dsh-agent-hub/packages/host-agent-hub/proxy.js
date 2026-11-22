/**
 * HTTP proxy support for the hub client (CONNECT tunnel, no third-party code).
 *
 * Node's `https.request` ignores HTTPS_PROXY, so on a machine whose traffic to
 * the hub must leave through a local proxy (MYDESK: Clash / mihomo on
 * http://127.0.0.1:7890) the client opens the tunnel itself:
 *
 *   1. `node:http` request `CONNECT <hub host>:<port> HTTP/1.1` to the proxy
 *      (with `Proxy-Authorization: Basic ...` when the proxy URL has user:pass);
 *   2. on `200`, `node:tls` connect over the returned socket (servername = hub
 *      host unless it is an IP, the hostname is still verified, `ca` = caFile);
 *   3. the caller sends its normal `https.request` over that TLS socket
 *      (`createConnection: () => tlsSocket`).
 *
 * Only `http://` proxies are accepted (no https:// or SOCKS proxies). Plain
 * `http://` hub URLs (loopback only) never go through a proxy.
 *
 * Config value (`proxy` of the plugin):
 *   unset / '' / false / 'off'  -> direct
 *   'env'                       -> HTTPS_PROXY, https_proxy, HTTP_PROXY, http_proxy (first set wins),
 *                                  unless NO_PROXY / no_proxy matches the hub host
 *   'http://[user:pass@]host:port' -> always this proxy (NO_PROXY is not consulted)
 *
 * Proxy credentials never appear in a log line or an error message: callers
 * only ever see `display` (`http://***@host:port`). Every pure step is a
 * separate export so it can be tested with fake http / tls modules.
 *
 * @module host-agent-hub/proxy
 */

import { request as httpRequest } from 'node:http'
import { connect as tlsConnect } from 'node:tls'

export const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
export const NO_PROXY_ENV_KEYS = ['NO_PROXY', 'no_proxy']
const OFF = new Set(['', 'off', 'none', 'direct', 'false'])

/** A tunnel failure: `stage` is proxy-connect | proxy-refused | tls | timeout. Message has no credentials. */
export class TunnelError extends Error {
  constructor(stage, message, code) {
    super(message)
    Object.defineProperty(this, 'name', { value: 'TunnelError', configurable: true, writable: true })
    this.stage = stage
    this.code = code
  }
}

/** IPv4 / IPv6 literal? (SNI must not carry an IP address.) */
export function isIpLiteral(host) {
  const h = String(host ?? '').replace(/^\[|\]$/g, '')
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')
}

/**
 * Parse a proxy URL. Never throws, never echoes the input.
 * @returns {{ ok: true, host: string, port: number, authority: string, display: string, authorization?: string, secrets: string[] }
 *          | { ok: false, problem: string }}
 */
export function parseProxyUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { ok: false, problem: 'proxy URL is empty' }
  let url
  try { url = new URL(text.includes('://') ? text : `http://${text}`) } catch { return { ok: false, problem: 'proxy is not a valid URL (expected http://host:port, e.g. http://127.0.0.1:7890)' } }
  if (url.protocol !== 'http:') return { ok: false, problem: 'proxy must be an http:// URL (https:// and socks proxies are not supported), e.g. http://127.0.0.1:7890' }
  if (url.hostname === '') return { ok: false, problem: 'proxy URL has no host' }
  if ((url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') return { ok: false, problem: 'proxy URL must not contain a path, query or fragment' }
  const port = url.port === '' ? 80 : Number(url.port)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const authority = `${url.hostname}:${port}`
  const secrets = []
  let authorization
  if (url.username !== '' || url.password !== '') {
    let user, pass
    try { user = decodeURIComponent(url.username); pass = decodeURIComponent(url.password) } catch { return { ok: false, problem: 'proxy credentials are not valid percent-encoding' } }
    authorization = `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`
    for (const s of [url.username, url.password, user, pass, authorization.slice(6)]) if (s && s.length >= 2) secrets.push(s)
  }
  return { ok: true, host, port, authority, display: `http://${authorization ? '***@' : ''}${authority}`, authorization, secrets }
}

/** Replace proxy secrets (user, password, base64 credentials) in a text. */
export function scrubProxy(text, proxy) {
  let out = String(text ?? '')
  for (const secret of proxy?.secrets ?? []) out = out.split(secret).join('***')
  return out
}

/**
 * NO_PROXY match. Entries are comma (or space) separated: `*` (everything),
 * `host`, `.suffix` / `*.suffix` / `suffix` (the domain and its subdomains),
 * optional `:port`, IPv6 in brackets. CIDR ranges are not supported.
 */
export function shouldBypass(noProxy, host, port) {
  if (typeof noProxy !== 'string' || noProxy.trim() === '') return false
  const target = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (target === '') return false
  for (const raw of noProxy.split(/[\s,]+/)) {
    let entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    let entryPort
    const bracket = entry.match(/^\[([^\]]+)\](?::(\d+))?$/)
    if (bracket) { entry = bracket[1]; entryPort = bracket[2] } else {
      const m = entry.match(/^([^:]+):(\d+)$/)
      if (m) { entry = m[1]; entryPort = m[2] }
    }
    if (entryPort !== undefined && port !== undefined && String(port) !== entryPort) continue
    entry = entry.replace(/^\*\./, '.').replace(/\.$/, '')
    if (entry.startsWith('.')) {
      const bare = entry.slice(1)
      if (target === bare || target.endsWith(entry)) return true
    } else if (target === entry || target.endsWith(`.${entry}`)) return true
  }
  return false
}

/**
 * Validate the `proxy` config value (no env lookup yet).
 * @returns {{ mode: 'direct' } | { mode: 'env' } | { mode: 'url', proxy: object } | { mode: 'invalid', problem: string }}
 */
export function proxySetting(value) {
  if (value === undefined || value === null || value === false) return { mode: 'direct' }
  if (typeof value !== 'string') return { mode: 'invalid', problem: 'config.proxy must be an http:// URL, "env" or "off"' }
  const v = value.trim()
  if (OFF.has(v.toLowerCase())) return { mode: 'direct' }
  if (v.toLowerCase() === 'env') return { mode: 'env' }
  const parsed = parseProxyUrl(v)
  if (!parsed.ok) return { mode: 'invalid', problem: `config.proxy: ${parsed.problem}` }
  return { mode: 'url', proxy: parsed }
}

/**
 * Proxy for one request to `target` (a URL object).
 * @returns {{ proxy?: object, source: string, problem?: string }}  no `proxy` = direct
 */
export function resolveProxy(setting, target, env = {}) {
  if (target.protocol !== 'https:') return { source: 'direct (plain http hub on loopback is never proxied)' }
  if (setting.mode === 'url') return { proxy: setting.proxy, source: 'config.proxy' }
  if (setting.mode !== 'env') return { source: 'direct' }
  const key = PROXY_ENV_KEYS.find(k => typeof env[k] === 'string' && env[k].trim() !== '')
  if (key === undefined) return { source: 'direct (proxy: env, but no HTTPS_PROXY / HTTP_PROXY set)' }
  const noKey = NO_PROXY_ENV_KEYS.find(k => typeof env[k] === 'string' && env[k].trim() !== '')
  const port = target.port === '' ? 443 : Number(target.port)
  if (noKey !== undefined && shouldBypass(env[noKey], target.hostname, port)) return { source: `direct (${noKey} matches ${target.hostname})` }
  const parsed = parseProxyUrl(env[key])
  if (!parsed.ok) return { source: key, problem: `${key}: ${parsed.problem}` }
  return { proxy: parsed, source: key }
}

/** `node:http` request options for `CONNECT host:port` (pure; the request line is `CONNECT <path> HTTP/1.1`). */
export function buildConnectRequest(proxy, targetHost, targetPort, { timeoutMs } = {}) {
  const bare = String(targetHost).replace(/^\[|\]$/g, '')
  const authority = `${bare.includes(':') ? `[${bare}]` : bare}:${targetPort}`
  const headers = { host: authority, 'proxy-connection': 'keep-alive', 'user-agent': 'dsh-host-agent-hub' }
  if (proxy.authorization) headers['proxy-authorization'] = proxy.authorization
  const options = { host: proxy.host, port: proxy.port, method: 'CONNECT', path: authority, headers, agent: false }
  if (timeoutMs !== undefined) options.timeout = timeoutMs
  return options
}

/** `node:tls` connect options over the tunnel socket (pure). */
export function buildTlsOptions(socket, targetHost, { ca } = {}) {
  const bare = String(targetHost).replace(/^\[|\]$/g, '')
  const options = { socket, host: bare, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] }
  if (!isIpLiteral(bare)) options.servername = bare
  if (ca !== undefined) options.ca = ca
  return options
}

const TLS_CODE_RE = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|HOSTNAME|ALTNAME|SSL|EPROTO/

/**
 * Open CONNECT + TLS to `target` through `proxy`. Resolves the secure socket.
 * Rejects with a TunnelError whose message names the failed stage and contains
 * neither proxy credentials nor anything the caller did not pass in.
 *
 * @param {{ proxy: object, target: URL, timeoutMs: number, ca?: any,
 *           deps?: { httpRequest?: Function, tlsConnect?: Function } }} options
 */
export function openTunnel({ proxy, target, timeoutMs, ca, deps = {} }) {
  const request = deps.httpRequest ?? httpRequest
  const connect = deps.tlsConnect ?? tlsConnect
  const port = target.port === '' ? 443 : Number(target.port)
  const hostLabel = `${target.hostname}:${port}`
  return new Promise((resolve, reject) => {
    let settled = false
    let req
    let socket
    let secure
    const fail = (stage, message, code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const s of [secure, socket]) { try { s?.destroy?.() } catch { /* ignore */ } }
      try { req?.destroy?.() } catch { /* ignore */ }
      reject(new TunnelError(stage, scrubProxy(message, proxy), code))
    }
    let stageNow = 'proxy-connect'
    const timer = setTimeout(() => {
      const what = stageNow === 'tls' ? `TLS handshake with ${hostLabel} through proxy ${proxy.display}` : `proxy ${proxy.display} (CONNECT ${hostLabel})`
      fail('timeout', `timed out after ${timeoutMs} ms waiting for ${what}`, 'ETIMEDOUT_HUB')
    }, timeoutMs)
    timer.unref?.()

    const onTunnel = (res, sock, head) => {
      if (settled) { try { sock?.destroy?.() } catch { /* ignore */ } return }
      socket = sock
      const status = res?.statusCode
      if (status !== 200) {
        const reason = typeof res?.statusMessage === 'string' ? res.statusMessage.replace(/[^\x20-\x7e]/g, '').slice(0, 80) : ''
        const hint = status === 407 ? ' (proxy authentication required: put user:password into the proxy URL)' : ''
        fail('proxy-refused', `proxy ${proxy.display} refused CONNECT ${hostLabel}: HTTP ${status ?? '?'}${reason ? ` ${reason}` : ''}${hint}`, `PROXY_${status ?? 'ERR'}`)
        return
      }
      if (head && head.length > 0) { try { sock.unshift(head) } catch { /* ignore */ } }
      stageNow = 'tls'
      try {
        secure = connect(buildTlsOptions(sock, target.hostname, { ca }))
      } catch (error) {
        fail('tls', `TLS to ${hostLabel} through proxy ${proxy.display} failed (${error?.code ?? 'error'})`, error?.code)
        return
      }
      secure.once?.('secureConnect', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(secure)
      })
      secure.on?.('error', (error) => {
        const code = typeof error?.code === 'string' ? error.code : undefined
        const tlsy = code !== undefined && TLS_CODE_RE.test(code)
        fail('tls', `TLS to ${hostLabel} through proxy ${proxy.display} failed (${code ?? 'error'})${tlsy && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|HOSTNAME/.test(code) ? '; set caFile to the hub certificate' : ''}`, code)
      })
    }

    try {
      // No socket idle timeout on the CONNECT request: it would stay on the tunnel socket; the timer above covers the setup.
      req = request(buildConnectRequest(proxy, target.hostname, port))
    } catch (error) {
      fail('proxy-connect', `cannot reach proxy ${proxy.display} (${error?.code ?? 'error'})`, error?.code)
      return
    }
    req.on?.('connect', onTunnel)
    // Some proxies answer a refused CONNECT as a normal response.
    req.on?.('response', (res) => { try { res.resume?.() } catch { /* ignore */ } onTunnel(res, res?.socket, undefined) })
    req.on?.('error', (error) => {
      if (stageNow === 'tls') return
      const code = typeof error?.code === 'string' ? error.code : undefined
      const hint = code === 'ECONNREFUSED' ? ' - is Clash / mihomo running on that port?' : ''
      fail('proxy-connect', `cannot reach proxy ${proxy.display} (${code ?? 'error'})${hint}`, code)
    })
    req.on?.('timeout', () => fail('timeout', `timed out after ${timeoutMs} ms waiting for proxy ${proxy.display} (CONNECT ${hostLabel})`, 'ETIMEDOUT_HUB'))
    try { req.end?.() } catch (error) { fail('proxy-connect', `cannot reach proxy ${proxy.display} (${error?.code ?? 'error'})`, error?.code) }
  })
}
