/**
 * Input validation and redaction for the egress store and bridge.
 *
 * Everything that crosses the HTTP bridge is checked here, because an exit
 * record is later turned into a network destination and a header value: a
 * newline in a host name or a user name is a header-injection primitive, and an
 * unchecked host is a way to point the server at something it should not reach.
 *
 * @module host-egress/validate
 */

import { isIP, isIPv4, isIPv6 } from 'node:net'

/** Exit kinds a person may define. `direct` is built in and never stored. */
export const PROXY_TYPES = ['http', 'https', 'socks5'] as const
/** One definable exit kind. */
export type ProxyType = (typeof PROXY_TYPES)[number]
/** Exit kinds including the built-in direct exit. */
export type ExitType = ProxyType | 'direct'

/** Id of the built-in exit that connects straight out. */
export const DIRECT_ID = 'direct'

/** A validation failure with a stable code the panel can print. */
export class ValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

/** Control characters, including NUL, CR and LF. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** One DNS label: letters, digits and inner hyphens. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** Exit ids: lowercase slug, never `direct`. */
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/

/**
 * Reject a string that carries a control character.
 * @param value - candidate.
 * @param field - field name for the message.
 */
function noControl(value: string, field: string): void {
  if (CONTROL.test(value)) throw new ValidationError('bad-characters', `${field} must not contain control characters, newlines or NUL`)
}

/**
 * Validate and normalise a host name or IP literal.
 *
 * Accepts DNS names and IPv4/IPv6 literals (IPv6 with or without brackets) and
 * returns the lower-case form without brackets. Rejects anything that looks like
 * a URL, a path, credentials or a port.
 * @param raw - candidate host.
 * @param field - field name for messages.
 * @returns the normalised host.
 */
export function validateHost(raw: unknown, field = 'host'): string {
  if (typeof raw !== 'string') throw new ValidationError('bad-host', `${field} must be a string`)
  noControl(raw, field)
  let host = raw.trim().toLowerCase()
  if (host === '') throw new ValidationError('bad-host', `${field} must not be empty`)
  if (host.length > 253) throw new ValidationError('bad-host', `${field} is too long`)
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (isIPv6(host)) return host
  if (isIPv4(host)) return host
  if (/[\s/\\@:?#%]/.test(host) || host.includes('..')) throw new ValidationError('bad-host', `${field} is not a valid host name`)
  const name = host.endsWith('.') ? host.slice(0, -1) : host
  if (name === '' || !name.split('.').every(label => LABEL.test(label))) {
    throw new ValidationError('bad-host', `${field} is not a valid host name`)
  }
  // An all-numeric dotted name that is not a clean IPv4 is an ambiguous legacy spelling.
  if (/^[0-9.]+$/.test(name) && isIP(name) === 0) throw new ValidationError('bad-host', `${field} is not a valid host name`)
  return name
}

/**
 * Validate a TCP port.
 * @param raw - number or numeric string.
 * @returns the port, 1..65535.
 */
export function validatePort(raw: unknown): number {
  const value = typeof raw === 'string' && /^[0-9]{1,5}$/.test(raw) ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new ValidationError('bad-port', 'port must be an integer between 1 and 65535')
  }
  return value
}

/**
 * Validate a proxy type against the whitelist; `socks5h` is accepted as socks5.
 * @param raw - candidate type.
 * @returns the stored type.
 */
export function validateType(raw: unknown): ProxyType {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : raw
  if (value === 'socks5h') return 'socks5'
  if (value === 'http' || value === 'https' || value === 'socks5') return value
  throw new ValidationError('bad-type', 'type must be one of http, https, socks5')
}

/**
 * Validate an exit's display name.
 * @param raw - candidate name.
 * @returns the trimmed name, 1..40 characters.
 */
export function validateName(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('bad-name', 'name must be a string')
  noControl(raw, 'name')
  const name = raw.trim()
  if (name === '' || name.length > 40) throw new ValidationError('bad-name', 'name must be 1 to 40 characters')
  return name
}

/**
 * Validate an exit id.
 * @param raw - candidate id.
 * @returns the id.
 */
export function validateId(raw: unknown): string {
  if (typeof raw !== 'string' || !ID.test(raw) || raw === DIRECT_ID) {
    throw new ValidationError('bad-id', 'id must be a lowercase slug (a-z, 0-9, -) and not "direct"')
  }
  return raw
}

/**
 * Validate proxy credentials.
 * @param raw - candidate value.
 * @param field - `username` or `password`.
 * @returns the value.
 */
export function validateCredential(raw: unknown, field: 'username' | 'password'): string {
  if (typeof raw !== 'string') throw new ValidationError('bad-credential', `${field} must be a string`)
  noControl(raw, field)
  if (raw === '' || raw.length > 255) throw new ValidationError('bad-credential', `${field} must be 1 to 255 characters`)
  if (field === 'username' && raw.includes(':')) throw new ValidationError('bad-credential', 'username must not contain ":"')
  return raw
}

/** What `host:port` renders to, bracketing IPv6. */
export function hostPort(host: string, port: number): string {
  return `${isIPv6(host) ? `[${host}]` : host}:${String(port)}`
}

/**
 * Redact a proxy URL: userinfo is always `***:***`, never the real values.
 * @param scheme - proxy scheme.
 * @param host - proxy host.
 * @param port - proxy port.
 * @param hasAuth - whether credentials exist.
 * @returns `scheme://[***:***@]host:port`.
 */
export function redactedUrl(scheme: string, host: string, port: number, hasAuth: boolean): string {
  return `${scheme}://${hasAuth ? '***:***@' : ''}${hostPort(host, port)}`
}

/**
 * Remove secrets from free text such as an upstream error message.
 *
 * Masks every `scheme://userinfo@` and every literal secret value passed in.
 * @param text - text to clean.
 * @param secrets - literal values to mask.
 * @returns the cleaned text.
 */
export function scrub(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***:***@')
  for (const secret of secrets) {
    if (secret.length >= 3) out = out.split(secret).join('***')
  }
  return out
}

/** Whether a host names this machine; loopback never leaves it, so no exit applies. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(host)?.[1]
  if (mapped !== undefined) return (Number.parseInt(mapped, 16) >>> 8) === 127
  const v4 = host.startsWith('::ffff:') ? host.slice(7) : host
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4) && isIPv4(v4)
}