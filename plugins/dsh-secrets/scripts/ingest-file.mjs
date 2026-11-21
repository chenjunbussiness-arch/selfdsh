#!/usr/bin/env node
/**
 * ingest-file.mjs — import key files from a drop directory into the local
 * encrypted dsh-secrets vault.
 *
 * The value never goes through a tool call or the session log: this script
 * imports the host vault module directly and calls `Vault.mutate()`.
 *
 * Supported inputs (detected by extension):
 *   .env                 KEY=VALUE / export KEY=VALUE / quoted values / comments
 *   .json                {"NAME":"value"}, {"NAME":{"value","description?","tags?"}}
 *                        or [{name,value,description?,tags?}]; per-entry problems
 *                        skip only that entry
 *   .yaml / .yml         flat `key: value` only (no nesting, no lists)
 *   .pem .key .crt .p12  the whole file is one secret, byte-for-byte (no trim, no
 *                        newline normalisation, no line splitting; .p12 is stored
 *                        as standard base64 of the raw bytes)
 *   anything else        the whole trimmed file is one value; name = filename
 *
 * Project layout: `<keys-dir>/inbox/<project>/<file>` adds the tag
 * `project:<project lowercase>` and requires every entry name in that file to
 * start with `<PROJECT>_` (xhs -> XHS_). One mismatch rejects the whole file:
 * nothing from it is written. `<keys-dir>/inbox/<file>` keeps the old behaviour
 * (no project tag) unless `--project <name>` is given, which only adds the tag
 * and does not enforce the prefix.
 *
 * Empty values are skipped and merged into one `.err` block. Two different
 * names with the same value in one file are reported as a warning (same-file
 * copy/paste signal) in the summary and the `.err`, without changing the exit
 * code.
 *
 * Same-name protection happens before the write plan is built. An auto-named
 * certificate (`<PROJECT>_<STEM>`) whose name is already used by a different
 * value (in this batch or in the vault) is renamed to `<PROJECT>_<STEM>_<EXT>`
 * (lumen.pem + lumen.p12 -> LUMEN_LUMEN_PEM / LUMEN_LUMEN_P12). If even that
 * qualified name is taken by a different value the entry is skipped and the
 * run exits 1. Non-certificate entries use first-wins within the batch: a later
 * same-name entry with a different value is skipped (exit 1), an identical
 * value is an idempotent no-op.
 *
 * After a successful vault write the source file moves to `processed/`
 * (mode 0600). Only a whole-file parse failure (bad JSON/YAML, unreadable, no
 * entries at all) moves to `rejected/`. A partially imported file moves to
 * `processed/` and its `<filename>.err` sits next to it; a rejected file gets
 * `rejected/<filename>.err`.
 *
 * The `.err` files and stdout contain names, line numbers, fingerprints and
 * lengths only — never a plaintext value.
 *
 * Usage:
 *   node scripts/ingest-file.mjs --dry-run
 *   node scripts/ingest-file.mjs
 *   node scripts/ingest-file.mjs --keys-dir /tmp/test-keys --dry-run
 *   node scripts/ingest-file.mjs --dir /tmp/test-inbox --dry-run
 *   node scripts/ingest-file.mjs --project acme
 *   node scripts/ingest-file.mjs /path/to/one.env --dry-run   # preview one file
 */

import { constants as fsConstants } from 'node:fs'
import { chmod, copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { resolveConfig } from '../packages/host-secrets/config.js'
import { NAME_RE, VAULT_FORMAT, Vault, fingerprint, parseEnvelope, valueLength } from '../packages/host-secrets/vault.js'

const DEFAULT_KEYS_DIR = '/srv/workspace/keys'
const DEFAULT_INBOX = join(DEFAULT_KEYS_DIR, 'inbox')

/** Certificate/key formats: extension (lowercase) -> format / kind name. */
const CERT_FORMATS = new Map([
  ['.pem', 'pem'],
  ['.key', 'key'],
  ['.crt', 'crt'],
  ['.p12', 'p12'],
])
const CERT_KINDS = new Set(CERT_FORMATS.values())

// Mirrors packages/host-secrets/tools.js (secret_set) so the script rejects
// exactly what the tool would reject, before touching the vault.
const MAX_VALUE_BYTES = 64 * 1024
const MAX_DESCRIPTION = 4000
const MAX_TAGS = 32
const TAG_RE = /^[^\s,]{1,64}$/
const NAME_HINT = String(NAME_RE)

const USAGE = `用法：
  node scripts/ingest-file.mjs [选项] [文件...]

选项：
  --dry-run                 只解析并打印 name / tag / 指纹 / 长度 / 告警，不写库、不搬文件、
                            不生成 .err，也不需要口令或 keyfile。退出码 0。
  --keys-dir <目录>         投放根目录，默认 ${DEFAULT_KEYS_DIR}；其下用 inbox/、
                            processed/、rejected/。显式 --dir/--processed/--rejected 优先。
  --dir <目录>              只改投放目录，默认 <keys-dir>/inbox（--inbox 同义）
  --processed <目录>        成功/部分成功文件归档目录，默认 <投放目录的父目录>/processed
  --rejected <目录>         文件级失败（解析不了）的归档目录，默认 <投放目录的父目录>/rejected
  --project <名>            只给 inbox 根下的文件加 project:<名小写> tag，不强制名字前缀；
                            项目子目录仍按目录名归类并强制前缀校验
  --vault <路径>            vault 文件路径，默认 <DSH_HOME 或 ~/.dsh>/secrets.vault
  --key-source <来源>       passphrase-env | keyfile；默认按 vault header 自动判断，
                            没有 vault 时用 passphrase-env
  --keyfile <路径>          keyfile 路径，默认 <DSH_HOME 或 ~/.dsh>/secrets.key
  -h, --help                显示本帮助

显式文件参数（只预览）：
  node scripts/ingest-file.mjs /path/to/one.env --dry-run
  只解析列出的文件，不扫描 inbox；**只支持 --dry-run**，真跑请放进 inbox 或用 --dir。

JSON 对象形态（逐条处理，单条跳过不影响整文件）：
  {"NAME": "value"}                                  直接写入
  {"NAME": {"value": "v", "description": "d", "tags": ["a"]}}
                                                     value 写入，description/tags 一并入库
  {"NAME": {"value": 123}} / {"NAME": null}          value 不是字符串 → 跳过该条
  {"NAME": {"id": "...", "secret": "..."}}           缺 value 键 → 跳过该条，提示一个 key 一个条目
  tags 里的非字符串元素会被丢掉并在 .err 里提示；description/tags 类型不对则跳过该条。

跳过与告警：
  - 空值（空字符串或纯空白）：跳过并计数，.err 里把所有空值合并成一段
    "NAME: 空值已跳过"。逐条跳过 ≠ 文件失败：文件照常进 processed/，退出码 1。
  - 同一文件内两个不同名字的 value sha256 相同：告警
    "NAME_A 与 NAME_B 值完全相同（指纹 xxxxxxxx）"，写进 .err 和运行汇总（dry-run 也显示）；
    仅告警，不改变退出码。
  - 只有文件整体解析不了（JSON/YAML 语法错、读不了、没有任何条目）才进 rejected/。

同名与默认名冲突（写库前预检）：
  - 证书默认名 <PROJECT>_<STEM>：同批内或 vault 里已有同名但值不同的条目时，自动改名
    <PROJECT>_<STEM>_<扩展名大写>（lumen.pem + lumen.p12 → LUMEN_LUMEN_PEM / LUMEN_LUMEN_P12），
    保证两条都完整入库、互不覆盖；同一文件重复导入且值相同视为幂等，不报错。
  - 加扩展名后仍与不同值冲突 → 跳过该条，.err 写明目标名与原因，计入跳过，退出码 1。
  - 非证书（.env/.json/.yaml/文本/显式 "# name:"）：同批同名不同值 → 先到者写入，其余跳过并
    写 .err（退出码 1）；同名同值幂等，只写一次。vault 里已存在的非证书同名条目按“更新”处理。
  - dry-run 不读口令、不解密，只检测批内冲突；跨批冲突在真跑时检测。
  - 汇总行给出 导入 / 跳过 / 改名 计数。

项目维度（目录派生）：
  <keys-dir>/inbox/<项目名>/<文件>   自动加 tag project:<项目名小写>，并要求该文件里
                                     每个条目名以 <项目名大写、非字母数字转下划线>_
                                     开头（xhs -> XHS_）。任一条不匹配则该文件整体进
                                     rejected/、写清原因，一条都不写库（退出码 1）。
  <keys-dir>/inbox/<文件>            与旧行为一致：不加 project tag；--project 只打 tag、
                                     不校验前缀（取舍：覆盖路径不做命名约束）。
  只扫描 inbox 的一级子目录；更深的子目录会被忽略并在头部提示。

证书/key 文件（扩展名大小写不敏感）：
  .pem .key .crt .p12   整个文件是一个 secret：不按行拆分、不 trim、不做换行归一化。
                        .p12 按原始字节读入后以标准 base64 存储；其余按 UTF-8 文本
                        读入，并校验 UTF-8 往返字节完全一致（含结尾换行）。
  tags                  kind:pem|kind:key|kind:crt|kind:p12；.crt 与 .p12 另加
                        kind:cert；.p12 另加 binary:b64（此外仍有 src:<格式>、prefix:<文件>）。
  默认名                <PROJECT>_<文件名去扩展名、转大写、非字母数字转下划线>；
                        无项目时只用文件名部分。
  "# name: XXX"         文件第一行形如 "# name: XXX" 时用 XXX 覆盖默认名；该行仍原样
                        保留在值里，整文件 sha256 不变。

环境变量：
  DSH_SECRETS_PASSPHRASE     vault 主口令（默认变量名，来自 host-secrets config）
  DSH_HOME                   决定默认 vault/keyfile 路径（默认 ~/.dsh）
  DSH_SECRETS_VAULT_PATH     可选，覆盖 vault 路径
  DSH_SECRETS_KEYFILE_PATH   可选，覆盖 keyfile 路径
  DSH_SECRETS_KEY_SOURCE     可选，覆盖 keySource

实现要点：
  - 直接 import packages/host-secrets/vault.js 的 Vault 写库，不调用 secret_set，
    所以值不会进入会话日志；
  - 所有条目在一次 Vault.mutate() 里写入（一次加锁、一次加密落盘）；
  - 缺少主密钥时在任何写操作之前退出，不建库、不搬文件、不写 .err；
  - 指纹 = sha256(value) 的前 8 个十六进制字符（与 host-secrets 一致）；
  - .err 与归档文件放在同一目录：processed/<文件>.err（部分成功）或
    rejected/<文件>.err（整文件失败），只含名字/行号/原因，不含值。

退出码：
  0 全部成功（或 dry-run）
  1 有条目/空值被跳过、有命名冲突被跳过、有文件被拒绝或归档失败（含项目前缀校验失败）
  2 参数/环境/解锁错误（没有写入任何东西）
  3 写库失败（没有搬动文件）
`

class UsageError extends Error {}

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    dryRun: false, help: false, keysDir: null, inbox: null, processed: null, rejected: null,
    project: null, vault: null, keySource: null, keyfile: null, files: [],
  }
  const valueFlags = {
    '--keys-dir': 'keysDir',
    '--dir': 'inbox', '--inbox': 'inbox', '--processed': 'processed', '--rejected': 'rejected',
    '--project': 'project',
    '--vault': 'vault', '--key-source': 'keySource', '--keyfile': 'keyfile',
  }
  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i]
    if (flag === '--dry-run') { options.dryRun = true; continue }
    if (flag === '--help' || flag === '-h') { options.help = true; continue }
    if (!flag.startsWith('-')) { options.files.push(flag); continue }
    let value
    const eq = flag.indexOf('=')
    if (flag.startsWith('--') && eq !== -1) {
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
    options[field] = value
  }
  return options
}

function normalizeKeySource(value, origin) {
  if (value === undefined || value === null || value === '') return null
  const text = String(value).trim()
  if (text === 'passphrase-env' || text === 'keyfile') return text
  throw new UsageError(`${origin} 只能是 passphrase-env 或 keyfile，收到：${text}`)
}

/**
 * Derive the tag and the required name prefix of a project.
 * `xhs` -> tag `project:xhs`, prefix `XHS_`.
 * `requirePrefix` is true for directory-derived projects (the prefix is then
 * enforced on every entry) and false for `--project` (tag only).
 * @param {string} rawName
 * @param {{requirePrefix?: boolean}} [options]
 */
function projectContext(rawName, { requirePrefix = false } = {}) {
  const name = String(rawName).trim()
  const tag = `project:${name.toLowerCase()}`
  if (name === '' || !TAG_RE.test(tag)) {
    return { error: `项目名「${name}」无法生成合法 tag（须 1-64 字符、不含空格或逗号）` }
  }
  const cleaned = name.toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  const prefix = cleaned === '' ? '' : `${cleaned}_`
  if (prefix !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
    return { error: `项目名「${name}」生成的前缀 ${prefix} 不是合法的名字前缀（需字母或 _ 开头）` }
  }
  if (requirePrefix && prefix === '') {
    return { error: `项目名「${name}」无法生成名字前缀（只允许 A-Z/0-9/_；例如 xhs -> XHS_）` }
  }
  return { name, tag, prefix }
}

// --- filesystem helpers ------------------------------------------------------

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

async function exists(path) {
  try { await stat(path); return true } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
}

/** Move, falling back to copy+unlink when source and destination are on different mounts. */
async function moveFile(source, destination) {
  try {
    await rename(source, destination)
    return
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
  }
  await copyFile(source, destination, fsConstants.COPYFILE_EXCL)
  await unlink(source)
}

/** `<dir>/<filename>`, with a timestamp inserted before the extension on collision. */
async function freeName(dir, filename) {
  const direct = join(dir, filename)
  if (!(await exists(direct))) return direct
  const ext = extname(filename)
  const stem = ext ? filename.slice(0, -ext.length) : filename
  const stamp = timestamp()
  let candidate = join(dir, `${stem}.${stamp}${ext}`)
  for (let n = 2; await exists(candidate); n++) candidate = join(dir, `${stem}.${stamp}-${n}${ext}`)
  return candidate
}

/** `<dir>/<filename>.err`, with a timestamp on collision. */
async function freeErrName(dir, filename) {
  const direct = join(dir, `${filename}.err`)
  if (!(await exists(direct))) return direct
  const stamp = timestamp()
  let candidate = join(dir, `${filename}.${stamp}.err`)
  for (let n = 2; await exists(candidate); n++) candidate = join(dir, `${filename}.${stamp}-${n}.err`)
  return candidate
}

async function moveInto(dir, filename, source) {
  await ensureDir(dir)
  const destination = await freeName(dir, filename)
  await moveFile(source, destination)
  await chmod(destination, 0o600)
  return destination
}

async function writeErrFile(dir, filename, text) {
  await ensureDir(dir)
  const path = await freeErrName(dir, filename)
  await writeFile(path, text, { mode: 0o600 })
  await chmod(path, 0o600)
  return path
}

// --- parsing -----------------------------------------------------------------

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function detectFormat(filename) {
  const lower = filename.toLowerCase()
  if (lower === '.env' || lower.endsWith('.env') || lower.startsWith('.env.')) return 'env'
  const ext = extname(lower)
  if (ext === '.json') return 'json'
  if (ext === '.yaml' || ext === '.yml') return 'yaml'
  const cert = CERT_FORMATS.get(ext)
  if (cert !== undefined) return cert
  return 'text'
}

/** Read a quoted scalar starting at text[0]; no multi-line values. */
function readQuoted(text, quote) {
  let value = ''
  for (let i = 1; i < text.length; i++) {
    const char = text[i]
    if (quote === '"' && char === '\\') {
      const next = text[i + 1]
      if (next === undefined) return { error: '引号内的转义不完整' }
      const escapes = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', "'": "'", $: '$' }
      value += escapes[next] ?? next
      i++
      continue
    }
    if (char === quote) return { value, rest: text.slice(i + 1) }
    value += char
  }
  return { error: quote === "'" ? '单引号未闭合' : '双引号未闭合' }
}

/** First `#` that starts the string or follows whitespace (conservative inline comment). */
function commentIndex(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '#' && (i === 0 || /\s/.test(text[i - 1]))) return i
  }
  return -1
}

/** Parse one unquoted/quoted scalar (an env or YAML value). */
function parseScalar(raw) {
  const text = raw.trim()
  if (text === '') return { empty: true }
  if (text[0] === '"' || text[0] === "'") {
    const quoted = readQuoted(text, text[0])
    if (quoted.error) return { error: quoted.error }
    const rest = quoted.rest.trim()
    if (rest !== '' && !rest.startsWith('#')) return { error: '引号结束后还有多余字符' }
    if (quoted.value.trim() === '') return { empty: true }
    return { value: quoted.value }
  }
  const cut = commentIndex(text)
  const value = (cut === -1 ? text : text.slice(0, cut)).trim()
  if (value === '') return { empty: true }
  return { value }
}

function parseEnv(text) {
  const entries = []
  const rejects = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    let line = lines[i].trim()
    if (line === '' || line.startsWith('#')) continue
    if (/^export\s+/.test(line)) line = line.replace(/^export\s+/, '').trim()
    const eq = line.indexOf('=')
    if (eq === -1) {
      // Never echo the line: a bare value without `=` would be a plaintext leak.
      rejects.push({ line: lineNo, reason: "不是 KEY=VALUE 形式（缺少 '='）" })
      continue
    }
    const name = line.slice(0, eq).trim()
    if (name === '') { rejects.push({ line: lineNo, reason: 'key 为空' }); continue }
    const scalar = parseScalar(line.slice(eq + 1))
    if (scalar.error) { rejects.push({ line: lineNo, name, reason: scalar.error }); continue }
    if (scalar.empty) { rejects.push({ line: lineNo, name, reason: '空值或纯空白' }); continue }
    entries.push({ name, value: scalar.value, line: lineNo, format: 'env' })
  }
  return { entries, rejects, notes: [] }
}

function parseJson(text) {
  let doc
  try {
    doc = JSON.parse(text)
  } catch (error) {
    // Do not print the V8 message: it can quote a snippet of the input. Use only
    // its numeric position to report an approximate line number.
    let where = ''
    const position = /position (\d+)/.exec(error?.message ?? '')
    if (position) {
      const offset = Math.min(Number(position[1]), text.length)
      where = `（第 ${text.slice(0, offset).split('\n').length} 行附近）`
    }
    return { entries: [], rejects: [], notes: [], fileError: `不是合法 JSON${where}（解析失败；为避免泄露原始片段，不打印解析器细节）` }
  }
  const entries = []
  const rejects = []
  const notes = []
  if (Array.isArray(doc)) {
    doc.forEach((item, index) => {
      const ref = `item[${index}]`
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        rejects.push({ ref, code: 'bad-item', reason: '数组元素必须是对象' })
        return
      }
      if (typeof item.name !== 'string') { rejects.push({ ref, code: 'bad-item', reason: '缺少字符串 name' }); return }
      if (typeof item.value !== 'string') {
        rejects.push({ ref, name: item.name, code: 'non-string-value', reason: '缺少字符串 value' })
        return
      }
      if (item.description !== undefined && typeof item.description !== 'string') {
        rejects.push({ ref, name: item.name, code: 'bad-meta', reason: 'description 必须是字符串' })
        return
      }
      if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.some(tag => typeof tag !== 'string'))) {
        rejects.push({ ref, name: item.name, code: 'bad-meta', reason: 'tags 必须是字符串数组' })
        return
      }
      entries.push({
        name: item.name,
        value: item.value,
        description: item.description,
        tags: item.tags,
        ref,
        format: 'json',
      })
    })
  } else if (doc !== null && typeof doc === 'object') {
    // Object form accepts three shapes per entry:
    //   "NAME": "value"
    //   "NAME": {"value": "...", "description": "...", "tags": ["a"]}
    //   anything else is skipped entry-by-entry (never a file-level failure).
    for (const [name, raw] of Object.entries(doc)) {
      if (typeof raw === 'string') {
        entries.push({ name, value: raw, ref: 'object', format: 'json' })
        continue
      }
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        rejects.push({
          ref: 'object', name, code: 'non-string-value',
          reason: 'value 必须是字符串，或含 value/description/tags 的对象',
        })
        continue
      }
      if (!Object.prototype.hasOwnProperty.call(raw, 'value')) {
        rejects.push({
          ref: 'object', name, code: 'missing-value',
          reason: '缺少 value 键；不支持把多个字段（如 {"id": ..., "secret": ...}）塞进一个条目，请一个 key 一个条目：{"NAME": {"value": "..."}}',
        })
        continue
      }
      if (typeof raw.value !== 'string') {
        rejects.push({ ref: 'object', name, code: 'non-string-value', reason: 'value 不是字符串（已跳过该条）' })
        continue
      }
      if (raw.description !== undefined && typeof raw.description !== 'string') {
        rejects.push({ ref: 'object', name, code: 'bad-meta', reason: 'description 必须是字符串' })
        continue
      }
      if (raw.tags !== undefined && !Array.isArray(raw.tags)) {
        rejects.push({ ref: 'object', name, code: 'bad-meta', reason: 'tags 必须是字符串数组' })
        continue
      }
      const tags = []
      if (Array.isArray(raw.tags)) {
        const dropped = raw.tags.filter(tag => typeof tag !== 'string').length
        for (const tag of raw.tags) if (typeof tag === 'string') tags.push(tag)
        if (dropped > 0) notes.push(`${name}：tags 里有 ${dropped} 个非字符串元素已跳过`)
      }
      entries.push({
        name,
        value: raw.value,
        description: raw.description,
        tags,
        ref: 'object',
        format: 'json',
      })
    }
  } else {
    return { entries: [], rejects: [], notes: [], fileError: 'JSON 顶层必须是对象或数组' }
  }
  return { entries, rejects, notes }
}

function parseYaml(text) {
  const entries = []
  const rejects = []
  const lines = text.split(/\r?\n/)
  let nestedParent = null
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const raw = lines[i]
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (trimmed === '---' || trimmed === '...') { nestedParent = null; continue }
    if (raw.startsWith('\t')) {
      rejects.push({ line: lineNo, reason: 'YAML 缩进使用了制表符（不支持）' })
      continue
    }
    const indent = raw.length - raw.trimStart().length
    if (indent > 0) {
      if (nestedParent) continue // child lines of an already-rejected nested block
      rejects.push({ line: lineNo, reason: '缩进行（不支持嵌套 YAML）' })
      continue
    }
    nestedParent = null
    if (trimmed === '-' || /^-\s/.test(trimmed)) {
      return { entries: [], rejects: [], notes: [], fileError: `不支持 YAML 列表（第 ${lineNo} 行；只支持扁平 key: value）` }
    }
    const match = /^([^:#][^:]*?)\s*:\s*(.*)$/.exec(trimmed)
    if (!match) {
      rejects.push({ line: lineNo, reason: '不是扁平 key: value 形式' })
      continue
    }
    const key = match[1].trim()
    if (key === '' || key.startsWith('"') || key.startsWith("'")) {
      rejects.push({ line: lineNo, reason: 'key 为空或带引号（不支持）' })
      continue
    }
    const rest = match[2].trim()
    if (rest === '') {
      nestedParent = key
      rejects.push({ line: lineNo, name: key, reason: '空值或嵌套结构（只支持扁平 key: value）' })
      continue
    }
    if (rest.startsWith('|') || rest.startsWith('>')) {
      nestedParent = key
      rejects.push({ line: lineNo, name: key, reason: '块标量（| / >）不支持' })
      continue
    }
    if (rest.startsWith('[') || rest.startsWith('{')) {
      rejects.push({ line: lineNo, name: key, reason: 'flow 列表/对象不支持（只支持标量值）' })
      continue
    }
    const scalar = parseScalar(rest)
    if (scalar.error) { rejects.push({ line: lineNo, name: key, reason: scalar.error }); continue }
    if (scalar.empty) { rejects.push({ line: lineNo, name: key, reason: '空值或纯空白' }); continue }
    entries.push({ name: key, value: scalar.value, line: lineNo, format: 'yaml' })
  }
  return { entries, rejects, notes: [] }
}

function parseText(text, filename) {
  const value = text.trim()
  if (value === '') return { entries: [], rejects: [], notes: [], fileError: '文件内容为空（trim 后没有值）' }
  const ext = extname(filename)
  let name = (ext ? filename.slice(0, -ext.length) : filename)
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .toUpperCase()
    .replace(/^_+|_+$/g, '')
  if (name === '') name = 'FILE'
  if (!/^[A-Za-z_]/.test(name)) name = `_${name}`
  name = name.slice(0, 128)
  return { entries: [{ name, value, ref: 'file', format: 'text' }], rejects: [], notes: [] }
}

// --- certificates / keys -----------------------------------------------------

/** `<PROJECT>_<stem>`; stem = filename without extension, upper, non-alnum -> `_`. */
function certName(filename, prefix) {
  const ext = extname(filename)
  const stem = (ext ? filename.slice(0, -ext.length) : filename)
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase() || 'CERT'
  let name = `${prefix}${stem}`
  if (!/^[A-Za-z_]/.test(name)) name = `_${name}`
  return name.slice(0, 128)
}

/** Extra tags implied by a certificate extension. */
function certTags(kind) {
  const tags = [`kind:${kind}`]
  if (kind === 'crt' || kind === 'p12') tags.push('kind:cert')
  if (kind === 'p12') tags.push('binary:b64')
  return tags
}

/**
 * One whole file -> exactly one secret value.
 * - `.p12` is binary: standard base64 of the raw bytes.
 * - the others must be valid UTF-8 and are kept byte-for-byte (no trim, no
 *   newline normalisation); a round-trip check proves sha256(value) equals
 *   sha256(file).
 * - a first line `# name: XXX` overrides the default name and stays in the value.
 */
function parseCert(buffer, filename, format, projectPrefix) {
  if (buffer.length === 0) {
    return { entries: [], rejects: [], notes: [], fileError: '文件为空（0 字节）' }
  }
  let value
  if (format === 'p12') {
    value = buffer.toString('base64')
  } else {
    value = buffer.toString('utf8')
    if (!Buffer.from(value, 'utf8').equals(buffer)) {
      return {
        entries: [], rejects: [], notes: [],
        fileError: '不是合法 UTF-8 文本：为保证字节级保真未做任何转码；二进制证书请改用 .p12',
      }
    }
  }
  const firstLine = (value.split('\n', 1)[0] ?? '').replace(/\r$/, '')
  const explicit = /^#\s*name\s*:\s*(\S.*?)\s*$/.exec(firstLine)
  let name
  if (explicit) {
    name = explicit[1].trim()
    if (!NAME_RE.test(name)) {
      return {
        entries: [], rejects: [], notes: [],
        fileError: `第一行 "# name:" 给出的名字不合法（须匹配 ${NAME_HINT}）`,
      }
    }
  } else {
    name = certName(filename, projectPrefix)
  }
  return {
    entries: [{
      name,
      value,
      ref: 'file',
      format,
      tags: certTags(format),
      certKind: format,
      certAutoName: explicit === null,
    }],
    rejects: [],
    notes: [],
  }
}

// --- validation and metadata -------------------------------------------------

function filePrefix(filename) {
  const ext = extname(filename)
  let stem = ext ? filename.slice(0, -ext.length) : filename
  stem = stem.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '')
  if (stem === '') stem = 'file'
  return stem.slice(0, 48)
}

function autoTags(filename, format) {
  return [`src:${format}`, `prefix:${filePrefix(filename)}`]
}

function finalizeEntry(entry, filename, filePath, projectTag = null) {
  if (typeof entry.name !== 'string' || !NAME_RE.test(entry.name)) {
    return { error: `name 不合法（须匹配 ${NAME_HINT}）` }
  }
  if (typeof entry.value !== 'string') return { error: 'value 必须是字符串' }
  if (entry.value.trim() === '') return { error: '空值或纯空白' }
  const bytes = Buffer.byteLength(entry.value, 'utf8')
  if (bytes > MAX_VALUE_BYTES) return { error: `值 ${bytes} 字节，超过上限 ${MAX_VALUE_BYTES} 字节` }

  const provided = typeof entry.description === 'string' ? entry.description.trim() : ''
  const description = provided === ''
    ? `from ${filename} (${filePath})`
    : `${provided} — from ${filename} (${filePath})`
  if (description.length > MAX_DESCRIPTION) return { error: `description 超过 ${MAX_DESCRIPTION} 字符` }

  const tags = []
  const candidates = [...autoTags(filename, entry.format)]
  if (projectTag !== null) candidates.push(projectTag)
  candidates.push(...(entry.tags ?? []))
  for (const tag of candidates) {
    if (tags.includes(tag)) continue
    if (!TAG_RE.test(tag)) return { error: `tag 不合法（第 ${tags.length + 1} 个，须 1-64 字符且不含空格或逗号）` }
    tags.push(tag)
  }
  if (tags.length > MAX_TAGS) return { error: `tags 超过 ${MAX_TAGS} 个` }

  return {
    item: {
      name: entry.name,
      value: entry.value,
      description,
      tags,
      bytes,
      chars: valueLength(entry.value),
      certKind: entry.certKind,
      certAutoName: entry.certAutoName,
    },
  }
}

// --- per-file ingest ---------------------------------------------------------

async function readSourceBytes(filePath) {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) throw Object.assign(new Error('不是普通文件'), { code: 'EISDIR' })
    return await readFile(filePath)
  } catch (error) {
    throw new Error(`无法读取：${error?.code ?? error?.message ?? 'unknown'}`)
  }
}

async function readSource(filePath) {
  return stripBom((await readSourceBytes(filePath)).toString('utf8'))
}

/** Sort skipped entries by line number / JSON item index for readable .err files. */
function rejectOrder(reject) {
  if (typeof reject.line === 'number') return reject.line
  const match = /^item\[(\d+)\]$/.exec(reject.ref ?? '')
  if (match) return Number(match[1]) + 0.5
  return Number.MAX_SAFE_INTEGER
}

function valueDigest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Two different names with the same value in one file usually mean a copy/paste
 * error. Returns `[{ a, b, fp }]`; `fp` is the first 8 hex chars of sha256(value).
 */
function findDuplicateValues(items) {
  const groups = new Map()
  for (const item of items) {
    const digest = valueDigest(item.value)
    const names = groups.get(digest)
    if (names === undefined) groups.set(digest, [item.name])
    else if (!names.includes(item.name)) names.push(item.name)
  }
  const duplicates = []
  for (const [digest, names] of groups) {
    if (names.length < 2) continue
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        duplicates.push({ a: names[i], b: names[j], fp: digest.slice(0, 8) })
      }
    }
  }
  return duplicates
}

/**
 * Parse one inbox file.
 * @param {string} filePath
 * @param {string} filename - basename (extension detection, archive name).
 * @param {{display?: string, projectName?: string|null, enforcePrefix?: boolean}} [job]
 *   `projectName` is the directory-derived project (enforced) or the `--project`
 *   override (tag only).
 */
async function ingestFile(filePath, filename, job = {}) {
  const format = detectFormat(filename)
  const display = job.display ?? filename
  const result = {
    file: filePath, filename, display, format,
    project: job.projectName ?? null, prefix: null,
    entries: [], valid: [], rejects: [], notes: [], empty: [], duplicates: [], renames: [],
    fileError: null, movedTo: null, errPath: null, moveError: null,
    prefixRejected: false,
  }

  // Validated per file so that one bad directory name rejects its files
  // instead of aborting the whole run.
  let project = null
  if (job.projectName !== undefined && job.projectName !== null) {
    project = projectContext(job.projectName, { requirePrefix: job.enforcePrefix === true })
    if (project.error) {
      result.fileError = project.error
      return result
    }
    if (job.enforcePrefix === true) result.prefix = project.prefix
  }
  const projectTag = project?.tag ?? null

  let parsed
  if (CERT_KINDS.has(format)) {
    let buffer
    try {
      buffer = await readSourceBytes(filePath)
    } catch (error) {
      result.fileError = error.message
      return result
    }
    parsed = parseCert(buffer, filename, format, project?.prefix ?? '')
  } else {
    let text
    try {
      text = await readSource(filePath)
    } catch (error) {
      result.fileError = error.message
      return result
    }
    try {
      if (format === 'env') parsed = parseEnv(text)
      else if (format === 'json') parsed = parseJson(text)
      else if (format === 'yaml') parsed = parseYaml(text)
      else parsed = parseText(text, filename)
    } catch (error) {
      result.fileError = `解析失败：${error?.message ?? 'unknown'}`
      return result
    }
  }

  result.entries = parsed.entries
  // Empty values are not "errors": they are skipped and reported as one merged
  // block in the .err file. Reasons other than "空值或纯空白" stay per-entry.
  result.rejects = []
  for (const reject of parsed.rejects) {
    if (reject.name && reject.reason === '空值或纯空白') {
      result.empty.push({ name: reject.name, line: reject.line, ref: reject.ref })
    } else {
      result.rejects.push(reject)
    }
  }
  result.notes = [...(parsed.notes ?? [])]
  result.fileError = parsed.fileError ?? null

  // A file that failed structurally contributes no entries.
  if (result.fileError) return result

  const seen = new Map()
  for (const entry of parsed.entries) {
    const outcome = finalizeEntry(entry, filename, filePath, projectTag)
    if (outcome.error) {
      if (outcome.error === '空值或纯空白' && typeof entry.name === 'string' && entry.name !== '') {
        result.empty.push({ name: entry.name, line: entry.line, ref: entry.ref })
      } else {
        result.rejects.push({ line: entry.line, ref: entry.ref, name: entry.name, reason: outcome.error })
      }
      continue
    }
    const item = outcome.item
    if (seen.has(item.name)) {
      const first = seen.get(item.name)
      result.rejects.push({
        line: entry.line,
        ref: entry.ref,
        name: item.name,
        reason: `同一文件内重名（首次出现在 ${first}）`,
      })
      continue
    }
    seen.set(item.name, entry.line ? `line ${entry.line}` : (entry.ref ?? 'first entry'))
    result.valid.push(item)
  }

  result.rejects.sort((a, b) => rejectOrder(a) - rejectOrder(b))
  result.empty = [...new Map(result.empty.map(item => [item.name, item])).values()]

  // Directory-derived project: every entry name must start with <PROJECT>_.
  // One mismatch rejects the whole file: nothing from it is written.
  if (project !== null && job.enforcePrefix === true) {
    const mismatched = result.valid.filter(item => !item.name.startsWith(project.prefix))
    if (mismatched.length > 0) {
      const names = mismatched.slice(0, 3).map(item => item.name).join('、')
      const more = mismatched.length > 3 ? ` 等 ${mismatched.length} 条` : ''
      const compliant = result.valid.filter(item => item.name.startsWith(project.prefix))
      const withheld = compliant.length
      result.rejects.push(...mismatched.map(item => ({
        name: item.name,
        ref: 'file',
        reason: `不以项目前缀 ${project.prefix} 开头`,
      })))
      result.rejects.sort((a, b) => rejectOrder(a) - rejectOrder(b))
      result.valid = []
      result.prefixRejected = true
      const detail = mismatched.length > 1 ? `（共 ${mismatched.length} 条：${names}${more}）` : ''
      result.fileError = `条目 ${mismatched[0].name} 不以项目前缀 ${project.prefix} 开头${detail}；整文件拒绝，未写入任何条目`
      if (withheld > 0) {
        const kept = compliant.slice(0, 5).map(item => item.name).join('、')
        const keptMore = withheld > 5 ? ` 等 ${withheld} 条` : ''
        result.notes.push(`整文件拒绝：另有 ${withheld} 条名字符合前缀的条目（${kept}${keptMore}）也一并未写入`)
      }
      return result
    }
  }

  result.duplicates = findDuplicateValues(result.valid)

  // Only "the whole file could not be parsed / has nothing to import" is a
  // file-level failure. Per-entry skips (bad value, empty value, ...) keep the
  // file in processed/ and are reported in its .err.
  if (result.valid.length === 0 && result.rejects.length === 0 && result.empty.length === 0) {
    result.fileError = '没有解析出任何条目'
  }
  return result
}

// --- vault -------------------------------------------------------------------

async function detectKeySource(vaultPath) {
  try {
    const envelope = parseEnvelope(await readFile(vaultPath, 'utf8'), VAULT_FORMAT)
    return envelope.kdf.name === 'keyfile' ? 'keyfile' : 'passphrase-env'
  } catch {
    return null
  }
}

function createVault({ vaultPath, keySource, keyfilePath, config }) {
  return new Vault({
    path: vaultPath,
    keySource,
    passphraseEnv: config.passphraseEnv,
    keyfilePath,
    scrypt: config.scrypt,
    lockTimeoutMs: config.lockTimeoutMs,
    lockStaleMs: config.lockStaleMs,
  })
}

/**
 * Unlock/decrypt before any write. `load({ requireKey: true })` checks the
 * passphrase, the keyfile, the vault format and the kdf/keySource match.
 */
async function assertVaultReady(vault, { vaultPath, keySource, keyfilePath }) {
  try {
    return await vault.load({ requireKey: true })
  } catch (error) {
    const message = error?.message ?? String(error)
    const lines = [
      '错误：无法打开/解锁保险库，本次没有写入任何数据。',
      `  保险库：${vaultPath}（keySource=${keySource}）`,
    ]
    const envMatch = /set environment variable (\S+)/.exec(message)
    const keyfileMatch = /keyfile not found at (.+)$/.exec(message)
    if (envMatch) lines.push(`  缺少：环境变量 ${envMatch[1]}（vault 主口令）`)
    else if (keyfileMatch) lines.push(`  缺少：keyfile 文件 ${keyfileMatch[1]}`)
    lines.push(`  原因：${message}`)
    if (envMatch) {
      lines.push(`  补救：在当前 shell 执行 export ${envMatch[1]}='<口令>' 后重跑；不要把口令写进聊天或日志。`)
      lines.push('        或改用 keyfile：--key-source keyfile --keyfile <路径>。')
    } else if (keyfileMatch) {
      lines.push(`  补救：生成 keyfile：head -c 32 /dev/urandom > ${keyfilePath} && chmod 600 ${keyfilePath}`)
      lines.push('        或检查 --keyfile / DSH_SECRETS_KEYFILE_PATH 是否指向正确文件。')
    } else if (/accessible by group\/other/.test(message)) {
      lines.push(`  补救：chmod 600 ${keyfilePath}`)
    } else if (/too short/.test(message)) {
      lines.push('  补救：keyfile 需要至少 32 原始字节，或 64 个 hex 字符，或 32 字节的 base64。')
    } else if (/decryption failed/.test(message)) {
      lines.push('  原因提示：口令/keyfile 与现有 vault 不匹配，或 vault 文件已损坏。')
    } else if (/uses kdf/.test(message)) {
      lines.push('  补救：用 --key-source 指定与 vault header 匹配的来源。')
    } else if (/writable by group\/other/.test(message)) {
      lines.push(`  补救：chmod 700 ${dirname(vaultPath)}`)
    }
    lines.push('  未创建 vault、未搬动 inbox 文件、未生成 .err。')
    throw new UsageError(lines.join('\n'))
  }
}

async function writeVault(vault, items) {
  const now = new Date().toISOString()
  return vault.mutate((entries) => {
    for (const item of items) {
      const previous = entries[item.name]
      entries[item.name] = {
        value: item.value,
        description: item.description,
        tags: item.tags,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        metaUpdatedAt: now,
      }
    }
    return { written: items.length }
  })
}

// --- name collisions ---------------------------------------------------------

/** A certificate whose name was derived from the filename (no `# name:` line). */
function isAutoCert(item) {
  return item.certKind !== undefined && item.certAutoName === true
}

/** `LUMEN_LUMEN` + `p12` -> `LUMEN_LUMEN_P12`. */
function qualifiedName(name, kind) {
  return `${name}_${String(kind).toUpperCase()}`.slice(0, 128)
}

/**
 * Prevent silent overwrites before building the write plan.
 *
 * - Auto-named certificates (`<PROJECT>_<STEM>`) that collide with a *different*
 *   value — in this batch or already in the vault — are renamed to
 *   `<PROJECT>_<STEM>_<EXT>` so every file keeps its own entry
 *   (lumen.pem/lumen.p12 -> LUMEN_LUMEN_PEM/LUMEN_LUMEN_P12).
 * - If even the qualified name is taken by a different value, the entry is
 *   skipped, reported in the .err and counted as skipped (exit code 1).
 * - Other entries keep first-wins within the batch: later entries with the same
 *   value are idempotent, later entries with a different value are skipped.
 * - Identical values are never treated as an error.
 *
 * Mutates `result.valid` / `result.rejects` / `result.renames` / `result.notes`.
 * @returns {{renamed: number, skipped: number}}
 */
function resolveNameCollisions(results, existingEntries) {
  const entries = []
  for (const result of results) {
    if (result.fileError) continue
    for (const item of result.valid) entries.push({ item, result, preferred: item.name })
  }

  // Pass 1: vault-aware preference. A real run has decrypted entries here; a
  // dry-run passes null (it must not read the passphrase), so only in-batch
  // collisions are visible in dry-run.
  if (existingEntries !== null) {
    for (const entry of entries) {
      if (!isAutoCert(entry.item)) continue
      const { item } = entry
      const qualified = qualifiedName(item.name, item.certKind)
      const sameName = existingEntries[item.name]
      const qualifiedEntry = existingEntries[qualified]

      // Same name and same value: already imported, nothing to move.
      if (sameName !== undefined && sameName.value === item.value) continue

      if (sameName !== undefined) {
        // The default name holds a different value: move to the qualified name.
        entry.preferred = qualified
        entry.fromVault = true
        if (qualifiedEntry !== undefined && qualifiedEntry.value !== item.value) {
          entry.skipReason = `默认名 ${item.name} 冲突，改用 ${qualified} 仍与 vault 里的不同值冲突，已跳过`
        } else if (qualifiedEntry !== undefined) {
          entry.idempotentRename = true
        }
        continue
      }

      if (qualifiedEntry !== undefined) {
        // A previous run renamed this file; keep using the qualified name.
        entry.preferred = qualified
        entry.fromVault = true
        if (qualifiedEntry.value !== item.value) {
          entry.skipReason = `默认名 ${item.name} 未被占用，但 ${qualified} 已存在且值不同，已跳过`
        } else {
          entry.idempotentRename = true
        }
      }
    }
  }

  // Pass 2: group by the preferred name and assign a final name per entry.
  const groups = new Map()
  for (const entry of entries) {
    const list = groups.get(entry.preferred)
    if (list === undefined) groups.set(entry.preferred, [entry])
    else list.push(entry)
  }

  for (const [name, group] of groups) {
    const values = new Set(group.map(entry => entry.item.value))
    if (values.size === 1) {
      for (const entry of group) entry.finalName = name
      for (const entry of group.slice(1)) entry.idempotent = true
      continue
    }

    const certificates = group.filter(entry => isAutoCert(entry.item))
    const fixed = group.filter(entry => !isAutoCert(entry.item))

    // Non-cert / explicit `# name:` entries: first one wins.
    if (fixed.length > 0) {
      fixed[0].finalName = name
      for (const entry of fixed.slice(1)) {
        entry.finalName = name
        if (entry.item.value === fixed[0].item.value) entry.idempotent = true
        else entry.skipReason = `同名不同值：${name} 已被 ${fixed[0].result.display} 使用且值不同，本条未写入`
      }
    }

    // Auto-named certs move out of a name that holds a different value.
    for (const entry of certificates) {
      if (entry.skipReason !== undefined) continue
      const owner = fixed[0]
      if (owner !== undefined && owner.item.value === entry.item.value) {
        entry.finalName = name
        entry.idempotent = true
        continue
      }
      if (entry.fromVault) {
        // Already moved to the qualified name once; a second clash is a skip.
        entry.finalName = entry.preferred
        entry.skipReason = `默认名 ${entry.item.name} 冲突，改用 ${entry.preferred} 仍与不同值冲突，已跳过`
        continue
      }
      entry.finalName = qualifiedName(name, entry.item.certKind)
    }
  }

  // Pass 3: names can still collide after renaming (e.g. a literal
  // `LUMEN_LUMEN_PEM` entry). First wins; the rest are skipped.
  const finalGroups = new Map()
  for (const entry of entries) {
    if (entry.skipReason !== undefined) continue
    const list = finalGroups.get(entry.finalName)
    if (list === undefined) finalGroups.set(entry.finalName, [entry])
    else list.push(entry)
  }
  for (const [name, group] of finalGroups) {
    if (new Set(group.map(entry => entry.item.value)).size > 1) {
      for (const entry of group.slice(1)) {
        entry.skipReason = `目标名 ${name} 已被 ${group[0].result.display} 使用且值不同，无法改名写入`
      }
    } else {
      for (const entry of group.slice(1)) entry.idempotent = true
    }
  }

  // Pass 4: a renamed entry must not overwrite a different value already in the
  // vault under the qualified name.
  if (existingEntries !== null) {
    for (const entry of entries) {
      if (entry.skipReason !== undefined) continue
      if (entry.finalName === undefined || entry.finalName === entry.item.name) continue
      const clash = existingEntries[entry.finalName]
      if (clash !== undefined && clash.value !== entry.item.value) {
        entry.skipReason = `默认名 ${entry.item.name} 冲突后改用 ${entry.finalName}，但 vault 里该名字已存在且值不同，已跳过`
      }
    }
  }

  // Apply: rename items, remove skipped ones from this file's write set.
  let renamed = 0
  let skipped = 0
  for (const entry of entries) {
    const { item, result } = entry
    if (entry.skipReason !== undefined) {
      result.valid = result.valid.filter(candidate => candidate !== item)
      result.rejects.push({
        ref: 'file',
        code: 'name-collision',
        name: entry.finalName,
        reason: entry.skipReason,
      })
      skipped++
      continue
    }
    if (entry.finalName !== undefined && entry.finalName !== item.name) {
      const from = item.name
      item.name = entry.finalName
      if (entry.idempotentRename === true) {
        result.notes.push(`沿用上次冲突改名后的名字：${from} → ${entry.finalName}（同值，幂等）`)
      } else {
        result.renames.push({ from, to: entry.finalName })
        result.notes.push(`默认名冲突：${from} → ${entry.finalName}（加扩展名区分，避免覆盖）`)
        renamed++
      }
    }
    if (entry.idempotent) {
      result.notes.push(`同名同值：${item.name} 与前面的条目值相同，只写入一次（幂等）`)
    }
  }
  return { renamed, skipped }
}

// --- reporting ---------------------------------------------------------------

function pad(text, width) {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function printHeader({ dryRun, inbox, processedDir, rejectedDir, vaultPath, keySource, projectOverride, fileMode = false }) {
  console.log(`== dsh-secrets ingest-file ${dryRun ? '（dry-run 预演，不写任何文件）' : '（真跑）'} ==`)
  console.log(`inbox:     ${fileMode ? '（显式文件模式，只支持 --dry-run）' : inbox}`)
  console.log(`processed: ${processedDir}`)
  console.log(`rejected:  ${rejectedDir}`)
  console.log(`vault:     ${vaultPath}`)
  console.log(`keySource: ${keySource}${dryRun ? '（dry-run 不读取口令/keyfile）' : ''}`)
  console.log(`project:   ${projectOverride === null
    ? '（按 inbox 一级子目录名派生，强制前缀校验）'
    : `${projectOverride.tag}（仅 inbox 根下文件；只打 tag，不强制前缀）`}`)
}

/** Aggregate per-file counters for the run summary. */
function summarize(results) {
  const count = key => results.reduce((n, result) => n + result[key].length, 0)
  const byCode = code => results.reduce(
    (n, result) => n + result.rejects.filter(reject => reject.code === code).length,
    0,
  )
  return {
    files: results.length,
    extracted: count('entries'),
    skipped: count('rejects'),
    empty: count('empty'),
    duplicates: count('duplicates'),
    duplicatePairs: results.flatMap(result => result.duplicates),
    renamed: count('renames'),
    failedFiles: results.filter(result => result.fileError !== null).length,
    prefixRejected: results.filter(result => result.prefixRejected).length,
    missingValue: byCode('missing-value'),
    nonStringValue: byCode('non-string-value'),
  }
}

function printSummary(stats, { written, dryRun }) {
  console.log(`汇总：文件=${stats.files} 解析=${stats.extracted} ${dryRun ? '计划写入' : '导入'}=${written} `
    + `跳过=${stats.skipped} 空值=${stats.empty} 改名=${stats.renamed} 失败文件=${stats.failedFiles}`)
  const other = stats.skipped - stats.missingValue - stats.nonStringValue
  console.log(`跳过构成：缺 value 键=${stats.missingValue} 非字符串 value=${stats.nonStringValue} 其他=${other}`)
  if (stats.prefixRejected > 0) {
    console.log(`项目前缀校验：整文件拒绝=${stats.prefixRejected}（这些文件里的条目一条都没有写入）`)
  }
  console.log(`同值告警：${stats.duplicates} 组${stats.duplicates > 0 ? '（仅告警，不影响退出码）' : ''}`)
  for (const dup of stats.duplicatePairs.slice(0, 20)) {
    console.log(`  ! ${dup.a} 与 ${dup.b} 值完全相同（指纹 ${dup.fp}）`)
  }
  if (stats.duplicatePairs.length > 20) {
    console.log(`  …另有 ${stats.duplicatePairs.length - 20} 组同值告警，详见各文件的 .err`)
  }
}

function printFileResult(result, dryRun) {
  const hasWarnings = result.rejects.length > 0 || result.empty.length > 0
    || result.duplicates.length > 0 || result.renames.length > 0
  const status = result.fileError ? 'fail' : (hasWarnings ? 'warn' : 'ok')
  const counts = `条目=${result.entries.length} 通过=${result.valid.length} 跳过=${result.rejects.length} 空值=${result.empty.length}`
  const project = result.project ? ` project=${result.project}${result.prefix ? ` prefix=${result.prefix}` : ''}` : ''
  let where = ''
  if (result.fileError) {
    where = dryRun
      ? ' -> 将归档到 rejected/（并写 .err）'
      : ` -> ${result.movedTo ?? '(未搬动)'}${result.moveError ? `（搬移失败：${result.moveError}）` : ''}`
    console.log(`[${status}] ${result.display} (${result.format})${project} ${counts}${where}`)
    console.log(`       文件级错误：${result.fileError}`)
  } else {
    where = dryRun ? ' -> 将归档到 processed/（部分跳过时写 .err）' : ` -> ${result.movedTo ?? '(未搬动)'}`
    if (result.moveError) where += `（搬移失败：${result.moveError}）`
    console.log(`[${status}] ${result.display} (${result.format})${project} ${counts}${where}`)
  }
  for (const item of result.valid) {
    const action = dryRun ? '计划写入' : '写入'
    console.log(`       + ${pad(item.name, 32)} fp=${fingerprint(item.value)} bytes=${item.bytes} chars=${item.chars} tags=${item.tags.join(',')} (${action})`)
  }
  for (const rename of result.renames) {
    console.log(`       ~ 改名：${rename.from} → ${rename.to}（默认名冲突，加扩展名区分）`)
  }
  for (const reject of result.rejects) {
    const place = reject.line ? `line ${reject.line}` : (reject.ref ?? '?')
    const who = reject.name ? ` ${reject.name}` : ''
    console.log(`       - ${place}${who} 跳过：${reject.reason}`)
  }
  if (result.empty.length > 0) {
    console.log(`       - 空值跳过 ${result.empty.length} 条（.err 里合并为一段）：${result.empty.map(item => item.name).join('、')}`)
  }
  for (const dup of result.duplicates) {
    console.log(`       ! 同值告警：${dup.a} 与 ${dup.b} 值完全相同（指纹 ${dup.fp}）`)
  }
  for (const note of result.notes) console.log(`       · ${note}`)
  if (result.errPath) console.log(`       .err: ${result.errPath}`)
}

function renderErr(result, at) {
  const lines = [
    '# dsh-secrets ingest-file.mjs',
    `file: ${result.file}`,
    `filename: ${result.filename}`,
    `format: ${result.format}`,
    `result: ${result.fileError ? 'rejected' : 'partial'}`,
    `counts: 条目=${result.entries.length} 通过=${result.valid.length} 跳过=${result.rejects.length} 空值=${result.empty.length}`,
    `at: ${at}`,
  ]
  if (result.project) lines.push(`project: ${result.project}${result.prefix ? ` (prefix ${result.prefix})` : ' (no prefix check)'}`)
  if (result.movedTo) lines.push(`moved-to: ${result.movedTo}`)
  if (result.moveError) lines.push(`move-error: ${result.moveError}`)
  if (result.fileError) lines.push(`file-error: ${result.fileError}`)
  lines.push('', 'skipped:')
  if (result.rejects.length === 0) lines.push('  (none)')
  for (const reject of result.rejects) {
    const place = reject.line ? `line ${reject.line}` : (reject.ref ?? 'unknown')
    lines.push(`  ${place}  ${reject.name ? `${reject.name}: ` : ''}${reject.reason}`)
  }
  if (result.renames.length > 0) {
    lines.push('', `renamed（${result.renames.length} 条，默认名冲突，已加扩展名区分）:`)
    for (const rename of result.renames) lines.push(`  ${rename.from} → ${rename.to}`)
  }
  if (result.empty.length > 0) {
    lines.push('', `empty-values（${result.empty.length} 条，空值已跳过）:`)
    for (const item of result.empty) lines.push(`  ${item.name}: 空值已跳过`)
  }
  if (result.duplicates.length > 0) {
    lines.push('', `duplicate-values（${result.duplicates.length} 组，仅告警，不影响退出码）:`)
    for (const dup of result.duplicates) {
      lines.push(`  ${dup.a} 与 ${dup.b} 值完全相同（指纹 ${dup.fp}）`)
    }
  }
  if (result.notes.length > 0) {
    lines.push('', 'notes:')
    for (const note of result.notes) lines.push(`  ${note}`)
  }
  lines.push('', '# 本文件只有名称、行号和原因，不含任何密钥值。')
  return `${lines.join('\n')}\n`
}

// --- main --------------------------------------------------------------------

async function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(USAGE)
    return 0
  }

  const config = resolveConfig({}, process.env)
  const keysDir = resolve(options.keysDir ?? DEFAULT_KEYS_DIR)
  const inbox = resolve(options.inbox ?? join(keysDir, 'inbox'))
  const processedDir = resolve(options.processed ?? join(dirname(inbox), 'processed'))
  const rejectedDir = resolve(options.rejected ?? join(dirname(inbox), 'rejected'))
  const projectOverride = options.project === null
    ? null
    : projectContext(options.project, { requirePrefix: false })
  if (projectOverride !== null && projectOverride.error) {
    throw new UsageError(`--project：${projectOverride.error}`)
  }
  const explicitFiles = options.files.map(item => resolve(item))
  if (explicitFiles.length > 0 && !options.dryRun) {
    throw new UsageError('显式文件参数只支持 --dry-run（只预览：不写库、不搬文件、不建 .err）；'
      + '真跑请把文件放进 <inbox>，或用 --dir 指向文件所在目录。')
  }
  const vaultPath = resolve(options.vault ?? process.env.DSH_SECRETS_VAULT_PATH ?? config.vaultPath)
  const keyfilePath = resolve(options.keyfile ?? process.env.DSH_SECRETS_KEYFILE_PATH ?? config.keyfilePath)

  let keySource = options.keySource !== null
    ? normalizeKeySource(options.keySource, '--key-source')
    : normalizeKeySource(process.env.DSH_SECRETS_KEY_SOURCE, 'DSH_SECRETS_KEY_SOURCE')
  if (keySource === null) keySource = await detectKeySource(vaultPath)
  if (keySource === null) keySource = config.keySource

  const vault = createVault({ vaultPath, keySource, keyfilePath, config })

  // Hard requirement: the key check happens before any write (no vault dir, no
  // move, no .err). --dry-run is explicitly exempt, so it also cannot see the
  // existing vault values used for cross-batch collision checks.
  let existingEntries = null
  if (!options.dryRun) {
    const loaded = await assertVaultReady(vault, { vaultPath, keySource, keyfilePath })
    existingEntries = loaded.entries
  }
  const vaultOnDisk = options.dryRun ? await vault.exists() : false

  const jobs = []
  const projectDirs = []
  const nestedDirs = []

  if (explicitFiles.length > 0) {
    // Preview mode: one or more explicit files, --dry-run only.
    for (const path of explicitFiles) {
      const info = await stat(path).catch((error) => {
        if (error?.code === 'ENOENT') throw new UsageError(`文件不存在：${path}`)
        throw new UsageError(`无法访问文件 ${path}：${error?.code ?? error?.message}`)
      })
      if (!info.isFile()) throw new UsageError(`不是普通文件：${path}`)
      // Derive the project exactly like the directory scan would: a file whose
      // parent is a direct child of <inbox> belongs to that project.
      const dir = dirname(path)
      const projectName = dir !== inbox && dirname(dir) === inbox
        ? basename(dir)
        : (projectOverride?.name ?? null)
      const display = path.startsWith(`${inbox}/`) ? path.slice(inbox.length + 1) : path
      jobs.push({
        file: path,
        filename: basename(path),
        display,
        projectName,
        enforcePrefix: dir !== inbox && dirname(dir) === inbox,
      })
    }
    jobs.sort((a, b) => a.display.localeCompare(b.display))
  } else {
    const inboxInfo = await stat(inbox).catch((error) => {
      if (error?.code === 'ENOENT') throw new UsageError(`投放目录不存在：${inbox}`)
      throw new UsageError(`无法访问投放目录 ${inbox}：${error?.code ?? error?.message}`)
    })
    if (!inboxInfo.isDirectory()) throw new UsageError(`投放目录不是目录：${inbox}`)

    const dirents = await readdir(inbox, { withFileTypes: true })
    for (const dirent of dirents) {
      if (dirent.isFile()) {
        jobs.push({
          file: join(inbox, dirent.name),
          filename: dirent.name,
          display: dirent.name,
          projectName: projectOverride?.name ?? null,
          enforcePrefix: false,
        })
        continue
      }
      if (!dirent.isDirectory()) continue
      projectDirs.push(dirent.name)
      const children = await readdir(join(inbox, dirent.name), { withFileTypes: true })
      for (const child of [...children].sort((a, b) => a.name.localeCompare(b.name))) {
        if (child.isDirectory()) { nestedDirs.push(`${dirent.name}/${child.name}`); continue }
        if (!child.isFile()) continue
        jobs.push({
          file: join(inbox, dirent.name, child.name),
          filename: child.name,
          display: `${dirent.name}/${child.name}`,
          projectName: dirent.name,
          enforcePrefix: true,
        })
      }
    }
    jobs.sort((a, b) => a.display.localeCompare(b.display))
  }

  printHeader({ dryRun: options.dryRun, inbox, processedDir, rejectedDir, vaultPath, keySource, projectOverride, fileMode: explicitFiles.length > 0 })
  if (vaultOnDisk) {
    console.log('注意：vault 已存在；dry-run 不读口令/不解密，跨批同名冲突只在真跑时检测（批内冲突仍会检测）。')
  }
  if (explicitFiles.length > 0) console.log(`文件:      ${jobs.map(job => job.file).join(', ')}`)
  const projectNote = projectDirs.length > 0 ? `（含项目子目录 ${projectDirs.length} 个：${projectDirs.join(', ')}）` : ''
  console.log(`文件数:    ${jobs.length}${projectNote}`)
  if (nestedDirs.length > 0) console.log(`忽略更深的子目录（只扫一级）：${nestedDirs.join(', ')}`)
  if (jobs.length === 0) console.log('（inbox 为空，没有可导入的文件）')
  if (jobs.length > 0) console.log('')

  const results = []
  for (const job of jobs) {
    results.push(await ingestFile(job.file, job.filename, job))
  }

  // Same-name protection: certificates that would share a default name get an
  // extension suffix; remaining same-name/different-value entries are skipped.
  resolveNameCollisions(results, existingEntries)

  // First occurrence wins; identical later values are idempotent no-ops.
  const plan = new Map()
  for (const result of results) {
    if (result.fileError) continue
    for (const item of [...result.valid]) {
      if (plan.has(item.name)) continue
      plan.set(item.name, { ...item, file: result.file })
    }
  }

  if (options.dryRun) {
    for (const result of results) printFileResult(result, true)
    const stats = summarize(results)
    console.log('')
    printSummary(stats, { written: plan.size, dryRun: true })
    console.log('dry-run：未写入保险库、未搬动文件、未生成 .err、未读取口令/keyfile。')
    return 0
  }

  console.log('')

  let written = 0
  if (plan.size > 0) {
    try {
      const outcome = await writeVault(vault, [...plan.values()])
      written = outcome?.written ?? plan.size
    } catch (error) {
      console.error(`错误：写入保险库失败，未搬动任何源文件。`)
      console.error(`  保险库：${vaultPath}`)
      console.error(`  原因：${error?.message ?? error}`)
      return 3
    }
  }

  let moveErrors = 0
  let errErrors = 0
  for (const result of results) {
    const isRejected = result.fileError !== null
    const targetDir = isRejected ? rejectedDir : processedDir
    try {
      result.movedTo = await moveInto(targetDir, result.filename, result.file)
    } catch (error) {
      result.moveError = error?.message ?? String(error)
      moveErrors++
    }
    const needsErr = isRejected || result.rejects.length > 0 || result.empty.length > 0
      || result.duplicates.length > 0 || result.renames.length > 0 || result.notes.length > 0
    if (needsErr) {
      try {
        // The .err sits next to the archived file: processed/<file>.err for a
        // partially imported file, rejected/<file>.err for a rejected one.
        result.errPath = await writeErrFile(targetDir, result.filename, renderErr(result, new Date().toISOString()))
      } catch (error) {
        errErrors++
        result.notes.push(`写入 .err 失败：${error?.message ?? error}`)
      }
    }
  }

  for (const result of results) printFileResult(result, false)

  const stats = summarize(results)
  const processedFiles = results.filter(r => r.fileError === null && r.movedTo !== null).length
  const rejectedFiles = results.filter(r => r.fileError !== null && r.movedTo !== null).length

  console.log('')
  printSummary(stats, { written, dryRun: false })
  console.log(`归档：processed=${processedFiles} rejected=${rejectedFiles} 搬移失败=${moveErrors} .err失败=${errErrors}`)
  if (stats.skipped > 0 || stats.empty > 0 || stats.failedFiles > 0 || moveErrors > 0 || errErrors > 0) {
    console.log('注意：有被跳过/拒绝的条目，请查看对应目录下的 *.err；被跳过的值没有写入保险库。')
    return 1
  }
  return 0
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code },
  (error) => {
    if (error instanceof UsageError) console.error(error.message)
    else console.error(`错误：${error?.message ?? error}`)
    process.exitCode = 2
  },
)
