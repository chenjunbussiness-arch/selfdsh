/**
 * Read `KEY=value` pairs from a dotenv file, for the master passphrase.
 *
 * Lookup order for a name (see createEnvSource):
 *   1. the process environment (non-empty value wins: systemd EnvironmentFile,
 *      shell export);
 *   2. the configured env file (default <DSH home>/secrets.env).
 *
 * Never `<DSH home>/.env` for a `DSH_*` name: that file is DSH's own credential
 * file, and DSH refuses to start when it sets ANY `DSH_*` variable ("only the
 * launching environment may set" those). When `file` is `<DSH home>/.env`
 * (compared normalized, case-insensitively, `\` == `/`), lookups of `DSH_*`
 * names (e.g. DSH_SECRETS_PASSPHRASE) never touch the file, and one warning
 * (no value) explains how to migrate. Other names are still read from it.
 *
 * The file is re-read when its mtime or size changes, so editing .env does not
 * need a restart. A missing file is silently skipped. On POSIX a file readable
 * by group/other is still used, but a warning (without any value) is logged
 * once. No value is ever logged.
 *
 * Format: `KEY=value` per line; blank lines and `# comments` are ignored; an
 * optional `export ` prefix is accepted; a value may be wrapped in single or
 * double quotes (double quotes understand \n \r \t \" \\); an unquoted value
 * ends at ` #` (inline comment) and is trimmed.
 *
 * @module dsh-host-secrets/env-file
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const GROUP_OTHER_BITS = 0o077

/**
 * Parse dotenv text. Later lines override earlier ones.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseEnvFile(text) {
  const out = new Map()
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/)
  for (const raw of lines) {
    let line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice(7).trimStart()
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const name = line.slice(0, eq).trim()
    if (!NAME_RE.test(name)) continue
    let value = line.slice(eq + 1).trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.length >= 2) {
      const end = value.lastIndexOf(quote)
      if (end > 0) {
        value = value.slice(1, end)
        if (quote === '"') {
          value = value.replace(/\\([nrt"\\])/g, (_m, c) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[c])
        }
        out.set(name, value)
        continue
      }
    }
    const hash = value.search(/\s#/)
    if (hash >= 0) value = value.slice(0, hash)
    out.set(name, value.trim())
  }
  return out
}

/** DSH reserves every `DSH_*` name for the launching environment (case-insensitive, as on Windows). */
export const RESERVED_ENV_RE = /^DSH_/i

/**
 * Comparable form of a path: `\` -> `/`, empty / `.` segments dropped, `..` applied,
 * no trailing separator, lower case (Windows paths are case-insensitive).
 * @param {string} path
 */
export function comparablePath(path) {
  const text = String(path ?? '').trim().replace(/\\/g, '/')
  const absolute = text.startsWith('/')
  const out = []
  for (const segment of text.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length > 0 && out.at(-1) !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(segment)
  }
  return `${absolute ? '/' : ''}${out.join('/')}`.toLowerCase()
}

/** True when `file` is `<dshHome>/.env`, DSH's own credential file. */
export function isDshDotEnv(file, dshHome) {
  if (typeof file !== 'string' || file === '' || typeof dshHome !== 'string' || dshHome === '') return false
  return comparablePath(file) === comparablePath(join(dshHome, '.env'))
}

/** The one-time warning for a DSH_* name configured to come from `<DSH home>/.env` (never a value). */
export function reservedEnvWarning(file, name, dshHome) {
  return `dsh-secrets: ${name} is NOT read from ${file}: that is DSH's own <DSH home>/.env, and DSH refuses to start when it sets any DSH_* variable`
    + ` (DSH 不允许 <DSH home>/.env 里出现 DSH_ 开头的变量，会拒绝启动). Move the ${name}=... line to ${join(dshHome, 'secrets.env')}`
    + ` (the default envFile; chmod 600) or export ${name} in the service environment, and remove it from ${file}.`
}

/**
 * An object usable as `env` for the Vault: `source[NAME]` returns the
 * process value, else the file value, else undefined.
 * `dshHome` enables the `<DSH home>/.env` guard; `names` (e.g. [passphraseEnv])
 * are checked at once, so the guard warning appears at startup, not at first use.
 * @param {{ file: string | null, env?: Record<string, string | undefined>, logger?: any, platform?: string, dshHome?: string, names?: string[] }} options
 */
export function createEnvSource({ file, env = process.env, logger, platform = process.platform, dshHome, names = [] }) {
  let cache = { key: '', values: new Map() }
  let warned = false
  const guarded = isDshDotEnv(file, dshHome)
  let reservedWarned = false
  const warnReserved = (name) => {
    if (reservedWarned) return
    reservedWarned = true
    try { logger?.warn?.(reservedEnvWarning(file, name, dshHome)) } catch { /* ignore */ }
  }
  for (const name of names) if (guarded && typeof name === 'string' && RESERVED_ENV_RE.test(name)) warnReserved(name)
  const fromFile = (name) => {
    if (file === null || file === undefined) return undefined
    if (guarded && RESERVED_ENV_RE.test(name)) {
      warnReserved(name)
      return undefined // DSH's own .env: never read for DSH_* names
    }
    let info
    try {
      info = statSync(file)
    } catch (error) {
      if (error?.code !== 'ENOENT') logger?.warn?.(`dsh-secrets: cannot stat env file ${file}: ${error?.code ?? 'error'}`)
      cache = { key: '', values: new Map() }
      return undefined
    }
    if (!info.isFile()) return undefined
    if (!warned && platform !== 'win32' && (info.mode & GROUP_OTHER_BITS) !== 0) {
      warned = true
      logger?.warn?.(`dsh-secrets: env file ${file} is readable by group/other; run "chmod 600 ${file}"`)
    }
    const key = `${info.mtimeMs}:${info.size}`
    if (key !== cache.key) {
      try {
        cache = { key, values: parseEnvFile(readFileSync(file, 'utf8')) }
      } catch (error) {
        logger?.warn?.(`dsh-secrets: cannot read env file ${file}: ${error?.code ?? 'error'}`)
        cache = { key: '', values: new Map() }
      }
    }
    return cache.values.get(name)
  }
  return new Proxy(Object.create(null), {
    get(_target, name) {
      if (typeof name !== 'string') return undefined
      const live = env[name]
      if (typeof live === 'string' && live !== '') return live
      return fromFile(name)
    },
    has(_target, name) {
      return typeof name === 'string' && (typeof env[name] === 'string' || fromFile(name) !== undefined)
    },
  })
}
