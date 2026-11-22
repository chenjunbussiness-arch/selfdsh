import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../config.js'
import { createEnvSource, parseEnvFile } from '../env-file.js'

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

test('resolveConfig: envFile defaults to <DSH home>/.env, false disables, string is resolved', () => {
  const home = join(tmpdir(), 'dsh-home-x')
  assert.equal(resolveConfig({}, { DSH_HOME: home }).envFile, join(home, '.env'))
  assert.equal(resolveConfig({ envFile: false }, { DSH_HOME: home }).envFile, null)
  assert.equal(resolveConfig({ envFile: join(home, 'custom.env') }, { DSH_HOME: home }).envFile, join(home, 'custom.env'))
  assert.throws(() => resolveConfig({ envFile: '' }, { DSH_HOME: home }), /envFile/)
})
