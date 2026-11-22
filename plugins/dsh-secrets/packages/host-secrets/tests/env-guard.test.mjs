/**
 * The `<DSH home>/.env` guard at plugin level: DSH refuses to start when its own
 * .env sets any DSH_* variable, so the plugin never takes a DSH_* passphrase
 * from that file and says once, at startup, how to migrate. Fake values only.
 */
import assert from 'node:assert/strict'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { PASS_ENV, PASSPHRASE, mount, tempHome } from './helpers.mjs'

const GUARD = 'is NOT read from'

test('apply: default envFile is <DSH home>/secrets.env and a DSH_* passphrase is read from it', async (t) => {
  const home = await tempHome(t)
  delete process.env[PASS_ENV]
  const file = join(home, 'secrets.env')
  await writeFile(file, `${PASS_ENV}=${PASSPHRASE}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
  const plugin = mount(home)
  assert.ok(plugin.logs.some(l => l.includes(`or ${file}`)), plugin.logs.join('\n'))
  assert.ok(!plugin.logs.some(l => l.includes(GUARD)))
  await plugin.call('secret_set', { name: 'A_KEY', value: 'sk-test-FAKE-0123456789abcdef' })
})

test('apply: envFile = <DSH home>/.env with a DSH_* passphraseEnv: warned once, the file is not used', async (t) => {
  const home = await tempHome(t)
  delete process.env[PASS_ENV]
  const file = join(home, '.env')
  await writeFile(file, `${PASS_ENV}=${PASSPHRASE}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
  const plugin = mount(home, { envFile: file })
  const warned = plugin.logs.filter(l => l.includes(GUARD))
  assert.equal(warned.length, 1, plugin.logs.join('\n'))
  assert.match(warned[0], /DSH 不允许 <DSH home>\/\.env 里出现 DSH_ 开头的变量/)
  assert.ok(warned[0].includes(join(home, 'secrets.env')))
  assert.ok(plugin.logs.some(l => l.includes("DSH's own .env")), 'startup line does not claim the file is used')
  await assert.rejects(plugin.call('secret_set', { name: 'A_KEY', value: 'sk-test-FAKE-0123456789abcdef' }))
  await assert.rejects(plugin.call('secret_set', { name: 'B_KEY', value: 'sk-test-FAKE-0123456789abcdef' }))
  assert.equal(plugin.logs.filter(l => l.includes(GUARD)).length, 1, 'still only one warning')
  assert.ok([...plugin.logs, ...plugin.seen].every(l => !l.includes(PASSPHRASE)), 'passphrase never logged')
})

test('apply: a non-DSH_ passphraseEnv may still come from <DSH home>/.env', async (t) => {
  const home = await tempHome(t)
  const file = join(home, '.env')
  await writeFile(file, `SECRETS_MASTER_FAKE=${PASSPHRASE}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
  const plugin = mount(home, { envFile: file, passphraseEnv: 'SECRETS_MASTER_FAKE' })
  assert.ok(!plugin.logs.some(l => l.includes(GUARD)))
  await plugin.call('secret_set', { name: 'A_KEY', value: 'sk-test-FAKE-0123456789abcdef' })
})
