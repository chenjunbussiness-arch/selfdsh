/**
 * Read-only dashboard bridge: GET /api/secrets/summary and /api/secrets/list.
 *
 * Mounts the real plugin (index.js `apply`) on a fake ctx that additionally
 * exposes `inject(['webServer'])`, a fake web server that records routes, and a
 * fake `connection` service whose `requestRejection` the test controls.
 */
import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { LIST_PATH, MAX_FILTER_CHARS, SUMMARY_PATH } from '../bridge.js'
import { fingerprint } from '../vault.js'
import { FAKE, PASS_ENV, PASSPHRASE, tempHome } from './helpers.mjs'

const ITEM_KEYS = ['createdAt', 'description', 'fingerprint', 'length', 'metaUpdatedAt', 'name', 'tags', 'updatedAt']

/** A response recorder shaped like `http.ServerResponse` (writeHead + end). */
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

/**
 * Mount the plugin with a web server. `state.rejection` is what the fake
 * connection's `requestRejection` answers (undefined = logged in).
 */
function mountWeb(home, { connection = true, config = {} } = {}) {
  const tools = new Map()
  const routes = new Map()
  const logs = []
  const seen = []
  const state = { rejection: undefined }
  const webCtx = {
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    effect(run) { return run() },
  }
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    logger: {
      info(...args) { logs.push(args.join(' ')) },
      warn(...args) { logs.push(args.join(' ')) },
      error(...args) { logs.push(args.join(' ')) },
      debug(...args) { logs.push(args.join(' ')) },
    },
    on() { return () => {} },
    effect(run) { return run() },
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['webServer'])
      callback(webCtx)
      return () => {}
    },
    get(name) {
      if (name !== 'connection' || !connection) return undefined
      return { requestRejection: () => state.rejection }
    },
  }
  apply(ctx, { vaultPath: join(home, 'secrets.vault'), passphraseEnv: PASS_ENV, scryptN: 1024, ...config })

  async function call(name, args) {
    const definition = tools.get(name)
    assert.ok(definition, `tool ${name} is not registered`)
    return definition.execute(args, { signal: new AbortController().signal })
  }

  async function request(url, method = 'GET') {
    const path = url.split('?')[0]
    const route = routes.get(path)
    assert.ok(route, `route ${path} is not registered`)
    const res = fakeResponse()
    await route.handler({ method, url, headers: {} }, res)
    const out = res.result()
    seen.push(out.body)
    return out
  }

  return { tools, routes, logs, seen, state, call, request, vaultPath: join(home, 'secrets.vault') }
}

/** Three fake secrets with tags and descriptions. */
async function seed(plugin) {
  await plugin.call('secret_set', { name: 'OPENAI_KEY', value: FAKE.OPENAI, description: 'OpenAI API key for the eval runner', tags: ['prod', 'llm'] })
  await plugin.call('secret_set', { name: 'GITHUB_TOKEN', value: FAKE.GITHUB, description: 'CI deploy token', tags: ['prod', 'ci'] })
  await plugin.call('secret_set', { name: 'db.password', value: FAKE.SHORTISH })
}

/** Every encoding of every fake value that must never appear in any response. */
function forbiddenForms() {
  return Object.values(FAKE).flatMap(value => [
    value,
    Buffer.from(value, 'utf8').toString('base64'),
    Buffer.from(value, 'utf8').toString('hex'),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ])
}

test('mounts the read-only routes plus the management routes and logs where', async (t) => {
  const plugin = mountWeb(await tempHome(t))
  const paths = [...plugin.routes.keys()]
  assert.ok(paths.includes(LIST_PATH) && paths.includes(SUMMARY_PATH))
  assert.ok(paths.every(path => path.startsWith('/api/secrets/')))
  assert.equal(paths.length, 12)
  for (const route of plugin.routes.values()) assert.equal(route.kind, 'exact')
  assert.ok(plugin.logs.some(line => line.includes('dashboard bridge mounted at /api/secrets')))
  // The tools are still all there: the bridge is additive.
  assert.equal(plugin.tools.size, 10)
})

test('not logged in: 401 / 403 from the connection, 503 without it; nothing is read', async (t) => {
  const home = await tempHome(t)
  const plugin = mountWeb(home)
  await seed(plugin)
  plugin.state.rejection = 401
  for (const path of [LIST_PATH, SUMMARY_PATH, `${LIST_PATH}?tag=prod`]) {
    const out = await plugin.request(path)
    assert.equal(out.status, 401)
    assert.equal(out.body, 'unauthorized')
    assert.equal(out.json, undefined)
  }
  plugin.state.rejection = 403
  assert.equal((await plugin.request(SUMMARY_PATH)).status, 403)
  plugin.state.rejection = undefined
  assert.equal((await plugin.request(SUMMARY_PATH)).status, 200)

  const noConnection = mountWeb(home, { connection: false })
  const out = await noConnection.request(LIST_PATH)
  assert.equal(out.status, 503)
  assert.equal(out.body, 'login service unavailable')
})

test('responses never contain a value (or an encoding of one): metadata, fingerprint, length only', async (t) => {
  const plugin = mountWeb(await tempHome(t))
  await seed(plugin)
  const list = await plugin.request(LIST_PATH)
  assert.equal(list.status, 200)
  assert.equal(list.headers['cache-control'], 'no-store')
  assert.match(String(list.headers['content-type']), /application\/json/)
  assert.equal(list.json.vault.state, 'unlocked')
  assert.equal(list.json.vault.exists, true)
  assert.equal(list.json.vault.unlocked, true)
  assert.equal(list.json.vault.keySource, 'passphrase-env')
  assert.equal(list.json.vault.keyConfigured, true)
  assert.equal(list.json.total, 3)
  assert.equal(list.json.matched, 3)
  assert.deepEqual(list.json.items.map(entry => entry.name), ['GITHUB_TOKEN', 'OPENAI_KEY', 'db.password'])
  const byName = Object.fromEntries(list.json.items.map(entry => [entry.name, entry]))
  for (const [name, value] of [['OPENAI_KEY', FAKE.OPENAI], ['GITHUB_TOKEN', FAKE.GITHUB], ['db.password', FAKE.SHORTISH]]) {
    const entry = byName[name]
    assert.deepEqual(Object.keys(entry).sort(), ITEM_KEYS, 'an item carries exactly the metadata keys, no value field')
    assert.equal(entry.fingerprint, fingerprint(value))
    assert.match(entry.fingerprint, /^[0-9a-f]{8}$/)
    assert.equal(entry.length, [...value].length)
    assert.equal(typeof entry.createdAt, 'string')
    assert.equal(typeof entry.updatedAt, 'string')
    assert.equal(typeof entry.metaUpdatedAt, 'string')
  }
  assert.equal(byName.OPENAI_KEY.description, 'OpenAI API key for the eval runner')
  assert.deepEqual(byName.OPENAI_KEY.tags, ['prod', 'llm'])

  await plugin.request(SUMMARY_PATH)
  await plugin.request(`${LIST_PATH}?query=key`)
  await plugin.request(`${LIST_PATH}?tag=prod`)

  const haystack = [...plugin.seen, ...plugin.logs].join('\n')
  for (const form of forbiddenForms()) {
    assert.ok(!haystack.includes(form), `a value (or an encoding of it, ${form.length} chars) leaked into a dashboard response or log`)
  }
  // Searching by a value finds nothing: values are not searchable, so the page
  // cannot be used as an oracle. (The response echoes only the caller's own
  // `filter.query`, which is why it is checked separately from the scan above.)
  const byValue = await plugin.request(`${LIST_PATH}?query=${encodeURIComponent(FAKE.OPENAI)}`)
  assert.equal(byValue.json.matched, 0)
  assert.deepEqual(byValue.json.items, [])
})

test('filters: exact tag, case-insensitive keyword on name/description, both, empty, too long', async (t) => {
  const plugin = mountWeb(await tempHome(t))
  await seed(plugin)
  const names = async (query) => {
    const out = await plugin.request(`${LIST_PATH}${query}`)
    assert.equal(out.status, 200, out.body)
    return out.json
  }
  assert.deepEqual((await names('?tag=prod')).items.map(entry => entry.name), ['GITHUB_TOKEN', 'OPENAI_KEY'])
  assert.deepEqual((await names('?tag=ci')).items.map(entry => entry.name), ['GITHUB_TOKEN'])
  assert.deepEqual((await names('?tag=PROD')).items, [], 'tags are exact')
  assert.deepEqual((await names('?tag=nope')).items, [])
  assert.deepEqual((await names('?query=OPENAI')).items.map(entry => entry.name), ['OPENAI_KEY'])
  assert.deepEqual((await names('?query=deploy')).items.map(entry => entry.name), ['GITHUB_TOKEN'], 'description is searched')
  assert.deepEqual((await names('?query=PASS')).items.map(entry => entry.name), ['db.password'])
  assert.deepEqual((await names('?tag=prod&query=eval')).items.map(entry => entry.name), ['OPENAI_KEY'])
  const empty = await names('?tag=&query=')
  assert.equal(empty.matched, 3)
  assert.deepEqual(empty.filter, { tag: null, query: null })
  const filtered = await names('?tag=prod&query=ci%20deploy')
  assert.equal(filtered.total, 3)
  assert.equal(filtered.matched, 1)
  assert.deepEqual(filtered.filter, { tag: 'prod', query: 'ci deploy' })

  // The same filter semantics as secret_list.
  const tool = await plugin.call('secret_list', { tag: 'prod', query: 'eval' })
  assert.deepEqual(tool.items.map(entry => entry.name), ['OPENAI_KEY'])

  const long = await plugin.request(`${LIST_PATH}?query=${'x'.repeat(MAX_FILTER_CHARS + 1)}`)
  assert.equal(long.status, 400)
  assert.equal(long.json.error.code, 'bad-request')

  const summary = (await plugin.request(SUMMARY_PATH)).json
  assert.equal(summary.total, 3)
  assert.equal(summary.untagged, 1)
  assert.deepEqual(summary.tags, [{ tag: 'prod', count: 2 }, { tag: 'ci', count: 1 }, { tag: 'llm', count: 1 }])
  assert.equal(typeof summary.lastUpdatedAt, 'string')
  assert.equal(summary.vault.state, 'unlocked')
})

test('vault missing: 200 with an empty list and state "missing", nothing is created', async (t) => {
  const plugin = mountWeb(await tempHome(t))
  const list = await plugin.request(`${LIST_PATH}?tag=prod`)
  assert.equal(list.status, 200)
  assert.deepEqual(list.json.items, [])
  assert.equal(list.json.total, 0)
  assert.equal(list.json.matched, 0)
  assert.equal(list.json.vault.state, 'missing')
  assert.equal(list.json.vault.exists, false)
  assert.equal(list.json.vault.unlocked, false)
  assert.equal(list.json.vault.keyConfigured, true)
  const summary = await plugin.request(SUMMARY_PATH)
  assert.equal(summary.status, 200)
  assert.equal(summary.json.total, 0)
  assert.deepEqual(summary.json.tags, [])
  assert.equal(summary.json.lastUpdatedAt, null)
  await assert.rejects(stat(plugin.vaultPath), { code: 'ENOENT' }, 'a read must not create the vault')
})

test('vault locked: no key or wrong key is a 200 with state "locked" and no items', async (t) => {
  const plugin = mountWeb(await tempHome(t))
  await seed(plugin)
  t.after(() => { process.env[PASS_ENV] = PASSPHRASE })

  delete process.env[PASS_ENV]
  const missingKey = await plugin.request(LIST_PATH)
  assert.equal(missingKey.status, 200)
  assert.equal(missingKey.json.vault.state, 'locked')
  assert.equal(missingKey.json.vault.error.code, 'key-missing')
  assert.equal(missingKey.json.vault.keyConfigured, false)
  assert.deepEqual(missingKey.json.items, [])

  process.env[PASS_ENV] = 'wrong-FAKE-passphrase'
  const wrongKey = await plugin.request(SUMMARY_PATH)
  assert.equal(wrongKey.status, 200)
  assert.equal(wrongKey.json.vault.state, 'locked')
  assert.equal(wrongKey.json.vault.error.code, 'decrypt-failed')
  assert.equal(wrongKey.json.vault.keyConfigured, true)
  assert.equal(wrongKey.json.total, 0)
  assert.ok(!wrongKey.body.includes('wrong-FAKE-passphrase'), 'the passphrase is never echoed')

  process.env[PASS_ENV] = PASSPHRASE
  assert.equal((await plugin.request(LIST_PATH)).json.matched, 3)
})

test('read-only: any method but GET is 405 and changes nothing', async (t) => {
  const plugin = mountWeb(await tempHome(t))
  await seed(plugin)
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    for (const path of [LIST_PATH, SUMMARY_PATH]) {
      const out = await plugin.request(path, method)
      assert.equal(out.status, 405)
      assert.equal(out.headers.allow, 'GET')
      assert.equal(out.json.error.code, 'method-not-allowed')
    }
  }
  assert.equal((await plugin.request(LIST_PATH)).json.total, 3)
})
