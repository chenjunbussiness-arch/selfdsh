import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  DECRYPT_FAILED, VAULT_FORMAT, Vault, clearKeyCache, deriveKey, newScryptKdf, open_, parseEnvelope, seal,
} from '../vault.js'
import { FAKE, PASS_ENV, PASSPHRASE, mount, tempHome } from './helpers.mjs'

const kdfParams = { N: 1024, r: 8, p: 1 }

function vaultAt(path, env = { [PASS_ENV]: PASSPHRASE }, extra = {}) {
  return new Vault({
    path, keySource: 'passphrase-env', passphraseEnv: PASS_ENV, keyfilePath: `${path}.key`,
    scrypt: kdfParams, lockTimeoutMs: 5000, lockStaleMs: 30000, env, ...extra,
  })
}

test('seal/open round trip', async () => {
  const kdf = newScryptKdf(kdfParams)
  const key = await deriveKey(kdf, Buffer.from(PASSPHRASE))
  const envelope = seal(VAULT_FORMAT, kdf, key, { entries: { A: { value: FAKE.OPENAI } } })
  assert.equal(envelope.format, VAULT_FORMAT)
  assert.equal(Buffer.from(envelope.nonce, 'base64').length, 12)
  assert.ok(!JSON.stringify(envelope).includes(FAKE.OPENAI))
  const parsed = parseEnvelope(JSON.stringify(envelope), VAULT_FORMAT)
  assert.deepEqual(open_(parsed, key), { entries: { A: { value: FAKE.OPENAI } } })
  // fresh nonce per seal
  assert.notEqual(seal(VAULT_FORMAT, kdf, key, {}).nonce, envelope.nonce)
})

test('vault file round trip, modes 600/700, plaintext never on disk', async (t) => {
  const home = await tempHome(t)
  const path = join(home, 'sub', 'secrets.vault')
  const plugin = mount(home, { vaultPath: path })
  await plugin.call('secret_set', { name: 'OPENAI_KEY', value: FAKE.OPENAI, description: 'fake' })
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.equal((await stat(join(home, 'sub'))).mode & 0o777, 0o700)
  const text = await readFile(path, 'utf8')
  assert.ok(!text.includes(FAKE.OPENAI))
  assert.ok(!text.includes('OPENAI_KEY'), 'names and metadata are encrypted too')
  const doc = JSON.parse(text)
  assert.equal(doc.format, 'dsh-secrets-vault')
  assert.equal(doc.kdf.name, 'scrypt')
  assert.equal(doc.cipher, 'aes-256-gcm')
  const loaded = await vaultAt(path).load()
  assert.equal(loaded.entries.OPENAI_KEY.value, FAKE.OPENAI)
})

test('wrong passphrase fails with the GCM error and no details', async (t) => {
  const home = await tempHome(t)
  const plugin = mount(home)
  await plugin.call('secret_set', { name: 'K', value: FAKE.OPENAI })
  clearKeyCache()
  await assert.rejects(vaultAt(plugin.vaultPath, { [PASS_ENV]: 'wrong-FAKE-passphrase' }).load(), { message: DECRYPT_FAILED })
})

test('tampered ciphertext, tag, or header fails', async (t) => {
  const home = await tempHome(t)
  const plugin = mount(home)
  await plugin.call('secret_set', { name: 'K', value: FAKE.OPENAI })
  const original = JSON.parse(await readFile(plugin.vaultPath, 'utf8'))
  const flip = (b64) => {
    const bytes = Buffer.from(b64, 'base64')
    bytes[0] ^= 1
    return bytes.toString('base64')
  }
  const variants = [
    { ...original, ciphertext: flip(original.ciphertext) },
    { ...original, tag: flip(original.tag) },
    { ...original, nonce: flip(original.nonce) },
    { ...original, kdf: { ...original.kdf, salt: flip(original.kdf.salt) } },
    { ...original, kdf: { ...original.kdf, r: 4 } },
  ]
  for (const variant of variants) {
    clearKeyCache()
    await writeFile(plugin.vaultPath, JSON.stringify(variant), { mode: 0o600 })
    await assert.rejects(vaultAt(plugin.vaultPath).load(), { message: DECRYPT_FAILED })
  }
  await writeFile(plugin.vaultPath, JSON.stringify({ ...original, format: 'other' }), { mode: 0o600 })
  await assert.rejects(vaultAt(plugin.vaultPath).load(), /not a dsh-secrets-vault/)
})

test('refuses a 0644 vault and a group-writable directory', async (t) => {
  const home = await tempHome(t)
  const plugin = mount(home)
  await plugin.call('secret_set', { name: 'K', value: FAKE.OPENAI })
  await chmod(plugin.vaultPath, 0o644)
  await assert.rejects(plugin.call('secret_list', {}), /mode 0644.*chmod 600/)
  await assert.rejects(plugin.call('secret_set', { name: 'K2', value: FAKE.GITHUB }), /chmod 600/)
  await chmod(plugin.vaultPath, 0o600)
  await chmod(home, 0o770)
  await assert.rejects(plugin.call('secret_list', {}), /chmod 700/)
  await chmod(home, 0o700)
  assert.equal((await plugin.call('secret_list', {})).total, 1)
})

test('missing master key gives a clear error', async (t) => {
  const home = await tempHome(t)
  const plugin = mount(home, { passphraseEnv: 'DSH_SECRETS_TEST_UNSET_VAR' })
  await assert.rejects(plugin.call('secret_set', { name: 'K', value: FAKE.OPENAI }), { message: 'master key missing: set environment variable DSH_SECRETS_TEST_UNSET_VAR' })
  const keyed = mount(home, { keySource: 'keyfile', keyfilePath: join(home, 'none.key') })
  await assert.rejects(keyed.call('secret_set', { name: 'K', value: FAKE.OPENAI }), /master key missing: keyfile not found/)
})

test('keyfile key source: hex keyfile, mode 600 enforced', async (t) => {
  const home = await tempHome(t)
  const keyfile = join(home, 'secrets.key')
  await writeFile(keyfile, `${'ab'.repeat(32)}\n`, { mode: 0o600 })
  const plugin = mount(home, { keySource: 'keyfile', keyfilePath: keyfile })
  await plugin.call('secret_set', { name: 'K', value: FAKE.OPENAI })
  assert.equal(JSON.parse(await readFile(plugin.vaultPath, 'utf8')).kdf.name, 'keyfile')
  assert.equal((await plugin.call('secret_check', { name: 'K', value: FAKE.OPENAI })).matches, true)
  await chmod(keyfile, 0o640)
  await assert.rejects(plugin.call('secret_check', { name: 'K' }), /keyfile .*chmod 600/)
  // a passphrase-configured instance refuses the keyfile vault
  await chmod(keyfile, 0o600)
  const other = mount(home)
  await assert.rejects(other.call('secret_list', {}), /keySource/)
})

test('20 parallel secret_set calls leave a valid vault with all entries and no tmp/lock files', async (t) => {
  const home = await tempHome(t)
  const plugin = mount(home)
  const second = mount(home) // another plugin instance on the same file
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    (i % 2 === 0 ? plugin : second).call('secret_set', { name: `K_${i}`, value: `${FAKE.OPENAI}-${i}`, description: `n${i}` })))
  const { entries } = await vaultAt(plugin.vaultPath).load()
  assert.equal(Object.keys(entries).length, 20)
  for (let i = 0; i < 20; i++) assert.equal(entries[`K_${i}`].value, `${FAKE.OPENAI}-${i}`)
  const files = await readdir(home)
  assert.deepEqual(files, ['secrets.vault'])
})

test('a stale lock file from a dead process is broken', async (t) => {
  const home = await tempHome(t)
  const plugin = mount(home, { lockTimeoutMs: 2000 })
  await mkdir(home, { recursive: true })
  await writeFile(`${plugin.vaultPath}.lock`, JSON.stringify({ pid: 2 ** 22 + 12345, at: 0 }))
  await plugin.call('secret_set', { name: 'K', value: FAKE.OPENAI })
  assert.deepEqual(await readdir(home), ['secrets.vault'])
})
