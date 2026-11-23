/**
 * Management routes (manage.js): vault writes, credential store, plugins, hub file.
 *
 * Mounts the real plugin on a fake ctx with a recording web server, a fake
 * `connection` (login) service and a fake `credentials` service.
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import {
  CREDENTIALS_PATH, CREDENTIALS_SET_PATH, CREDENTIALS_UNSET_PATH, HUB_SET_PATH, HUB_UNSET_PATH, PLUGINS_PATH,
  VAULT_DELETE_PATH, VAULT_DESCRIBE_PATH, VAULT_RENAME_PATH, VAULT_SET_PATH, envLine, parseEnvText, profileFromArgv,
} from '../manage.js'
import { LIST_PATH } from '../bridge.js'
import { FAKE, PASS_ENV, tempHome } from './helpers.mjs'

function fakeResponse() {
  let status
  let headers = {}
  let body = ''
  return {
    writeHead(code, head) { status = code; headers = head ?? {} },
    end(chunk) { body = chunk === undefined ? '' : String(chunk) },
    result() {
      let json
      try { json = JSON.parse(body) } catch { json = undefined }
      return { status, headers, body, json }
    },
  }
}

/** A credential store shaped like dsh-credentials-local (describe also returns `masked`). */
function fakeCredentials() {
  const values = new Map()
  return {
    values,
    async describe(ref) {
      if (values.has(ref)) return { configured: true, source: 'file', writable: true, masked: `${values.get(ref).slice(0, 6)}••••` }
      return { configured: false, writable: true }
    },
    async set(ref, value) { values.set(ref, value) },
    async unset(ref) { values.delete(ref) },
  }
}

function mountWeb(home, { credentials = fakeCredentials(), config = {} } = {}) {
  const routes = new Map()
  const logs = []
  const seen = []
  const state = { rejection: undefined }
  const webCtx = {
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
    effect(run) { return run() },
  }
  const ctx = {
    tools: { register() { return () => {} } },
    logger: { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')), debug() {} },
    on() { return () => {} },
    effect(run) { return run() },
    inject(_deps, callback) { callback(webCtx); return () => {} },
    get(name) {
      if (name === 'connection') return { requestRejection: () => state.rejection }
      if (name === 'credentials') return credentials ?? undefined
      return undefined
    },
  }
  apply(ctx, { vaultPath: join(home, 'secrets.vault'), passphraseEnv: PASS_ENV, scryptN: 1024, ...config })

  async function request(path, { method = 'GET', body, headers } = {}) {
    const route = routes.get(path.split('?')[0])
    assert.ok(route, `route ${path} is not registered`)
    const res = fakeResponse()
    const head = method === 'POST'
      ? { host: '127.0.0.1:18080', 'content-type': 'application/json', 'x-dsh-secrets': '1', origin: 'http://127.0.0.1:18080', ...headers }
      : { ...headers }
    await route.handler({ method, url: path, headers: head, body }, res)
    const out = res.result()
    seen.push(out.body)
    return out
  }
  const post = (path, body, headers) => request(path, { method: 'POST', body, headers })
  return { routes, logs, seen, state, credentials, request, post }
}

const forbidden = values => values.flatMap(value => [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('hex')])

test('vault: set, describe, rename, delete through the page; no value ever comes back', async (t) => {
  const plugin = mountWeb(await tempHome(t))
  const created = await plugin.post(VAULT_SET_PATH, { name: 'OPENAI_KEY', value: FAKE.OPENAI, description: 'eval', tags: ['llm'] })
  assert.equal(created.status, 200, created.body)
  assert.equal(created.json.created, true)
  assert.match(created.json.fingerprint, /^[0-9a-f]{8}$/)

  const described = await plugin.post(VAULT_DESCRIBE_PATH, { name: 'OPENAI_KEY', description: 'eval runner', tags: ['llm', 'prod'] })
  assert.equal(described.status, 200, described.body)
  assert.deepEqual(described.json.tags, ['llm', 'prod'])

  const renamed = await plugin.post(VAULT_RENAME_PATH, { from: 'OPENAI_KEY', to: 'OPENAI_API_KEY' })
  assert.equal(renamed.status, 200, renamed.body)
  let list = await plugin.request(LIST_PATH)
  assert.deepEqual(list.json.items.map(item => item.name), ['OPENAI_API_KEY'])
  assert.equal(list.json.items[0].description, 'eval runner')

  const deleted = await plugin.post(VAULT_DELETE_PATH, { name: 'OPENAI_API_KEY' })
  assert.equal(deleted.status, 200, deleted.body)
  list = await plugin.request(LIST_PATH)
  assert.equal(list.json.total, 0)

  const bad = await plugin.post(VAULT_SET_PATH, { name: 'bad name', value: 'x' })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'rejected')
  const missing = await plugin.post(VAULT_DELETE_PATH, { name: 'NOPE' })
  assert.equal(missing.status, 400)

  const haystack = [...plugin.seen, ...plugin.logs].join('\n')
  for (const form of forbidden([FAKE.OPENAI])) assert.ok(!haystack.includes(form), 'a value leaked')
})

test('writes need POST + json + the page header + same origin; login still applies', async (t) => {
  const plugin = mountWeb(await tempHome(t))
  const body = { name: 'A_KEY', value: FAKE.SHORTISH }
  assert.equal((await plugin.request(VAULT_SET_PATH)).status, 405)
  assert.equal((await plugin.post(VAULT_SET_PATH, body, { 'x-dsh-secrets': undefined })).status, 403)
  assert.equal((await plugin.post(VAULT_SET_PATH, body, { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await plugin.post(VAULT_SET_PATH, body, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await plugin.post(VAULT_SET_PATH, body, { origin: 'null' })).status, 403)
  plugin.state.rejection = 401
  assert.equal((await plugin.post(VAULT_SET_PATH, body)).status, 401)
  plugin.state.rejection = undefined
  assert.equal((await plugin.post(VAULT_SET_PATH, body, { origin: undefined })).status, 200)
  assert.equal((await plugin.request(LIST_PATH)).json.total, 1)
})

test('vault locked: writes answer 409 vault-locked', async (t) => {
  const home = await tempHome(t)
  const plugin = mountWeb(home)
  await plugin.post(VAULT_SET_PATH, { name: 'A_KEY', value: FAKE.SHORTISH })
  const saved = process.env[PASS_ENV]
  delete process.env[PASS_ENV]
  t.after(() => { process.env[PASS_ENV] = saved })
  const out = await plugin.post(VAULT_SET_PATH, { name: 'B_KEY', value: FAKE.SHORTISH })
  assert.equal(out.status, 409)
  assert.equal(out.json.error.code, 'vault-locked')
})

test('credentials: presence only (masked dropped), set / unset managed refs, others refused', async (t) => {
  const plugin = mountWeb(await tempHome(t), { config: { manageCredentialRefs: ['FAL_API_KEY'] } })
  let list = await plugin.request(CREDENTIALS_PATH)
  assert.equal(list.status, 200)
  assert.equal(list.json.available, true)
  assert.deepEqual(list.json.items.map(item => item.ref), ['DEEPSEEK_API_KEY', 'EXA_API_KEY', 'GITHUB_TOKEN', 'GITEA_TOKEN', 'FAL_API_KEY'])
  assert.ok(list.json.items.every(item => item.configured === false))

  const set = await plugin.post(CREDENTIALS_SET_PATH, { ref: 'GITHUB_TOKEN', value: FAKE.GITHUB })
  assert.equal(set.status, 200, set.body)
  assert.deepEqual(set.json, { ref: 'GITHUB_TOKEN', configured: true, source: 'file', writable: true })
  assert.equal(plugin.credentials.values.get('GITHUB_TOKEN'), FAKE.GITHUB)
  list = await plugin.request(CREDENTIALS_PATH)
  assert.ok(list.json.items.every(item => !Object.hasOwn(item, 'masked')))

  assert.equal((await plugin.post(CREDENTIALS_SET_PATH, { ref: 'DSH_HUB_TOKEN', value: 'x' })).status, 403)
  assert.equal((await plugin.post(CREDENTIALS_SET_PATH, { ref: 'PATH', value: 'x' })).status, 403)
  assert.equal((await plugin.post(CREDENTIALS_SET_PATH, { ref: 'GITHUB_TOKEN', value: '  ' })).status, 400)
  assert.equal((await plugin.post(CREDENTIALS_UNSET_PATH, { ref: 'GITHUB_TOKEN' })).json.configured, false)

  const haystack = [...plugin.seen, ...plugin.logs].join('\n')
  for (const form of forbidden([FAKE.GITHUB, FAKE.GITHUB.slice(0, 6)])) assert.ok(!haystack.includes(form), 'a credential (or its masked prefix) leaked')
})

test('credentials: no store mounted → listed as unavailable, writes 503', async (t) => {
  const plugin = mountWeb(await tempHome(t), { credentials: null })
  const list = await plugin.request(CREDENTIALS_PATH)
  assert.equal(list.json.available, false)
  assert.equal((await plugin.post(CREDENTIALS_SET_PATH, { ref: 'EXA_API_KEY', value: 'x' })).status, 503)
})

test('config: manageCredentialRefs refuses DSH_* names', () => {
  assert.throws(() => mountWeb('/nonexistent', { config: { manageCredentialRefs: ['DSH_HUB_TOKEN'] } }), /manageCredentialRefs/)
})

test('hub: URL and proxy are shown, the token is write-only; file is 0600 and keeps other lines', async (t) => {
  const home = await tempHome(t)
  const file = join(home, 'agent-hub', 'controller.env')
  await mkdir(join(home, 'agent-hub'), { recursive: true, mode: 0o700 })
  await writeFile(file, '# my notes\nDSH_HUB_CONTROLLER_ID=dsh-cloud\nexport DSH_HUB_URL=https://old.example:7891\n', { mode: 0o600 })
  const plugin = mountWeb(home)

  let out = await plugin.post(HUB_SET_PATH, { name: 'DSH_HUB_URL', value: 'https://hub.example:7891' })
  assert.equal(out.status, 200, out.body)
  out = await plugin.post(HUB_SET_PATH, { name: 'DSH_HUB_TOKEN', value: 'dshc_dsh-cloud_FAKEFAKEFAKE' })
  assert.equal(out.status, 200, out.body)
  const byKey = Object.fromEntries(out.json.items.map(item => [item.key, item]))
  assert.equal(byKey.DSH_HUB_URL.value, 'https://hub.example:7891')
  assert.equal(byKey.DSH_HUB_TOKEN.configured, true)
  assert.ok(!Object.hasOwn(byKey.DSH_HUB_TOKEN, 'value'))

  const text = await readFile(file, 'utf8')
  assert.match(text, /^# my notes$/m)
  assert.match(text, /^DSH_HUB_CONTROLLER_ID=dsh-cloud$/m)
  assert.equal(parseEnvText(text).DSH_HUB_URL, 'https://hub.example:7891')
  assert.equal(text.match(/DSH_HUB_URL/g).length, 1)
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)

  assert.equal((await plugin.post(HUB_SET_PATH, { name: 'DSH_HUB_URL', value: 'ftp://x' })).status, 400)
  assert.equal((await plugin.post(HUB_SET_PATH, { name: 'DSH_HUB_URL', value: 'https://u:p@hub.example' })).status, 400)
  assert.equal((await plugin.post(HUB_SET_PATH, { name: 'DSH_HUB_PROXY', value: 'https://proxy:1' })).status, 400)
  assert.equal((await plugin.post(HUB_SET_PATH, { name: 'DSH_HUB_PROXY', value: 'env' })).status, 200)
  assert.equal((await plugin.post(HUB_SET_PATH, { name: 'DSH_HUB_PROXY', value: 'http://127.0.0.1:7890' })).status, 200)
  assert.equal((await plugin.post(HUB_SET_PATH, { name: 'PATH', value: '/bin' })).status, 400)
  assert.equal((await plugin.post(HUB_SET_PATH, { name: 'DSH_HUB_URL', value: 'https://a\nDSH_X=1' })).status, 400)

  out = await plugin.post(HUB_UNSET_PATH, { name: 'DSH_HUB_TOKEN' })
  assert.equal(out.status, 200)
  assert.ok(!(await readFile(file, 'utf8')).includes('DSH_HUB_TOKEN'))
  assert.ok(!plugin.seen.join('\n').includes('FAKEFAKEFAKE'))
})

test('plugins: installed from the running profile, needs with presence', async (t) => {
  const home = await tempHome(t)
  await mkdir(join(home, 'profiles', 'web'), { recursive: true })
  await writeFile(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-router-b', 'dsh-secrets'] } } }))
  await mkdir(join(home, 'profiles', 'other'), { recursive: true })
  await writeFile(join(home, 'profiles', 'other', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-agent-hub'] } } }))
  const plugin = mountWeb(home)
  await plugin.post(CREDENTIALS_SET_PATH, { ref: 'DEEPSEEK_API_KEY', value: 'sk-FAKE-123456789' })
  const argv = process.argv
  process.argv = [...argv, '--profile', 'web']
  t.after(() => { process.argv = argv })
  const out = await plugin.request(PLUGINS_PATH)
  assert.equal(out.status, 200, out.body)
  assert.deepEqual(out.json.profiles, [{ name: 'web', running: true }])
  const byId = Object.fromEntries(out.json.plugins.map(plugin_ => [plugin_.id, plugin_]))
  assert.equal(byId['dsh-router-b'].installed, true)
  assert.equal(byId['dsh-agent-hub'].installed, false)
  assert.equal(byId['dsh-router-b'].needs.find(need => need.key === 'DEEPSEEK_API_KEY').configured, true)
  assert.equal(byId['dsh-secrets'].needs[0].configured, true)
  assert.ok(!out.body.includes('sk-FAKE'))

  process.argv = argv
  const all = await plugin.request(PLUGINS_PATH)
  assert.deepEqual(all.json.profiles.map(profile => profile.name), ['other', 'web'])
  assert.equal(all.json.plugins.find(plugin_ => plugin_.id === 'dsh-agent-hub').installed, true)
})

test('helpers: profileFromArgv, envLine quoting', () => {
  assert.equal(profileFromArgv(['node', 'dsh', '--profile', 'web']), 'web')
  assert.equal(profileFromArgv(['node', 'dsh', '--profile=desk']), 'desk')
  assert.equal(profileFromArgv(['node', 'dsh']), undefined)
  assert.equal(envLine('A', 'x y'), 'A="x y"')
  assert.equal(envLine('A', 'say "hi"'), `A='say "hi"'`)
  assert.throws(() => envLine('A', `"'`))
})
