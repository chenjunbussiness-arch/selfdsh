import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTemplate, render } from '../placeholders.js'
import { createRedactor, formsOf, truncate } from '../redact.js'
import { FAKE } from './helpers.mjs'

test('redacts multiple secrets', () => {
  const r = createRedactor([['A', FAKE.OPENAI], ['B', FAKE.GITHUB]])
  assert.equal(r.redact(`x ${FAKE.OPENAI} y ${FAKE.GITHUB} z ${FAKE.OPENAI}`), 'x [REDACTED:A] y [REDACTED:B] z [REDACTED:A]')
})

test('overlapping secrets: longest first', () => {
  const inner = 'FAKEinner1234'
  const outer = `pre-${inner}-post`
  const r = createRedactor([['INNER', inner], ['OUTER', outer]])
  assert.equal(r.redact(`${outer} and ${inner}`), '[REDACTED:OUTER] and [REDACTED:INNER]')
  const r2 = createRedactor([['OUTER', outer], ['INNER', inner]])
  assert.equal(r2.redact(outer), '[REDACTED:OUTER]')
})

test('encoded forms: base64, base64 unpadded, base64url, url-encoded, hex', () => {
  const value = 'FAKE+key/with?&=chars~~'
  const r = createRedactor([['S', value]])
  const bytes = Buffer.from(value)
  for (const form of [bytes.toString('base64'), bytes.toString('base64').replace(/=+$/, ''), bytes.toString('base64url'), encodeURIComponent(value), bytes.toString('hex'), bytes.toString('hex').toUpperCase()]) {
    assert.equal(r.redact(`<${form}>`), '<[REDACTED:S]>', form)
  }
  assert.ok(formsOf(value).length >= 6)
  assert.deepEqual(formsOf('abc'), ['abc'], 'short values: literal only')
})

test('truncate keeps surrogate pairs and marks truncation', () => {
  assert.deepEqual(truncate('abc', 10), { text: 'abc', truncated: false })
  const out = truncate('a😀b', 2)
  assert.equal(out.truncated, true)
  assert.ok(out.text.startsWith('a\n'))
})

test('placeholders: substitution and escape', () => {
  const values = new Map([['TOKEN', 'FAKEv'], ['b.x-1', 'Q']])
  const lookup = name => values.get(name)
  assert.equal(render(parseTemplate('Bearer ${secret:TOKEN}', 'h'), lookup), 'Bearer FAKEv')
  assert.equal(render(parseTemplate('${secret:TOKEN}${secret:b.x-1}', 'b'), lookup), 'FAKEvQ')
  assert.equal(render(parseTemplate('lit $${secret:TOKEN} $x ${other}', 'b'), lookup), 'lit ${secret:TOKEN} $x ${other}')
  assert.equal(render(parseTemplate('', 'b'), lookup), '')
})

test('placeholders: every error case', () => {
  const lookup = () => undefined
  assert.throws(() => render(parseTemplate('a ${secret:MISSING} b', 'body'), lookup), { message: 'secret not found: MISSING' })
  assert.throws(() => parseTemplate('ab${secret:}', 'body'), { message: 'malformed placeholder at offset 2 in body' })
  assert.throws(() => parseTemplate('${secret:bad name}', 'url'), { message: 'malformed placeholder at offset 0 in url' })
  assert.throws(() => parseTemplate('xyz ${secret:X', 'header Authorization'), { message: 'malformed placeholder at offset 4 in header Authorization' })
  assert.throws(() => parseTemplate('${secret:1abc}', 'body'), /offset 0/)
})
