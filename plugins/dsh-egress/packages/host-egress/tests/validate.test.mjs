import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ValidationError, redactedUrl, scrub, validateCredential, validateHost, validateId, validateName, validatePort, validateType, isLoopbackHost,
} from '../lib/validate.js'
import { parseConfig } from '../lib/store.js'

const bad = (fn, code) => assert.throws(fn, (e) => e instanceof ValidationError && (code === undefined || e.code === code))

test('host: accepts names and IP literals, normalises case and brackets', () => {
  assert.equal(validateHost('Proxy.Example.COM'), 'proxy.example.com')
  assert.equal(validateHost('10.0.0.5'), '10.0.0.5')
  assert.equal(validateHost('[::1]'), '::1')
  assert.equal(validateHost('2001:db8::1'), '2001:db8::1')
  assert.equal(validateHost('a.b-c.d'), 'a.b-c.d')
})

test('host: rejects newlines, NUL, urls, credentials, ports, spaces, empty', () => {
  for (const value of ['a.com\nb', 'a.com\r', 'a\0.com', 'http://a.com', 'a.com/x', 'u@a.com', 'a.com:80', 'a b.com', '', '   ', '-a.com', 'a..com', '1.2.3', '256.1.1.1.1', 'a_b.com', 'a.com?x', 5, null, undefined]) {
    bad(() => validateHost(value), undefined)
  }
  bad(() => validateHost('a'.repeat(254)))
  bad(() => validateHost(`${'a'.repeat(64)}.com`))
})

test('port: 1..65535 integers only', () => {
  assert.equal(validatePort(1), 1)
  assert.equal(validatePort('65535'), 65535)
  for (const value of [0, 65536, -1, 1.5, 'abc', '', '80\n', NaN, null, '1e3']) bad(() => validatePort(value), 'bad-port')
})

test('type: protocol whitelist, socks5h folds to socks5', () => {
  assert.equal(validateType('HTTP'), 'http')
  assert.equal(validateType('socks5h'), 'socks5')
  for (const value of ['ftp', 'direct', 'socks4', 'file', '', 'javascript', undefined]) bad(() => validateType(value), 'bad-type')
})

test('name / id / credentials', () => {
  assert.equal(validateName('  Tokyo  '), 'Tokyo')
  bad(() => validateName('a\nb'))
  bad(() => validateName(''))
  bad(() => validateName('x'.repeat(41)))
  assert.equal(validateId('tokyo-1'), 'tokyo-1')
  for (const value of ['direct', 'Tokyo', '-a', 'a b', '', 'a'.repeat(41)]) bad(() => validateId(value), 'bad-id')
  bad(() => validateCredential('a\nb', 'password'))
  bad(() => validateCredential('a\0', 'username'))
  bad(() => validateCredential('a:b', 'username'))
  assert.equal(validateCredential('p:w', 'password'), 'p:w')
})

test('redaction: userinfo is always masked and never the real value', () => {
  assert.equal(redactedUrl('http', 'p.example.com', 3128, false), 'http://p.example.com:3128')
  assert.equal(redactedUrl('socks5', 'p.example.com', 1080, true), 'socks5://***:***@p.example.com:1080')
  assert.equal(redactedUrl('http', '::1', 8080, true), 'http://***:***@[::1]:8080')
  assert.equal(scrub('failed http://alice:hunter2@p.example.com:3128 now'), 'failed http://***:***@p.example.com:3128 now')
  assert.equal(scrub('bad password hunter2 here', ['hunter2']), 'bad password *** here')
})

test('loopback detection', () => {
  for (const host of ['localhost', 'a.localhost', '127.0.0.1', '127.9.9.9', '::1', '[::1]', '::ffff:127.0.0.1', '0.0.0.0']) assert.equal(isLoopbackHost(host), true, host)
  for (const host of ['api.commandcode.ai', '10.0.0.1', '128.0.0.1', '::2']) assert.equal(isLoopbackHost(host), false, host)
})

test('parseConfig: rejects corrupt documents instead of guessing', () => {
  assert.throws(() => parseConfig(null))
  assert.throws(() => parseConfig({ version: 2, exits: [] }))
  assert.throws(() => parseConfig({ version: 1, exits: [{ id: 'a', name: 'A', type: 'ftp', host: 'h.com', port: 1 }] }))
  assert.throws(() => parseConfig({ version: 1, exits: [{ id: 'a', name: 'A', type: 'http', host: 'h.com\n', port: 1 }] }))
  assert.throws(() => parseConfig({ version: 1, exits: [{ id: 'a', name: 'A', type: 'http', host: 'h.com', port: 1 }, { id: 'a', name: 'B', type: 'http', host: 'h.com', port: 2 }] }))
  const ok = parseConfig({ version: 1, exits: [{ id: 'a', name: 'A', type: 'socks5h', host: 'H.com', port: '1080' }], bindings: { 'API.X.com': 'a' } })
  assert.equal(ok.exits[0].type, 'socks5')
  assert.equal(ok.exits[0].host, 'h.com')
  assert.equal(ok.bindings['api.x.com'], 'a')
  assert.equal(ok.defaultExit, 'direct')
})
