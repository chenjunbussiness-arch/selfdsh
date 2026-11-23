import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../config.js'
import { comparablePath, createEnvSource, isDshDotEnv, parseEnvFile } from '../env-file.js'

test('parseEnvFile: comments, export, quotes, inline comments, last wins', () => {
  const map = parseEnvFile([
    '\uFEFF# header',
    '',
    'A=plain',
    'export B = spaced value  ',
    'C="dq # not a comment\\nline2"',
    "D='sq $HOME \\n'",
    'E=val # trailing comment',
    'F=',
    '1BAD=x',
    'no-equals-line',
    'A=override',
    'G=a=b=c',
  ].join('\r\n'))
  assert.equal(map.get('A'), 'override')
  assert.equal(map.get('B'), 'spaced value')
  assert.equal(map.get('C'), 'dq # not a comment\nline2')
  assert.equal(map.get('D'), 'sq $HOME \\n')
  assert.equal(map.get('E'), 'val')
  assert.equal(map.get('F'), '')
  assert.equal(map.get('G'), 'a=b=c')
  assert.equal(map.has('1BAD'), false)
})

test('createEnvSource: process env wins, file is fallback, re-read on change, missing file ok', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-envfile-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, '.env')
  const env = {}
  const warnings = []
  const source = createEnvSource({ file, env, logger: { warn: m => warnings.push(m) } })

  assert.equal(source.DSH_SECRETS_PASSPHRASE, undefined, 'missing file is skipped')
  await writeFile(file, 'DSH_SECRETS_PASSPHRASE="from-FAKE-file"\n', { mode: 0o600 })
  assert.equal(source.DSH_SECRETS_PASSPHRASE, 'from-FAKE-file')

  env.DSH_SECRETS_PASSPHRASE = 'from-FAKE-process'
  assert.equal(source.DSH_SECRETS_PASSPHRASE, 'from-FAKE-process', 'process env wins')
  env.DSH_SECRETS_PASSPHRASE = ''
  assert.equal(source.DSH_SECRETS_PASSPHRASE, 'from-FAKE-file', 'empty process value falls back to the file')

  await writeFile(file, 'DSH_SECRETS_PASSPHRASE=changed-FAKE-value-longer\n')
  assert.equal(source.DSH_SECRETS_PASSPHRASE, 'changed-FAKE-value-longer', 'edits are picked up without restart')
  assert.ok(warnings.every(w => !w.includes('FAKE')), 'no value is ever logged')
})

test('createEnvSource: warns once when the file is group/other readable (POSIX only)', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-envfile-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, '.env')
  await writeFile(file, 'K=secret-FAKE\n')
  await chmod(file, 0o644)
  const warnings = []
  const source = createEnvSource({ file, env: {}, logger: { warn: m => warnings.push(m) } })
  assert.equal(source.K, 'secret-FAKE')
  assert.equal(source.K, 'secret-FAKE')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /chmod 600/)
  assert.ok(!warnings[0].includes('secret-FAKE'))
})

test('createEnvSource: file=null reads the process env only', () => {
  const source = createEnvSource({ file: null, env: { X: '1' } })
  assert.equal(source.X, '1')
  assert.equal(source.Y, undefined)
})

test('resolveConfig: envFile defaults to <DSH home>/secrets.env, false disables, string is resolved', () => {
  const home = join(tmpdir(), 'dsh-home-x')
  assert.equal(resolveConfig({}, { DSH_HOME: home }).envFile, join(home, 'secrets.env'))
  assert.notEqual(resolveConfig({}, { DSH_HOME: home }).envFile, join(home, '.env'), 'never DSH\'s own .env by default')
  assert.equal(resolveConfig({}, { DSH_HOME: home }).dshHome, home)
  assert.equal(resolveConfig({ envFile: false }, { DSH_HOME: home }).envFile, null)
  assert.equal(resolveConfig({ envFile: join(home, 'custom.env') }, { DSH_HOME: home }).envFile, join(home, 'custom.env'))
  assert.throws(() => resolveConfig({ envFile: '' }, { DSH_HOME: home }), /envFile/)
})

test('isDshDotEnv: <DSH home>/.env matched normalized, case-insensitive, either separator', () => {
  assert.equal(comparablePath('C:\\Users\\Me\\.DSH\\.\\x\\..\\.env\\'), 'c:/users/me/.dsh/.env')
  for (const file of ['/root/.dsh/.env', '/root/.dsh//.env', '/ROOT/.DSH/.ENV', '\\root\\.dsh\\.env', '/root/.dsh/x/../.env']) assert.equal(isDshDotEnv(file, '/root/.dsh'), true, file)
  for (const file of ['/root/.dsh/secrets.env', '/root/.dsh/worker/.env', '/root/.env', '/root/.dsh/.env.bak']) assert.equal(isDshDotEnv(file, '/root/.dsh'), false, file)
  assert.equal(isDshDotEnv('c:\\users\\alice\\.DSH\\.env', 'C:\\Users\\alice\\.dsh'), true)
  assert.equal(isDshDotEnv('C:/Users/alice/.dsh/.env', 'C:\\Users\\alice\\.dsh'), true)
  assert.equal(isDshDotEnv(null, '/root/.dsh'), false)
  assert.equal(isDshDotEnv('/root/.dsh/.env', undefined), false)
})

test('createEnvSource: <DSH home>/.env is never read for DSH_* names; one warning, no value', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-home-guard-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const file = join(home, '.env')
  await writeFile(file, 'DSH_SECRETS_PASSPHRASE=from-FAKE-dsh-dotenv\nOTHER_PASS=other-FAKE-value\n', { mode: 0o600 })
  await chmod(file, 0o600)
  const warnings = []
  const source = createEnvSource({ file, env: {}, logger: { warn: m => warnings.push(m) }, dshHome: home, names: ['DSH_SECRETS_PASSPHRASE'] })
  assert.equal(warnings.length, 1, 'warned once, at creation')
  assert.match(warnings[0], /DSH_SECRETS_PASSPHRASE is NOT read from/)
  assert.match(warnings[0], /DSH 不允许 <DSH home>\/\.env 里出现 DSH_ 开头的变量/)
  assert.ok(warnings[0].includes(join(home, 'secrets.env')), 'names the migration target')
  assert.equal(source.DSH_SECRETS_PASSPHRASE, undefined, 'the file value is not adopted')
  assert.equal(source.dsh_secrets_passphrase, undefined, 'lower-case dsh_ is reserved too')
  assert.equal('DSH_SECRETS_PASSPHRASE' in source, false)
  assert.equal(source.OTHER_PASS, 'other-FAKE-value', 'non-DSH_ names are still read from it')
  assert.equal(warnings.length, 1, 'no repeated warning')
  assert.ok(warnings.every(w => !w.includes('FAKE')), 'no value is ever logged')

  // Windows-style spelling of the same path (other case, backslashes) is caught as well
  const winSpelled = file.replace(/\//g, '\\').toUpperCase()
  const w2 = []
  const viaWin = createEnvSource({ file: winSpelled, env: {}, logger: { warn: m => w2.push(m) }, dshHome: home })
  assert.equal(viaWin.DSH_SECRETS_PASSPHRASE, undefined)
  assert.equal(w2.length, 1, 'warned on first lookup')

  // process environment still works
  const live = createEnvSource({ file, env: { DSH_SECRETS_PASSPHRASE: 'from-FAKE-process' }, dshHome: home })
  assert.equal(live.DSH_SECRETS_PASSPHRASE, 'from-FAKE-process')

  // without dshHome (old callers) there is no guard; with another file there is none either
  const other = join(home, 'secrets.env')
  await writeFile(other, 'DSH_SECRETS_PASSPHRASE=from-FAKE-secrets-env\n', { mode: 0o600 })
  await chmod(other, 0o600)
  const w3 = []
  const fine = createEnvSource({ file: other, env: {}, logger: { warn: m => w3.push(m) }, dshHome: home, names: ['DSH_SECRETS_PASSPHRASE'] })
  assert.equal(fine.DSH_SECRETS_PASSPHRASE, 'from-FAKE-secrets-env')
  assert.deepEqual(w3, [])
})
