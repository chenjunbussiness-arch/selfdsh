import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { resolveConfig } from '../config.js'
import { createManageRoutes, requireLogin } from '../manage.js'
import { baseFromRequest, checkBaseUrl, isInternalHost } from '../origin.js'
import { deniedBy, effectiveRoots, resolveShareable, safeFileName } from '../paths.js'
import { createPublicRoutes, parseRange } from '../public.js'
import { createService } from '../service.js'
import { LinkStore } from '../store.js'
import { createTools } from '../tools.js'

let work
let home
let project
let outside
let server
let port
let loggedIn = true

/** Minimal stand-in for the Harness web server: exact, then longest prefix. */
function startServer(routes) {
  const exact = new Map(routes.filter(r => r.kind === 'exact').map(r => [r.path, r]))
  const prefixes = routes.filter(r => r.kind === 'prefix')
  const srv = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    const route = exact.get(path) ?? prefixes.filter(r => path === r.path || path.startsWith(`${r.path}/`)).sort((a, b) => b.path.length - a.path.length)[0]
    if (route === undefined) { res.writeHead(404); res.end(); return }
    Promise.resolve(route.handler(req, res)).catch((error) => { res.writeHead(500); res.end(String(error)) })
  })
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve(srv)))
}

function make(extra = {}) {
  const config = resolveConfig({ dshHome: home, roots: [project], ...extra })
  const store = new LinkStore({ file: config.stateFile, maxActiveLinks: config.maxActiveLinks, keepExpiredMs: config.keepExpiredMs })
  const service = createService({ config, store })
  return { config, store, service }
}

let ctx

before(async () => {
  work = await realpath(await mkdtemp(join(tmpdir(), 'fileshare-')))
  home = join(work, 'dsh-home')
  project = join(work, 'project')
  outside = join(work, 'outside')
  await mkdir(home, { recursive: true })
  await mkdir(join(project, 'out'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(project, 'out', 'report.txt'), 'hello report\n')
  await writeFile(join(project, 'out', 'big.bin'), Buffer.alloc(100000, 7))
  await writeFile(join(project, 'page.html'), '<script>alert(1)</script>')
  await writeFile(join(project, '.env'), 'SECRET=1')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, '.git', 'config'), '[core]')
  await writeFile(join(outside, 'passwd.txt'), 'nope')
  await symlink(join(outside, 'passwd.txt'), join(project, 'link-out.txt'))
  ctx = make()
  const connection = () => ({ requestRejection: () => (loggedIn ? undefined : 401) })
  const routes = [
    ...createPublicRoutes({ store: ctx.store }),
    ...createManageRoutes({ service: ctx.service, store: ctx.store, config: ctx.config, secure: () => false }).map(r => requireLogin(r, connection)),
  ]
  server = await startServer(routes)
  port = server.address().port
})

after(async () => {
  server?.close()
  await rm(work, { recursive: true, force: true })
})

const url = path => `http://127.0.0.1:${port}${path}`

describe('origin', () => {
  test('internal hosts are refused', () => {
    for (const host of ['10.1.2.3', '192.168.0.9', '172.16.5.5', '172.31.0.1', '127.0.0.1', '100.64.1.1', '169.254.1.1', '0.0.0.0', 'localhost', '::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1', 'nas', 'box.local', 'git.lan', 'a.internal', 'x.home.arpa']) {
      assert.equal(isInternalHost(host), true, host)
    }
    for (const host of ['example.com', 'dsh.example.org', '8.8.8.8', '172.32.0.1', '2001:4860::8888']) {
      assert.equal(isInternalHost(host), false, host)
    }
  })
  test('base url checks', () => {
    assert.deepEqual(checkBaseUrl('https://dsh.example.com:8443/'), { ok: true, base: 'https://dsh.example.com:8443' })
    assert.equal(checkBaseUrl('https://192.168.1.2:8443').ok, false)
    assert.equal(checkBaseUrl('https://u:p@dsh.example.com').ok, false)
    assert.equal(checkBaseUrl('ftp://dsh.example.com').ok, false)
  })
  test('base from request honours forwarded proto and refuses internal Host', () => {
    assert.deepEqual(baseFromRequest({ headers: { host: 'dsh.example.com:8443', 'x-forwarded-proto': 'https' } }), { ok: true, base: 'https://dsh.example.com:8443' })
    assert.equal(baseFromRequest({ headers: { host: '10.0.0.5:8443' } }).ok, false)
    assert.equal(baseFromRequest({ headers: { host: 'evil.com/x' } }).ok, false)
  })
  test('config drops an internal publicBaseUrl with a warning', () => {
    const warnings = []
    const config = resolveConfig({ dshHome: '/tmp/x', publicBaseUrl: 'https://192.168.3.4:8443' }, { warn: m => warnings.push(m) })
    assert.equal(config.publicBaseUrl, '')
    assert.match(warnings[0], /internal/)
  })
})

describe('paths', () => {
  test('deny patterns match segments', () => {
    assert.equal(deniedBy('out/report.txt', resolveConfig({ dshHome: '/x' }).deny), undefined)
    assert.equal(deniedBy('.git/config', resolveConfig({ dshHome: '/x' }).deny), '.git')
    assert.equal(deniedBy('keys/server.KEY', resolveConfig({ dshHome: '/x' }).deny), '*.key')
    assert.equal(deniedBy('.env.prod', resolveConfig({ dshHome: '/x' }).deny), '.env.*')
  })
  test('too broad roots and DSH home are dropped', async () => {
    await mkdir(join(home, 'sessions'), { recursive: true })
    const { roots, dropped } = await effectiveRoots({ roots: ['/', home, join(home, 'sessions'), project, join(work, 'missing')], inboxDir: join(home, 'fileshare', 'inbox'), dshHome: home })
    assert.deepEqual(roots, [project])
    assert.deepEqual(dropped.map(d => d.reason).sort(), ['inside DSH home', 'missing', 'too broad', 'too broad'])
  })
  test('resolveShareable refuses traversal, symlink escape, denied names and directories', async () => {
    const opts = { cwd: project, roots: [project], deny: resolveConfig({ dshHome: '/x' }).deny }
    assert.equal((await resolveShareable('out/report.txt', opts)).ok, true)
    assert.match((await resolveShareable('../outside/passwd.txt', opts)).reason, /outside/)
    assert.match((await resolveShareable('link-out.txt', opts)).reason, /outside/)
    assert.match((await resolveShareable('.env', opts)).reason, /deny/)
    assert.match((await resolveShareable('.git/config', opts)).reason, /deny/)
    assert.match((await resolveShareable('out', opts)).reason, /directory/)
    assert.match((await resolveShareable('nope.txt', opts)).reason, /not found/)
  })
  test('safeFileName', () => {
    assert.equal(safeFileName('../../etc/passwd'), 'passwd')
    assert.equal(safeFileName('..\\..\\x.txt'), 'x.txt')
    assert.equal(safeFileName('.env'), 'env')
    assert.equal(safeFileName('a<b>:c?.txt'), 'a_b__c_.txt')
    assert.equal(safeFileName('..'), undefined)
    assert.equal(safeFileName('CON.txt'), undefined)
    assert.equal(safeFileName('报告 最终版.pdf'), '报告 最终版.pdf')
  })
  test('parseRange', () => {
    assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 })
    assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 })
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
    assert.equal(parseRange('bytes=200-300', 100), null)
    assert.equal(parseRange(undefined, 100), undefined)
  })
})

describe('download links', () => {
  test('no public base yet: url is null, path is given', async () => {
    const link = await ctx.service.createDownload({ path: 'out/report.txt', cwd: project, by: 'test' })
    assert.equal(link.url, null)
    assert.match(link.path, /^\/api\/fileshare\/d\/[A-Za-z0-9_-]{32}\/report\.txt$/)
  })

  test('full download, HEAD, range, counts, tokens never stored', async () => {
    const link = await ctx.service.createDownload({ path: join(project, 'out', 'big.bin'), by: 'test' })
    const head = await fetch(url(link.path), { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), '100000')
    const range = await fetch(url(link.path), { headers: { range: 'bytes=10-19' } })
    assert.equal(range.status, 206)
    assert.equal(range.headers.get('content-range'), 'bytes 10-19/100000')
    assert.equal((await range.arrayBuffer()).byteLength, 10)
    const full = await fetch(url(link.path))
    assert.equal(full.status, 200)
    assert.match(full.headers.get('content-disposition'), /^attachment; filename="big.bin"/)
    assert.match(full.headers.get('content-security-policy'), /sandbox/)
    assert.equal((await full.arrayBuffer()).byteLength, 100000)
    const [listed] = await ctx.service.list({ id: link.id })
    assert.equal(listed.downloads, 1)
    const stateText = await readFile(ctx.config.stateFile, 'utf8')
    const token = link.path.split('/')[4]
    assert.equal(stateText.includes(token), false, 'token must not be stored')
  })

  test('max downloads, revoke, unknown', async () => {
    const once = await ctx.service.createDownload({ path: join(project, 'out', 'report.txt'), maxDownloads: 1, by: 'test' })
    assert.equal((await fetch(url(once.path))).status, 200)
    assert.equal((await fetch(url(once.path))).status, 410)
    const revoked = await ctx.service.createDownload({ path: join(project, 'out', 'report.txt'), by: 'test' })
    await ctx.service.revoke(revoked.id)
    const dead = await fetch(url(revoked.path), { headers: { accept: 'text/html' } })
    assert.equal(dead.status, 410)
    assert.match(await dead.text(), /已撤销/)
    assert.equal((await fetch(url('/api/fileshare/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/x'))).status, 404)
    assert.equal((await fetch(url('/api/fileshare/d/short'))).status, 404)
  })

  test('expiry', async () => {
    const link = await ctx.service.createDownload({ path: join(project, 'out', 'report.txt'), ttlMinutes: 1, by: 'test' })
    await ctx.store.mutate(link.id, (l) => { l.expiresAt = new Date(Date.now() - 1000).toISOString() })
    assert.equal((await fetch(url(link.path))).status, 410)
  })

  test('a file swapped for a symlink after the link was made is not served', async () => {
    const file = join(project, 'out', 'swap.txt')
    await writeFile(file, 'original')
    const link = await ctx.service.createDownload({ path: file, by: 'test' })
    await rm(file)
    await symlink(join(outside, 'passwd.txt'), file)
    const res = await fetch(url(link.path))
    assert.equal(res.status, 410)
  })

  test('html is an attachment; ?view=1 only inlines safe types', async () => {
    const html = await ctx.service.createDownload({ path: join(project, 'page.html'), by: 'test' })
    const res = await fetch(url(`${html.path}?view=1`))
    assert.match(res.headers.get('content-disposition'), /^attachment/)
    assert.equal(res.headers.get('content-type'), 'application/octet-stream')
    const txt = await ctx.service.createDownload({ path: join(project, 'out', 'report.txt'), by: 'test' })
    const view = await fetch(url(`${txt.path}?view=1`))
    assert.match(view.headers.get('content-disposition'), /^inline/)
  })

  test('refusals carry a reason', async () => {
    await assert.rejects(ctx.service.createDownload({ path: join(project, '.env'), by: 'test' }), /deny pattern/)
    await assert.rejects(ctx.service.createDownload({ path: join(outside, 'passwd.txt'), by: 'test' }), /outside every allowed/)
    await assert.rejects(ctx.service.createDownload({ path: join(project, 'out', 'report.txt'), ttlMinutes: -1, by: 'test' }), /ttl_minutes/)
  })

  test('hub task outputs', async () => {
    const outputs = join(home, 'agent-hub', 'artifacts', 't-1', 'outputs')
    await mkdir(outputs, { recursive: true })
    await writeFile(join(outputs, 'result.zip'), 'zip')
    await writeFile(join(home, 'agent-hub', 'artifacts', 't-1', 'session.jsonl'), 'secret session')
    const link = await ctx.service.createDownload({ hubTask: 't-1', name: 'result.zip', by: 'test' })
    assert.equal(await (await fetch(url(link.path))).text(), 'zip')
    await assert.rejects(ctx.service.createDownload({ hubTask: 't-1', name: '../session.jsonl', by: 'test' }), /output file name/)
    await assert.rejects(ctx.service.createDownload({ hubTask: '../t-1', name: 'x', by: 'test' }), /task id/)
    await assert.rejects(ctx.service.createDownload({ path: join(home, 'agent-hub', 'artifacts', 't-1', 'session.jsonl'), by: 'test' }), /outside every allowed/)
  })
})

describe('upload links', () => {
  test('page, PUT, rename on clash, traversal name, status', async () => {
    const link = await ctx.service.createUpload({ dir: 'incoming', cwd: project, maxFiles: 3, maxMb: 1, by: 'test' })
    const page = await fetch(url(link.path))
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy'), /script-src 'nonce-/)
    const html = await page.text()
    assert.match(html, /incoming/)
    assert.equal(html.includes(project), false, 'page must not show server paths')
    const noSlash = await fetch(url(link.path.replace(/\/$/, '')), { redirect: 'manual' })
    assert.equal(noSlash.status, 301)

    const put = await fetch(url(`${link.path}${encodeURIComponent('a.txt')}`), { method: 'PUT', body: 'first' })
    assert.equal(put.status, 201)
    const body = await put.json()
    assert.equal(body.sha256, createHash('sha256').update('first').digest('hex'))
    const again = await (await fetch(url(`${link.path}a.txt`), { method: 'PUT', body: 'second' })).json()
    assert.equal(again.name, 'a (1).txt')
    const sneaky = await (await fetch(url(`${link.path}?name=${encodeURIComponent('../../escape.txt')}`), { method: 'POST', body: 'x' })).json()
    assert.equal(sneaky.name, 'escape.txt')
    const files = (await readdir(join(project, 'incoming'))).sort()
    assert.deepEqual(files, ['a (1).txt', 'a.txt', 'escape.txt'])
    assert.equal(await readFile(join(project, 'incoming', 'a.txt'), 'utf8'), 'first')
    const full = await fetch(url(`${link.path}b.txt`), { method: 'PUT', body: 'x' })
    assert.equal(full.status, 410)
    const status = await (await fetch(url(`${link.path}?status=1`))).json()
    assert.equal(status.state, 'used-up')
    assert.equal(status.files.length, 3)
    const [listed] = await ctx.service.list({ id: link.id })
    assert.equal(listed.files.length, 3)
  })

  test('capacity is enforced while streaming', async () => {
    const link = await ctx.service.createUpload({ dir: join(project, 'cap'), maxMb: 0.001, by: 'test' })
    const declared = await fetch(url(`${link.path}big.bin`), { method: 'PUT', body: Buffer.alloc(5000) })
    assert.equal(declared.status, 413)
    const streamed = await fetch(url(`${link.path}big.bin`), {
      method: 'PUT',
      duplex: 'half',
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(800)); c.enqueue(new Uint8Array(800)); c.close() } }),
    })
    assert.equal(streamed.status, 413)
    assert.deepEqual(await readdir(join(project, 'cap')), [])
  })

  test('upload dirs outside roots or denied are refused; default inbox works', async () => {
    await assert.rejects(ctx.service.createUpload({ dir: outside, by: 'test' }), /outside every allowed/)
    await assert.rejects(ctx.service.createUpload({ dir: join(project, '.ssh'), by: 'test' }), /deny pattern/)
    const inbox = await ctx.service.createUpload({ by: 'test' })
    assert.equal(inbox.path.startsWith('/api/fileshare/u/'), true)
    const put = await fetch(url(`${inbox.path}note.txt`), { method: 'PUT', body: 'in' })
    assert.equal(put.status, 201)
    assert.equal(await readFile(join(home, 'fileshare', 'inbox', 'note.txt'), 'utf8'), 'in')
  })

  test('an upload link cannot read files', async () => {
    const link = await ctx.service.createUpload({ dir: join(project, 'incoming2'), by: 'test' })
    await fetch(url(`${link.path}x.txt`), { method: 'PUT', body: 'x' })
    assert.equal((await fetch(url(`${link.path}x.txt`))).status, 404)
  })
})

describe('page routes', () => {
  test('need login and the header', async () => {
    loggedIn = false
    assert.equal((await fetch(url('/api/fileshare/links'))).status, 401)
    loggedIn = true
    assert.equal((await fetch(url('/api/fileshare/links'))).status, 200)
    const noHeader = await fetch(url('/api/fileshare/create'), { method: 'POST', body: '{}' })
    assert.equal(noHeader.status, 403)
  })

  test('hello learns the public base, never an internal one; links then carry full urls', async () => {
    const internal = await (await fetch(url('/api/fileshare/hello'), { method: 'POST', headers: { 'x-dsh-fileshare': '1' } })).json()
    assert.equal(internal.base, null)
    assert.match(internal.refused, /internal/)
    const pub = await (await fetch(url('/api/fileshare/hello'), { method: 'POST', headers: { 'x-dsh-fileshare': '1', 'x-forwarded-host': 'dsh.example.com:8443', 'x-forwarded-proto': 'https' } })).json()
    assert.equal(pub.base, 'https://dsh.example.com:8443')
    const created = await (await fetch(url('/api/fileshare/create'), {
      method: 'POST',
      headers: { 'x-dsh-fileshare': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'download', path: join(project, 'out', 'report.txt'), ttlMinutes: 5 }),
    })).json()
    assert.match(created.url, /^https:\/\/dsh\.example\.com:8443\/api\/fileshare\/d\/[A-Za-z0-9_-]{32}\/report\.txt$/)
    const overview = await (await fetch(url('/api/fileshare/links'))).json()
    assert.equal(JSON.stringify(overview).includes(created.url.split('/')[6]), false, 'list never carries tokens')
    const revoked = await (await fetch(url('/api/fileshare/revoke'), { method: 'POST', headers: { 'x-dsh-fileshare': '1' }, body: JSON.stringify({ id: created.id }) })).json()
    assert.equal(revoked.state, 'revoked')
  })
})

describe('tools', () => {
  test('file_share resolves against the session cwd and returns the url', async () => {
    const tools = createTools({ service: ctx.service, cwdOf: async () => project })
    const share = tools.find(t => t.name === 'file_share')
    const out = await share.execute({ path: 'out/report.txt', ttl_minutes: 10 }, { agent: {} })
    assert.match(out.url, /^https:\/\/dsh\.example\.com:8443\/api\/fileshare\/d\//)
    assert.equal(out.expiresIn, '10 min')
    const up = await tools.find(t => t.name === 'file_upload_link').execute({ dir: 'from-user' }, { agent: {} })
    assert.match(up.curl, /^curl -T <file> https:\/\/dsh\.example\.com:8443\/api\/fileshare\/u\//)
    const listed = await tools.find(t => t.name === 'file_links').execute({ id: up.id })
    assert.equal(listed.count, 1)
    await assert.rejects(share.execute({ path: '.env' }, { agent: {} }), /deny pattern/)
    await assert.rejects(share.execute({}, { agent: {} }), /give path/)
    const revoked = await tools.find(t => t.name === 'file_link_revoke').execute({ id: up.id })
    assert.equal(revoked.state, 'revoked')
  })
})

describe('store shared by several processes', () => {
  test('a link created by one store is found by another on the same file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fileshare-store-'))
    try {
      const file = join(dir, 'links.json')
      const a = new LinkStore({ file, maxActiveLinks: 50, keepExpiredMs: 1000 })
      const b = new LinkStore({ file, maxActiveLinks: 50, keepExpiredMs: 1000 })
      assert.equal((await b.list()).length, 0)
      const expiresAt = new Date(Date.now() + 60_000).toISOString()
      const { link, token } = await a.create({ kind: 'download', path: '/x', name: 'x', expiresAt, maxDownloads: null })
      assert.equal((await b.find(token))?.id, link.id)
      // concurrent changes from both stores are all kept
      await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).create({ kind: 'download', path: `/x${i}`, name: 'x', expiresAt, maxDownloads: null })))
      assert.equal((await a.list()).length, 11)
      assert.equal((await b.list()).length, 11)
      await b.revoke(link.id)
      assert.equal((await a.find(token))?.revokedAt !== undefined, true)
      assert.deepEqual((await readdir(dir)).sort(), ['links.json'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
