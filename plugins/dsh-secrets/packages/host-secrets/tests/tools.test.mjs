import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { DESCRIPTION_HINT } from '../tools.js'
import { FAKE, assertNoLeak, mount, tempHome } from './helpers.mjs'

const EXPORT_PASS = 'export-FAKE-passphrase'

test('registers exactly the ten tools, no secret_get, strict schemas', async (t) => {
  const plugin = mount(await tempHome(t))
  assert.deepEqual([...plugin.tools.keys()].sort(), [
    'secret_check', 'secret_delete', 'secret_describe', 'secret_exec', 'secret_export',
    'secret_http', 'secret_import', 'secret_list', 'secret_rename', 'secret_set',
  ])
  for (const tool of plugin.tools.values()) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
  }
  assert.ok(plugin.listeners.has('tools/post-execute'))
})

test('secret_set: created/overwrite, hint, createdAt kept, invalid input', async (t) => {
  const plugin = mount(await tempHome(t))
  const first = await plugin.call('secret_set', { name: 'OPENAI_KEY', value: FAKE.OPENAI })
  assert.equal(first.created, true)
  assert.equal(first.hint, DESCRIPTION_HINT)
  assert.equal(first.length, FAKE.OPENAI.length)
  assert.match(first.fingerprint, /^[0-9a-f]{8}$/)
  const before = (await plugin.call('secret_list', {})).items[0]
  await new Promise(ok => setTimeout(ok, 5))
  const second = await plugin.call('secret_set', { name: 'OPENAI_KEY', value: FAKE.GITHUB })
  assert.equal(second.created, false)
  assert.equal(second.hint, undefined)
  assert.notEqual(second.fingerprint, first.fingerprint)
  const after = (await plugin.call('secret_list', {})).items[0]
  assert.equal(after.createdAt, before.createdAt)
  assert.notEqual(after.updatedAt, before.updatedAt)
  const described = await plugin.call('secret_set', { name: 'WITH_DESC', value: FAKE.OPENAI, description: 'd' })
  assert.equal(described.hint, undefined)
  await assert.rejects(plugin.call('secret_set', { name: 'bad name', value: FAKE.OPENAI }), /invalid name/)
  await assert.rejects(plugin.call('secret_set', { name: 'X', value: '' }), /non-empty/)
  await assert.rejects(plugin.call('secret_set', { name: 'X', value: 5 }), /non-empty string/)
  assertNoLeak(plugin)
})

test('metadata: 60-char truncation, tag filter, query search, describe keeps value', async (t) => {
  const plugin = mount(await tempHome(t))
  const long = '这是一个很长的描述'.repeat(10) // 90 code points, multi-byte
  await plugin.call('secret_set', { name: 'LONG', value: FAKE.OPENAI, description: long, tags: ['prod', 'llm'] })
  await plugin.call('secret_set', { name: 'GH_TOKEN', value: FAKE.GITHUB, description: 'GitHub deploy token', tags: ['ci'] })
  await plugin.call('secret_set', { name: 'other.pw', value: FAKE.SHORTISH, description: 'misc', tags: ['prod'] })

  const all = await plugin.call('secret_list', {})
  assert.equal(all.total, 3)
  const longItem = all.items.find(entry => entry.name === 'LONG')
  assert.equal([...longItem.description].length, 61)
  assert.ok(longItem.description.endsWith('…'))
  assert.equal(longItem.description, `${[...long].slice(0, 60).join('')}…`)
  assert.equal(all.items.find(entry => entry.name === 'other.pw').description, 'misc')
  for (const entry of all.items) assert.deepEqual(Object.keys(entry).sort(), ['createdAt', 'description', 'fingerprint', 'length', 'metaUpdatedAt', 'name', 'tags', 'updatedAt'])

  assert.deepEqual((await plugin.call('secret_list', { tag: 'prod' })).items.map(entry => entry.name), ['LONG', 'other.pw'])
  assert.deepEqual((await plugin.call('secret_list', { query: 'github' })).items.map(entry => entry.name), ['GH_TOKEN'])
  assert.deepEqual((await plugin.call('secret_list', { query: 'OTHER' })).items.map(entry => entry.name), ['other.pw'])
  assert.deepEqual((await plugin.call('secret_list', { tag: 'prod', query: 'misc' })).items.map(entry => entry.name), ['other.pw'])

  const before = all.items.find(entry => entry.name === 'GH_TOKEN')
  await new Promise(ok => setTimeout(ok, 5))
  const described = await plugin.call('secret_describe', { name: 'GH_TOKEN', description: 'rotated desc', tags: ['ci', 'gh'] })
  assert.equal(described.fingerprint, before.fingerprint)
  assert.equal(described.updatedAt, before.updatedAt)
  assert.notEqual(described.metaUpdatedAt, before.metaUpdatedAt)
  assert.deepEqual(described.tags, ['ci', 'gh'])
  assert.equal((await plugin.call('secret_check', { name: 'GH_TOKEN', value: FAKE.GITHUB })).matches, true)
  await assert.rejects(plugin.call('secret_describe', { name: 'GH_TOKEN' }), /description and\/or tags/)
  await assert.rejects(plugin.call('secret_describe', { name: 'NOPE', description: 'x' }), { message: 'secret not found: NOPE' })
  assertNoLeak(plugin)
})

test('delete, rename (overwrite rules), check', async (t) => {
  const plugin = mount(await tempHome(t))
  await plugin.call('secret_set', { name: 'A', value: FAKE.OPENAI, description: 'a' })
  await plugin.call('secret_set', { name: 'B', value: FAKE.GITHUB, description: 'b' })
  await assert.rejects(plugin.call('secret_rename', { from: 'A', to: 'B' }), /already exists: B/)
  assert.deepEqual(await plugin.call('secret_rename', { from: 'A', to: 'C' }), { from: 'A', to: 'C', overwritten: false })
  assert.deepEqual(await plugin.call('secret_rename', { from: 'C', to: 'B', overwrite: true }), { from: 'C', to: 'B', overwritten: true })
  const check = await plugin.call('secret_check', { name: 'B', value: FAKE.OPENAI })
  assert.equal(check.exists, true)
  assert.equal(check.matches, true)
  assert.equal((await plugin.call('secret_check', { name: 'B', value: FAKE.GITHUB })).matches, false)
  assert.deepEqual(await plugin.call('secret_check', { name: 'ZZ' }), { name: 'ZZ', exists: false })
  assert.deepEqual(await plugin.call('secret_delete', { name: 'B' }), { name: 'B', deleted: true })
  await assert.rejects(plugin.call('secret_delete', { name: 'B' }), { message: 'secret not found: B' })
  assert.equal((await plugin.call('secret_list', {})).total, 0)
  assertNoLeak(plugin)
})

test('export → import round trip: merge (skip/overwrite) and replace counts', async (t) => {
  const home = await tempHome(t)
  const plugin = mount(home)
  await plugin.call('secret_set', { name: 'A', value: FAKE.OPENAI, description: 'alpha', tags: ['t1'] })
  await plugin.call('secret_set', { name: 'B', value: FAKE.GITHUB, description: 'beta' })
  const outDir = join(home, 'exports')
  await mkdir(outDir, { mode: 0o700 })
  const exported = await plugin.call('secret_export', { path: outDir, passphrase: EXPORT_PASS })
  assert.match(exported.path, /secrets-export-\d{8}T\d{6}Z\.dshvault$/)
  assert.equal(exported.entries, 2)
  assert.match(exported.sha256, /^[0-9a-f]{64}$/)
  const text = await readFile(exported.path, 'utf8')
  assert.equal(exported.bytes, Buffer.byteLength(text))
  assert.equal((await stat(exported.path)).mode & 0o777, 0o600)
  assert.equal(JSON.parse(text).format, 'dsh-secrets-export')
  for (const needle of [FAKE.OPENAI, FAKE.GITHUB, 'alpha', 'beta', EXPORT_PASS]) assert.ok(!text.includes(needle))
  await assert.rejects(plugin.call('secret_export', { path: exported.path, passphrase: EXPORT_PASS }), /already exists/)
  await assert.rejects(plugin.call('secret_export', { path: outDir, passphrase: 'short' }), /at least 8/)

  // second vault with a different master passphrase
  const home2 = join(home, 'second')
  await mkdir(home2, { mode: 0o700 })
  process.env.DSH_SECRETS_TEST_PASSPHRASE_2 = 'second-FAKE-master'
  t.after(() => { delete process.env.DSH_SECRETS_TEST_PASSPHRASE_2 })
  const other = mount(home2, { passphraseEnv: 'DSH_SECRETS_TEST_PASSPHRASE_2' })
  await other.call('secret_set', { name: 'B', value: FAKE.SHORTISH, description: 'local b' })
  await other.call('secret_set', { name: 'LOCAL', value: FAKE.SHORTISH, description: 'only here' })

  await assert.rejects(other.call('secret_import', { path: exported.path, passphrase: 'wrong-FAKE-pass', strategy: 'merge' }),
    { message: 'decryption failed: wrong passphrase or corrupted file' })

  const skip = await other.call('secret_import', { path: exported.path, passphrase: EXPORT_PASS, strategy: 'merge' })
  assert.deepEqual(skip, { strategy: 'merge', added: 1, overwritten: 0, skipped: 1, removed: 0 })
  assert.equal((await other.call('secret_check', { name: 'B', value: FAKE.SHORTISH })).matches, true)
  const a = (await other.call('secret_list', { query: 'alpha' })).items[0]
  assert.equal(a.name, 'A')
  assert.deepEqual(a.tags, ['t1'])

  const over = await other.call('secret_import', { path: exported.path, passphrase: EXPORT_PASS, strategy: 'merge', onConflict: 'overwrite' })
  assert.deepEqual(over, { strategy: 'merge', added: 0, overwritten: 2, skipped: 0, removed: 0 })
  assert.equal((await other.call('secret_check', { name: 'B', value: FAKE.GITHUB })).matches, true)

  const replace = await other.call('secret_import', { path: exported.path, passphrase: EXPORT_PASS, strategy: 'replace' })
  assert.deepEqual(replace, { strategy: 'replace', added: 0, overwritten: 2, skipped: 0, removed: 1 })
  assert.deepEqual((await other.call('secret_list', {})).items.map(entry => entry.name), ['A', 'B'])

  // tampered export
  const doc = JSON.parse(text)
  doc.ciphertext = `A${doc.ciphertext.slice(1)}` === doc.ciphertext ? `B${doc.ciphertext.slice(1)}` : `A${doc.ciphertext.slice(1)}`
  const tampered = join(outDir, 'tampered.dshvault')
  await writeFile(tampered, JSON.stringify(doc), { mode: 0o600 })
  await assert.rejects(other.call('secret_import', { path: tampered, passphrase: EXPORT_PASS, strategy: 'merge' }), /decryption failed/)
  assertNoLeak(plugin, [...Object.values(FAKE), EXPORT_PASS])
  assertNoLeak(other, [...Object.values(FAKE), EXPORT_PASS])
})

test('secret_exec: injection by list and mapping, redaction incl. encodings and command echo', async (t) => {
  const plugin = mount(await tempHome(t))
  await plugin.call('secret_set', { name: 'OPENAI_KEY', value: FAKE.OPENAI, description: 'x' })
  await plugin.call('secret_set', { name: 'gh.token', value: FAKE.GITHUB, description: 'y' })
  const script = 'const a=process.env.OPENAI_KEY,b=process.env.GH;'
    + 'console.log(a);console.log(Buffer.from(a).toString("base64"));console.log(encodeURIComponent(b));'
    + 'console.error(Buffer.from(b).toString("hex"));console.log("plain="+process.env.PLAIN);process.exit(3)'
  const out = await plugin.call('secret_exec', {
    command: process.execPath,
    args: ['-e', script, FAKE.OPENAI],
    secrets: { OPENAI_KEY: 'OPENAI_KEY', GH: 'gh.token' },
    env: { PLAIN: 'visible' },
  })
  assert.equal(out.exitCode, 3)
  assert.equal(out.success, false)
  assert.equal(out.timedOut, false)
  assert.equal(out.stdout, '[REDACTED:OPENAI_KEY]\n[REDACTED:OPENAI_KEY]\n[REDACTED:gh.token]\nplain=visible\n')
  assert.equal(out.stderr, '[REDACTED:gh.token]\n')
  assert.equal(out.args[2], '[REDACTED:OPENAI_KEY]')
  assert.deepEqual(out.injected.map(entry => entry.env), ['OPENAI_KEY', 'GH'])

  const list = await plugin.call('secret_exec', { command: process.execPath, args: ['-e', 'console.log(process.env.OPENAI_KEY.length)'], secrets: ['OPENAI_KEY'] })
  assert.equal(list.stdout.trim(), String(FAKE.OPENAI.length))
  assert.equal(list.success, true)

  await assert.rejects(plugin.call('secret_exec', { command: process.execPath, args: [], secrets: ['MISSING_ONE'] }), { message: 'secret not found: MISSING_ONE' })
  await assert.rejects(plugin.call('secret_exec', { command: process.execPath, secrets: ['gh.token'] }), /mapping form/)
  await assert.rejects(plugin.call('secret_exec', { command: process.execPath, secrets: ['OPENAI_KEY'], env: { OPENAI_KEY: 'x' } }), /collides/)
  await assert.rejects(plugin.call('secret_exec', { command: '/nonexistent/FAKE-cmd', secrets: ['OPENAI_KEY'] }), { message: 'failed to start command: ENOENT' })
  assertNoLeak(plugin)
})

test('secret_exec: timeout, abort, allowlist, output truncation', async (t) => {
  const plugin = mount(await tempHome(t), { maxOutputChars: 256 })
  await plugin.call('secret_set', { name: 'K', value: FAKE.OPENAI, description: 'x' })
  const slow = await plugin.call('secret_exec', { command: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'], secrets: ['K'], timeoutMs: 200 })
  assert.equal(slow.timedOut, true)
  assert.equal(slow.success, false)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  const aborted = await plugin.call('secret_exec', { command: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'], secrets: ['K'] }, controller.signal)
  assert.equal(aborted.aborted, true)
  const big = await plugin.call('secret_exec', { command: process.execPath, args: ['-e', 'for(let i=0;i<200;i++)console.log(process.env.K)'], secrets: ['K'] })
  assert.equal(big.truncated.stdout, true)
  assert.ok(big.stdout.length < 400)
  assert.ok(big.stdout.startsWith('[REDACTED:K]\n'))
  const locked = mount(await tempHome(t), { execAllowedCommands: ['curl'] })
  await assert.rejects(locked.call('secret_exec', { command: process.execPath, secrets: ['K'] }), /not allowed by execAllowedCommands/)
  assertNoLeak(plugin)
})

async function echoServer(t) {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body })
      if (request.url.startsWith('/redirect')) {
        response.writeHead(302, { location: `http://example.invalid/?k=${FAKE.OPENAI}` })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json', 'x-echo': String(request.headers.authorization ?? '') })
      response.end(JSON.stringify({ url: request.url, auth: request.headers.authorization, body }))
    })
  })
  await new Promise(ok => server.listen(0, '127.0.0.1', ok))
  t.after(() => new Promise(ok => server.close(ok)))
  return { base: `http://127.0.0.1:${server.address().port}`, requests }
}

test('secret_http: substitution in url/headers/body, redacted response, errors', async (t) => {
  const plugin = mount(await tempHome(t))
  await plugin.call('secret_set', { name: 'TOKEN', value: FAKE.OPENAI, description: 'x' })
  await plugin.call('secret_set', { name: 'gh.token', value: FAKE.GITHUB, description: 'y' })
  const { base, requests } = await echoServer(t)
  const out = await plugin.call('secret_http', {
    url: `${base}/api?key=\${secret:gh.token}`,
    method: 'POST',
    headers: { Authorization: 'Bearer ${secret:TOKEN}', 'X-Lit': '$${secret:TOKEN}' },
    body: '{"k":"${secret:TOKEN}"}',
  })
  assert.equal(out.status, 200)
  assert.equal(out.ok, true)
  assert.equal(requests[0].headers.authorization, `Bearer ${FAKE.OPENAI}`)
  assert.equal(requests[0].headers['x-lit'], '${secret:TOKEN}')
  assert.equal(requests[0].body, `{"k":"${FAKE.OPENAI}"}`)
  assert.equal(requests[0].url, `/api?key=${FAKE.GITHUB}`)
  assert.equal(out.headers['x-echo'], 'Bearer [REDACTED:TOKEN]')
  assert.ok(out.body.includes('[REDACTED:TOKEN]'))
  assert.ok(out.body.includes('[REDACTED:gh.token]'))
  assert.ok(out.url.includes('[REDACTED:gh.token]'))

  const redirect = await plugin.call('secret_http', { url: `${base}/redirect`, headers: { Authorization: '${secret:TOKEN}' } })
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.location, 'http://example.invalid/?k=[REDACTED:TOKEN]')
  assert.equal(requests.length, 2, 'redirect not followed')

  await assert.rejects(plugin.call('secret_http', { url: `${base}/`, body: '${secret:NOPE}' }), { message: 'secret not found: NOPE' })
  await assert.rejects(plugin.call('secret_http', { url: `${base}/`, body: 'ab${secret:}' }), { message: 'malformed placeholder at offset 2 in body' })
  await assert.rejects(plugin.call('secret_http', { url: `${base}/`, headers: { A: '${secret:bad name}' } }), { message: 'malformed placeholder at offset 0 in header A' })
  await assert.rejects(plugin.call('secret_http', { url: `${base}/\${secret:TOKEN` }), /malformed placeholder at offset \d+ in url/)
  await assert.rejects(plugin.call('secret_http', { url: 'file:///etc/passwd' }), /only http/)
  await assert.rejects(plugin.call('secret_http', { url: `http://127.0.0.1:1/\${secret:TOKEN}` }), /request failed/)
  const locked = mount(await tempHome(t), { httpAllowedHosts: ['*.example.com'] })
  await assert.rejects(locked.call('secret_http', { url: `${base}/` }), /host not allowed/)
  assert.equal(requests.length, 2)
  assertNoLeak(plugin)
})

test('post-execute listener redacts known values from any tool text output', async (t) => {
  const plugin = mount(await tempHome(t))
  await plugin.call('secret_set', { name: 'TOKEN', value: FAKE.OPENAI, description: 'x' })
  const listener = plugin.listeners.get('tools/post-execute')
  const result = { isError: false, content: [{ type: 'text', text: `cat .env -> KEY=${FAKE.OPENAI}` }, { type: 'image', data: 'x' }] }
  const decision = await listener({ name: 'bash' }, result, async () => ({ kind: 'accept' }))
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content[0].text, 'cat .env -> KEY=[REDACTED:TOKEN]')
  assert.equal(decision.content[1].type, 'image')
  const untouched = await listener({ name: 'bash' }, { isError: false, content: [{ type: 'text', text: 'clean' }] }, async () => ({ kind: 'accept' }))
  assert.deepEqual(untouched, { kind: 'accept' })
  const block = { kind: 'block', feedback: [] }
  assert.equal(await listener({ name: 'x' }, result, async () => block), block)
  // key missing → the original decision, never a failure
  delete process.env.DSH_SECRETS_TEST_PASSPHRASE
  const fallback = await listener({ name: 'bash' }, result, async () => ({ kind: 'accept' }))
  assert.deepEqual(fallback, { kind: 'accept' })
})

test('apply without ctx.on still works; bad config is rejected', async (t) => {
  const home = await tempHome(t)
  const { apply } = await import('../index.js')
  const tools = new Map()
  apply({ tools: { register: def => tools.set(def.name, def) }, effect: run => run(), logger: { info() {} } }, { vaultPath: join(home, 'v') })
  assert.equal(tools.size, 10)
  assert.throws(() => apply({ tools: { register() {} }, effect: run => run() }, { bogus: 1 }), /unknown key bogus/)
  assert.throws(() => apply({ tools: { register() {} }, effect: run => run() }, { keySource: 'x' }), /keySource/)
})

test('leak scan: no fake value in any return, render, log, or error across all tools', async (t) => {
  const home = await tempHome(t)
  const plugin = mount(home)
  for (const [name, value] of Object.entries(FAKE)) await plugin.call('secret_set', { name, value, description: `desc ${name}`, tags: ['scan'] })
  await plugin.call('secret_set', { name: 'OPENAI', value: FAKE.OPENAI })
  await plugin.call('secret_describe', { name: 'GITHUB', description: 'new' })
  await plugin.call('secret_list', { tag: 'scan' })
  await plugin.call('secret_check', { name: 'OPENAI', value: FAKE.GITHUB })
  await plugin.call('secret_rename', { from: 'SHORTISH', to: 'SHORT2' })
  await plugin.call('secret_exec', { command: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.env))'], secrets: ['OPENAI', 'GITHUB'] })
  await plugin.call('secret_exec', { command: process.execPath, args: ['-e', 'throw new Error(process.env.OPENAI)'], secrets: ['OPENAI'] })
  const exported = await plugin.call('secret_export', { path: home, passphrase: EXPORT_PASS })
  await plugin.call('secret_import', { path: exported.path, passphrase: EXPORT_PASS, strategy: 'merge', onConflict: 'overwrite' })
  for (const bad of [
    () => plugin.call('secret_exec', { command: process.execPath, secrets: ['NOPE'] }),
    () => plugin.call('secret_http', { url: 'http://127.0.0.1:1/${secret:OPENAI}' }),
    () => plugin.call('secret_import', { path: exported.path, passphrase: 'nope-nope-nope', strategy: 'replace' }),
    () => plugin.call('secret_set', { name: '!!', value: FAKE.OPENAI }),
    () => plugin.call('secret_rename', { from: 'OPENAI', to: 'GITHUB' }),
  ]) await assert.rejects(bad())
  assert.ok(plugin.seen.length > 20)
  assert.ok(plugin.logs.length > 5)
  assertNoLeak(plugin, [...Object.values(FAKE), EXPORT_PASS])
  // no tmp leftovers anywhere in the home dir
  assert.ok((await readdir(home)).every(file => !file.includes('.tmp-') && !file.endsWith('.lock')))
  await chmod(home, 0o700)
})
