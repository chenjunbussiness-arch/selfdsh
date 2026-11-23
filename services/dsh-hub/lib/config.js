/**
 * Configuration of dsh-hub: `<DSH home>/agent-hub/hub.json` (DSH home =
 * $DSH_HOME or ~/.dsh). The state directory is fixed to that same folder.
 *
 *   { "port": 7891, "host": "0.0.0.0", "tls": { "cert": "...", "key": "..." },
 *     "allow": ["203.0.113.7/32", "10.0.0.0/8", "2001:db8::1"], "trustProxy": false,
 *     "maxRetries": 2, "offlineAfterMs": 90000, "sweepIntervalMs": 15000,
 *     "maxResultBytes": 20971520 }
 *
 * The environment variable DSH_HUB_PORT overrides `port`.
 *
 * Default port 7891, not 7890: 7890 is the local HTTP proxy port of Clash /
 * mihomo on the workstation (MYDESK), and the two must not be confused.
 *
 * @module dsh-hub/config
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { compileAllow, DEFAULT_MAX_RESULT_BYTES, resolveListenHost } from './http.js'

export const DEFAULT_PORT = 7891
export const CONFIG_KEYS = ['port', 'host', 'tls', 'allow', 'trustProxy', 'maxRetries', 'offlineAfterMs', 'sweepIntervalMs', 'maxResultBytes', 'fallback', 'mcp']

/** A configuration problem: the service must not start (exit code 78, EX_CONFIG). */
export class ConfigError extends Error {}

/** <DSH home>: $DSH_HOME, else ~/.dsh. */
export function dshHome(env = {}, home = homedir()) {
  return typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : join(home, '.dsh')
}

/** Fixed state directory: <DSH home>/agent-hub. */
export function stateDir(env = {}, home = homedir()) { return join(dshHome(env, home), 'agent-hub') }

function integer(raw, key, min, max, fallback) {
  if (raw === undefined) return fallback
  if (!Number.isInteger(raw) || raw < min || raw > max) throw new ConfigError(`hub.json: ${key} must be an integer ${min}..${max}`)
  return raw
}

/**
 * Validate a parsed hub.json (plus env overrides). Relative tls paths are
 * resolved against `dir` (the state directory).
 * @returns {{ config: object, warnings: string[] }}
 */
export function resolveConfig(raw = {}, { env = {}, dir = '.' } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('hub.json must be a JSON object')
  const warnings = Object.keys(raw).filter(k => !CONFIG_KEYS.includes(k)).map(k => `hub.json: unknown key "${k}" ignored`)

  let port = integer(raw.port, 'port', 1, 65535, DEFAULT_PORT)
  if (env.DSH_HUB_PORT !== undefined && env.DSH_HUB_PORT !== '') {
    const n = Number(env.DSH_HUB_PORT)
    if (!/^[0-9]+$/.test(String(env.DSH_HUB_PORT)) || !Number.isInteger(n) || n < 1 || n > 65535) throw new ConfigError('DSH_HUB_PORT must be an integer 1..65535')
    port = n
  }

  if (raw.host !== undefined && (typeof raw.host !== 'string' || raw.host.trim() === '')) throw new ConfigError('hub.json: host must be a non-empty string')
  const host = raw.host?.trim()

  let tls
  if (raw.tls !== undefined && raw.tls !== null) {
    const t = raw.tls
    if (typeof t !== 'object' || typeof t.cert !== 'string' || t.cert === '' || typeof t.key !== 'string' || t.key === '') {
      throw new ConfigError('hub.json: tls needs both "cert" and "key" (file paths)')
    }
    const abs = p => (isAbsolute(p) ? p : resolve(dir, p))
    tls = { cert: abs(t.cert), key: abs(t.key) }
  }

  const allow = raw.allow ?? []
  try { compileAllow(allow) } catch (error) { throw new ConfigError(`hub.json: ${error.message}`) }

  if (raw.trustProxy !== undefined && typeof raw.trustProxy !== 'boolean') throw new ConfigError('hub.json: trustProxy must be true or false')

  const fb = raw.fallback ?? {}
  if (typeof fb !== 'object' || Array.isArray(fb) || fb === null) throw new ConfigError('hub.json: fallback must be an object')
  if (fb.enabled !== undefined && typeof fb.enabled !== 'boolean') throw new ConfigError('hub.json: fallback.enabled must be true or false')
  if (fb.noFallbackCapabilities !== undefined && (!Array.isArray(fb.noFallbackCapabilities) || fb.noFallbackCapabilities.some(c => typeof c !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(c)))) {
    throw new ConfigError('hub.json: fallback.noFallbackCapabilities must be a list of capability names')
  }
  const mcp = raw.mcp ?? {}
  if (typeof mcp !== 'object' || Array.isArray(mcp) || mcp === null || (mcp.enabled !== undefined && typeof mcp.enabled !== 'boolean')) throw new ConfigError('hub.json: mcp must be {"enabled": true|false}')

  const config = {
    fallback: { enabled: fb.enabled !== false, noFallbackCapabilities: fb.noFallbackCapabilities ?? ['quick'] },
    mcp: { enabled: mcp.enabled !== false },
    port, host, tls, allow: [...allow], trustProxy: raw.trustProxy === true,
    maxRetries: integer(raw.maxRetries, 'maxRetries', 0, 20, 2),
    offlineAfterMs: integer(raw.offlineAfterMs, 'offlineAfterMs', 1000, 7 * 86400_000, 90_000),
    sweepIntervalMs: integer(raw.sweepIntervalMs, 'sweepIntervalMs', 1000, 3600_000, 15_000),
    maxResultBytes: integer(raw.maxResultBytes, 'maxResultBytes', 64 * 1024, 1024 * 1024 * 1024, DEFAULT_MAX_RESULT_BYTES),
  }
  try { config.host = resolveListenHost(config) } catch (error) { throw new ConfigError(error.message) }
  if (config.tls && config.allow.length === 0) warnings.push('hub.json: no "allow" list - any address can reach the hub (tokens are still required)')
  if (config.trustProxy && config.tls) warnings.push('hub.json: trustProxy with tls - X-Forwarded-For is trusted, make sure only your proxy can connect')
  return { config, warnings }
}

/** Read and validate <state dir>/hub.json (missing file = defaults). */
export async function loadConfig({ env = {}, home = homedir() } = {}) {
  const dir = stateDir(env, home)
  const path = join(dir, 'hub.json')
  let raw = {}
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new ConfigError(`cannot read ${path}: ${error instanceof SyntaxError ? 'not valid JSON' : error.message}`)
  }
  return { ...resolveConfig(raw, { env, dir }), dir, path }
}

/**
 * Warning text when a TLS private key file is readable by group or others
 * (POSIX only; Windows has no meaningful mode bits), else undefined.
 */
export function keyModeWarning(mode, platform, path) {
  if (platform === 'win32' || !Number.isInteger(mode)) return undefined
  if ((mode & 0o077) === 0) return undefined
  return `tls.key ${path} is accessible by group/others (mode ${(mode & 0o777).toString(8).padStart(3, '0')}); run: chmod 600 ${path}`
}

/**
 * Startup check of tls.key permissions. Only the path is configured; the key
 * itself is read by the TLS stack, the hub never asks for a passphrase.
 * @returns {Promise<string | undefined>} a warning, if any
 */
export async function checkTlsKey(path, { platform = process.platform, statFn = stat } = {}) {
  let info
  try {
    info = await statFn(path)
  } catch (error) {
    throw new ConfigError(`tls.key ${path} cannot be read: ${error?.code ?? error?.message ?? error}`)
  }
  if (typeof info.isFile === 'function' && !info.isFile()) throw new ConfigError(`tls.key ${path} is not a file`)
  return keyModeWarning(info.mode, platform, path)
}
