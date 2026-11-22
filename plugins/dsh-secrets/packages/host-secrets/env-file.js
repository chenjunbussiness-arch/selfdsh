/**
 * Read `KEY=value` pairs from a dotenv file, for the master passphrase.
 *
 * Lookup order for a name (see createEnvSource):
 *   1. the process environment (non-empty value wins: systemd EnvironmentFile,
 *      shell export);
 *   2. the configured env file (default <DSH home>/.env).
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

/**
 * An object usable as `env` for the Vault: `source[NAME]` returns the
 * process value, else the file value, else undefined.
 * @param {{ file: string | null, env?: Record<string, string | undefined>, logger?: any, platform?: string }} options
 */
export function createEnvSource({ file, env = process.env, logger, platform = process.platform }) {
  let cache = { key: '', values: new Map() }
  let warned = false
  const fromFile = (name) => {
    if (file === null || file === undefined) return undefined
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
