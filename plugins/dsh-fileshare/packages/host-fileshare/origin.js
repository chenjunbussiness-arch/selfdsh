/**
 * The public address links are built on, and the rule that keeps internal
 * addresses out of every link.
 *
 * A link is `<base>/api/fileshare/d/<token>/<name>`. `<base>` is, in order:
 *
 *   1. `publicBaseUrl` from the config;
 *   2. the address the browser used for the last logged-in DSH page load
 *      (Host + X-Forwarded-Proto), recorded by the client plugin's ping;
 *   3. nothing: tools then return only the path and say why.
 *
 * Neither source may be an internal address: loopback, private, link-local,
 * CGNAT, unique-local IPv6, `localhost`, or a name under .local / .lan /
 * .internal / .intranet / .home.arpa / .localdomain. Such a base is refused,
 * never used.
 *
 * @module dsh-host-fileshare/origin
 */

import { isIP } from 'node:net'

const INTERNAL_SUFFIXES = ['.local', '.lan', '.internal', '.intranet', '.home.arpa', '.localdomain', '.corp', '.localhost']

function v4Internal(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a >= 224) return true
  return false
}

function v6Internal(address) {
  const lower = address.toLowerCase().replace(/%.*$/, '')
  if (lower === '::' || lower === '::1') return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped !== null) return v4Internal(mapped[1])
  const head = parseInt(lower.split(':')[0] || '0', 16)
  if ((head & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((head & 0xffc0) === 0xfe80) return true // fe80::/10 link local
  if ((head & 0xff00) === 0xff00) return true // multicast
  return false
}

/**
 * Whether a hostname (no port, no brackets) names an internal address.
 * @param {string} hostname
 */
export function isInternalHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === '' || host === 'localhost') return true
  const family = isIP(host)
  if (family === 4) return v4Internal(host)
  if (family === 6) return v6Internal(host)
  if (!host.includes('.')) return true // single-label names only resolve on a LAN
  return INTERNAL_SUFFIXES.some(suffix => host.endsWith(suffix))
}

/**
 * Validate a base URL: http(s), no credentials, no query, not internal.
 * @param {string} text
 * @returns {{ ok: true, base: string } | { ok: false, reason: string }}
 */
export function checkBaseUrl(text) {
  let url
  try {
    url = new URL(text)
  } catch {
    return { ok: false, reason: 'not a URL' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'must be http or https' }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'must not carry credentials' }
  if (url.search !== '' || url.hash !== '') return { ok: false, reason: 'must not have a query or fragment' }
  if (isInternalHost(url.hostname)) return { ok: false, reason: 'internal addresses are never used in links' }
  const path = url.pathname.replace(/\/+$/, '')
  return { ok: true, base: `${url.protocol}//${url.host}${path}` }
}

function header(req, name) {
  const value = req.headers?.[name]
  const text = Array.isArray(value) ? value[0] : value
  return typeof text === 'string' ? text.split(',')[0].trim() : ''
}

/**
 * The base a logged-in browser request was made against.
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} [secureDefault] - the listener itself speaks TLS.
 * @returns {{ ok: true, base: string } | { ok: false, reason: string }}
 */
export function baseFromRequest(req, secureDefault = false) {
  const host = header(req, 'x-forwarded-host') || header(req, 'host')
  if (host === '' || /[\s/\\@]/.test(host)) return { ok: false, reason: 'no usable Host header' }
  let proto = header(req, 'x-forwarded-proto').toLowerCase()
  if (proto !== 'http' && proto !== 'https') proto = secureDefault || req.socket?.encrypted === true ? 'https' : 'http'
  return checkBaseUrl(`${proto}://${host}`)
}
