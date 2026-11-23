/**
 * Tiny `.env` reader for the controller token (no third-party dependency).
 *
 * Format (one variable per line):
 *
 *     # comment lines and blank lines are ignored
 *     DSH_HUB_TOKEN=dshc_dsh-cloud_xxxxxxxx
 *     export DSH_HUB_TOKEN="dshc_dsh-cloud_xxxxxxxx"   # `export ` prefix ignored, quotes optional
 *     OTHER='single quotes work too'
 *
 * Rules:
 *   - key: `[A-Za-z_][A-Za-z0-9_]*`, whitespace around `=` and the value is trimmed;
 *   - a value wrapped in matching '...' or "..." is taken literally (no escapes);
 *   - an unquoted value ends at the first ` #` (whitespace + `#` starts a comment);
 *     `KEY=   # comment` is an EMPTY value (= not set), not the text `# comment`;
 *   - text after a closing quote is ignored only if it is a comment;
 *   - malformed lines are skipped; the LAST definition of a key wins;
 *   - a UTF-8 BOM and CRLF line endings are accepted.
 *
 * Values are never logged here; callers only learn which keys exist.
 *
 * Which file: `<DSH home>/agent-hub/controller.env` by default (config `envFile`).
 * Do NOT point it at `<DSH home>/.env` with a `DSH_*` variable: that is DSH's own
 * credential file, and DSH refuses to start when it contains any `DSH_*` line
 * ("only the launching environment may set" those). hub-client.js skips such a
 * file and warns; this reader itself does not care which path it gets.
 *
 * @module host-agent-hub/env-file
 */

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Parse `.env` text into a plain object (prototype-free, so `__proto__` is just a key).
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  const out = Object.create(null)
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)
  for (const rawLine of lines) {
    let line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (/^export\s+/.test(line)) line = line.replace(/^export\s+/, '')
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!KEY_RE.test(key)) continue
    let value = line.slice(eq + 1).trim()
    const quote = value[0]
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1)
      if (end < 0) continue // unterminated quote: skip the line rather than guess
      const rest = value.slice(end + 1).trim()
      if (rest !== '' && !rest.startsWith('#')) continue
      value = value.slice(1, end)
    } else if (value.startsWith('#')) {
      value = '' // `KEY=   # comment`: empty value, the rest is a comment
    } else {
      const hash = value.search(/\s#/)
      if (hash >= 0) value = value.slice(0, hash).trimEnd()
    }
    out[key] = value
  }
  return out
}

/**
 * Read one `.env` file.
 *
 * @param {string} path
 * @param {{ fs: { readFileSync: Function, statSync: Function }, platform?: string }} deps
 * @returns {{ exists: boolean, values: Record<string, string>, warning?: string }}
 *   A missing file is `{ exists: false }` with no warning (silently skipped).
 *   On POSIX a file readable by group or others (mode & 0o044) gets a warning,
 *   but is still used. Other read errors give a warning and no values.
 */
export function readEnvFile(path, { fs, platform = globalThis.process?.platform } = {}) {
  const empty = Object.create(null)
  let stat
  try {
    stat = fs.statSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { exists: false, values: empty }
    return { exists: false, values: empty, warning: `cannot read envFile ${path}: ${error?.code ?? 'error'}` }
  }
  if (typeof stat.isFile === 'function' && !stat.isFile()) return { exists: false, values: empty, warning: `envFile ${path} is not a regular file` }
  let warning
  if (platform !== 'win32' && typeof stat.mode === 'number' && (stat.mode & 0o044) !== 0) {
    warning = `envFile ${path} is readable by group or others (mode ${(stat.mode & 0o777).toString(8).padStart(3, '0')}); run: chmod 600 ${path}`
  }
  let text
  try {
    text = fs.readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, values: empty }
    return { exists: false, values: empty, warning: `cannot read envFile ${path}: ${error?.code ?? 'error'}` }
  }
  return { exists: true, values: parseEnvFile(text), warning }
}
