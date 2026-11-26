/**
 * Path rules: which files may be shared, where uploads may land, and how an
 * uploaded file is named.
 *
 * A path is allowed only when its real path (symlinks resolved) lies inside the
 * real path of an allowed root, no segment below the root matches a deny
 * pattern, and it is not inside `<DSH home>` (except the upload inbox and the
 * agent-hub task outputs). Roots that are too broad (`/`, the home directory,
 * `<DSH home>` or one of its parents) are never used.
 *
 * @module dsh-host-fileshare/paths
 */

import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

/** Names never shared or written, matched against every segment below the root (case-insensitive, `*` = any run). */
export const DEFAULT_DENY = Object.freeze([
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.git', '.svn', '.hg',
  '.env', '.env.*', '*.env', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.htpasswd', '.dsh-auth',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.kdbx', '*.ovpn',
  'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', 'authorized_keys', 'known_hosts',
  'secrets.*', 'credentials', 'credentials.json', 'tokens', '*.token', 'shadow', 'passwd',
])

const patternCache = new Map()
function patternRe(pattern) {
  let re = patternCache.get(pattern)
  if (re === undefined) {
    const body = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    re = new RegExp(`^${body}$`, 'i')
    patternCache.set(pattern, re)
  }
  return re
}

/**
 * The first deny pattern matching a segment of `rel` (a path relative to a root), or undefined.
 * @param {string} rel
 * @param {readonly string[]} deny
 */
export function deniedBy(rel, deny) {
  for (const segment of rel.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue
    for (const pattern of deny) if (patternRe(pattern).test(segment)) return pattern
  }
  return undefined
}

/** `child` equals `parent` or lies below it (both absolute, normalized). */
export function isInside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Whether a directory is too broad to be a root.
 * @param {string} dir - real path.
 * @param {string} dshHome - real path (or resolved path when it does not exist).
 */
export function tooBroad(dir, dshHome) {
  if (parse(dir).root === dir) return true
  if (dir === homedir()) return true
  if (isInside(dir, dshHome)) return true // dshHome itself or one of its parents
  return false
}

async function realOrNull(path) {
  try { return await realpath(path) } catch { return null }
}

/**
 * Resolve the effective roots: configured roots, the upload inbox, optionally
 * the session cwd, each as a real path, dropping missing and too-broad ones.
 * @param {{ roots: string[], inboxDir: string, dshHome: string }} config
 * @param {string[]} [extra] - session cwds.
 * @returns {Promise<{ roots: string[], dropped: { path: string, reason: string }[] }>}
 */
export async function effectiveRoots(config, extra = []) {
  const dshHome = (await realOrNull(config.dshHome)) ?? resolve(config.dshHome)
  const roots = []
  const dropped = []
  const inbox = await realOrNull(config.inboxDir)
  if (inbox !== null) roots.push(inbox)
  for (const candidate of [...config.roots, ...extra]) {
    const real = await realOrNull(candidate)
    if (real === null) { dropped.push({ path: candidate, reason: 'missing' }); continue }
    if (tooBroad(real, dshHome)) { dropped.push({ path: candidate, reason: 'too broad' }); continue }
    if (isInside(dshHome, real) && real !== inbox) { dropped.push({ path: candidate, reason: 'inside DSH home' }); continue }
    if (!roots.includes(real)) roots.push(real)
  }
  return { roots, dropped }
}

/**
 * Check that `real` (a real path) may be read or written under `roots`.
 * @returns {{ ok: true, root: string, rel: string } | { ok: false, reason: string }}
 */
export function checkAllowed(real, roots, deny) {
  const root = roots.filter(candidate => isInside(candidate, real)).sort((a, b) => b.length - a.length)[0]
  if (root === undefined) return { ok: false, reason: 'outside every allowed directory' }
  const rel = relative(root, real)
  const pattern = deniedBy(rel, deny)
  if (pattern !== undefined) return { ok: false, reason: `name matches deny pattern ${pattern}` }
  return { ok: true, root, rel }
}

/**
 * Resolve a file to share.
 * @param {string} input - path from the caller (absolute, or relative to `cwd`).
 * @param {{ cwd?: string, roots: string[], deny: readonly string[] }} options
 * @returns {Promise<{ ok: true, real: string, size: number, mtimeMs: number, root: string, rel: string } | { ok: false, reason: string }>}
 */
export async function resolveShareable(input, { cwd, roots, deny }) {
  if (typeof input !== 'string' || input.trim() === '') return { ok: false, reason: 'path is empty' }
  if (input.includes('\0')) return { ok: false, reason: 'path contains a NUL byte' }
  const expanded = input.replace(/^~(?=$|[\\/])/, homedir())
  if (!isAbsolute(expanded) && cwd === undefined) return { ok: false, reason: 'relative path but no working directory; give an absolute path' }
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
  const real = await realOrNull(absolute)
  if (real === null) return { ok: false, reason: 'file not found' }
  const info = await stat(real)
  if (info.isDirectory()) return { ok: false, reason: 'is a directory; pack it first (e.g. tar czf out.tgz dir/) and share the archive' }
  if (!info.isFile()) return { ok: false, reason: 'not a regular file' }
  const allowed = checkAllowed(real, roots, deny)
  if (!allowed.ok) return allowed
  return { ok: true, real, size: info.size, mtimeMs: info.mtimeMs, root: allowed.root, rel: allowed.rel }
}

/**
 * Resolve (and later create) an upload directory. The nearest existing
 * ancestor must already be inside a root.
 * @returns {Promise<{ ok: true, dir: string, root: string, rel: string } | { ok: false, reason: string }>}
 */
export async function resolveUploadDir(input, { cwd, roots, deny }) {
  if (typeof input !== 'string' || input.trim() === '' || input.includes('\0')) return { ok: false, reason: 'dir is empty' }
  const expanded = input.replace(/^~(?=$|[\\/])/, homedir())
  if (!isAbsolute(expanded) && cwd === undefined) return { ok: false, reason: 'relative dir but no working directory; give an absolute path' }
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
  let existing = absolute
  const missing = []
  for (;;) {
    const real = await realOrNull(existing)
    if (real !== null) {
      const info = await stat(real)
      if (!info.isDirectory()) return { ok: false, reason: 'not a directory' }
      const target = missing.length === 0 ? real : join(real, ...missing.reverse())
      const allowed = checkAllowed(target, roots, deny)
      if (!allowed.ok) return allowed
      return { ok: true, dir: target, root: allowed.root, rel: allowed.rel }
    }
    const parent = dirname(existing)
    if (parent === existing) return { ok: false, reason: 'no existing parent directory' }
    missing.push(basename(existing))
    existing = parent
  }
}

const RESERVED_WIN = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i

/**
 * Turn a client-supplied name into a safe single file name, or undefined.
 * @param {string} raw
 */
export function safeFileName(raw) {
  if (typeof raw !== 'string') return undefined
  let name = raw.normalize('NFC').split(/[\\/]/).pop() ?? ''
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim()
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (name === '' || RESERVED_WIN.test(name)) return undefined
  while (Buffer.byteLength(name, 'utf8') > 200) {
    const ext = extname(name)
    const stem = name.slice(0, name.length - ext.length)
    name = stem.length > 1 ? stem.slice(0, -1) + ext : name.slice(0, -1)
  }
  return name
}

/** `name`, `name (1)`, `name (2)`… : the n-th candidate when `name` is taken. */
export function numbered(name, n) {
  if (n === 0) return name
  const ext = extname(name)
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`
}
