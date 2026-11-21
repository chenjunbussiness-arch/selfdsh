#!/usr/bin/env node
/**
 * scan-keys.mjs — read-only key inventory generator.
 *
 * Walks a directory tree, finds files that plausibly hold credentials, parses
 * them, and writes a Markdown table of *metadata only*: path, name, suspected
 * type, file size, mtime, length bucket, sha256 prefix, duplicate marker and a
 * suggested project. Plaintext values never leave this process: they are only
 * hashed and measured, and the generated document is audited against every
 * value substring before it is written.
 *
 * Supported inputs:
 *   .env / .env.* / *.env      KEY=VALUE (quoted values, inline comments)
 *   *.json                     nested objects/arrays, key-ish field names only
 *   credentials*               JSON, YAML/ini `name: value` / `name=value`
 *   *.pem / *.key              whole file = one entry (likely private key)
 *   *.crt                      whole file = one entry (certificate)
 *
 * Skipped: node_modules/.git/.venv/vendor/__pycache__/cache dirs, symbolic
 * links (never followed), files over 5 MiB (metadata only, no parsing), and
 * example files such as .env.example. A file that fails to read/parse is
 * counted and skipped; one bad file never aborts the run.
 *
 * Usage:
 *   node scripts/scan-keys.mjs [root] [--out FILE]
 *   node scripts/scan-keys.mjs [root] --audit FILE
 *
 * Security:
 *   - the inventory and stdout contain no values, value prefixes/suffixes or
 *     masked fragments — only names, types, length buckets and sha256[:8];
 *   - parse errors are reported with an error code, never a parser message
 *     (V8 messages can quote a snippet of the input);
 *   - `--audit` re-scans and asserts that no 8-character window of any value
 *     appears in the inventory outside the metadata corpus; the normal run
 *     performs the same audit in memory before writing.
 */

import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

// A closed pipe (e.g. `| head`) must not crash the scanner after the inventory
// has already been written; it is a normal shell condition, not an error.
process.stdout.on('error', error => {
  if (error?.code === 'EPIPE') process.exit(0)
})
process.stderr.on('error', error => {
  if (error?.code === 'EPIPE') process.exit(0)
})

const DEFAULT_ROOT = '/srv/workspace'
const MAX_PARSE_BYTES = 5 * 1024 * 1024
const CONCURRENCY = 8
const MAX_JSON_DEPTH = 32
const MAX_NAME_LEN = 200
const AUDIT_WINDOW = 8
const AUDIT_MAX_WINDOWS = 3000000
const AUDIT_MAX_VALUE_BYTES = 256 * 1024
const VERSION = '1.0.0'

// Directory names that never contain user key material and are expensive to
// walk. Matched case-insensitively against the basename.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.venv', 'venv', 'virtualenv',
  '.tox', 'vendor', 'bower_components', 'jspm_packages', '__pycache__',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.cache', 'caches',
  '.npm', '.pnpm-store', '.yarn', '.turbo', '.parcel-cache', '.next',
  '.nuxt', '.svelte-kit', '.gradle', 'coverage',
])

// Source/compiled files whose names start with "credentials" but which are
// code, not credential stores (credentials.ts, credentials.py, ...).
const SOURCE_LIKE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.map', '.py', '.pyc', '.pyo',
  '.go', '.rs', '.java', '.class', '.rb', '.php', '.cs', '.c', '.cc', '.cpp',
  '.h', '.hpp', '.m', '.mm', '.swift', '.kt', '.kts', '.scala', '.sh', '.bash',
  '.zsh', '.ps1', '.sql', '.html', '.css', '.scss', '.less', '.o', '.so',
  '.dylib', '.dll', '.exe', '.bin',
])

// Field names that look like key material. Deliberately narrower than "any
// name containing token": pricing/cache JSON is full of max_tokens,
// input_tokens, token_count and source.key fields, which are not credentials.
function isKeyishName(name) {
  const lower = name.toLowerCase()
  if (/(api[_-]?key|apikey|access[_-]?key|private[_-]?key|secret[_-]?key|auth[_-]?key|client[_-]?secret|client[_-]?key|session[_-]?key|encryption[_-]?key|signing[_-]?key|master[_-]?key)/.test(lower)) return true
  if (/password|passwd|passphrase|credential|bearer/.test(lower)) return true
  if (/(^|[._-])pwd($|[._-])/.test(lower)) return true
  if (/(^|[._-])secret($|[._-]|value|key)/.test(lower)) {
    return !/^secrets?[_-]?(name|id|arn|path|ref)$/.test(lower)
  }
  if (/(cost|price|rate|usage)/.test(lower) && /token/.test(lower)) return false
  if (/(count|limit|budget|length|size|per)[_-]?tokens?$/.test(lower)) return false
  if (/tokens?[_-]?(count|limit|budget|length|size)/.test(lower)) return false
  if (/(^|[._-])(access|refresh|auth|api|bot|bearer|session|csrf|verification|reset|id|jwt)[_-]?token($|[._-])/.test(lower)) return true
  if (/(^|[._-])token$/.test(lower)) return true
  // camelCase singular: myToken / placeholderToken. Plural *Tokens is almost
  // always a count/limit field and stays excluded.
  if (/[a-z0-9]Token(Value|Secret|Key)?$/.test(name)) return true
  if (/^token(value|secret|key)?$/.test(lower)) return true
  return false
}

// Cheap pre-filter: only JSON whose raw text mentions something key-ish is
// parsed at all (requirement: include JSON only when it has key-ish config).
const KEYISH_CONTENT_RE = /api[_-]?key|apikey|access[_-]?key|private[_-]?key|secret|token|password|passwd|pwd|credential|passphrase/i

const DB_CONTEXT_RE = /(db|database|mysql|mariadb|postgres|postgresql|redis|mongo|mongodb|sql|odbc|jdbc)/

const PLACEHOLDER_WORDS = new Set([
  'changeme', 'change', 'replaceme', 'placeholder', 'placeholderkey',
  'placeholderpassword', 'yourkey', 'yourkeyhere', 'yourapikey',
  'yourapikeyhere', 'yoursecret', 'yourtoken', 'yourpassword',
  'insertkeyhere', 'insertyourkeyhere', 'insertapikeyhere', 'putyourkeyhere',
  'addyourkeyhere', 'pasteyourkeyhere', 'replacewithyourkey',
  'notreal', 'notarealkey', 'notarealsecret', 'notarealtoken',
  'example', 'examplekey', 'exampletoken', 'examplesecret', 'samplekey',
  'sampletoken', 'samplessecret', 'dummy', 'dummykey', 'dummytoken',
  'fake', 'fakekey', 'faketoken', 'fakesecret', 'placeholderhere',
  'todo', 'tbd', 'fixme', 'none', 'null', 'nil', 'undefined', 'redacted',
  'removed', 'hidden', 'masked', 'secret', 'password', 'passwd', 'pwd',
  'token', 'apikey', 'key', 'value', 'empty', 'test', 'testkey',
])

const USAGE = `用法：
  node scripts/scan-keys.mjs [root] [--out FILE]
  node scripts/scan-keys.mjs [root] --audit FILE

参数：
  root                 扫描根目录，默认 ${DEFAULT_ROOT}
  --out FILE           把 Markdown 清单写到 FILE；省略则输出到 stdout
  --audit FILE         自检模式：重新扫描 root，检查 FILE 中是否出现任何
                       值片段；不生成清单。发现片段时退出码 4。
  --verbose            在 stderr 打印各阶段耗时与计数（不含任何值）
  -h, --help           显示本帮助

扫描范围（递归，不跟随符号链接）：
  .env / .env.* / *.env、*.json、credentials*、*.pem、*.key、*.crt
  跳过 node_modules/.git/.venv/vendor/__pycache__/缓存目录；
  超过 5MB 的文件只记大小与时间，不解析内容；
  单文件读取/解析失败只计数并跳过，不中断全量扫描。

输出列：
  文件路径、名字、疑似类型、文件大小、最后修改时间(UTC)、
  长度桶（1-15/16-31/32-63/64-127/128+）、值 sha256 前 8 位、
  疑似重复（同组 dup-1、dup-2…）、建议项目。

安全：
  清单与终端输出只允许出现名字、类型、长度桶和 sha256 前 8 位；不会输出
  任何真实值、值前缀/后缀或掩码片段。脚本不写被扫描文件，也不接触 vault。

退出码：
  0 成功；2 参数或根目录错误；3 写文件失败；4 防泄漏自检失败
`

class UsageError extends Error {}

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const options = { root: null, out: null, audit: null, help: false, verbose: false }
  const valueFlags = { '--out': 'out', '--audit': 'audit' }
  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i]
    if (flag === '--help' || flag === '-h') { options.help = true; continue }
    if (flag === '--verbose') { options.verbose = true; continue }
    if (flag.startsWith('-') && !flag.startsWith('--')) throw new UsageError(`未知参数：${flag}\n\n${USAGE}`)
    if (flag.startsWith('--')) {
      let value
      const eq = flag.indexOf('=')
      if (eq !== -1) {
        value = flag.slice(eq + 1)
        flag = flag.slice(0, eq)
      }
      const field = valueFlags[flag]
      if (field === undefined) throw new UsageError(`未知参数：${flag}\n\n${USAGE}`)
      if (value === undefined) {
        value = argv[++i]
        if (value === undefined) throw new UsageError(`${flag} 需要一个值\n\n${USAGE}`)
      }
      if (value === '') throw new UsageError(`${flag} 的值不能为空`)
      if (options[field] !== null) throw new UsageError(`${flag} 只能出现一次`)
      options[field] = value
      continue
    }
    if (options.root !== null) throw new UsageError(`多余的位置参数：${flag}\n\n${USAGE}`)
    options.root = flag
  }
  if (options.out !== null && options.audit !== null) {
    throw new UsageError('--out 与 --audit 不能同时使用')
  }
  return options
}

// --- small helpers -----------------------------------------------------------

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

function lengthBucket(length) {
  if (length <= 15) return '1-15'
  if (length <= 31) return '16-31'
  if (length <= 63) return '32-63'
  if (length <= 127) return '64-127'
  return '128+'
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Minute-resolution UTC timestamp; the column header says UTC. */
function formatMtime(date) {
  return date.toISOString().slice(0, 16).replace('T', ' ')
}

function nowStamp() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC'
}

/** One Markdown table cell. Newlines would break the table, pipes need escaping. */
function cell(value, limit = 240) {
  let text = String(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/`/g, "'")
  if (text.length > limit) text = `${text.slice(0, limit - 3)}...`
  return text
}

// --- file classification -----------------------------------------------------

/** True for .env.example / config.sample.json / credentials.template etc. */
function isExampleFile(filename) {
  return /\.(example|sample|template|dist)(\..*)?$/i.test(filename)
}

function kindOf(filename) {
  const lower = filename.toLowerCase()
  if (/^credentials?([._-]|$)/.test(lower)) {
    const ext = extname(lower)
    if (ext && SOURCE_LIKE_EXT.has(ext)) return null
    return 'credentials'
  }
  if (lower === '.env' || lower.startsWith('.env.')) return 'env'
  if (lower.endsWith('.env') && lower.length > 4) return 'env'
  const ext = extname(lower)
  if (ext === '.json') return 'json'
  if (ext === '.pem' || ext === '.key') return 'pem'
  if (ext === '.crt') return 'cert'
  return null
}

const PROJECT_RULES = [
  { re: /xhs/, name: 'XHS' },
  { re: /lumen/, name: 'LUMEN' },
  { re: /googletend/, name: 'GOOGLE_TEND' },
  { re: /deepseekharness/, name: 'DEEPSEEK_HARNESS' },
]

/**
 * Pick the deepest directory segment that matches a known project, so a LUMEN
 * checkout under `google tend/` becomes LUMEN while its siblings stay
 * GOOGLE_TEND.
 */
function suggestProject(relPath) {
  const dirs = relPath.split('/').slice(0, -1)
  for (let i = dirs.length - 1; i >= 0; i--) {
    const normalized = dirs[i].toLowerCase().replace(/[\s._-]+/g, '')
    for (const rule of PROJECT_RULES) {
      if (rule.re.test(normalized)) return rule.name
    }
  }
  return '待定'
}

// --- placeholder filtering ---------------------------------------------------

/**
 * Return a reason when a value is empty/placeholder/sample, else null.
 * Conservative on purpose: a false negative just leaves one row in the list;
 * a false positive would hide a real key.
 */
function placeholderReason(rawValue) {
  const raw = rawValue.trim()
  if (raw === '') return 'empty'
  if (/^<[^<>]*>$/.test(raw)) return 'placeholder'
  if (/^\{\{[^{}]*\}\}$/.test(raw)) return 'placeholder'
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(raw)) return 'placeholder'
  if (/^%[A-Za-z_][A-Za-z0-9_]*%$/.test(raw)) return 'placeholder'
  if (/^\$\([^()]*\)$/.test(raw)) return 'placeholder'
  if (/^(x{3,}|\*{3,}|\.{3,}|_{3,}|-{3,})$/.test(raw)) return 'placeholder'
  if (/^sk-[x*]{4,}$/i.test(raw)) return 'placeholder'
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (normalized === '') return 'placeholder'
  if (PLACEHOLDER_WORDS.has(normalized)) return 'placeholder'
  if (/^x{3,}/.test(normalized)) return 'placeholder'
  if (/^(your|my)(api|access|secret|private|auth)?(key|token|secret|password|passwd|credential)(here)?$/.test(normalized)) {
    return 'placeholder'
  }
  if (/^(insert|put|replace|add|paste)(your)?(api|access|secret|private)?(key|token|secret|password|credential)(here)?$/.test(normalized)) {
    return 'placeholder'
  }
  if (/^(replace|insert|put|add|paste).*(key|token|secret|password)/.test(normalized) && normalized.length <= 64) {
    return 'placeholder'
  }
  if (/^(not|non)(a)?real/.test(normalized)) return 'placeholder'
  if (/^(example|sample|demo|dummy|fake|placeholder|changeme|replaceme)/.test(normalized)) return 'placeholder'
  if (/(example|sample|placeholder|changeme|dummy|fake)/.test(normalized) && normalized.length <= 48) {
    return 'placeholder'
  }
  return null
}

// --- value shape / type inference -------------------------------------------

/** Type inferred from the value shape only; never printed alongside the value. */
function shapeType(value) {
  if (/^-----BEGIN [^-]*CERTIFICATE-----/.test(value)) return 'cert'
  if (/^-----BEGIN [^-]*PRIVATE KEY-----/.test(value)) return 'pem'
  if (/^sk-[A-Za-z0-9_-]{16,}/.test(value)) return 'api-key'
  if (/^(AKIA|ASIA)[A-Z0-9]{12,}/.test(value)) return 'api-key'
  if (/^(gh[pousr]_|github_pat_)/.test(value)) return 'token'
  if (/^xox[baprs]-/.test(value)) return 'token'
  if (/^eyJ[A-Za-z0-9_-]+\./.test(value)) return 'token'
  if (/^(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\//.test(value)) return 'db-url'
  return null
}

function inferType(name, kind, value) {
  if (kind === 'pem') return 'pem'
  if (kind === 'cert') return 'cert'
  const shaped = shapeType(value)
  if (shaped !== null) return shaped
  const lower = name.toLowerCase()
  if (/pass(word|wd|phrase)|(^|[._-])pwd($|[._-])/.test(lower)) {
    return DB_CONTEXT_RE.test(lower) ? 'db-password' : 'password'
  }
  if (/token|jwt|bearer/.test(lower)) return 'token'
  if (/credential/.test(lower)) return 'credential'
  if (/api[_-]?key|apikey|access[_-]?key|private[_-]?key|secret[_-]?key|(^|[._-])key($|[._-])/.test(lower)) {
    return 'api-key'
  }
  if (/secret/.test(lower)) return 'secret'
  if (DB_CONTEXT_RE.test(lower)) return 'credential'
  return kind === 'credentials' ? 'credential' : 'config'
}

// --- scanning ----------------------------------------------------------------

class Semaphore {
  constructor(limit) {
    this.limit = limit
    this.active = 0
    this.waiting = []
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active++
      return
    }
    await new Promise(resolvePromise => this.waiting.push(resolvePromise))
    this.active++
  }

  release() {
    this.active--
    const next = this.waiting.shift()
    if (next) next()
  }
}

function newState() {
  return {
    filesVisited: 0,
    dirsVisited: 0,
    candidates: 0,
    entries: 0,
    empty: 0,
    placeholder: 0,
    emptyFiles: 0,
    malformedLines: 0,
    jsonNoKey: 0,
    tooLarge: [],
    readErrors: [],
    walkErrors: [],
    examples: [],
    symlinks: 0,
    skippedDirs: 0,
    excludedOutput: 0,
  }
}

/**
 * Collect candidate file paths. Directory reads are async and bounded by a
 * semaphore; symbolic links are never followed.
 */
async function walkTree(root, excluded, state) {
  const files = []
  const semaphore = new Semaphore(CONCURRENCY)

  async function visit(dir) {
    await semaphore.acquire()
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
      state.dirsVisited++
    } catch (error) {
      state.walkErrors.push({ path: relative(root, dir) || '.', code: error?.code ?? 'UNKNOWN' })
      semaphore.release()
      return
    }
    semaphore.release()

    const subdirs = []
    for (const dirent of dirents) {
      const full = join(dir, dirent.name)
      if (dirent.isSymbolicLink()) {
        state.symlinks++
        continue
      }
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name.toLowerCase())) {
          state.skippedDirs++
          continue
        }
        subdirs.push(full)
        continue
      }
      if (!dirent.isFile()) continue
      state.filesVisited++
      if (excluded.has(resolve(full))) {
        state.excludedOutput++
        continue
      }
      if (kindOf(dirent.name) !== null) files.push(full)
    }
    await Promise.all(subdirs.map(subdir => visit(subdir)))
  }

  await visit(root)
  return files
}

// --- parsers -----------------------------------------------------------------

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Read a quoted scalar; used for env/YAML/ini values (may contain newlines). */
function readQuoted(text, quote) {
  let value = ''
  for (let i = 1; i < text.length; i++) {
    const char = text[i]
    if (quote === '"' && char === '\\') {
      const next = text[i + 1]
      if (next === undefined) return { error: 'escape' }
      const escapes = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', "'": "'", $: '$' }
      value += escapes[next] ?? next
      i++
      continue
    }
    if (char === quote) return { value, rest: text.slice(i + 1) }
    value += char
  }
  return { error: 'unterminated' }
}

/** First `#` that starts the string or follows whitespace. */
function commentIndex(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '#' && (i === 0 || /\s/.test(text[i - 1]))) return i
  }
  return -1
}

/** Parse one scalar; quoted strings may span lines, unquoted stop at `#`. */
function parseScalar(raw) {
  const text = raw.trim()
  if (text === '') return { empty: true }
  if (text[0] === '"' || text[0] === "'") {
    const quoted = readQuoted(text, text[0])
    if (quoted.error) return { error: quoted.error }
    const rest = quoted.rest.trim()
    if (rest !== '' && !rest.startsWith('#')) return { error: 'trailing' }
    if (quoted.value.trim() === '') return { empty: true }
    return { value: quoted.value }
  }
  const cut = commentIndex(text)
  const value = (cut === -1 ? text : text.slice(0, cut)).trim()
  if (value === '') return { empty: true }
  return { value }
}

/** True when the opening quote is closed (double quotes honour backslashes). */
function hasClosingQuote(text, quote) {
  for (let i = 1; i < text.length; i++) {
    if (quote === '"' && text[i] === '\\') { i++; continue }
    if (text[i] === quote) return true
  }
  return false
}

/**
 * Add one text entry after empty/placeholder filtering. Values stay in this
 * object only long enough to be hashed and audited.
 */
function addEntry(entries, state, fileInfo, name, rawValue, kind) {
  const value = String(rawValue).trim()
  if (value === '') {
    state.empty++
    return
  }
  if (placeholderReason(value) !== null) {
    state.placeholder++
    return
  }
  const digest = sha256Hex(value)
  entries.push({
    rel: fileInfo.rel,
    name,
    type: inferType(name, kind, value),
    size: fileInfo.size,
    mtime: fileInfo.mtime,
    length: value.length,
    bucket: lengthBucket(value.length),
    sha256: digest,
    sha8: digest.slice(0, 8),
    project: fileInfo.project,
    dup: null,
    audit: value,
  })
}

function parseEnv(text, fileInfo, entries, state) {
  const lines = stripBom(text).split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    let line = lines[i].trim()
    if (line === '' || line.startsWith('#')) { i++; continue }
    if (/^export\s+/.test(line)) line = line.slice(7).trim()
    const eq = line.indexOf('=')
    if (eq === -1) { state.malformedLines++; i++; continue }
    const name = line.slice(0, eq).trim()
    if (name === '') { state.malformedLines++; i++; continue }
    let raw = line.slice(eq + 1)
    const trimmed = raw.trim()
    if (trimmed[0] === '"' || trimmed[0] === "'") {
      const quote = trimmed[0]
      let accumulated = trimmed
      // Multi-line quoted value (common for inline PEM blocks). Bounded so a
      // broken quote cannot swallow a whole large file.
      while (!hasClosingQuote(accumulated, quote) && i + 1 < lines.length && accumulated.length < 64 * 1024) {
        i++
        accumulated += `\n${lines[i]}`
      }
      raw = accumulated
    }
    const scalar = parseScalar(raw)
    if (scalar.error) { state.malformedLines++; i++; continue }
    if (scalar.empty) { state.empty++; i++; continue }
    addEntry(entries, state, fileInfo, name, scalar.value, 'env')
    i++
  }
}

/**
 * Recognise the two secret-bundle shapes used by dsh-secrets ingest files:
 *   { "NAME": { "value": "...", "description": "..." }, ... }
 *   [ { "name": "NAME", "value": "...", "description": "..." }, ... ]
 * Those names are arbitrary (AWS_SECRET_ACCESS_KEY, GITEA_8444_PASSWORD, ...),
 * so the normal key-name filter would miss them. Description fields are never
 * treated as values.
 */
function extractSecretBundle(doc) {
  if (Array.isArray(doc)) {
    if (doc.length === 0) return null
    const items = doc.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item))
    if (items.length !== doc.length) return null
    if (!items.every(item => typeof item.name === 'string' && (typeof item.value === 'string' || typeof item.value === 'number'))) {
      return null
    }
    return items.map(item => ({ name: item.name, value: String(item.value) }))
  }
  if (doc === null || typeof doc !== 'object') return null
  const pairs = Object.entries(doc)
  if (pairs.length < 2) return null
  const shaped = pairs.filter(([, value]) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (typeof value.value === 'string' || typeof value.value === 'number'))
  if (shaped.length !== pairs.length) return null
  return shaped.map(([name, value]) => ({ name, value: String(value.value) }))
}

/** Walk a parsed JSON document and yield key-ish scalar fields. */
function collectJsonEntries(doc, fileInfo, entries, state, filterNames) {
  let nodes = 0
  const seen = new Set()

  function visit(node, path, depth) {
    if (depth > MAX_JSON_DEPTH || nodes > 200000) return
    if (node === null) return
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++) {
        visit(node[index], `${path}[${index}]`, depth + 1)
      }
      return
    }
    if (typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)
    nodes++
    for (const [key, value] of Object.entries(node)) {
      const child = path === '' ? key : `${path}.${key}`
      if (value !== null && typeof value === 'object') {
        visit(value, child, depth + 1)
        continue
      }
      if (filterNames && !isKeyishName(key)) continue
      if (typeof value !== 'string' && typeof value !== 'number') continue
      addEntry(entries, state, fileInfo, child, String(value), 'json')
    }
  }

  visit(doc, '', 0)
}

function parseJson(text, fileInfo, entries, state) {
  let doc
  try {
    doc = JSON.parse(stripBom(text))
  } catch {
    // Never surface the V8 message: it can quote a snippet of the input.
    state.readErrors.push({ path: fileInfo.rel, reason: 'JSON 解析失败（不输出解析器详情）' })
    return
  }
  const bundle = extractSecretBundle(doc)
  if (bundle !== null) {
    for (const item of bundle) addEntry(entries, state, fileInfo, item.name, item.value, 'credentials')
    return
  }
  collectJsonEntries(doc, fileInfo, entries, state, true)
}

function parseCredentials(text, fileInfo, entries, state) {
  const trimmed = stripBom(text).trim()
  if (trimmed === '') { state.emptyFiles++; return }

  if (trimmed[0] === '{' || trimmed[0] === '[') {
    let doc
    try {
      doc = JSON.parse(trimmed)
    } catch {
      state.readErrors.push({ path: fileInfo.rel, reason: 'credentials JSON 解析失败（不输出解析器详情）' })
      return
    }
    const bundle = extractSecretBundle(doc)
    if (bundle !== null) {
      for (const item of bundle) addEntry(entries, state, fileInfo, item.name, item.value, 'credentials')
      return
    }
    collectJsonEntries(doc, fileInfo, entries, state, false)
    return
  }

  // A credentials file that is really a PEM block: one entry, like *.pem.
  if (trimmed.startsWith('-----BEGIN')) {
    addFileEntry(entries, state, fileInfo, basename(fileInfo.rel), Buffer.from(text, 'utf8'), 'pem')
    return
  }

  const lines = trimmed.split(/\r?\n/)
  let parsed = 0
  let sawPair = false
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) continue
    if (/^\[.*\]$/.test(line) || line === '---' || line === '...') continue
    if (line.startsWith('- ')) line = line.slice(2).trim()
    const eq = line.indexOf('=')
    const colon = line.indexOf(':')
    let index = -1
    if (eq === -1) index = colon
    else if (colon === -1) index = eq
    else index = Math.min(eq, colon)
    if (index <= 0) { state.malformedLines++; continue }
    sawPair = true
    let name = line.slice(0, index).trim()
    if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
      name = name.slice(1, -1).trim()
    }
    if (name === '') { state.malformedLines++; continue }
    const scalar = parseScalar(line.slice(index + 1))
    if (scalar.error) { state.malformedLines++; continue }
    if (scalar.empty) { state.empty++; continue }
    addEntry(entries, state, fileInfo, name, scalar.value, 'credentials')
    parsed++
  }
  if (parsed === 0 && !sawPair) {
    state.readErrors.push({ path: fileInfo.rel, reason: '未解析出任何 name: value / name=value 条目' })
  }
}

/** Whole-file entry (PEM / certificate / PEM-like credentials file). */
function addFileEntry(entries, state, fileInfo, name, buffer, kind) {
  if (buffer.length === 0) { state.emptyFiles++; return }
  const digest = sha256Hex(buffer)
  // Only text-like file bodies take part in the substring audit; binary DER
  // certificates cannot contribute a printable fragment to a Markdown file.
  const text = buffer.toString('utf8')
  const audit = text.includes('\uFFFD') ? null : text
  entries.push({
    rel: fileInfo.rel,
    name,
    type: kind,
    size: fileInfo.size,
    mtime: fileInfo.mtime,
    length: buffer.length,
    bucket: lengthBucket(buffer.length),
    sha256: digest,
    sha8: digest.slice(0, 8),
    project: fileInfo.project,
    dup: null,
    audit,
  })
}

// --- per-file processing -----------------------------------------------------

async function processFile(fullPath, root, state) {
  const rel = relative(root, fullPath).split('\\').join('/')
  const name = basename(fullPath)
  const kind = kindOf(name)
  if (kind === null) return null

  if (isExampleFile(name)) {
    state.examples.push(rel)
    return null
  }

  let info
  try {
    info = await stat(fullPath)
  } catch (error) {
    state.readErrors.push({ path: rel, reason: `stat 失败（${error?.code ?? 'UNKNOWN'}）` })
    return null
  }
  if (!info.isFile()) return null
  if (info.size > MAX_PARSE_BYTES) {
    state.tooLarge.push({ path: rel, size: info.size })
    return null
  }

  const fileInfo = { rel, size: info.size, mtime: info.mtime, project: suggestProject(rel) }
  const entries = []

  try {
    if (kind === 'pem' || kind === 'cert') {
      const buffer = await readFile(fullPath)
      addFileEntry(entries, state, fileInfo, name, buffer, kind)
      return entries
    }

    const text = await readFile(fullPath, 'utf8')
    if (kind === 'env') parseEnv(text, fileInfo, entries, state)
    else if (kind === 'json') {
      if (!KEYISH_CONTENT_RE.test(text)) {
        state.jsonNoKey++
        return null
      }
      parseJson(text, fileInfo, entries, state)
    } else if (kind === 'credentials') {
      parseCredentials(text, fileInfo, entries, state)
    }
    return entries
  } catch (error) {
    state.readErrors.push({ path: rel, reason: `读取失败（${error?.code ?? 'UNKNOWN'}）` })
    return null
  }
}

async function scanFiles(root, files, state) {
  const entries = []
  let cursor = 0
  async function worker() {
    while (true) {
      const index = cursor++
      if (index >= files.length) return
      const fileEntries = await processFile(files[index], root, state)
      if (fileEntries && fileEntries.length > 0) entries.push(...fileEntries)
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(files.length, 1)) }, () => worker())
  await Promise.all(workers)
  return entries
}

// --- duplicate grouping ------------------------------------------------------

function groupDuplicates(entries) {
  const byHash = new Map()
  for (const entry of entries) {
    const bucket = byHash.get(entry.sha256)
    if (bucket === undefined) byHash.set(entry.sha256, [entry])
    else bucket.push(entry)
  }
  const groups = [...byHash.values()].filter(group => group.length > 1)
  groups.sort((a, b) => b.length - a.length || a[0].sha256.localeCompare(b[0].sha256))
  groups.forEach((group, groupIndex) => {
    group.sort((a, b) => a.rel.localeCompare(b.rel) || a.name.localeCompare(b.name))
    group.forEach((entry, index) => {
      entry.dup = `dup-${index + 1}`
      entry.group = `G${groupIndex + 1}`
    })
  })
  return groups
}

// --- Markdown rendering ------------------------------------------------------

const PROJECT_ORDER = new Map([
  ['XHS', 0], ['LUMEN', 1], ['GOOGLE_TEND', 2], ['DEEPSEEK_HARNESS', 3], ['待定', 9],
])

const STATIC_TEXT = [
  '# 密钥清单（只读扫描）',
  '本文件只含元数据，不含任何密钥值、值前缀/后缀或掩码片段。',
  '生成时间', '扫描根目录', '脚本', '输出文件', '扫描文件总数', '目录总数',
  '候选文件数', '纳入条目数', '忽略：空值', '忽略：占位符或样例值',
  '忽略：示例文件', '忽略：无 key-ish 配置的 JSON 文件', '跳过：超过 5MB',
  '跳过：读取/解析失败', '跳过：符号链接', '跳过：缓存/依赖目录',
  '排除：输出文件自身', '重复组', '重复条目', '忽略/跳过合计',
  '## 概览', '## 条目', '## 重复组（同一值）', '## 已忽略的示例文件',
  '## 已跳过 / 无法解析', '## 方法与局限',
  '文件路径', '名字', '疑似类型', '文件大小', '最后修改时间(UTC)',
  '长度桶', 'sha256 前 8 位', '疑似重复', '建议项目',
  '组', '条目数', '涉及文件 + 名字', '未发现重复值。',
  '所有路径相对扫描根目录。', 'pem/cert 的长度为文件字节数。',
  'api-key', 'token', 'password', 'db-password', 'db-url', 'credential',
  'secret', 'pem', 'cert', 'config', '待定', 'dup-', 'G',
].join('\n')

function renderOverview(state, stats) {
  const ignoredTotal = state.empty + state.placeholder + state.examples.length +
    state.jsonNoKey + state.tooLarge.length + state.readErrors.length
  return [
    '## 概览',
    '',
    '| 指标 | 数量 |',
    '| --- | ---: |',
    `| 扫描文件总数 | ${state.filesVisited} |`,
    `| 目录总数 | ${state.dirsVisited} |`,
    `| 候选文件数（按文件名匹配） | ${state.candidates} |`,
    `| 纳入条目数 | ${stats.entryCount} |`,
    `| 忽略：空值 | ${state.empty} |`,
    `| 忽略：占位符或样例值 | ${state.placeholder} |`,
    `| 忽略：示例文件 | ${state.examples.length} |`,
    `| 忽略：无 key-ish 配置的 JSON 文件 | ${state.jsonNoKey} |`,
    `| 跳过：超过 5MB | ${state.tooLarge.length} |`,
    `| 跳过：读取/解析失败 | ${state.readErrors.length} |`,
    `| 跳过：符号链接 | ${state.symlinks} |`,
    `| 跳过：缓存/依赖目录 | ${state.skippedDirs} |`,
    `| 排除：输出文件自身 | ${state.excludedOutput} |`,
    `| 重复组 | ${stats.groupCount} |`,
    `| 重复条目 | ${stats.duplicateCount} |`,
    `| 忽略/跳过合计（条目+文件） | ${ignoredTotal + state.symlinks + state.skippedDirs} |`,
    '',
  ]
}

function renderEntries(entries) {
  const lines = ['## 条目', '']
  if (entries.length === 0) {
    lines.push('未发现可纳入的条目。', '')
    return lines
  }
  const projects = [...new Set(entries.map(entry => entry.project))]
  projects.sort((a, b) => (PROJECT_ORDER.get(a) ?? 8) - (PROJECT_ORDER.get(b) ?? 8) || a.localeCompare(b))
  for (const project of projects) {
    const rows = entries.filter(entry => entry.project === project)
    lines.push(`### ${project}（${rows.length}）`, '')
    lines.push('| 文件路径 | 名字 | 疑似类型 | 文件大小 | 最后修改时间(UTC) | 长度桶 | sha256 前 8 位 | 疑似重复 | 建议项目 |')
    lines.push('| --- | --- | --- | ---: | --- | --- | --- | --- | --- |')
    for (const entry of rows) {
      lines.push([
        '|', cell(entry.rel, 220), '|', cell(entry.name, MAX_NAME_LEN), '|', entry.type, '|',
        formatSize(entry.size), '|', formatMtime(entry.mtime), '|', entry.bucket, '|',
        entry.sha8, '|', entry.dup ?? '-', '|', entry.project, '|',
      ].join(' '))
    }
    lines.push('')
  }
  return lines
}

function renderDuplicates(groups) {
  const lines = ['## 重复组（同一值）', '']
  if (groups.length === 0) {
    lines.push('未发现重复值。', '')
    return lines
  }
  lines.push('| 组 | sha256 前 8 位 | 条目数 | 涉及文件 + 名字 |')
  lines.push('| --- | --- | ---: | --- |')
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]
    const involved = group.map(entry => `${cell(entry.rel, 220)} :: ${cell(entry.name, MAX_NAME_LEN)}`).join('<br>')
    lines.push(`| G${index + 1} | ${group[0].sha8} | ${group.length} | ${involved.replace(/\|/g, '\\|')} |`)
  }
  lines.push('')
  return lines
}

function renderExamples(examples) {
  const lines = ['## 已忽略的示例文件', '']
  if (examples.length === 0) {
    lines.push('无。', '')
    return lines
  }
  for (const path of examples) lines.push(`- ${path.replace(/\|/g, '\\|')}`)
  lines.push('')
  return lines
}

function renderSkipped(state) {
  const lines = ['## 已跳过 / 无法解析', '']
  if (state.tooLarge.length === 0 && state.readErrors.length === 0 && state.walkErrors.length === 0) {
    lines.push('无。', '')
    return lines
  }
  lines.push('| 文件或目录 | 原因 |')
  lines.push('| --- | --- |')
  for (const item of state.tooLarge) {
    lines.push(`| ${item.path.replace(/\|/g, '\\|')} | 超过 5MB（${formatSize(item.size)}），仅记录元数据，未解析内容 |`)
  }
  for (const item of state.readErrors) {
    lines.push(`| ${item.path.replace(/\|/g, '\\|')} | ${item.reason.replace(/\|/g, '\\|')} |`)
  }
  for (const item of state.walkErrors) {
    lines.push(`| ${item.path.replace(/\|/g, '\\|')} | 目录读取失败（${item.code}） |`)
  }
  lines.push('')
  return lines
}

function renderMethod(state, stats) {
  return [
    '## 方法与局限',
    '',
    '- 所有路径相对扫描根目录；文件以只读方式打开，脚本不修改任何被扫描文件。',
    '- `.env`：解析 `KEY=VALUE`，支持单/双引号与多行引号值，跳过注释；文件内所有非空、非占位符的值都会成为条目。',
    '- `*.json`：仅当原始文本出现 key-ish 字样才解析；递归遍历嵌套对象/数组，只收名字匹配 `api_key|secret|token|password|pwd|credential|private_key|access_key` 等且值非空的字段，名字用点号路径表示。`max_tokens`、`input_tokens`、`*_cost_per_token` 等计费/长度字段按非密钥字段忽略。',
    '- `credentials*`：先尝试 JSON；否则按 YAML/ini 的 `name: value` / `name=value` 行解析，嵌套 YAML 会被拍平成单层名字。名字以 credentials 开头但扩展名为源码/编译产物（如 credentials.ts、credentials.py）的不当作凭据库。',
    '- `*.pem` / `*.key` / `*.crt`：整份文件算一个条目，名字取文件名（保留扩展名），pem/cert 的长度与哈希基于文件字节。',
    '- 长度桶固定为 1-15 / 16-31 / 32-63 / 64-127 / 128+ 字符；pem/cert 为字节数。',
    '- `sha256 前 8 位` 是值的 sha256 十六进制前缀；重复组按完整 sha256 分组，组内按路径排序标 `dup-1`、`dup-2`…。',
    `- 跳过目录：${[...SKIP_DIRS].join('、')}；不跟随符号链接；超过 5MB 的文件不解析内容。`,
    '- 示例文件按文件名中的 `.example` / `.sample` / `.template` / `.dist` 识别，只列路径，不解析内容。',
    `- 本次扫描共记录 ${state.malformedLines} 行无法解析的键值行（只计数，不输出行内容）。`,
    `- 重复组 ${stats.groupCount} 个，涉及 ${stats.duplicateCount} 个条目；其余条目值唯一。`,
    '- 建议项目按路径最深目录段启发式判断：xhs→XHS、lumen→LUMEN、google tend→GOOGLE_TEND、deepseek-harness→DEEPSEEK_HARNESS，无法判断为“待定”。',
    '- 防泄漏自检：写出前检查清单中是否出现任何值的长片段（8 字符窗口，含数字或符号的窗口），发现即拒绝写出；纯字母值用整值比对，单个超长值最多审计前 256KB，窗口总数有上限。',
    '',
  ]
}

function renderInventory({ root, outLabel, entries, groups, state, generatedAt, stats }) {
  const lines = [
    '# 密钥清单（只读扫描）',
    '',
    `- 生成时间：${generatedAt}`,
    `- 扫描根目录：\`${root}\``,
    `- 脚本：\`dsh-secrets/scripts/scan-keys.mjs\` v${VERSION}`,
    `- 输出文件：${outLabel === null ? 'stdout' : `\`${outLabel}\``}`,
    `- 安全说明：本文件只含路径、名字、类型、大小、时间、长度桶和 sha256 前 8 位，不含任何密钥值、值前缀/后缀或掩码片段。`,
    '',
    ...renderOverview(state, stats),
    ...renderEntries(entries),
    ...renderDuplicates(groups),
    ...renderExamples(state.examples),
    ...renderSkipped(state),
    ...renderMethod(state, stats),
  ]
  return lines.join('\n')
}

// --- leak audit --------------------------------------------------------------

/**
 * Build the metadata corpus: every string the document is allowed to display.
 * A value window that appears in the document but not in this corpus is a leak.
 */
function auditCorpus(build) {
  const parts = [STATIC_TEXT, build.root, build.outLabel ?? '', build.generatedAt, renderMethod(build.state, build.stats)]
  for (const entry of build.entries) {
    parts.push(entry.rel, entry.name, entry.type, entry.project, entry.sha8, entry.bucket,
      entry.dup ?? '', String(entry.size), formatMtime(entry.mtime))
    // PEM/cert files often start with a comment/attribute header naming the
    // key (e.g. "# ALIYUN_RAM_ECS_POWER_AK"). Such a header is metadata, not
    // key material; without it the audit can flag a boundary window that spans
    // the table separator and the name as a leak. Keep the key body audited,
    // but make the header text explainable.
    if ((entry.type === 'pem' || entry.type === 'cert') && typeof entry.audit === 'string') {
      for (const line of entry.audit.split(/\r?\n/)) {
        const trimmed = line.trimStart()
        if (trimmed.startsWith('#') || /^(Bag Attributes|friendlyName|localKeyID|subject|issuer)\b/i.test(trimmed)) {
          parts.push(line)
        }
      }
    }
  }
  for (const path of build.state.examples) parts.push(path)
  for (const item of build.state.tooLarge) parts.push(item.path)
  for (const item of build.state.readErrors) parts.push(item.path, item.reason)
  for (const item of build.state.walkErrors) parts.push(item.path, item.code)
  return parts.join('\n')
}

/** 53-bit hash of an 8-character window (two independent 32-bit hashes). */
function windowHash(text, start) {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < AUDIT_WINDOW; i++) {
    const code = text.charCodeAt(start + i)
    h1 = Math.imul(h1 ^ code, 16777619)
    h2 = Math.imul(h2 + code, 2246822519)
  }
  return (h1 >>> 0) * 2097152 + (h2 >>> 11)
}

/** True when the window has a digit or a non-alphanumeric character. */
function suspiciousWindow(text, start) {
  for (let i = 0; i < AUDIT_WINDOW; i++) {
    const code = text.charCodeAt(start + i)
    if (code >= 48 && code <= 57) return true
    if (code >= 65 && code <= 90) continue
    if (code >= 97 && code <= 122) continue
    return true
  }
  return false
}

/**
 * Hash-based substring audit. Instead of asking `doc.includes(value)` for every
 * value (quadratic on a large inventory), hash every 8-character window of the
 * values into a map, then scan the document once and look windows up. Only
 * windows that carry a digit or a symbol are indexed: pure-alphabetic windows
 * collide with ordinary prose and would produce false positives, while a real
 * credential almost always has a digit or symbol in any 8-character stretch.
 * A full value made only of letters is additionally checked with includes().
 */
function auditDocument(doc, entries, corpus, progress = () => {}) {
  // Hashes of every suspicious window that legitimately occurs in metadata.
  // Checking a match against this set is O(1); checking corpus.includes() per
  // match was the hot spot on inventories with tens of thousands of rows.
  const corpusWindows = new Set()
  for (let i = 0; i + AUDIT_WINDOW <= corpus.length; i++) {
    if (!suspiciousWindow(corpus, i)) continue
    corpusWindows.add(windowHash(corpus, i))
  }

  const valueWindows = new Map()
  const hits = []
  let checkedEntries = 0
  let checkedWindows = 0
  let truncated = false
  let fullValueHits = 0

  for (const entry of entries) {
    const value = entry.audit
    if (typeof value !== 'string' || value.length < AUDIT_WINDOW) continue
    checkedEntries++
    const limit = Math.min(value.length, AUDIT_MAX_VALUE_BYTES)
    if (value.length > AUDIT_MAX_VALUE_BYTES) truncated = true
    let sawSuspicious = false

    for (let i = 0; i + AUDIT_WINDOW <= limit; i++) {
      if (!suspiciousWindow(value, i)) continue
      sawSuspicious = true
      if (checkedWindows >= AUDIT_MAX_WINDOWS) { truncated = true; break }
      checkedWindows++
      const hash = windowHash(value, i)
      const window = value.slice(i, i + AUDIT_WINDOW)
      const existing = valueWindows.get(hash)
      if (existing === undefined) valueWindows.set(hash, window)
      else if (typeof existing === 'string') {
        if (existing !== window) valueWindows.set(hash, [existing, window])
      } else if (!existing.includes(window)) {
        existing.push(window)
      }
    }

    if (!sawSuspicious) {
      if (value.length <= AUDIT_MAX_VALUE_BYTES) {
        if (doc.includes(value) && !corpus.includes(value)) fullValueHits++
      } else {
        truncated = true
      }
    }
  }

  progress(`audit index built: ${valueWindows.size} hashes / ${checkedWindows} windows / ${doc.length} doc chars`)
  for (let i = 0; i + AUDIT_WINDOW <= doc.length; i++) {
    if ((i & 0x1fffff) === 0) progress(`audit scan ${i}/${doc.length}`)
    if (!suspiciousWindow(doc, i)) continue
    const hash = windowHash(doc, i)
    const candidate = valueWindows.get(hash)
    if (candidate === undefined) continue
    const window = doc.slice(i, i + AUDIT_WINDOW)
    const match = typeof candidate === 'string' ? candidate === window : candidate.includes(window)
    if (match && !corpusWindows.has(hash)) {
      hits.push({ position: i })
      if (hits.length >= 20) break
    }
  }

  return { checkedEntries, checkedWindows, hits, truncated, fullValueHits }
}

// --- main --------------------------------------------------------------------

function writeStdout(text) {
  return new Promise((resolvePromise, reject) => {
    process.stdout.write(text, error => (error ? reject(error) : resolvePromise()))
  })
}

function logEntryValueStats(entries, log) {
  let total = 0
  let max = 0
  let long = 0
  for (const entry of entries) {
    if (typeof entry.audit !== 'string') continue
    total += entry.audit.length
    if (entry.audit.length > max) max = entry.audit.length
    if (entry.audit.length > 4096) long++
  }
  log(`entry values: ${total} chars total, max ${max}, ${long} over 4096 chars`)
}

function failUsage(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 2
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) {
      failUsage(error.message)
      return
    }
    throw error
  }

  if (options.help) {
    await writeStdout(USAGE)
    return
  }

  const root = resolve(options.root ?? DEFAULT_ROOT)
  let rootInfo
  try {
    rootInfo = await stat(root)
  } catch (error) {
    failUsage(`根目录不可访问：${root}（${error?.code ?? 'UNKNOWN'}）`)
    return
  }
  if (!rootInfo.isDirectory()) {
    failUsage(`根目录不是目录：${root}`)
    return
  }

  const outPath = options.out === null ? null : resolve(options.out)
  const auditPath = options.audit === null ? null : resolve(options.audit)
  const excluded = new Set()
  if (outPath !== null) excluded.add(outPath)
  if (auditPath !== null) excluded.add(auditPath)

  if (outPath !== null) {
    try {
      const existing = await stat(outPath)
      if (existing.isDirectory()) {
        failUsage(`--out 指向目录：${outPath}`)
        return
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        failUsage(`无法检查输出路径：${outPath}（${error?.code ?? 'UNKNOWN'}）`)
        return
      }
    }
  }

  const state = newState()
  const startedAt = Date.now()
  const log = (message) => {
    if (options.verbose) process.stderr.write(`[scan-keys +${Date.now() - startedAt}ms] ${message}\n`)
  }

  log(`walk ${root}`)
  const files = await walkTree(root, excluded, state)
  state.candidates = files.length
  log(`walk done: ${state.filesVisited} files, ${state.dirsVisited} dirs, ${files.length} candidates`)

  log('parse candidates')
  const entries = await scanFiles(root, files, state)
  state.entries = entries.length
  log(`parse done: ${entries.length} entries`)

  const groups = groupDuplicates(entries)

  entries.sort((a, b) => {
    const rankA = PROJECT_ORDER.get(a.project) ?? 8
    const rankB = PROJECT_ORDER.get(b.project) ?? 8
    return rankA - rankB || a.rel.localeCompare(b.rel) || a.name.localeCompare(b.name) || a.sha8.localeCompare(b.sha8)
  })
  log(`sort/dup done: ${groups.length} duplicate groups`)

  const generatedAt = nowStamp()
  const stats = {
    entryCount: entries.length,
    groupCount: groups.length,
    duplicateCount: groups.reduce((sum, group) => sum + group.length, 0),
  }

  // Audit mode: re-scan, read the existing inventory as text and verify that no
  // value window leaked into it. The file itself is excluded from the scan.
  if (auditPath !== null) {
    let doc
    try {
      doc = await readFile(auditPath, 'utf8')
    } catch (error) {
      failUsage(`无法读取待自检文件：${auditPath}（${error?.code ?? 'UNKNOWN'}）`)
      return
    }
    const corpus = auditCorpus({ root, outLabel: auditPath, entries, state, generatedAt, stats })
    logEntryValueStats(entries, log)
    log(`audit ${doc.length} document chars against ${entries.length} entries`)
    const audit = auditDocument(doc, entries, corpus, log)
    const hitCount = audit.hits.length + audit.fullValueHits
    log(`audit done: ${audit.checkedWindows} value windows, ${hitCount} hits`)
    if (hitCount > 0) {
      process.stderr.write(`防泄漏自检失败：${hitCount} 处疑似值片段出现在清单中（未输出任何片段）；已拒绝通过。\n`)
      process.exitCode = 4
      return
    }
    process.stdout.write(`防泄漏自检通过：${entries.length} 个条目 / ${audit.checkedWindows} 个值片段窗口，未在清单中发现值片段${audit.truncated ? '（窗口数达到上限，已截断）' : ''}。\n`)
    process.stdout.write(`文件：${auditPath}（${Buffer.byteLength(doc)} 字节）\n`)
    return
  }

  const doc = renderInventory({ root, outLabel: outPath, entries, groups, state, generatedAt, stats })
  log(`render done: ${doc.length} chars`)
  const corpus = auditCorpus({ root, outLabel: outPath, entries, state, generatedAt, stats })
  logEntryValueStats(entries, log)
  log(`audit ${doc.length} document chars against ${entries.length} entries`)
  const audit = auditDocument(doc, entries, corpus, log)
  const hitCount = audit.hits.length + audit.fullValueHits
  log(`audit done: ${audit.checkedWindows} value windows, ${hitCount} hits`)
  if (hitCount > 0) {
    process.stderr.write(`防泄漏自检失败：${hitCount} 处疑似值片段出现在清单中（未输出任何片段），已拒绝写出。\n`)
    process.exitCode = 4
    return
  }

  const summary = `扫描：${state.filesVisited} 个文件 / ${state.dirsVisited} 个目录，候选 ${state.candidates}，条目 ${entries.length}，` +
    `重复组 ${groups.length}，忽略 ${state.empty + state.placeholder + state.examples.length + state.jsonNoKey}，` +
    `跳过 ${state.tooLarge.length + state.readErrors.length}\n` +
    `防泄漏自检：通过（${audit.checkedWindows} 个值片段窗口${audit.truncated ? '，已截断' : ''}）\n`

  if (outPath === null) {
    await writeStdout(doc.endsWith('\n') ? doc : `${doc}\n`)
    process.stderr.write(summary)
    return
  }

  try {
    await mkdir(dirname(outPath), { recursive: true, mode: 0o700 })
    await writeFile(outPath, doc, { mode: 0o600 })
    await chmod(outPath, 0o600)
  } catch (error) {
    process.stderr.write(`写出清单失败：${outPath}（${error?.code ?? 'UNKNOWN'}）\n`)
    process.exitCode = 3
    return
  }
  const bytes = Buffer.byteLength(doc)
  process.stdout.write(`已写入：${outPath}（0600，${bytes} 字节）\n`)
  process.stdout.write(summary)
}

main().catch(error => {
  // Last-resort handler: print an error code/name only, never a message that
  // could embed file content.
  process.stderr.write(`扫描失败：${error?.code ?? error?.name ?? 'UNKNOWN'}\n`)
  process.exitCode = 1
})
