#!/usr/bin/env node
/**
 * Self-test for scripts/ingest-file.mjs.
 *
 * Everything happens under one `mkdtemp()` root: a temporary DSH_HOME (vault +
 * passphrase live there) and temporary keys roots (`inbox/processed/rejected`).
 * It never touches `/root/.dsh`, `/srv/workspace/keys` or any real vault, and
 * it prints names, tags, byte lengths and SHA-256 digests only — never a value.
 *
 * Usage: node scripts/ingest-file.selftest.mjs
 * Exit code 0 = all checks passed.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Vault } from '../packages/host-secrets/vault.js'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'ingest-file.mjs')
const PASSPHRASE_ENV = 'DSH_SECRETS_PASSPHRASE'
const PASSPHRASE = 'selftest-passphrase-not-a-real-secret'
const REAL_VAULT = '/root/.dsh/secrets.vault'
const REAL_INBOX = '/srv/workspace/keys/inbox'

// Fake values only. Their literal bodies must never appear in any output.
const MARKERS = {
  root: 'FAKE-ROOT-TOKEN-9f8e7d6c',
  lumen: 'FAKE-LUMEN-TOKEN-a1b2c3',
  pem: 'FAKE-PEM-BODY-a1b2c3d4e5f6',
  key: 'FAKE-KEY-BODY-QWERTY',
  crt: 'FAKE-CRT-BODY-zzz',
  project: 'FAKE-PROJECT-TOKEN-p9q8r7',
  rootPem: 'FAKE-ROOT-PEM-BODY-m3n4o5',
  json: 'FAKE-JSON-VALUE-11',
  yaml: 'FAKE-YAML-VALUE-22',
  text: 'FAKE-TEXT-VALUE-33',
  jsonString: 'FAKE-JSON-STRING-ENTRY',
  jsonObj: 'FAKE-JSON-OBJECT-VALUE',
  jsonDup: 'FAKE-JSON-DUPLICATE-VALUE',
  jsonTag: 'FAKE-JSON-TAGMIX-VALUE',
  preview: 'FAKE-PREVIEW-VALUE',
  collidePem: 'FAKE-COLLIDE-PEM-BODY',
  soloPem: 'FAKE-CROSS-PEM-BODY',
  batchOne: 'FAKE-BATCH-VALUE-ONE',
  batchTwo: 'FAKE-BATCH-VALUE-TWO',
  sameDup: 'FAKE-SAME-DUP-VALUE',
  xhsOk: 'FAKE-XHS-OK-VALUE',
  other: 'FAKE-OTHER-FOO-VALUE',
  dry: 'FAKE-DRY-RUN-VALUE',
}
const ALL_MARKERS = Object.values(MARKERS)

const results = []
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push({ name, ok: true }); console.log(`PASS  ${name}`) })
    .catch((error) => {
      results.push({ name, ok: false, error: error?.message ?? String(error) })
      console.log(`FAIL  ${name}: ${error?.message ?? error}`)
    })
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const sha256File = async (path) => sha256(await readFile(path))

async function exists(path) {
  try { await stat(path); return true } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function list(dir) {
  try { return (await readdir(dir)).sort() } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function fail(message) { throw new Error(message) }
function must(condition, message) { if (!condition) fail(message) }

async function main() {
  // Fixed points: never write these.
  const before = {
    realVault: await stat(REAL_VAULT).then(info => `${info.size}:${info.mtimeMs}`).catch(() => 'absent'),
    realInbox: (await list(REAL_INBOX))?.join(',') ?? 'absent',
  }

  const root = await mkdtemp(join(tmpdir(), 'dsh-ingest-selftest-'))
  const home = join(root, 'home')
  const vaultPath = join(home, 'secrets.vault')
  await mkdir(home, { recursive: true, mode: 0o700 })
  await chmod(home, 0o700)

  const childEnv = { ...process.env }
  for (const key of Object.keys(childEnv)) {
    if (key === 'DSH_HOME' || key.startsWith('DSH_SECRETS_')) delete childEnv[key]
  }
  childEnv.DSH_HOME = home
  childEnv[PASSPHRASE_ENV] = PASSPHRASE
  childEnv.DSH_SECRETS_TEST = '1'

  const run = (args) => {
    const out = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: childEnv })
    if (out.error) fail(`无法启动脚本：${out.error.code ?? 'spawn error'}`)
    return { code: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
  }

  const keysA = join(root, 'keys-dry')
  const keysB = join(root, 'keys-real')
  const keysC = join(root, 'keys-project')
  const keysD = join(root, 'keys-dry2')
  const makeKeys = async (dir) => {
    await mkdir(join(dir, 'inbox'), { recursive: true, mode: 0o700 })
    return dir
  }

  try {
    // ---------------------------------------------------------------- A: dry-run
    await makeKeys(keysA)
    await writeFile(join(keysA, 'inbox', 'dry.env'), `DRY_RUN_KEY=${MARKERS.dry}\n`)
    await mkdir(join(keysA, 'inbox', 'xhs'), { recursive: true, mode: 0o700 })
    await writeFile(join(keysA, 'inbox', 'xhs', 'ca.crt'), `-----BEGIN CERTIFICATE-----\n${MARKERS.crt}\n-----END CERTIFICATE-----\n`)

    const dry = run(['--keys-dir', keysA, '--vault', vaultPath, '--dry-run'])

    await check('dry-run: 退出码 0 且不创建 vault', async () => {
      must(dry.code === 0, `退出码 ${dry.code}，stderr=${dry.stderr.slice(0, 500)}`)
      must(!(await exists(vaultPath)), 'dry-run 后 vault 出现了')
      must((await list(home)).length === 0, `dry-run 在 DSH_HOME 里留下了文件：${(await list(home)).join(',')}`)
    })
    await check('dry-run: 不创建 processed/rejected、不搬文件', async () => {
      must((await list(join(keysA, 'processed'))) === null, 'dry-run 创建了 processed/')
      must((await list(join(keysA, 'rejected'))) === null, 'dry-run 创建了 rejected/')
      must((await list(join(keysA, 'inbox')))?.join(',') === 'dry.env,xhs', 'inbox 内容被改动')
      must(await exists(join(keysA, 'inbox', 'dry.env')), 'dry.env 被搬走')
    })
    await check('dry-run: 打印计划（name/tag/长度/指纹）且不含值', async () => {
      const text = dry.stdout
      must(text.includes('DRY_RUN_KEY'), '计划里没有条目名')
      must(text.includes('fp='), '计划里没有指纹')
      must(text.includes('bytes='), '计划里没有长度')
      must(text.includes('tags=src:env'), '计划里没有 tag')
      must(text.includes('project:xhs'), '计划里没有 project:xhs tag')
      must(text.includes('kind:crt') && text.includes('kind:cert'), '计划里没有证书 kind tag')
      must(text.includes('计划写入'), '计划里没有“计划写入”')
      const leaks = ALL_MARKERS.filter(marker => text.includes(marker))
      must(leaks.length === 0, `dry-run 输出泄露了值（${leaks.length} 处标记）`)
    })

    // ------------------------------------------------------------- B: real run
    await makeKeys(keysB)
    await mkdir(join(keysB, 'inbox', 'lumen'), { recursive: true, mode: 0o700 })
    await mkdir(join(keysB, 'inbox', 'xhs'), { recursive: true, mode: 0o700 })

    const pemBody = `-----BEGIN CERTIFICATE-----\n${MARKERS.pem}\nRkFLRS1QRU0tU0VDT05ELUxJTkU=\n-----END CERTIFICATE-----\n`
    const keyBody = `-----BEGIN PRIVATE KEY-----\n${MARKERS.key}\n-----END PRIVATE KEY-----`
    const crtBody = `# name: LUMEN_CA_CUSTOM\n-----BEGIN CERTIFICATE-----\n${MARKERS.crt}\n-----END CERTIFICATE-----\n`
    const p12Bytes = Buffer.from(Array.from({ length: 160 }, (_, i) => (i * 37 + 11) & 0xff))
    const files = {
      'lumen/lumen.pem': Buffer.from(pemBody, 'utf8'),
      'lumen/signing.key': Buffer.from(keyBody, 'utf8'),
      'lumen/ca.crt': Buffer.from(crtBody, 'utf8'),
      'xhs/cert.p12': p12Bytes,
      'lumen/lumen.env': Buffer.from(`LUMEN_API_KEY=${MARKERS.lumen}\n`, 'utf8'),
      'lumen/UPPER.PEM': Buffer.from(`-----BEGIN CERTIFICATE-----\n${MARKERS.pem}-UPPER\n-----END CERTIFICATE-----\n`, 'utf8'),
      'xhs/CERT2.P12': p12Bytes,
      'root.env': Buffer.from(`ROOT_TOKEN=${MARKERS.root}\n`, 'utf8'),
      'solo.pem': Buffer.from(`-----BEGIN CERTIFICATE-----\n${MARKERS.pem}-SOLO\n-----END CERTIFICATE-----\n`, 'utf8'),
    }
    for (const [rel, buffer] of Object.entries(files)) {
      await writeFile(join(keysB, 'inbox', rel), buffer)
    }
    const badEnv = `XHS_OK=${MARKERS.xhsOk}\nOTHER_FOO=${MARKERS.other}\n`
    await writeFile(join(keysB, 'inbox', 'xhs', 'bad.env'), badEnv)

    const sourceHashes = Object.fromEntries(
      await Promise.all(Object.keys(files).map(async rel => [rel, await sha256File(join(keysB, 'inbox', rel))])),
    )

    const real = run(['--keys-dir', keysB, '--vault', vaultPath])

    await check('真跑: 前缀不匹配 → 退出码 1，文件进 rejected/ 且不写库', async () => {
      must(real.code === 1, `退出码 ${real.code}，期望 1`)
      const rejected = await list(join(keysB, 'rejected'))
      must(rejected !== null, 'rejected/ 不存在')
      must(rejected.includes('bad.env'), `bad.env 没进 rejected/（实际：${rejected.join(',')}）`)
      must(rejected.includes('bad.env.err'), '.err 没生成')
      must(!(await exists(join(keysB, 'inbox', 'xhs', 'bad.env'))), 'bad.env 还在 inbox')
      const processed = await list(join(keysB, 'processed'))
      must(!processed.includes('bad.env'), '前缀不匹配的文件被归档到 processed/')
      must(real.stdout.includes('项目前缀校验：整文件拒绝=1'), '汇总里没有项目前缀拒绝计数')
      must(real.stdout.includes('不以项目前缀 XHS_ 开头'), '输出里没有前缀原因')
    })
    await check('真跑: .err 写明原因且不含任何值', async () => {
      const err = await readFile(join(keysB, 'rejected', 'bad.env.err'), 'utf8')
      must(err.includes('OTHER_FOO'), '.err 里没有违规条目名')
      must(err.includes('不以项目前缀 XHS_ 开头'), '.err 里没有前缀原因')
      must(err.includes('XHS_OK'), '.err 里没有说明同文件其他条目也未写入')
      const leaks = ALL_MARKERS.filter(marker => err.includes(marker))
      must(leaks.length === 0, `.err 泄露了值（${leaks.length} 处标记）`)
    })
    await check('真跑: stdout/stderr 不含任何值', async () => {
      const text = `${real.stdout}\n${real.stderr}`
      const leaks = ALL_MARKERS.filter(marker => text.includes(marker))
      must(leaks.length === 0, `输出泄露了值（${leaks.length} 处标记）`)
    })
    await check('真跑: 归档文件字节不变，vault 0600 / 目录 0700', async () => {
      for (const [rel, digest] of Object.entries(sourceHashes)) {
        const archived = join(keysB, 'processed', rel.split('/').pop())
        must(await exists(archived), `processed/ 里缺 ${rel.split('/').pop()}`)
        must(await sha256File(archived) === digest, `归档后字节变了：${rel}`)
      }
      const vaultInfo = await stat(vaultPath)
      must((vaultInfo.mode & 0o777) === 0o600, `vault 权限 ${(vaultInfo.mode & 0o777).toString(8)}`)
      const homeInfo = await stat(home)
      must((homeInfo.mode & 0o777) === 0o700, `DSH_HOME 权限 ${(homeInfo.mode & 0o777).toString(8)}`)
      must((await list(home)).join(',') === 'secrets.vault', `DSH_HOME 里有多余文件：${(await list(home)).join(',')}`)
    })

    const vault = new Vault({
      path: vaultPath,
      keySource: 'passphrase-env',
      passphraseEnv: PASSPHRASE_ENV,
      keyfilePath: join(home, 'secrets.key'),
      scrypt: { N: 32768, r: 8, p: 1 },
      lockTimeoutMs: 10_000,
      lockStaleMs: 30_000,
      env: { [PASSPHRASE_ENV]: PASSPHRASE },
    })
    let entries = (await vault.load()).entries

    await check('vault: PEM 整文件一条，解密值 sha256 与源文件完全一致', async () => {
      const entry = entries.LUMEN_LUMEN
      must(entry !== undefined, '没有 LUMEN_LUMEN 条目')
      const valueHash = sha256(Buffer.from(entry.value, 'utf8'))
      const fileHash = sourceHashes['lumen/lumen.pem']
      console.log(`      PEM sha256(value)=${valueHash.slice(0, 16)}… sha256(file)=${fileHash.slice(0, 16)}… bytes=${Buffer.byteLength(entry.value, 'utf8')}`)
      must(valueHash === fileHash, 'PEM 值的 sha256 与源文件不一致')
      must(entry.value.endsWith('\n'), '结尾换行被去掉了')
      must(entry.value === pemBody, 'PEM 值被改写过（多行/空白不保真）')
    })
    await check('vault: PEM tag = src:pem + prefix + project:lumen + kind:pem', async () => {
      const tags = entries.LUMEN_LUMEN.tags
      for (const tag of ['src:pem', 'prefix:lumen', 'project:lumen', 'kind:pem']) {
        must(tags.includes(tag), `缺 tag ${tag}（实际 ${tags.join(',')}）`)
      }
      must(!tags.includes('kind:cert'), 'PEM 不该有 kind:cert')
      must(tags.filter(tag => tag.startsWith('kind:')).length === 1, 'kind: tag 数量不对')
    })
    await check('vault: .crt 命中 "# name:" 覆盖名且值保真、带 kind:cert', async () => {
      const entry = entries.LUMEN_CA_CUSTOM
      must(entry !== undefined, '没有 LUMEN_CA_CUSTOM（# name: 覆盖失败）')
      must(!('LUMEN_CA' in entries), '默认名 LUMEN_CA 也写了库')
      must(entry.value === crtBody, '.crt 值被改写')
      must(entry.value.startsWith('# name: LUMEN_CA_CUSTOM\n'), '# name: 行没有保留在值里')
      must(sha256(Buffer.from(entry.value, 'utf8')) === sourceHashes['lumen/ca.crt'], '.crt 值 sha256 不一致')
      must(entry.tags.includes('kind:crt') && entry.tags.includes('kind:cert'), '.crt 缺 kind:crt/kind:cert')
      must(entry.tags.includes('project:lumen'), '.crt 缺 project:lumen')
    })
    await check('vault: .key 整文件一条、kind:key、结尾无换行也保真', async () => {
      const entry = entries.LUMEN_SIGNING
      must(entry !== undefined, '没有 LUMEN_SIGNING')
      must(entry.value === keyBody, '.key 值被改写')
      must(!entry.value.endsWith('\n'), '.key 结尾被加了换行')
      must(entry.tags.includes('kind:key'), '.key 缺 kind:key')
    })
    await check('vault: .p12 存 base64，可还原原始字节，带三个 tag', async () => {
      const entry = entries.XHS_CERT
      must(entry !== undefined, '没有 XHS_CERT')
      const decoded = Buffer.from(entry.value, 'base64')
      must(decoded.equals(p12Bytes), '.p12 base64 解不回原始字节')
      console.log(`      P12 bytes=${p12Bytes.length} base64chars=${entry.value.length} sha256(decoded)=${sha256(decoded).slice(0, 16)}…`)
      must(sha256(decoded) === sha256(p12Bytes), '.p12 原始字节 sha256 不一致')
      for (const tag of ['kind:p12', 'kind:cert', 'binary:b64', 'project:xhs']) {
        must(entry.tags.includes(tag), `.p12 缺 tag ${tag}`)
      }
    })
    await check('vault: 扩展名大小写不敏感（.PEM / .P12）', async () => {
      must(entries.LUMEN_UPPER !== undefined, '大写 .PEM 没被识别为证书')
      must(entries.LUMEN_UPPER.tags.includes('kind:pem'), '大写 .PEM 缺 kind:pem')
      must(entries.XHS_CERT2 !== undefined, '大写 .P12 没被识别为证书')
      must(entries.XHS_CERT2.tags.includes('kind:p12'), '大写 .P12 缺 kind:p12')
      must(Buffer.from(entries.XHS_CERT2.value, 'base64').equals(p12Bytes), '大写 .P12 base64 解不回原始字节')
    })
    await check('vault: 项目 env 自动 project tag；根目录文件无 project tag；默认证书名只用文件名', async () => {
      must(entries.LUMEN_API_KEY.tags.includes('project:lumen'), 'LUMEN_API_KEY 缺 project:lumen')
      must(!entries.ROOT_TOKEN.tags.some(tag => tag.startsWith('project:')), '根目录文件被加了 project tag')
      must(entries.SOLO !== undefined, '根目录 solo.pem 没有按文件名生成 SOLO')
      must(entries.SOLO.tags.includes('kind:pem'), 'SOLO 缺 kind:pem')
    })
    await check('vault: 前缀不匹配文件里的合规条目也没有写库', async () => {
      must(!('XHS_OK' in entries), '被拒绝文件里的 XHS_OK 被写进了 vault')
      must(!('OTHER_FOO' in entries), 'OTHER_FOO 被写进了 vault')
    })

    // --------------------------------------------------- C: --project override
    await makeKeys(keysC)
    await writeFile(join(keysC, 'inbox', 'token.env'), `PROJ_TOKEN=${MARKERS.project}\n`)
    await writeFile(join(keysC, 'inbox', 'root.pem'), `-----BEGIN CERTIFICATE-----\n${MARKERS.rootPem}\n-----END CERTIFICATE-----\n`)

    const proj = run(['--keys-dir', keysC, '--vault', vaultPath, '--project', 'ACME'])

    await check('--project: 根目录文件打 project:acme，且不强制前缀', async () => {
      must(proj.code === 0, `退出码 ${proj.code}，stderr=${proj.stderr.slice(0, 400)}`)
      const again = (await vault.load()).entries
      must(again.PROJ_TOKEN !== undefined, '没有 PROJ_TOKEN')
      must(again.PROJ_TOKEN.tags.includes('project:acme'), 'PROJ_TOKEN 缺 project:acme')
      must(again.PROJ_TOKEN.value === `${MARKERS.project}`, 'PROJ_TOKEN 值不对（不应被 trim/改写）')
      must(again.ACME_ROOT !== undefined, '--project 没有参与证书默认名（期望 ACME_ROOT）')
      must(again.ACME_ROOT.tags.includes('project:acme'), 'ACME_ROOT 缺 project:acme')
      must(again.ACME_ROOT.tags.includes('kind:pem'), 'ACME_ROOT 缺 kind:pem')
      entries = again
    })

    // ------------------------------------------- D: dry-run with existing vault
    await makeKeys(keysD)
    await writeFile(join(keysD, 'inbox', 'later.env'), `LATER_KEY=${MARKERS.dry}\n`)
    const vaultHashBefore = await sha256File(vaultPath)
    const dry2 = run(['--keys-dir', keysD, '--vault', vaultPath, '--dry-run'])

    await check('dry-run（vault 已存在）: 不改 vault、不搬文件、不建 archive 目录', async () => {
      must(dry2.code === 0, `退出码 ${dry2.code}`)
      must(await sha256File(vaultPath) === vaultHashBefore, 'dry-run 改动了 vault')
      must(await exists(join(keysD, 'inbox', 'later.env')), 'dry-run 搬走了文件')
      must((await list(join(keysD, 'processed'))) === null, 'dry-run 创建了 processed/')
      must((await list(join(keysD, 'rejected'))) === null, 'dry-run 创建了 rejected/')
      must(!dry2.stdout.includes(MARKERS.dry), 'dry-run 输出泄露了值')
    })

    // ------------------------- E: old formats + old --dir flag stay compatible
    const keysE = join(root, 'keys-compat')
    await makeKeys(keysE)
    await writeFile(join(keysE, 'inbox', 'settings.json'), `{"JSON_KEY":"${MARKERS.json}"}\n`)
    await writeFile(join(keysE, 'inbox', 'flat.yaml'), `YAML_KEY: ${MARKERS.yaml}\n`)
    await writeFile(join(keysE, 'inbox', 'plain.txt'), `  ${MARKERS.text}  \n`)

    const compat = run(['--dir', join(keysE, 'inbox'), '--vault', vaultPath])
    await check('兼容: .json/.yaml/单行文本解析与旧 --dir 归档行为不变', async () => {
      must(compat.code === 0, `退出码 ${compat.code}，stderr=${compat.stderr.slice(0, 400)}`)
      const again = (await vault.load()).entries
      must(again.JSON_KEY?.value === MARKERS.json, '.json 值变了')
      must(again.JSON_KEY.tags.includes('src:json'), '.json 缺 src:json')
      must(again.YAML_KEY?.value === MARKERS.yaml, '.yaml 值变了')
      must(again.YAML_KEY.tags.includes('src:yaml'), '.yaml 缺 src:yaml')
      must(again.PLAIN?.value === MARKERS.text, '单行文本的 trim 行为变了')
      must(again.PLAIN.tags.includes('src:text'), '单行文本缺 src:text')
      for (const name of ['JSON_KEY', 'YAML_KEY', 'PLAIN']) {
        must(!again[name].tags.some(tag => tag.startsWith('project:')), `${name} 不应有 project tag`)
      }
      // old flag: processed/rejected default to <parent of --dir>/...
      const processed = await list(join(keysE, 'processed'))
      must(processed.join(',') === 'flat.yaml,plain.txt,settings.json', `--dir 的 processed 推导不对：${processed.join(',')}`)
      must((await list(join(keysE, 'rejected'))) === null, '没有失败文件却建了 rejected/')
      const text = `${compat.stdout}\n${compat.stderr}`
      must(!ALL_MARKERS.some(marker => text.includes(marker)), '兼容用例输出泄露了值')
    })
    // --------------------- F: JSON object forms / empty values / duplicates
    const keysF = join(root, 'keys-json')
    await makeKeys(keysF)
    const mixed = {
      STRING_ENTRY: MARKERS.jsonString,
      OBJ_ENTRY: { value: MARKERS.jsonObj, description: '对象条目说明', tags: ['jsonobj', 'cloud'] },
      EMPTY_ONE: '',
      EMPTY_TWO: '   ',
      BAD_VALUE: { value: 123 },
      MISSING_VALUE: { id: 'fake-id', secret: 'fake-secret' },
      NULL_ENTRY: null,
      DUP_A: MARKERS.jsonDup,
      DUP_B: MARKERS.jsonDup,
      TAG_MIX: { value: MARKERS.jsonTag, tags: ['ok', 123] },
    }
    await writeFile(join(keysF, 'inbox', 'mixed.json'), `${JSON.stringify(mixed, null, 2)}\n`)
    const dupFp = sha256(Buffer.from(MARKERS.jsonDup, 'utf8')).slice(0, 8)

    const jsonDry = run(['--keys-dir', keysF, '--vault', vaultPath, '--dry-run'])
    await check('JSON 对象形态 dry-run：计数/空值/同值告警可见且不写', async () => {
      must(jsonDry.code === 0, `退出码 ${jsonDry.code}，stderr=${jsonDry.stderr.slice(0, 400)}`)
      must(jsonDry.stdout.includes('条目=7 通过=5 跳过=3 空值=2'), `计数不对：${jsonDry.stdout.match(/条目=\d+ 通过=\d+ 跳过=\d+ 空值=\d+/)?.[0]}`)
      must(jsonDry.stdout.includes('跳过构成：缺 value 键=1 非字符串 value=2 其他=0'), '跳过构成不对')
      must(jsonDry.stdout.includes('同值告警：1 组'), '汇总没有同值告警')
      must(jsonDry.stdout.includes(`DUP_A 与 DUP_B 值完全相同（指纹 ${dupFp}）`), '逐条同值告警缺失')
      must(jsonDry.stdout.includes('空值跳过 2 条'), 'dry-run 没显示空值跳过')
      must(await exists(join(keysF, 'inbox', 'mixed.json')), 'dry-run 搬走了 mixed.json')
      must((await list(join(keysF, 'processed'))) === null, 'dry-run 创建了 processed/')
      must((await list(join(keysF, 'rejected'))) === null, 'dry-run 创建了 rejected/')
      must(!ALL_MARKERS.some(marker => jsonDry.stdout.includes(marker)), 'dry-run 输出泄露了值')
    })

    const jsonRun = run(['--keys-dir', keysF, '--vault', vaultPath])
    await check('JSON 三形态落库，逐条跳过仍算部分成功（processed + exit 1）', async () => {
      must(jsonRun.code === 1, `退出码 ${jsonRun.code}，期望 1`)
      must((await list(join(keysF, 'processed'))).includes('mixed.json'), 'mixed.json 不在 processed/')
      must(!((await list(join(keysF, 'rejected'))) ?? []).includes('mixed.json'), 'mixed.json 被扔进 rejected/')
      const again = (await vault.load()).entries
      must(again.STRING_ENTRY?.value === MARKERS.jsonString, '字符串形态的值不对')
      must(again.OBJ_ENTRY?.value === MARKERS.jsonObj, '对象形态的 value 不对')
      must(again.OBJ_ENTRY.description.includes('对象条目说明'), '对象形态的 description 没落库')
      for (const tag of ['jsonobj', 'cloud', 'src:json']) {
        must(again.OBJ_ENTRY.tags.includes(tag), `对象形态缺 tag ${tag}（实际 ${again.OBJ_ENTRY.tags.join(',')}）`)
      }
      must(again.TAG_MIX?.tags.includes('ok'), 'TAG_MIX 的合法 tag 没保留')
      must(again.TAG_MIX.tags.filter(tag => tag === '123').length === 0, '非字符串 tag 被写进去了')
      for (const name of ['BAD_VALUE', 'MISSING_VALUE', 'NULL_ENTRY', 'EMPTY_ONE', 'EMPTY_TWO']) {
        must(!(name in again), `${name} 不应写进 vault`)
      }
      must(again.DUP_A !== undefined && again.DUP_B !== undefined, '同值条目应写入（只是告警）')
      must(again.DUP_A.tags.includes('src:json'), 'DUP_A 缺自动 tag')
    })
    await check('JSON 部分成功的 .err：在 processed 旁、空值合并一段、同值/缺 value 提示、无值', async () => {
      const errPath = join(keysF, 'processed', 'mixed.json.err')
      must(await exists(errPath), 'processed/mixed.json.err 不存在')
      const err = await readFile(errPath, 'utf8')
      must(err.includes('result: partial'), '.err 的 result 不是 partial')
      must(err.includes('empty-values（2 条，空值已跳过）'), '空值段标题不对')
      must(err.includes('EMPTY_ONE: 空值已跳过') && err.includes('EMPTY_TWO: 空值已跳过'), '空值没有按名字写进合并段')
      must(err.includes('MISSING_VALUE') && err.includes('缺少 value 键'), '缺 value 键提示缺失')
      must(err.includes('BAD_VALUE') && err.includes('value 不是字符串'), '非字符串 value 提示缺失')
      must(err.includes(`DUP_A 与 DUP_B 值完全相同（指纹 ${dupFp}）`), '同值告警缺失或指纹不对')
      must(/指纹 [0-9a-f]{8}[^0-9a-f]/.test(err), '同值告警没有 8 位指纹')
      must(err.includes('TAG_MIX：tags 里有 1 个非字符串元素已跳过'), 'tag 非字符串提示缺失')
      must(!ALL_MARKERS.some(marker => err.includes(marker)), '.err 泄露了值')
    })

    // ------------------------------------------- G: broken JSON is a file failure
    const keysG = join(root, 'keys-bad-json')
    await makeKeys(keysG)
    await writeFile(join(keysG, 'inbox', 'broken.json'), '{"A": "fake-broken-value",\n')

    const broken = run(['--keys-dir', keysG, '--vault', vaultPath])
    await check('JSON 语法错：整文件失败 → rejected/ + .err + exit 1，不写库', async () => {
      must(broken.code === 1, `退出码 ${broken.code}，期望 1`)
      const rejected = await list(join(keysG, 'rejected'))
      must(rejected !== null, 'rejected/ 不存在')
      must(rejected.includes('broken.json'), 'broken.json 不在 rejected/')
      must(rejected.includes('broken.json.err'), 'broken.json.err 不在 rejected/')
      must((await list(join(keysG, 'processed'))) === null, '语法错文件被归档到 processed/')
      const err = await readFile(join(keysG, 'rejected', 'broken.json.err'), 'utf8')
      must(err.includes('不是合法 JSON'), '.err 没写 JSON 语法错')
      must(err.includes('result: rejected'), '.err 的 result 不是 rejected')
      const again = (await vault.load()).entries
      must(!('A' in again), '语法错文件仍写入了条目')
    })

    // ------------------------------------- H: explicit file argument (dry-run only)
    const keysH = join(root, 'keys-file-mode')
    await makeKeys(keysH)
    const previewPath = join(keysH, 'inbox', 'preview.env')
    await writeFile(previewPath, `PREVIEW_KEY=${MARKERS.preview}\n`)

    await check('显式文件参数：dry-run 可用，真跑拒绝且不动文件', async () => {
      const realRun = run([previewPath, '--vault', vaultPath])
      must(realRun.code === 2, `真跑退出码 ${realRun.code}，期望 2`)
      must(`${realRun.stderr}${realRun.stdout}`.includes('显式文件参数只支持 --dry-run'), '没有提示只支持 dry-run')
      must(await exists(previewPath), '真跑把文件搬走了')
      const dryRun = run([previewPath, '--vault', vaultPath, '--dry-run'])
      must(dryRun.code === 0, `dry-run 退出码 ${dryRun.code}，stderr=${dryRun.stderr.slice(0, 400)}`)
      must(dryRun.stdout.includes('PREVIEW_KEY'), 'dry-run 没解析出条目')
      must(dryRun.stdout.includes('显式文件模式'), '头部没有显式文件模式提示')
      must(await exists(previewPath), 'dry-run 搬走了文件')
      must(!ALL_MARKERS.some(marker => dryRun.stdout.includes(marker)), 'dry-run 输出泄露了值')
    })

    // ------------------------- I: cert default-name collision (same batch)
    const keysI = join(root, 'keys-cert-collision')
    await makeKeys(keysI)
    await mkdir(join(keysI, 'inbox', 'colcert'), { recursive: true, mode: 0o700 })
    const collidePem = `-----BEGIN CERTIFICATE-----\n${MARKERS.collidePem}\n-----END CERTIFICATE-----\n`
    const collideP12 = Buffer.from(Array.from({ length: 96 }, (_, i) => (i * 29 + 5) & 0xff))
    await writeFile(join(keysI, 'inbox', 'colcert', 'colcert.pem'), collidePem)
    await writeFile(join(keysI, 'inbox', 'colcert', 'colcert.p12'), collideP12)
    const collidePemHash = sha256(Buffer.from(collidePem, 'utf8'))
    const collideP12Hash = sha256(collideP12)

    const collisionRun = run(['--keys-dir', keysI, '--vault', vaultPath])
    await check('同一批 pem+p12 默认名冲突：改名 *_PEM/*_P12，两条都完整入库，exit 0', async () => {
      must(collisionRun.code === 0, `退出码 ${collisionRun.code}，期望 0`)
      must(collisionRun.stdout.includes('导入=2') && collisionRun.stdout.includes('跳过=0')
        && collisionRun.stdout.includes('改名=2'), '汇总缺 导入/跳过/改名 计数')
      const again = (await vault.load()).entries
      must(again.COLCERT_COLCERT_PEM !== undefined, '缺 COLCERT_COLCERT_PEM')
      must(again.COLCERT_COLCERT_P12 !== undefined, '缺 COLCERT_COLCERT_P12')
      must(!('COLCERT_COLCERT' in again), '仍存在未改名的 COLCERT_COLCERT（可能互相覆盖）')
      must(sha256(Buffer.from(again.COLCERT_COLCERT_PEM.value, 'utf8')) === collidePemHash, 'PEM 值被覆盖/被改写')
      must(sha256(Buffer.from(again.COLCERT_COLCERT_P12.value, 'base64')) === collideP12Hash, 'P12 字节不对')
      must(again.COLCERT_COLCERT_PEM.tags.includes('project:colcert') && again.COLCERT_COLCERT_PEM.tags.includes('kind:pem'), 'PEM tags 不对')
      for (const tag of ['kind:p12', 'kind:cert', 'binary:b64', 'project:colcert']) {
        must(again.COLCERT_COLCERT_P12.tags.includes(tag), `P12 缺 tag ${tag}`)
      }
      const processed = await list(join(keysI, 'processed'))
      must(processed.includes('colcert.pem') && processed.includes('colcert.p12'), '两个文件没有都归档')
      must(processed.includes('colcert.pem.err') && processed.includes('colcert.p12.err'), '改名没有写 .err')
      const err = await readFile(join(keysI, 'processed', 'colcert.p12.err'), 'utf8')
      must(err.includes('COLCERT_COLCERT → COLCERT_COLCERT_P12'), '.err 没有改名行（含最终名字）')
      must(err.includes('renamed（'), '.err 没有 renamed 段')
      must(!ALL_MARKERS.some(marker => err.includes(marker)), '.err 泄露了值')
    })

    // ------------------------------- J: cert collision across two separate runs
    const keysJ = join(root, 'keys-cert-crossbatch')
    await makeKeys(keysJ)
    const soloPem = `-----BEGIN CERTIFICATE-----\n${MARKERS.soloPem}\n-----END CERTIFICATE-----\n`
    const soloPemHash = sha256(Buffer.from(soloPem, 'utf8'))
    const p12v1 = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 13 + 3) & 0xff))
    const p12v2 = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 13 + 99) & 0xff))

    await writeFile(join(keysJ, 'inbox', 'crosscert.pem'), soloPem)
    const cross1 = run(['--keys-dir', keysJ, '--vault', vaultPath])
    await check('跨批 1/4：先单独导 pem → CROSSCERT', async () => {
      must(cross1.code === 0, `退出码 ${cross1.code}`)
      const again = (await vault.load()).entries
      must(again.CROSSCERT !== undefined, '没有 CROSSCERT')
      must(sha256(Buffer.from(again.CROSSCERT.value, 'utf8')) === soloPemHash, 'pem 值不对')
    })

    await writeFile(join(keysJ, 'inbox', 'crosscert.p12'), p12v1)
    const cross2 = run(['--keys-dir', keysJ, '--vault', vaultPath])
    await check('跨批 2/4：再单独导 p12 → 自动改名 CROSSCERT_P12，不覆盖 pem，exit 0', async () => {
      must(cross2.code === 0, `退出码 ${cross2.code}`)
      must(cross2.stdout.includes('改名=1'), `汇总没有改名=1：${cross2.stdout.match(/汇总：.*/)?.[0]}`)
      const again = (await vault.load()).entries
      must(again.CROSSCERT !== undefined && sha256(Buffer.from(again.CROSSCERT.value, 'utf8')) === soloPemHash, 'pem 被覆盖')
      must(again.CROSSCERT_P12 !== undefined, '没有 CROSSCERT_P12')
      must(sha256(Buffer.from(again.CROSSCERT_P12.value, 'base64')) === sha256(p12v1), 'p12 字节不对')
      const err = await readFile(join(keysJ, 'processed', 'crosscert.p12.err'), 'utf8')
      must(err.includes('CROSSCERT → CROSSCERT_P12'), '.err 没有改名行')
    })

    await writeFile(join(keysJ, 'inbox', 'crosscert.p12'), p12v1)
    const cross3 = run(['--keys-dir', keysJ, '--vault', vaultPath])
    await check('跨批 3/4：同一个 p12 重复导入 → 幂等，不新增名字、exit 0', async () => {
      must(cross3.code === 0, `退出码 ${cross3.code}`)
      must(cross3.stdout.includes('改名=0'), '重复导入被当成新的改名')
      const again = (await vault.load()).entries
      const names = Object.keys(again).filter(name => name.startsWith('CROSSCERT')).sort()
      must(names.join(',') === 'CROSSCERT,CROSSCERT_P12', `vault 里 CROSSCERT* 名字不对：${names.join(',')}`)
      must(sha256(Buffer.from(again.CROSSCERT_P12.value, 'base64')) === sha256(p12v1), 'p12 值被改动')
    })

    await writeFile(join(keysJ, 'inbox', 'crosscert.p12'), p12v2)
    const cross4 = run(['--keys-dir', keysJ, '--vault', vaultPath])
    await check('跨批 4/4：同名不同值且改名目标已占用 → 跳过 + exit 1，两条旧值不变', async () => {
      must(cross4.code === 1, `退出码 ${cross4.code}，期望 1`)
      must(cross4.stdout.includes('跳过=1') && cross4.stdout.includes('导入=0'), '汇总没有体现跳过')
      const again = (await vault.load()).entries
      must(sha256(Buffer.from(again.CROSSCERT.value, 'utf8')) === soloPemHash, 'pem 被改动')
      must(sha256(Buffer.from(again.CROSSCERT_P12.value, 'base64')) === sha256(p12v1), '已入库的 p12 被覆盖')
      const errs = (await list(join(keysJ, 'processed'))).filter(name => /^crosscert\.p12.*\.err$/.test(name))
      let reason = ''
      for (const name of errs) {
        const text = await readFile(join(keysJ, 'processed', name), 'utf8')
        if (text.includes('CROSSCERT_P12') && text.includes('已跳过')) reason = text
      }
      must(reason !== '', '冲突跳过的 .err 没有写明目标名和原因')
      must(reason.includes('不同值'), '.err 原因不明确')
      must(!ALL_MARKERS.some(marker => reason.includes(marker)), '.err 泄露了值')
    })

    // --------------------------- K: non-cert same-name protection in one batch
    const keysK1 = join(root, 'keys-batch-dup')
    await makeKeys(keysK1)
    await writeFile(join(keysK1, 'inbox', 'a.env'), `BATCH_DUP=${MARKERS.batchOne}\n`)
    await writeFile(join(keysK1, 'inbox', 'b.env'), `BATCH_DUP=${MARKERS.batchTwo}\n`)
    const batchRun = run(['--keys-dir', keysK1, '--vault', vaultPath])
    await check('非证书同名不同值（同批）→ 后者跳过并 exit 1，先到值保留', async () => {
      must(batchRun.code === 1, `退出码 ${batchRun.code}，期望 1`)
      must(batchRun.stdout.includes('跳过=1'), '汇总没有跳过计数')
      const again = (await vault.load()).entries
      must(again.BATCH_DUP?.value === MARKERS.batchOne, 'BATCH_DUP 被后一个文件静默覆盖')
      const err = await readFile(join(keysK1, 'processed', 'b.env.err'), 'utf8')
      must(err.includes('同名不同值') && err.includes('BATCH_DUP'), '.err 没写同名不同值')
      must(!ALL_MARKERS.some(marker => err.includes(marker)), '.err 泄露了值')
    })

    const keysK2 = join(root, 'keys-batch-same')
    await makeKeys(keysK2)
    await writeFile(join(keysK2, 'inbox', 'c.env'), `SAME_DUP=${MARKERS.sameDup}\n`)
    await writeFile(join(keysK2, 'inbox', 'd.env'), `SAME_DUP=${MARKERS.sameDup}\n`)
    const sameRun = run(['--keys-dir', keysK2, '--vault', vaultPath])
    await check('非证书同名同值（同批）→ 幂等只写一次，exit 0', async () => {
      must(sameRun.code === 0, `退出码 ${sameRun.code}，期望 0`)
      must(sameRun.stdout.includes('导入=1') && sameRun.stdout.includes('跳过=0'), '汇总计数不对')
      const again = (await vault.load()).entries
      must(again.SAME_DUP?.value === MARKERS.sameDup, 'SAME_DUP 值不对')
      const err = await readFile(join(keysK2, 'processed', 'd.env.err'), 'utf8')
      must(err.includes('同名同值'), '.err 没有幂等说明')
    })

  } finally {
    // -------------------------------------------------------------- E: cleanup
    await rm(root, { recursive: true, force: true })
    await check('清理: 临时目录已删除，未留下 vault/明文副本', async () => {
      must(!existsSync(root), `临时目录仍存在：${root}`)
      must(!(await exists(vaultPath)), '临时 vault 仍存在')
    })
    await check('红线: 真实 vault 与真实 inbox 未被改动', async () => {
      const afterVault = await stat(REAL_VAULT).then(info => `${info.size}:${info.mtimeMs}`).catch(() => 'absent')
      must(afterVault === before.realVault, '真实 /root/.dsh/secrets.vault 被改动')
      const afterInbox = (await list(REAL_INBOX))?.join(',') ?? 'absent'
      must(afterInbox === before.realInbox, '真实 /srv/workspace/keys/inbox 被改动')
    })
  }

  const failed = results.filter(item => !item.ok)
  console.log('')
  console.log(`自测：${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) {
    console.log(`失败项：${failed.map(item => item.name).join('; ')}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(`自测框架错误：${error?.message ?? error}`)
  process.exitCode = 2
})
