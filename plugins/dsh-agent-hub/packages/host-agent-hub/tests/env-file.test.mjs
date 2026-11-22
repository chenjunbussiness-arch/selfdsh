import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEnvFile, readEnvFile } from '../env-file.js'
import { fakeFs } from './helpers.mjs'

const plain = obj => ({ ...obj })

test('parseEnvFile: KEY=value, comments, blank lines, export prefix, quotes', () => {
  const text = [
    '\uFEFF# controller token for dsh-hub',
    '',
    'DSH_HUB_TOKEN=dshc_dsh-cloud_abc',
    '  export   SPACED  =  value with spaces   ',
    'DOUBLE="quoted # not a comment"',
    "SINGLE='single'  # trailing comment",
    'INLINE=bare # comment after whitespace',
    'HASHY=a#b',
    'EMPTY=',
    'EMPTY_QUOTED=""',
    'EQUALS=a=b=c',
    '#COMMENTED=x',
    '   # indented comment',
  ].join('\r\n')
  assert.deepEqual(plain(parseEnvFile(text)), {
    DSH_HUB_TOKEN: 'dshc_dsh-cloud_abc',
    SPACED: 'value with spaces',
    DOUBLE: 'quoted # not a comment',
    SINGLE: 'single',
    INLINE: 'bare',
    HASHY: 'a#b',
    EMPTY: '',
    EMPTY_QUOTED: '',
    EQUALS: 'a=b=c',
  })
})

test('parseEnvFile: malformed lines are skipped, the last definition wins, no prototype keys', () => {
  const out = parseEnvFile([
    'no equals sign',
    '=novalue',
    '1BAD=x',
    'bad-key=x',
    'UNTERMINATED="abc',
    'JUNK_AFTER="abc" tail',
    'A=1',
    'A=2',
    '__proto__=polluted',
    'export=literal',
  ].join('\n'))
  assert.deepEqual(Object.keys(out).sort(), ['A', '__proto__', 'export'])
  assert.equal(out.A, '2')
  assert.equal(out['__proto__'], 'polluted', '__proto__ is an ordinary key here')
  assert.equal(out.export, 'literal')
  assert.equal(Object.getPrototypeOf(out), null)
  assert.equal({}.polluted, undefined)
  assert.deepEqual(plain(parseEnvFile('')), {})
  assert.deepEqual(plain(parseEnvFile(undefined)), {})
})

test('readEnvFile: missing file is silent, values parsed, 600 gives no warning', () => {
  const fs = fakeFs({ '/a/.env': { text: 'K=v', mode: 0o100600 } })
  const missing = readEnvFile('/nope/.env', { fs, platform: 'linux' })
  assert.equal(missing.exists, false)
  assert.equal(missing.warning, undefined)
  assert.deepEqual(plain(missing.values), {})
  const r = readEnvFile('/a/.env', { fs, platform: 'linux' })
  assert.equal(r.exists, true)
  assert.equal(r.warning, undefined)
  assert.deepEqual(plain(r.values), { K: 'v' })
})

test('readEnvFile: group/other readable warns on POSIX only (still parsed)', () => {
  for (const mode of [0o100640, 0o100604, 0o100644, 0o100666]) {
    const fs = fakeFs({ '/a/.env': { text: 'K=v', mode } })
    const r = readEnvFile('/a/.env', { fs, platform: 'linux' })
    assert.match(r.warning, /readable by group or others/, mode.toString(8))
    assert.match(r.warning, /chmod 600 \/a\/\.env/)
    assert.deepEqual(plain(r.values), { K: 'v' })
    assert.equal(readEnvFile('/a/.env', { fs, platform: 'win32' }).warning, undefined)
  }
  const ownerOnly = fakeFs({ '/a/.env': { text: 'K=v', mode: 0o100700 } })
  assert.equal(readEnvFile('/a/.env', { fs: ownerOnly, platform: 'darwin' }).warning, undefined)
})

test('readEnvFile: a directory or an unreadable file warns without values (and without content)', () => {
  const fs = fakeFs({ '/d/.env': { dir: true }, '/x/.env': { text: 'K=secret', error: 'EACCES' } })
  const dir = readEnvFile('/d/.env', { fs, platform: 'linux' })
  assert.equal(dir.exists, false)
  assert.match(dir.warning, /not a regular file/)
  const denied = readEnvFile('/x/.env', { fs, platform: 'linux' })
  assert.equal(denied.exists, false)
  assert.match(denied.warning, /cannot read envFile \/x\/\.env: EACCES/)
  assert.ok(!denied.warning.includes('secret'))
  assert.deepEqual(plain(denied.values), {})
})
